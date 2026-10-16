import { promises as fs } from 'fs';
import path from 'path';
import { TradingMatch, League } from './types';

const API_BASE = 'https://v3.football.api-sports.io';
const ATTEMPT_FILE = process.env.V1_HT_ATTEMPT_FILE || '/data/v1-ht-attempts.json';
const COOLDOWN_MS = 3 * 60 * 1000;
const LEAGUES: Record<League, number> = {
  MLS: 253,
  Allsvenskan: 113,
  'Liga MX': 262,
  'Brazil Serie A': 71,
  Eredivisie: 88,
  'Swiss Super League': 207,
  'Danish Superliga': 119,
  Eliteserien: 103,
};

export type VerifiedHtSnapshot = {
  scoreHome: number;
  scoreAway: number;
  cornersHome: number;
  cornersAway: number;
  liveGoalLine: number | null;
  liveCornerLine: number | null;
  liveGoalOverOdd: number | null;
  liveGoalUnderOdd: number | null;
  liveCornerOverOdd: number | null;
  liveCornerUnderOdd: number | null;
  missingInputs?: string[];
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

function numberFromText(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(value);
  if (typeof value !== 'string') return null;
  const m = value.match(/-?\d+(?:\.\d+)?/);
  return m ? Math.abs(Number(m[0])) : null;
}

function collectBets(node: unknown, out: Array<{ name: string; values: any[] }> = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectBets(item, out);
    return out;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.name === 'string' && Array.isArray(obj.values)) {
    out.push({ name: obj.name, values: obj.values as any[] });
  }
  for (const value of Object.values(obj)) collectBets(value, out);
  return out;
}

function collectBet365Bets(node: unknown, out: Array<{ name: string; values: any[] }> = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectBet365Bets(item, out);
    return out;
  }

  const obj = node as Record<string, unknown>;
  const isBet365 = String(obj.name ?? '').trim().toLowerCase() === 'bet365' || Number(obj.id) === 8;
  if (isBet365 && Array.isArray(obj.bets)) {
    collectBets(obj.bets, out);
    return out;
  }

  for (const value of Object.values(obj)) collectBet365Bets(value, out);
  return out;
}

function balancedLiveQuote(values: any[]) {
  const candidates = new Map<number, { over?: number; under?: number; main?: boolean }>();
  for (const value of values ?? []) {
    const label = String(value?.value ?? value?.name ?? '');
    const line = numberFromText(value?.handicap ?? label);
    if (line == null) continue;
    const odd = Number(value?.odd ?? value?.price);
    const slot = candidates.get(line) ?? {};
    if (/over/i.test(label) && Number.isFinite(odd)) slot.over = odd;
    if (/under/i.test(label) && Number.isFinite(odd)) slot.under = odd;
    if (value?.main === true) slot.main = true;
    candidates.set(line, slot);
  }

  let best: { line: number; over: number; under: number; score: number } | null = null;
  for (const [line, pair] of candidates) {
    if (pair.over == null || pair.under == null) continue;
    const score =
      (pair.main ? -3 : 0) +
      Math.abs(pair.over - pair.under) +
      Math.abs(pair.over - 1.9) * 0.2 +
      Math.abs(pair.under - 1.9) * 0.2;
    if (!best || score < best.score) {
      best = { line, over: pair.over, under: pair.under, score };
    }
  }
  return best ? { line: best.line, over: best.over, under: best.under } : null;
}

async function fetchLiveH2Lines(fixtureId: number, key: string) {
  try {
    const rows = await apiGet(`/odds/live?fixture=${fixtureId}`, key);

    // V1 execution uses Bet365 only:
    // - H2 goals: Bet365 second-half total goals line + both prices.
    // - Corners: Bet365 live FULL-MATCH total-corners line at HT + both prices.
    const bets = collectBet365Bets(rows);
    const secondHalf = (name: string) => /second\s*half|2nd\s*half|2nd\s*h|\bh2\b/i.test(name);
    const firstHalf = (name: string) => /first\s*half|1st\s*half|1st\s*h|\bh1\b/i.test(name);

    const goalBet = bets.find(
      b => secondHalf(b.name) && !/corner/i.test(b.name) &&
        /goal|total|over.*under|over\/under/i.test(b.name) &&
        balancedLiveQuote(b.values) != null
    );

    const cornerBets = bets.filter(
      b => /corner/i.test(b.name) &&
        !firstHalf(b.name) &&
        !secondHalf(b.name) &&
        !/home|away|team|race|first to|odd\/even|exact/i.test(b.name) &&
        balancedLiveQuote(b.values) != null
    );
    const cornerBet =
      cornerBets.find(b => /total\s*corners|corners\s*over.*under|asian.*corner/i.test(b.name)) ??
      cornerBets[0];

    const goal = goalBet ? balancedLiveQuote(goalBet.values) : null;
    const corner = cornerBet ? balancedLiveQuote(cornerBet.values) : null;

    return {
      liveGoalLine: goal?.line ?? null,
      liveGoalOverOdd: goal?.over ?? null,
      liveGoalUnderOdd: goal?.under ?? null,
      liveCornerLine: corner?.line ?? null,
      liveCornerOverOdd: corner?.over ?? null,
      liveCornerUnderOdd: corner?.under ?? null,
    };
  } catch {
    return {
      liveGoalLine: null,
      liveGoalOverOdd: null,
      liveGoalUnderOdd: null,
      liveCornerLine: null,
      liveCornerOverOdd: null,
      liveCornerUnderOdd: null,
    };
  }
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
    const liveLines = await fetchLiveH2Lines(id!, key);
    const missingInputs: string[] = [];
    if (liveLines.liveGoalLine == null) missingInputs.push('Exact H2 goal line');
    if (liveLines.liveCornerLine == null) missingInputs.push('Exact H2 corner line');

    return {
      providerStatus: 'CONNECTED',
      snapshot: {
        scoreHome: scoreHome!, scoreAway: scoreAway!,
        cornersHome, cornersAway,
        liveGoalLine: liveLines.liveGoalLine,
        liveGoalOverOdd: liveLines.liveGoalOverOdd,
        liveGoalUnderOdd: liveLines.liveGoalUnderOdd,
        liveCornerLine: liveLines.liveCornerLine,
        liveCornerOverOdd: liveLines.liveCornerOverOdd,
        liveCornerUnderOdd: liveLines.liveCornerUnderOdd,
        missingInputs,
        checkedAt: new Date().toISOString(),
        htVerified: true, htSourceType: 'API_FOOTBALL',
        sourceSummary: `API-Football fixture ${id}: confirmed HT score/corners${liveLines.liveGoalLine != null || liveLines.liveCornerLine != null ? ' + Bet365 HT execution lines' : ''}`,
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
