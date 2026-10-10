import { promises as fs } from 'fs';
import path from 'path';
import { TradingMatch, League } from './types';
import { listResearch } from './researchStore';

// FT verification uses a structured fixture ID + team-specific statistics.
// Do not fall back to a paid GPT web search if the provider is unavailable.
const API_BASE = 'https://v3.football.api-sports.io';
const ATTEMPT_FILE = process.env.V1_FT_ATTEMPT_FILE || '/data/v1-ft-attempts.json';
const COOLDOWN_MS = Math.max(15 * 60000, Number(process.env.V1_FT_RETRY_COOLDOWN_MS || 60 * 60000));
const LEAGUE_IDS: Record<League, number> = {
  MLS: 253, Allsvenskan: 113, 'Liga MX': 262, 'Brazil Serie A': 71,
};

export type VerifiedFtRow = {
  id: string;
  matchEnded: boolean;
  scheduledKickoff?: string | null;
  scoreHome?: number | null;
  scoreAway?: number | null;
  cornersHome?: number | null;
  cornersAway?: number | null;
  htScoreHome?: number | null;
  htScoreAway?: number | null;
  htCornersHome?: number | null;
  htCornersAway?: number | null;
  redCardsHome?: number | null;
  redCardsAway?: number | null;
  sourceSummary: string;
  sourceUrls: string[];
};

function integer(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function normalizeTeam(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\b(fc|cf|sc|ac)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function day(date: Date) {
  return date.toISOString().slice(0, 10);
}

async function readAttempts(): Promise<Record<string, number>> {
  try {
    const data = JSON.parse(await fs.readFile(ATTEMPT_FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

async function writeAttempts(attempts: Record<string, number>) {
  await fs.mkdir(path.dirname(ATTEMPT_FILE), { recursive: true });
  const temp = ATTEMPT_FILE + '.tmp';
  await fs.writeFile(temp, JSON.stringify(attempts), 'utf8');
  await fs.rename(temp, ATTEMPT_FILE);
}

function pending(match: TradingMatch, reason: string): VerifiedFtRow {
  return { id: match.id, matchEnded: false, sourceSummary: reason, sourceUrls: [] };
}

function completeCached(match: TradingMatch, row: TradingMatch): VerifiedFtRow {
  return {
    id: match.id, matchEnded: true,
    scoreHome: row.ftScoreHome, scoreAway: row.ftScoreAway,
    cornersHome: row.ftCornersHome, cornersAway: row.ftCornersAway,
    htScoreHome: row.htScoreHome, htScoreAway: row.htScoreAway,
    htCornersHome: row.htCornersHome, htCornersAway: row.htCornersAway,
    sourceSummary: row.ftSourceSummary || 'Previously verified API-Football FT result',
    sourceUrls: row.ftSourceUrls || [],
  };
}

function isTrustedFt(row: TradingMatch): boolean {
  return row.researchPhase === 'FT' && row.ftVerified === true &&
    /^API-Football fixture \d+/.test(row.ftSourceSummary || '') &&
    [row.ftScoreHome, row.ftScoreAway, row.ftCornersHome, row.ftCornersAway]
      .every(v => integer(v) !== null);
}

export async function collectVerifiedFt(matches: TradingMatch[]) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return {
    providerStatus: 'FT_DATA_PROVIDER_MISSING',
    message: 'FT Batch was blocked before any paid search. Configure API_FOOTBALL_KEY in Railway to verify finished matches and corners.',
    rows: [] as VerifiedFtRow[], requests: 0, cached: 0, deferred: matches.length,
  };

  let requests = 0;
  let cached = 0;
  let deferred = 0;
  const now = Date.now();
  const attempts = await readAttempts();
  const previous = await listResearch(1000);
  const verifiedHistory = new Map<string, TradingMatch>();
  for (const row of previous) {
    if (isTrustedFt(row) && !verifiedHistory.has(row.id)) verifiedHistory.set(row.id, row);
  }

  const eligible: TradingMatch[] = [];
  const byId = new Map<string, VerifiedFtRow>();
  for (const match of matches) {
    const prior = verifiedHistory.get(match.id);
    if (prior) {
      byId.set(match.id, completeCached(match, prior));
      cached++;
      continue;
    }

    const kickoff = new Date(match.kickoff || '').getTime();
    const elapsed = now - kickoff;
    if (!Number.isFinite(kickoff) || !LEAGUE_IDS[match.league]) {
      byId.set(match.id, pending(match, 'Cannot verify FT: kickoff or league is invalid.'));
    } else if (elapsed < 105 * 60000) {
      byId.set(match.id, pending(match, 'Match not yet due for FT verification.'));
    } else if (elapsed > 72 * 3600000) {
      byId.set(match.id, pending(match, 'Match is over 72h old; archived without a paid lookup.'));
    } else if (now - (Number(attempts[match.id]) || 0) < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - Number(attempts[match.id]))) / 60000);
      byId.set(match.id, pending(match, `FT lookup was already attempted. Retry in ${remaining} min; no new request made.`));
    } else {
      eligible.push(match);
    }
    if (byId.has(match.id)) deferred++;
  }

  if (eligible.length) {
    // Reserve cooldown BEFORE external calls. A browser retry / app restart cannot pay twice.
    for (const match of eligible) attempts[match.id] = now;
    // Bound file growth; the existing history is stored separately.
    for (const id of Object.keys(attempts)) {
      if (now - attempts[id] > 7 * 86400000) delete attempts[id];
    }
    await writeAttempts(attempts);
  }

  const fixtureCache = new Map<string, any[]>();
  const statsCache = new Map<number, any[]>();
  async function apiGet(endpoint: string): Promise<any[]> {
    requests++;
    const res = await fetch(API_BASE + endpoint, {
      headers: { 'x-apisports-key': key! }, cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error('API-Football HTTP ' + res.status);
    const data = await res.json();
    if (data?.errors && Object.keys(data.errors).length) {
      throw new Error('API-Football rejected the fixture/statistics request');
    }
    return Array.isArray(data?.response) ? data.response : [];
  }

  for (const match of eligible) {
    try {
      const kickoff = new Date(match.kickoff!);
      const season = kickoff.getUTCFullYear();
      const from = day(new Date(kickoff.getTime() - 86400000));
      const to = day(new Date(kickoff.getTime() + 86400000));
      const lookupKey = `${match.league}|${season}|${from}|${to}`;
      let fixtures = fixtureCache.get(lookupKey);
      if (!fixtures) {
        fixtures = await apiGet(`/fixtures?league=${LEAGUE_IDS[match.league]}&season=${season}&from=${from}&to=${to}`);
        fixtureCache.set(lookupKey, fixtures);
      }

      const exact = fixtures.filter((f: any) =>
        normalizeTeam(String(f?.teams?.home?.name || '')) === normalizeTeam(match.home) &&
        normalizeTeam(String(f?.teams?.away?.name || '')) === normalizeTeam(match.away) &&
        Math.abs(new Date(f?.fixture?.date).getTime() - kickoff.getTime()) <= 120 * 60000
      );
      if (exact.length !== 1) {
        byId.set(match.id, pending(match, 'FT unverified: no unique fixture matches both teams and kickoff (within 2h).'));
        continue;
      }

      const fixture = exact[0];
      const fixtureId = integer(fixture.fixture?.id);
      if (!fixtureId || fixture.fixture?.status?.short !== 'FT') {
        byId.set(match.id, pending(match, 'Fixture found but its provider status is not final FT.'));
        continue;
      }

      const homeId = integer(fixture.teams?.home?.id);
      const awayId = integer(fixture.teams?.away?.id);
      const scoreHome = integer(fixture.goals?.home);
      const scoreAway = integer(fixture.goals?.away);
      if (homeId === null || awayId === null || scoreHome === null || scoreAway === null) {
        byId.set(match.id, pending(match, 'FT fixture has incomplete team or final-score data.'));
        continue;
      }

      let stats = statsCache.get(fixtureId);
      if (!stats) {
        stats = await apiGet(`/fixtures/statistics?fixture=${fixtureId}`);
        statsCache.set(fixtureId, stats);
      }
      function corners(teamId: number): number | null {
        const team = stats!.find((s: any) => integer(s?.team?.id) === teamId);
        const raw = team?.statistics?.find((s: any) => /corner kicks/i.test(String(s?.type || '')))?.value;
        return integer(raw);
      }
      const cornersHome = corners(homeId);
      const cornersAway = corners(awayId);
      if (cornersHome === null || cornersAway === null) {
        byId.set(match.id, pending(match, `API-Football fixture ${fixtureId} FT, but team corner statistics are missing. Nothing was graded.`));
        continue;
      }
      byId.set(match.id, {
        id: match.id, matchEnded: true, scheduledKickoff: fixture.fixture.date,
        scoreHome, scoreAway, cornersHome, cornersAway,
        htScoreHome: integer(fixture.score?.halftime?.home),
        htScoreAway: integer(fixture.score?.halftime?.away),
        sourceSummary: `API-Football fixture ${fixtureId}: FT status, score and both teams' corner statistics confirmed`,
        sourceUrls: [],
      });
    } catch (error) {
      byId.set(match.id, pending(match,
        'FT provider lookup failed: ' + (error instanceof Error ? error.message : 'unknown error')));
    }
  }

  return {
    providerStatus: 'CONNECTED',
    rows: matches.map(m => byId.get(m.id) || pending(m, 'Fixture not verified')),
    requests, cached, deferred,
  };
}
