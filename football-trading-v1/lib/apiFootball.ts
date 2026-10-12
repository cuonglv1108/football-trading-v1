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

function balancedLine(values: Array<{ value?: string; odd?: string; handicap?: string; main?: boolean | null }> = []): number | null {
  const byLine = new Map<number, { over?: number; under?: number; mainOver?: boolean; mainUnder?: boolean }>();

  for (const item of values) {
    const text = String(item.value ?? '');
    const line = numberFrom(item.handicap ?? text);
    const odd = Number(item.odd);
    if (line === null || !Number.isFinite(odd)) continue;

    const key = Math.abs(line);
    const slot = byLine.get(key) ?? {};
    if (/over/i.test(text)) {
      slot.over = odd;
      if (item.main === true) slot.mainOver = true;
    }
    if (/under/i.test(text)) {
      slot.under = odd;
      if (item.main === true) slot.mainUnder = true;
    }
    byLine.set(key, slot);
  }

  // If the provider explicitly marks a main total, use it.
  for (const [line, pair] of byLine) {
    if (pair.over != null && pair.under != null && pair.mainOver && pair.mainUnder) return line;
  }

  // Pre-match totals do not always carry a main flag. For goals/corners only,
  // choose the balanced Over/Under line. These are V1 qualification markets.
  let best: { line: number; score: number } | null = null;
  for (const [line, pair] of byLine) {
    if (pair.over == null || pair.under == null) continue;
    const score = Math.abs(pair.over - pair.under) +
      Math.abs(pair.over - 1.9) * 0.25 +
      Math.abs(pair.under - 1.9) * 0.25;
    if (!best || score < best.score) best = { line, score };
  }
  return best?.line ?? null;
}

function moneylineFavourite(bets: any[]): 'HOME' | 'AWAY' | null {
  for (const bet of bets) {
    const name = String(bet?.name ?? '').trim();
    if (!/^(match winner|fulltime result|1x2)$/i.test(name)) continue;
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
): { favourite: 'HOME' | 'AWAY'; handicap: number } | null {
  type Quote = { side: 'HOME' | 'AWAY'; handicap: number; odd: number | null; main: boolean };
  const quotes: Quote[] = [];

  for (const item of values) {
    const side = sideFromValue(item.value);
    const handicap = numberFrom(item.handicap ?? item.value);
    const odd = Number(item.odd);
    if (!side || handicap === null) continue;
    quotes.push({
      side,
      handicap,
      odd: Number.isFinite(odd) ? odd : null,
      main: item.main === true,
    });
  }

  // API-Football pre-match odds can expose several alternative Asian lines and
  // does not reliably identify the sportsbook's displayed main line.
  // Only accept a handicap when BOTH sides are explicitly marked main.
  const home = quotes.find(q => q.side === 'HOME' && q.main);
  const away = quotes.find(q => q.side === 'AWAY' && q.main);
  if (!home || !away) return null;
  if (Math.abs(Math.abs(home.handicap) - Math.abs(away.handicap)) > 0.001) return null;

  const favourite =
    home.handicap < 0 && away.handicap > 0 ? 'HOME'
    : away.handicap < 0 && home.handicap > 0 ? 'AWAY'
    : null;
  if (!favourite) return null;
  if (moneylineFav && moneylineFav !== favourite) return null;

  return {
    favourite,
    handicap: favourite === 'HOME' ? home.handicap : away.handicap,
  };
}

function parseBookmakerOdds(bookmaker: any) {
  if (!bookmaker || !Array.isArray(bookmaker.bets)) return null;

  const bets = bookmaker.bets;
  // V1 uses the Asian FT goal line (quarter lines such as 2.75 / 3.25), not
  // the simple Goals Over/Under market that only exposes .5 lines.
  const asianGoalBet = bets.find((b: any) => /^goal line$/i.test(String(b?.name ?? '').trim()));
  const goalsBet = asianGoalBet ?? bets.find((b: any) => /goals over\/under/i.test(b?.name ?? '') && !/half|home|away/i.test(b?.name ?? ''));
  const cornersBet = bets.find((b: any) => /corner/i.test(b?.name ?? '') && /over|under|total/i.test(b?.name ?? '') && !/home|away|half|team/i.test(b?.name ?? ''));
  const handicapBet = bets.find((b: any) => /asian handicap/i.test(b?.name ?? '') && !/half/i.test(b?.name ?? ''));

  const goalLine = balancedLine(goalsBet?.values);
  const cornerLine = balancedLine(cornersBet?.values);
  if (goalLine === null || cornerLine === null) return null;

  const marketFavourite = moneylineFavourite(bets);
  const handicap = parseHandicap(handicapBet?.values, marketFavourite);
  const favourite: 'HOME' | 'AWAY' = handicap?.favourite ?? 'HOME';

  return {
    goalLine,
    cornerLine,
    favourite,
    handicap: handicap?.handicap ?? 0,
    handicapVerified: Boolean(handicap),
    bookmakerId: Number(bookmaker.id),
    bookmakerName: String(bookmaker.name ?? 'Unknown bookmaker'),
    oddsParserVersion: 'SAFEv8',
  };
}

function parsePreferredBookmaker(item: any, bookmakerId: number) {
  const bookmaker = (item?.bookmakers ?? []).find(
    (b: any) => b?.id === bookmakerId && /^bet365$/i.test(String(b?.name ?? '').trim())
  );
  return parseBookmakerOdds(bookmaker);
}

function fallbackBookmakerRank(name: string) {
  const n = name.toLowerCase();
  const preferred = [
    'pinnacle',
    'betano',
    'unibet',
    'william hill',
    'betfair',
    'bwin',
    'betway',
    '1xbet',
  ];
  const idx = preferred.findIndex(x => n.includes(x));
  return idx === -1 ? 999 : idx;
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
  const cacheKey = `odds-v8-fixture-${fixtureId}`;
  const cached = readCache<any>(cacheKey);
  if (cached !== null) return cached;

  // 1) Prefer Bet365 when it exposes BOTH FT goals and FT total-corners markets.
  const bet365Data = await apiGet<any>(`/odds?fixture=${fixtureId}&bookmaker=${bookmakerId}`);
  const bet365Parsed = (bet365Data.response ?? [])
    .map((item: any) => parsePreferredBookmaker(item, bookmakerId))
    .find(Boolean);

  if (bet365Parsed) {
    const result = { ...bet365Parsed, sourceTier: 'BET365' as const };
    writeCache(cacheKey, result, 3 * 60 * 60 * 1000);
    return result;
  }

  // 2) API-Football explicitly notes that odds availability varies by fixture/bookmaker.
  // If Bet365 is missing one V1 market, inspect other bookmakers instead of silently
  // dropping the fixture. Goals + corners must come from the SAME bookmaker.
  const candidates: any[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const data = await apiGet<any>(`/odds?fixture=${fixtureId}&page=${page}`);
    totalPages = Math.max(1, Number(data.paging?.total ?? 1));

    for (const item of data.response ?? []) {
      for (const bookmaker of item?.bookmakers ?? []) {
        const parsed = parseBookmakerOdds(bookmaker);
        if (parsed) candidates.push(parsed);
      }
    }

    page += 1;
  } while (page <= totalPages && page <= 4);

  candidates.sort((a, b) => {
    const rankDiff = fallbackBookmakerRank(a.bookmakerName) - fallbackBookmakerRank(b.bookmakerName);
    if (rankDiff !== 0) return rankDiff;
    return a.bookmakerName.localeCompare(b.bookmakerName);
  });

  const fallback = candidates[0] ?? null;
  const result = fallback ? { ...fallback, sourceTier: 'FALLBACK' as const } : null;
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

function fixtureToBase(
  league: League,
  fixture: any,
  odds: NonNullable<ReturnType<typeof parseBookmakerOdds>> & { sourceTier?: 'BET365' | 'FALLBACK' }
): TradingMatch {
  const corners = cornerCount(fixture.statistics);
  const status = statusOf(fixture.fixture?.status?.short ?? 'NS');
  const scoreHome = Number(fixture.goals?.home ?? 0);
  const scoreAway = Number(fixture.goals?.away ?? 0);

  const favouriteLosing = odds.handicapVerified
    ? (odds.favourite === 'HOME' ? scoreHome < scoreAway : scoreAway < scoreHome)
    : false;

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
    sourceSummary: `API-Football · ${odds.bookmakerName} #${odds.bookmakerId} · ${odds.sourceTier === 'BET365' ? 'Bet365 preferred' : 'fallback bookmaker'} · ${odds.handicapVerified ? 'SAFEv8 AH verified' : 'SAFEv8 AH unverified'} · pre-match lines · fixture ${fixture.fixture?.id ?? ''}`,
    sourceUrls: [],
  };
}

export type ApiFootballMarketAudit = {
  fixtureId: string;
  league: League;
  home: string;
  away: string;
  kickoff: string | null;
  marketStatus: 'VERIFIED' | 'MISSING_COMPLETE_MARKETS';
  bookmaker?: string;
};

export type ApiFootballScanResult = {
  matches: TradingMatch[];
  fixturesFound: number;
  fixturesWithCompleteMarkets: number;
  missingMarketCount: number;
  audit: ApiFootballMarketAudit[];
};

export async function getApiFootballScan(): Promise<ApiFootballScanResult> {
  const season = Number(process.env.API_FOOTBALL_SEASON ?? new Date().getFullYear());
  const now = Date.now();
  const horizonMs = Number(process.env.PREMATCH_SCAN_HOURS ?? 72) * 60 * 60 * 1000;
  const horizon = now + horizonMs;

  const leagueResults = await Promise.all(
    (Object.entries(LEAGUES) as Array<[League, number]>).map(async ([league, leagueId]) => {
      const fixtures = await fetchLeagueFixtures(league, leagueId, season);

      const upcoming = fixtures.filter((fixture: any) => {
        const kickoff = new Date(fixture.fixture?.date ?? 0).getTime();
        return kickoff >= now && kickoff <= horizon;
      });

      const rows = await Promise.all(
        upcoming.map(async (fixture: any) => {
          const fixtureId = Number(fixture.fixture?.id);
          const auditBase = {
            fixtureId: String(fixture.fixture?.id ?? ''),
            league,
            home: fixture.teams?.home?.name ?? 'Home',
            away: fixture.teams?.away?.name ?? 'Away',
            kickoff: fixture.fixture?.date ?? null,
          };

          if (!Number.isFinite(fixtureId)) {
            return {
              match: null,
              audit: { ...auditBase, marketStatus: 'MISSING_COMPLETE_MARKETS' as const },
            };
          }

          const odds = await fetchFixtureOdds(fixtureId);
          if (!odds) {
            return {
              match: null,
              audit: { ...auditBase, marketStatus: 'MISSING_COMPLETE_MARKETS' as const },
            };
          }

          const match = fixtureToBase(league, fixture, odds);
          return {
            match: { ...match, ...evaluateV1(match) } as TradingMatch,
            audit: {
              ...auditBase,
              marketStatus: 'VERIFIED' as const,
              bookmaker: odds.bookmakerName,
            },
          };
        })
      );

      return { fixtureCount: upcoming.length, rows };
    })
  );

  const allRows = leagueResults.flatMap(r => r.rows);
  const matches = allRows
    .map(r => r.match)
    .filter(Boolean) as TradingMatch[];

  matches.sort((a, b) => new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime());

  const audit = allRows.map(r => r.audit);
  const fixturesFound = leagueResults.reduce((sum, r) => sum + r.fixtureCount, 0);
  const fixturesWithCompleteMarkets = audit.filter(a => a.marketStatus === 'VERIFIED').length;

  return {
    matches,
    fixturesFound,
    fixturesWithCompleteMarkets,
    missingMarketCount: Math.max(0, fixturesFound - fixturesWithCompleteMarkets),
    audit,
  };
}

export async function getApiFootballMatches(): Promise<TradingMatch[]> {
  return (await getApiFootballScan()).matches;
}
