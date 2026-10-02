import { League, TradingMatch } from './types';
import { evaluateV1 } from './rules';

const BASE_URL = 'https://v3.football.api-sports.io';
const BOOKMAKER_ID = 8; // Bet365

const LEAGUES: Record<League, number> = {
  MLS: 253,
  Allsvenskan: 113,
  'Liga MX': 262,
};

type ApiResponse<T> = {
  response?: T[];
  errors?: unknown;
  paging?: { current?: number; total?: number };
};

type CacheEntry<T> = { value: T; expiresAt: number };
const cache = new Map<string, CacheEntry<unknown>>();

function readCache<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit || hit.expiresAt <= Date.now()) return null;
  return hit.value as T;
}

function writeCache<T>(key: string, value: T, ttlMs: number) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function apiGet<T>(path: string): Promise<ApiResponse<T>> {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY is not configured');

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store',
  });

  if (!res.ok) throw new Error(`API-Football HTTP ${res.status}`);
  const data = await res.json() as ApiResponse<T>;

  if (data.errors && typeof data.errors === 'object' && Object.keys(data.errors as object).length) {
    throw new Error(`API-Football error: ${JSON.stringify(data.errors)}`);
  }

  return data;
}

function statusOf(short: string): TradingMatch['status'] {
  if (short === 'HT') return 'HT';
  if (['1H', '2H', 'ET', 'BT', 'P', 'LIVE'].includes(short)) return 'LIVE';
  if (['FT', 'AET', 'PEN'].includes(short)) return 'FT';
  return 'PRE';
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function balancedLine(values: Array<{ value?: string; odd?: string; handicap?: string }> = []): number | null {
  const byLine = new Map<number, { over?: number; under?: number }>();

  for (const item of values) {
    const text = String(item.value ?? '');
    const line = numberFrom(item.handicap ?? text);
    const odd = Number(item.odd);
    if (line === null || !Number.isFinite(odd)) continue;

    const slot = byLine.get(Math.abs(line)) ?? {};
    if (/over/i.test(text)) slot.over = odd;
    if (/under/i.test(text)) slot.under = odd;
    byLine.set(Math.abs(line), slot);
  }

  let best: { line: number; score: number } | null = null;
  for (const [line, pair] of byLine) {
    if (!pair.over || !pair.under) continue;
    const score = Math.abs(pair.over - pair.under) + Math.abs(pair.over - 1.9) * 0.25 + Math.abs(pair.under - 1.9) * 0.25;
    if (!best || score < best.score) best = { line, score };
  }
  return best?.line ?? null;
}

function parseHandicap(values: Array<{ value?: string; odd?: string; handicap?: string }> = []) {
  let best: { favourite: 'HOME' | 'AWAY'; handicap: number; score: number } | null = null;

  for (const item of values) {
    const text = String(item.value ?? '');
    const odd = Number(item.odd);
    const handicap = numberFrom(item.handicap ?? text);
    if (handicap === null || handicap >= 0 || !Number.isFinite(odd)) continue;

    const side: 'HOME' | 'AWAY' = /away|2\b/i.test(text) ? 'AWAY' : 'HOME';
    const score = Math.abs(odd - 1.9);
    if (!best || score < best.score) best = { favourite: side, handicap, score };
  }

  return best ?? { favourite: 'HOME' as const, handicap: 0 };
}

function parseOdds(item: any) {
  const bookmaker = (item?.bookmakers ?? []).find((b: any) => b?.id === BOOKMAKER_ID || /bet365/i.test(b?.name ?? ''));
  if (!bookmaker) return null;

  const bets = bookmaker.bets ?? [];
  const goalsBet = bets.find((b: any) => /goals over\/under/i.test(b?.name ?? '') && !/half|home|away/i.test(b?.name ?? ''));
  const cornersBet = bets.find((b: any) => /corners over under|total corners/i.test(b?.name ?? '') && !/home|away|half/i.test(b?.name ?? ''));
  const handicapBet = bets.find((b: any) => /asian handicap/i.test(b?.name ?? '') && !/half/i.test(b?.name ?? ''));

  const goalLine = balancedLine(goalsBet?.values);
  const cornerLine = balancedLine(cornersBet?.values);
  if (goalLine === null || cornerLine === null) return null;

  const handicap = parseHandicap(handicapBet?.values);
  return {
    goalLine,
    cornerLine,
    favourite: handicap.favourite,
    handicap: handicap.handicap,
  };
}

async function fetchLeagueOdds(leagueId: number, season: number) {
  const cacheKey = `odds-${leagueId}-${season}`;
  const cached = readCache<Map<number, ReturnType<typeof parseOdds>>>(cacheKey);
  if (cached) return cached;

  const result = new Map<number, ReturnType<typeof parseOdds>>();
  let page = 1;
  let total = 1;

  do {
    const data = await apiGet<any>(`/odds?league=${leagueId}&season=${season}&bookmaker=${BOOKMAKER_ID}&page=${page}`);
    total = data.paging?.total ?? 1;

    for (const item of data.response ?? []) {
      const parsed = parseOdds(item);
      if (parsed) result.set(Number(item.fixture?.id), parsed);
    }

    page += 1;
  } while (page <= total && page <= 3);

  // API-Football says pre-match odds update roughly every 3 hours.
  writeCache(cacheKey, result, 3 * 60 * 60 * 1000);
  return result;
}

function cornerCount(statistics: any): { home: number; away: number } {
  if (!Array.isArray(statistics)) return { home: 0, away: 0 };

  const home = statistics[0]?.statistics?.find((s: any) => /corner kicks/i.test(s?.type ?? ''))?.value ?? 0;
  const away = statistics[1]?.statistics?.find((s: any) => /corner kicks/i.test(s?.type ?? ''))?.value ?? 0;
  return { home: Number(home) || 0, away: Number(away) || 0 };
}

async function fetchLeagueFixtures(league: League, leagueId: number, season: number) {
  const cacheKey = `fixtures-${leagueId}-${season}`;
  const cached = readCache<any[]>(cacheKey);
  if (cached) return cached;

  const data = await apiGet<any>(`/fixtures?league=${leagueId}&season=${season}&next=20&timezone=America%2FToronto`);
  const fixtures = data.response ?? [];
  writeCache(cacheKey, fixtures, 10 * 60 * 1000);
  return fixtures;
}

async function fetchLiveFixtures() {
  const cacheKey = 'live-fixtures';
  const cached = readCache<any[]>(cacheKey);
  if (cached) return cached;

  const ids = Object.values(LEAGUES).join('-');
  const data = await apiGet<any>(`/fixtures?live=${ids}&timezone=America%2FToronto`);
  const fixtures = data.response ?? [];

  // Default to 3 minutes so the free plan is not exhausted quickly.
  const ttl = Number(process.env.API_FOOTBALL_LIVE_TTL_MS ?? 180000);
  writeCache(cacheKey, fixtures, Math.max(60000, ttl));
  return fixtures;
}

function fixtureToBase(league: League, fixture: any, odds: NonNullable<ReturnType<typeof parseOdds>>): TradingMatch {
  const corners = cornerCount(fixture.statistics);
  const status = statusOf(fixture.fixture?.status?.short ?? 'NS');
  const scoreHome = Number(fixture.goals?.home ?? 0);
  const scoreAway = Number(fixture.goals?.away ?? 0);

  const favouriteLosing = odds.favourite === 'HOME' ? scoreHome < scoreAway : scoreAway < scoreHome;

  return {
    id: String(fixture.fixture?.id),
    league,
    home: fixture.teams?.home?.name ?? 'Home',
    away: fixture.teams?.away?.name ?? 'Away',
    minute: fixture.fixture?.status?.elapsed ?? null,
    status,
    kickoff: fixture.fixture?.date ?? null,
    scoreHome,
    scoreAway,
    cornersHome: corners.home,
    cornersAway: corners.away,
    prematchCornerLine: odds.cornerLine,
    prematchGoalLine: odds.goalLine,
    favourite: odds.favourite,
    handicap: odds.handicap,
    favouriteCoveringHandicap: false,
    favouriteLosing,
    ftGoalOverClear: false,
  };
}

export async function getApiFootballMatches(): Promise<TradingMatch[]> {
  const season = Number(process.env.API_FOOTBALL_SEASON ?? new Date().getFullYear());

  const upcomingByLeague = await Promise.all(
    (Object.entries(LEAGUES) as Array<[League, number]>).map(async ([league, leagueId]) => {
      const [fixtures, oddsMap] = await Promise.all([
        fetchLeagueFixtures(league, leagueId, season),
        fetchLeagueOdds(leagueId, season),
      ]);

      return fixtures
        .map((fixture: any) => {
          const odds = oddsMap.get(Number(fixture.fixture?.id));
          if (!odds) return null;
          const match = fixtureToBase(league, fixture, odds);
          return { ...match, ...evaluateV1(match) };
        })
        .filter(Boolean) as TradingMatch[];
    })
  );

  let liveMatches: TradingMatch[] = [];
  try {
    const live = await fetchLiveFixtures();

    for (const fixture of live) {
      const league = (Object.entries(LEAGUES) as Array<[League, number]>).find(([, id]) => id === Number(fixture.league?.id))?.[0];
      if (!league) continue;

      const leagueId = LEAGUES[league];
      const oddsMap = await fetchLeagueOdds(leagueId, season);
      const odds = oddsMap.get(Number(fixture.fixture?.id));
      if (!odds) continue;

      const match = fixtureToBase(league, fixture, odds);
      liveMatches.push({ ...match, ...evaluateV1(match) });
    }
  } catch {
    // Upcoming scanner can still work when live endpoint is unavailable on the plan.
  }

  const merged = new Map<string, TradingMatch>();
  for (const match of upcomingByLeague.flat()) merged.set(match.id, match);
  for (const match of liveMatches) merged.set(match.id, match);

  return Array.from(merged.values())
    .filter(match => match.status !== 'FT')
    .sort((a, b) => {
      const aLive = a.status === 'LIVE' || a.status === 'HT' ? 0 : 1;
      const bLive = b.status === 'LIVE' || b.status === 'HT' ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;
      return new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime();
    });
}
