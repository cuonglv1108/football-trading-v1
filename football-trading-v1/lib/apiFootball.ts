import { League, TradingMatch } from './types';
import { evaluateV1 } from './rules';

const BASE_URL = 'https://v3.football.api-sports.io';

const LEAGUES: Record<League, number> = {
  MLS: 253,
  Allsvenskan: 113,
  'Liga MX': 262,
  'Brazil Serie A': 71,
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

  // Asian quarter lines may be written as "-1,-1.5", "-1.0, -1.5" or "3,3.5".
  // Average the two components so split lines become -1.25 / 3.25 instead of
  // accidentally taking only the first number.
  const nums = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) ?? [];
  if (!nums.length) return null;
  if (nums.length >= 2) {
    const a = nums[nums.length - 2];
    const b = nums[nums.length - 1];
    if (Math.abs(Math.abs(a) - Math.abs(b)) <= 1 && Math.sign(a || b) === Math.sign(b || a)) {
      return (a + b) / 2;
    }
  }
  return nums[nums.length - 1];
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

function moneylineFavourite(bets: any[]): 'HOME' | 'AWAY' | null {
  for (const bet of bets) {
    const values = Array.isArray(bet?.values) ? bet.values : [];
    const home = values.find((v: any) => /^home$/i.test(String(v?.value ?? '').trim()));
    const away = values.find((v: any) => /^away$/i.test(String(v?.value ?? '').trim()));
    const draw = values.find((v: any) => /^draw$/i.test(String(v?.value ?? '').trim()));
    if (!home || !away || !draw) continue;

    const ho = Number(home.odd);
    const ao = Number(away.odd);
    const do_ = Number(draw.odd);
    if (![ho, ao, do_].every(Number.isFinite)) continue;

    // Only use a clear 1X2 favourite. If Home/Away are essentially tied, fail closed.
    if (Math.abs(ho - ao) < 0.08) return null;
    return ho < ao ? 'HOME' : 'AWAY';
  }
  return null;
}

function sideFromValue(value: unknown): 'HOME' | 'AWAY' | null {
  const text = String(value ?? '').trim();
  if (/^home\b/i.test(text)) return 'HOME';
  if (/^away\b/i.test(text)) return 'AWAY';
  return null;
}

function parseHandicap(
  values: Array<{ value?: string; odd?: string | number; handicap?: string | number; main?: boolean | null }> = [],
  moneylineFav: 'HOME' | 'AWAY' | null
) {
  type SideQuote = { side: 'HOME' | 'AWAY'; handicap: number; odd: number; main: boolean };
  const quotes: SideQuote[] = [];

  for (const item of values) {
    const side = sideFromValue(item.value);
    const handicap = numberFrom(item.handicap ?? item.value);
    const odd = Number(item.odd);
    if (!side || handicap === null || !Number.isFinite(odd)) continue;
    quotes.push({ side, handicap, odd, main: item.main === true });
  }

  // Handicap must agree with an independently derived 1X2 favourite.
  // This prevents an alternate "Away -0.75" quote from being mistaken for
  // the main Asian line when Home is actually the market favourite.
  if (!moneylineFav) return null;

  let best: { favourite: 'HOME' | 'AWAY'; handicap: number; score: number } | null = null;

  for (const home of quotes.filter(q => q.side === 'HOME')) {
    for (const away of quotes.filter(q => q.side === 'AWAY')) {
      if (Math.abs(Math.abs(home.handicap) - Math.abs(away.handicap)) > 0.001) continue;

      const validDirection =
        moneylineFav === 'HOME'
          ? home.handicap < 0 && away.handicap > 0
          : away.handicap < 0 && home.handicap > 0;
      if (!validDirection) continue;

      const favQuote = moneylineFav === 'HOME' ? home : away;
      const dogQuote = moneylineFav === 'HOME' ? away : home;

      // Prefer an explicitly-main pair when provided. Otherwise choose the
      // most balanced two-sided price, which corresponds to the market line.
      const score =
        (home.main && away.main ? -10 : home.main || away.main ? -3 : 0) +
        Math.abs(home.odd - away.odd) * 2 +
        Math.abs(home.odd - 1.9) * 0.35 +
        Math.abs(away.odd - 1.9) * 0.35;

      if (!best || score < best.score) {
        best = { favourite: moneylineFav, handicap: favQuote.handicap, score };
      }
    }
  }

  return best;
}

function parseOdds(item: any, bookmakerId: number) {
  const bookmaker = (item?.bookmakers ?? []).find((b: any) => b?.id === bookmakerId && /^bet365$/i.test(String(b?.name ?? '').trim()));
  if (!bookmaker) return null;

  const bets = bookmaker.bets ?? [];
  const goalsBet = bets.find((b: any) => /goals over\/under/i.test(b?.name ?? '') && !/half|home|away/i.test(b?.name ?? ''));
  const cornersBet = bets.find((b: any) => /corner/i.test(b?.name ?? '') && /over|under|total/i.test(b?.name ?? '') && !/home|away|half|team/i.test(b?.name ?? ''));
  const handicapBet = bets.find((b: any) => /asian handicap/i.test(b?.name ?? '') && !/half/i.test(b?.name ?? ''));

  const goalLine = balancedLine(goalsBet?.values);
  const cornerLine = balancedLine(cornersBet?.values);
  if (goalLine === null || cornerLine === null) return null;

  const marketFavourite = moneylineFavourite(bets);
  const handicap = parseHandicap(handicapBet?.values, marketFavourite);
  return {
    goalLine,
    cornerLine,
    favourite: handicap?.favourite ?? ('HOME' as const),
    handicap: handicap?.handicap ?? 0,
    handicapVerified: Boolean(handicap),
    bookmakerId,
    bookmakerName: bookmaker.name,
    oddsParserVersion: 'AHv3',
  };
}

async function resolveBet365BookmakerId() {
  const cacheKey = 'bookmaker-bet365-id';
  const cached = readCache<number>(cacheKey);
  if (cached) return cached;

  const data = await apiGet<any>('/odds/bookmakers?search=Bet365');
  const exact = (data.response ?? []).find((b: any) => /^bet365$/i.test(String(b?.name ?? '').trim()));
  const id = Number(exact?.id);
  if (!Number.isFinite(id)) throw new Error('Bet365 bookmaker ID could not be resolved from API-Football');

  writeCache(cacheKey, id, 24 * 60 * 60 * 1000);
  return id;
}

async function fetchFixtureOdds(fixtureId: number) {
  const bookmakerId = await resolveBet365BookmakerId();
  const cacheKey = `odds-v3-fixture-${fixtureId}-bookmaker-${bookmakerId}`;
  const cached = readCache<ReturnType<typeof parseOdds>>(cacheKey);
  if (cached) return cached;

  const data = await apiGet<any>(`/odds?fixture=${fixtureId}&bookmaker=${bookmakerId}`);
  const parsed = (data.response ?? []).map((item: any) => parseOdds(item, bookmakerId)).find(Boolean) ?? null;

  // Pre-match odds are cached, but the bookmaker identity and handicap side are now verified.
  writeCache(cacheKey, parsed, 3 * 60 * 60 * 1000);
  return parsed;
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
    homeLogo: fixture.teams?.home?.logo ?? null,
    awayLogo: fixture.teams?.away?.logo ?? null,
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
    handicapVerified: odds.handicapVerified,
    favouriteCoveringHandicap: false,
    favouriteLosing,
    ftGoalOverClear: false,
    sourceSummary: `API-Football · ${odds.bookmakerName} #${odds.bookmakerId} · AHv3 verified · pre-match lines · fixture ${fixture.fixture?.id ?? ''}`,
    sourceUrls: [],
  };
}

export async function getApiFootballMatches(): Promise<TradingMatch[]> {
  const season = Number(process.env.API_FOOTBALL_SEASON ?? new Date().getFullYear());
  const now = Date.now();
  const horizonMs = Number(process.env.PREMATCH_SCAN_HOURS ?? 72) * 60 * 60 * 1000;
  const horizon = now + horizonMs;

  const upcomingByLeague = await Promise.all(
    (Object.entries(LEAGUES) as Array<[League, number]>).map(async ([league, leagueId]) => {
      const fixtures = await fetchLeagueFixtures(league, leagueId, season);

      const upcoming = fixtures.filter((fixture: any) => {
        const kickoff = new Date(fixture.fixture?.date ?? 0).getTime();
        return kickoff >= now && kickoff <= horizon;
      });

      const matches = await Promise.all(
        upcoming.map(async (fixture: any) => {
          const fixtureId = Number(fixture.fixture?.id);
          if (!Number.isFinite(fixtureId)) return null;

          const odds = await fetchFixtureOdds(fixtureId);
          if (!odds) return null;

          const match = fixtureToBase(league, fixture, odds);
          return { ...match, ...evaluateV1(match) };
        })
      );

      return matches.filter(Boolean) as TradingMatch[];
    })
  );

  return upcomingByLeague
    .flat()
    .sort((a, b) => new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime());
}
