import { promises as fs } from 'fs';
import path from 'path';
import { TradingMatch, League } from './types';

const API_BASE = 'https://v3.football.api-sports.io';
const ATTEMPT_FILE = process.env.V1_HT_ATTEMPT_FILE || '/data/v1-ht-attempts.json';
const COOLDOWN_MS = 3 * 60 * 1000;
const LEAGUES: Record<League, number> = {
  MLS: 253, Allsvenskan: 113, 'Liga MX': 262, 'Brazil Serie A': 71,
};

export type VerifiedHtSnapshot = {
  scoreHome: number;
  scoreAway: number;
  cornersHome: number;
  cornersAway: number;
  liveGoalLine: null;
  liveCornerLine: null;
  sourceSummary: string;
  sourceUrls: string[];
  checkedAt: string;
  htVerified: true;
  htSourceType: 'API_FOOTBALL';
};
export type HtResult = {
  providerStatus: 'CONNECTED' | 'HT_DATA_PROVIDER_MISSING' | 'HT_NOT_VERIFIED' | 'ERROR';
  advice?: string;
  snapshot?: VerifiedHtSnapshot;
};

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function teamName(s: string) {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\b(fc|cf|sc|ac|if)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
async function apiGet(url: string, key: string): Promise<any[]> {
  const r = await fetch(API_BASE + url, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`API-Football HTTP ${r.status}`);
  const data = await r.json();
  if (data.errors && Object.keys(data.errors).length) throw new Error('API-Football provider rejected request');
  return Array.isArray(data.response) ? data.response : [];
}
async function reserveAttempt(id: string, now: number): Promise<boolean> {
  let attempts: Record<string, number> = {};
  try { attempts = JSON.parse(await fs.readFile(ATTEMPT_FILE, 'utf8')); } catch { /* no attempts yet */ }
  if (!attempts || typeof attempts !== 'object' || Array.isArray(attempts)) attempts = {};
  if (now - (Number(attempts[id]) || 0) < COOLDOWN_MS) return false;
  for (const [key, value] of Object.entries(attempts)) {
    if (now - Number(value) > 86400000) delete attempts[key];
  }
  attempts[id] = now;
  await fs.mkdir(path.dirname(ATTEMPT_FILE), { recursive: true });
  const tmp = ATTEMPT_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(attempts), 'utf8');
  await fs.rename(tmp, ATTEMPT_FILE);
  return true;
}

export async function fetchVerifiedHt(match: TradingMatch): Promise<HtResult> {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return {
    providerStatus: 'HT_DATA_PROVIDER_MISSING',
    advice: 'HT Check blocked with zero GPT web-search calls: API_FOOTBALL_KEY is missing. Do not trade using old GPT halftime corners. Use manual verification if necessary.',
  };

  const kickoff = new Date(match.kickoff || '').getTime();
  const now = Date.now();
  const elapsed = (now - kickoff) / 60000;
  if (!Number.isFinite(kickoff) || !LEAGUES[match.league]) return {
    providerStatus: 'HT_NOT_VERIFIED',
    advice: 'Missing valid kickoff/league; fixture identity cannot be verified.',
  };
  if (elapsed < 38 || elapsed > 85) return {
    providerStatus: 'HT_NOT_VERIFIED',
    advice: 'Outside the live halftime check window. Archived HT corner totals cannot be inferred from current match statistics.',
  };

  try {
    if (!(await reserveAttempt(match.id, now))) return {
      providerStatus: 'HT_NOT_VERIFIED',
      advice: 'HT fixture was queried within the last 3 minutes. Wait before trying again to avoid repeated provider requests.',
    };

    const date = new Date(kickoff).toISOString().slice(0, 10);
    const leagueId = LEAGUES[match.league];
    const season = Number(process.env.API_FOOTBALL_SEASON || new Date(kickoff).getUTCFullYear());
    const fixtures = await apiGet(`/fixtures?league=${leagueId}&season=${season}&date=${date}`, key);
    const candidates = fixtures.filter((f: any) => {
      const fixtureTime = new Date(f.fixture?.date).getTime();
      return teamName(String(f.teams?.home?.name ?? '')) === teamName(match.home) &&
        teamName(String(f.teams?.away?.name ?? '')) === teamName(match.away) &&
        Number.isFinite(fixtureTime) && Math.abs(fixtureTime - kickoff) <= 60 * 60000;
    });
    if (candidates.length !== 1) return {
      providerStatus: 'HT_NOT_VERIFIED',
      advice: 'Could not match exactly one fixture by both teams and kickoff. HT corners are not verified.',
    };
    const fixture = candidates[0];
    const id = numberOrNull(fixture.fixture?.id);
    const status = String(fixture.fixture?.status?.short || '');
    if (!id || status !== 'HT') return {
      providerStatus: 'HT_NOT_VERIFIED',
      advice: `Fixture status is ${status || 'unknown'}, not confirmed HT. Refusing to infer halftime corners.`,
    };

    const scoreHome = numberOrNull(fixture.score?.halftime?.home);
    const scoreAway = numberOrNull(fixture.score?.halftime?.away);
    const homeId = numberOrNull(fixture.teams?.home?.id);
    const awayId = numberOrNull(fixture.teams?.away?.id);
    if ([scoreHome, scoreAway, homeId, awayId].some(v => v === null) || homeId === awayId) return {
      providerStatus: 'HT_NOT_VERIFIED',
      advice: 'Official HT score or team identifiers are missing.',
    };

    const stats = await apiGet(`/fixtures/statistics?fixture=${id}`, key);
    function readCorners(teamId: number): number | null {
      const matching = stats.filter((s: any) => numberOrNull(s.team?.id) === teamId);
      if (matching.length !== 1) return null;
      const rows = matching[0].statistics;
      const found = Array.isArray(rows) ? rows.filter((s: any) => /corner kicks/i.test(String(s.type || ''))) : [];
      return found.length === 1 ? numberOrNull(found[0]?.value) : null;
    }
    const cornersHome = readCorners(homeId!);
    const cornersAway = readCorners(awayId!);
    if (cornersHome === null || cornersAway === null) return {
      providerStatus: 'HT_NOT_VERIFIED',
      advice: 'HT statistics are incomplete for one/both teams. Missing corners must never be assumed to be zero.',
    };
    return {
      providerStatus: 'CONNECTED',
      snapshot: {
        scoreHome: scoreHome!, scoreAway: scoreAway!,
        cornersHome, cornersAway,
        liveGoalLine: null, liveCornerLine: null,
        checkedAt: new Date().toISOString(),
        htVerified: true, htSourceType: 'API_FOOTBALL',
        sourceSummary: `API-Football fixture ${id}: confirmed HT status, halftime score, and both teams' corner statistics`,
        sourceUrls: [],
      },
    };
  } catch (err) {
    return {
      providerStatus: 'ERROR',
      advice: 'HT data provider error: ' + (err instanceof Error ? err.message : 'unknown error'),
    };
  }
}
