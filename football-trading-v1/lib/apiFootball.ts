import { League, TradingMatch } from './types';
import { evaluateV1 } from './rules';
import { isFtAhPriorityLeague } from './ftAhPriority';

const BASE_URL = 'https://v3.football.api-sports.io';

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

function balancedQuote(values: Array<{ value?: string; odd?: string; handicap?: string; main?: boolean | null }> = []) {
  const byLine = new Map<number, {
    over?: number;
    under?: number;
    mainOver?: boolean;
    mainUnder?: boolean;
  }>();

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

  let best: { line: number; over: number; under: number; score: number } | null = null;
  for (const [line, pair] of byLine) {
    if (pair.over == null || pair.under == null) continue;
    const bothMain = pair.mainOver && pair.mainUnder;
    const score =
      (bothMain ? -5 : 0) +
      Math.abs(pair.over - pair.under) +
      Math.abs(pair.over - 1.9) * 0.25 +
      Math.abs(pair.under - 1.9) * 0.25;
    if (!best || score < best.score) {
      best = { line, over: pair.over, under: pair.under, score };
    }
  }
  return best ? { line: best.line, over: best.over, under: best.under } : null;
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
): {
  favourite: 'HOME' | 'AWAY';
  handicap: number;
  homeOdd: number;
  awayOdd: number;
} | null {
  type Quote = { side: 'HOME' | 'AWAY'; handicap: number; odd: number; main: boolean };
  const quotes: Quote[] = [];

  for (const item of values) {
    const side = sideFromValue(item.value);
    const handicap = numberFrom(item.handicap ?? item.value);
    const odd = item.odd == null || item.odd === '' ? NaN : Number(item.odd);
    if (!side || handicap === null || !Number.isFinite(odd) || odd <= 1) continue;
    if (!Number.isInteger(handicap * 4) || Math.abs(handicap) > 5) continue;
    quotes.push({ side, handicap, odd, main: item.main === true });
  }

  const pairs: Array<{
    home: Quote;
    away: Quote;
    favourite: 'HOME' | 'AWAY';
    score: number;
  }> = [];

  for (const home of quotes.filter(q => q.side === 'HOME')) {
    for (const away of quotes.filter(q => q.side === 'AWAY')) {
      if (Math.abs(home.handicap + away.handicap) > 0.001) continue;
      // A true 0/0 Asian handicap is a valid draw-no-bet line.

      const favourite: 'HOME' | 'AWAY' = home.handicap === 0 ? (moneylineFav ?? 'HOME') :
        home.handicap < 0 ? 'HOME' : 'AWAY';
      // Moneyline favourite is supporting context, not proof of spread direction.
      // AH can legitimately disagree with a close 1X2 market; use actual paired lines.

      // Prefer true two-way main spreads with prices close to the user's normal
      // Asian range: decimal 1.80-2.00 (HK 0.80-1.00). Allow a small safety band.
      const inBand =
        home.odd >= 1.75 && home.odd <= 2.05 &&
        away.odd >= 1.75 && away.odd <= 2.05;
      const bothMain = home.main && away.main;
      // Explicit main-market markers are stronger than an arbitrary odds band.
      // Otherwise the odds band remains a conservative heuristic.
      // The main AH market often has no main flag; do not discard its sole valid pair.
      if (!bothMain && !inBand && quotes.length > 2) continue;
      const score =
        (bothMain ? -5 : 0) +
        (moneylineFav && moneylineFav !== favourite ? 0.5 : 0) +
        Math.abs(home.odd - away.odd) +
        Math.abs(home.odd - 1.9) +
        Math.abs(away.odd - 1.9);

      pairs.push({ home, away, favourite, score });
    }
  }

  pairs.sort((a, b) => a.score - b.score);
  const best = pairs[0];
  if (!best) return null;

  return {
    favourite: best.favourite,
    handicap: best.favourite === 'HOME' ? best.home.handicap : best.away.handicap,
    homeOdd: best.home.odd,
    awayOdd: best.away.odd,
  };
}

function parseBookmakerHandicapOnly(bookmaker: any) {
  if (!Array.isArray(bookmaker?.bets)) return null;
  const bets = bookmaker.bets;
  const favourite = moneylineFavourite(bets);
  return bets.filter((bet: any) =>
    /asian handicap/i.test(String(bet?.name ?? '')) &&
    !/half|1st|2nd|alternative|extra time|corners|cards/i.test(String(bet?.name ?? ''))
  ).map((bet: any) => parseHandicap(bet?.values, favourite)).find(Boolean) ?? null;
}

function parseBookmakerOdds(bookmaker: any) {
  if (!bookmaker || !Array.isArray(bookmaker.bets)) return null;

  const bets = bookmaker.bets;
  // V1 uses the Asian FT goal line (quarter lines such as 2.75 / 3.25), not
  // the simple Goals Over/Under market that only exposes .5 lines.
  const goalMarkets = bets.filter((b: any) =>
    (/^goal line$/i.test(String(b?.name ?? '').trim()) ||
     /goals over\/under/i.test(String(b?.name ?? ''))) &&
    !/half|home|away|team|1st|2nd/i.test(String(b?.name ?? '')));
  const cornerMarkets = bets.filter((b: any) =>
    /corner/i.test(String(b?.name ?? '')) &&
    /over|under|total/i.test(String(b?.name ?? '')) &&
    !/home|away|half|team|1st|2nd/i.test(String(b?.name ?? '')));
  const handicapMarkets = bets.filter((b: any) =>
    /asian handicap/i.test(String(b?.name ?? '')) &&
    !/half|1st|2nd|alternative/i.test(String(b?.name ?? '')));

  // Markets can be listed with no outcomes: try the next matching FT market.
  const goal = goalMarkets.map((b: any) => balancedQuote(b?.values)).find(Boolean) ?? null;
  const corner = cornerMarkets.map((b: any) => balancedQuote(b?.values)).find(Boolean) ?? null;
  if (!goal || !corner) return null;

  const marketFavourite = moneylineFavourite(bets);
  const handicap = parseBookmakerHandicapOnly(bookmaker);
  const favourite: 'HOME' | 'AWAY' = handicap?.favourite ?? 'HOME';

  return {
    goalLine: goal.line,
    cornerLine: corner.line,
    goalOverOdd: goal.over,
    goalUnderOdd: goal.under,
    cornerOverOdd: corner.over,
    cornerUnderOdd: corner.under,
    favourite,
    handicap: handicap?.handicap ?? 0,
    handicapVerified: Boolean(handicap),
    handicapBookmakerName: handicap ? String(bookmaker.name ?? 'Unknown bookmaker') : null,
    handicapHomeOdd: handicap?.homeOdd ?? null,
    handicapAwayOdd: handicap?.awayOdd ?? null,
    bookmakerId: Number(bookmaker.id),
    bookmakerName: String(bookmaker.name ?? 'Unknown bookmaker'),
    oddsParserVersion: 'SAFEv10',
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

async function fetchFixtureOdds(fixtureId: number, ahBudget: { remaining: number }, priorityAh: boolean) {
  const bookmakerId = await resolveBet365BookmakerId();
  const cacheKey = `odds-v10-fixture-${fixtureId}`;
  const cached = readCache<any>(cacheKey);
  if (cached !== null) return cached;

  // 1) Prefer Bet365 when it exposes BOTH FT goals and FT total-corners markets.
  const bet365Data = await apiGet<any>(`/odds?fixture=${fixtureId}&bookmaker=${bookmakerId}`);
  const bet365Parsed = (bet365Data.response ?? [])
    .map((item: any) => parsePreferredBookmaker(item, bookmakerId))
    .find(Boolean);

  // Keep Bet365 goals + corners intact, but don't stop looking just because
  // those two markets are complete while the FT Asian Handicap is absent.
  if (bet365Parsed && (bet365Parsed.handicapVerified || !priorityAh)) {
    const result = { ...bet365Parsed, sourceTier: 'BET365' as const };
    writeCache(cacheKey, result, 3 * 60 * 60 * 1000);
    return result;
  }

  const completeCandidates: any[] = [];
  const handicapCandidates: Array<{ bookmakerName: string; id: number; quote: NonNullable<ReturnType<typeof parseBookmakerHandicapOnly>> }> = [];
  let page = 1;
  let totalPages = 1;
  // When Bet365 has goals+corners, only spend up to two additional pages
  // searching for missing AH; do not exhaust API quota for this enhancement.
  const pageCap = bet365Parsed ? 2 : 4;
  do {
    // Extra AH-only searches have a shared per-scan limit; normal fallback
    // when goals/corners are absent retains its existing provider behaviour.
    if (bet365Parsed) {
      if (ahBudget.remaining <= 0) break;
      ahBudget.remaining--;
    }
    let data: ApiResponse<any>;
    try {
      data = await apiGet<any>(`/odds?fixture=${fixtureId}&page=${page}`);
    } catch (error) {
      if (!bet365Parsed) throw error;
      break; // recover the already valid Bet365 totals without AH
    }
    totalPages = Math.max(1, Number(data.paging?.total ?? 1));

    for (const item of data.response ?? []) {
      for (const bookmaker of item?.bookmakers ?? []) {
        const handicap = parseBookmakerHandicapOnly(bookmaker);
        if (handicap) handicapCandidates.push({
          bookmakerName: String(bookmaker.name ?? 'Unknown bookmaker'),
          id: Number(bookmaker.id),
          quote: handicap,
        });
        if (!bet365Parsed) {
          const parsed = parseBookmakerOdds(bookmaker);
          if (parsed) completeCandidates.push(parsed);
        }
      }
    }
    page++;
  } while (page <= totalPages && page <= pageCap);

  const ahRank = (name: string) => {
    const n = name.toLowerCase();
    if (/^bet365$/.test(n)) return 0;
    if (n === 'stake' || n === 'stake.com') return 1;
    return fallbackBookmakerRank(name) + 2;
  };
  handicapCandidates.sort((a, b) =>
    ahRank(a.bookmakerName) - ahRank(b.bookmakerName) ||
    a.bookmakerName.localeCompare(b.bookmakerName));
  const bestAh = handicapCandidates[0];

  completeCandidates.sort((a, b) =>
    fallbackBookmakerRank(a.bookmakerName) - fallbackBookmakerRank(b.bookmakerName) ||
    a.bookmakerName.localeCompare(b.bookmakerName));
  const base = bet365Parsed ?? completeCandidates[0] ?? null;
  if (!base) {
    writeCache(cacheKey, null, 10 * 60 * 1000);
    return null;
  }
  const supplement = !base.handicapVerified && bestAh ? {
    favourite: bestAh.quote.favourite,
    handicap: bestAh.quote.handicap,
    handicapVerified: true,
    handicapHomeOdd: bestAh.quote.homeOdd,
    handicapAwayOdd: bestAh.quote.awayOdd,
    handicapBookmakerName: bestAh.bookmakerName,
  } : {};
  const result = {
    ...base, ...supplement,
    sourceTier: bet365Parsed ? 'BET365' as const : 'FALLBACK' as const,
  };
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
    prematchCornerOverOdd: odds.cornerOverOdd,
    prematchCornerUnderOdd: odds.cornerUnderOdd,
    prematchGoalOverOdd: odds.goalOverOdd,
    prematchGoalUnderOdd: odds.goalUnderOdd,
    favourite: odds.favourite,
    handicap: odds.handicap,
    handicapVerified: odds.handicapVerified,
    prematchHandicapLine: odds.handicapVerified ? (odds.favourite === 'HOME' ? odds.handicap : -odds.handicap) : null,
    handicapLineVerified: odds.handicapVerified,
    handicapLineSource: odds.handicapVerified ? `API-Football · ${odds.handicapBookmakerName ?? odds.bookmakerName} · FT Asian Handicap two-way` : null,
    handicapHomeOdd: odds.handicapHomeOdd,
    handicapAwayOdd: odds.handicapAwayOdd,
    favouriteCoveringHandicap: false,
    favouriteLosing,
    ftGoalOverClear: false,
    sourceSummary: `API-Football · ${odds.bookmakerName} #${odds.bookmakerId} · ${odds.sourceTier === 'BET365' ? 'Bet365 preferred' : 'fallback bookmaker'} · ${odds.handicapVerified ? 'SAFEv10 AH verified' : 'SAFEv10 AH unverified'} · FT AH bookmaker ${odds.handicapBookmakerName ?? 'missing'} · pre-match lines · fixture ${fixture.fixture?.id ?? ''}`,
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
  const horizonMs = Math.min(24, Math.max(1, Number(process.env.PREMATCH_SCAN_HOURS ?? 24))) * 60 * 60 * 1000;
  const horizon = now + horizonMs;
  const ahBudget = {
    remaining: Math.min(12, Math.max(0, Number(process.env.API_FOOTBALL_EXTRA_AH_CALLS_PER_SCAN ?? 12))),
  };

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

          const odds = await fetchFixtureOdds(fixtureId, ahBudget, isFtAhPriorityLeague(league));
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
