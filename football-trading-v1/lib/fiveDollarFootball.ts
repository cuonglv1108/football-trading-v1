import { League, TradingMatch } from './types';
import { evaluateV1 } from './rules';

const BASE_URL = 'https://api.5dollarfootballapi.com/v1';

const LEAGUES: Array<{ league: League; ids: number[] }> = [
  { league: 'Eredivisie', ids: [137325260] },
  { league: 'Allsvenskan', ids: [112989244] },
  { league: 'Brazil Serie A', ids: [3118717965] },
  { league: 'Liga MX', ids: [2540173422] },
  { league: 'Swiss Super League', ids: [1810150156] },
  { league: 'Danish Superliga', ids: [357008264] },
  { league: 'Eliteserien', ids: [3962220103] },
  { league: 'MLS', ids: [2221499861, 751043315] },
];

const LEAGUE_BY_ID = new Map<number, League>(
  LEAGUES.flatMap(({ league, ids }) => ids.map(id => [id, league] as const))
);

type FiveDollarResponse<T> = {
  success?: number;
  data?: T;
  pagination?: {
    page?: number;
    per_page?: number;
    count?: number;
    has_more?: boolean;
  };
  error?: {
    code?: string;
    message?: string;
  };
};

type FiveDollarFixture = {
  id?: number;
  league?: { id?: number; name?: string };
  teams?: {
    home?: { id?: number; name?: string };
    away?: { id?: number; name?: string };
  };
  kickoff_utc?: string;
  kickoff_ts?: number;
  status?: string;
  goals?: { home?: number | null; away?: number | null };
  corners?: { home?: number | null; away?: number | null };
  odds?: {
    '1x2'?: {
      opening?: { home?: number; draw?: number; away?: number } | null;
      closing?: { home?: number; draw?: number; away?: number } | null;
      inplay?: { home?: number; draw?: number; away?: number } | null;
    } | null;
    asian_handicap?: {
      opening?: number | null;
      closing?: number | null;
      inplay?: number | null;
    } | null;
    goal_line?: {
      opening?: number | null;
      closing?: number | null;
      inplay?: number | null;
    } | null;
    corner_line?: {
      opening?: number | null;
      closing?: number | null;
      inplay?: number | null;
    } | null;
  };
};

type TwoWayTotalQuote = {
  line?: number | null;
  over?: number | null;
  under?: number | null;
};

type TwoWayHandicapQuote = {
  line?: number | null;
  home?: number | null;
  away?: number | null;
};

type Bet365FullOdds = {
  '1x2'?: {
    opening?: { home?: number | null; draw?: number | null; away?: number | null } | null;
    closing?: { home?: number | null; draw?: number | null; away?: number | null } | null;
    inplay?: { home?: number | null; draw?: number | null; away?: number | null } | null;
  } | null;
  asian_handicap?: {
    opening?: TwoWayHandicapQuote | null;
    closing?: TwoWayHandicapQuote | null;
    inplay?: TwoWayHandicapQuote | null;
  } | null;
  goal_line?: {
    opening?: TwoWayTotalQuote | null;
    closing?: TwoWayTotalQuote | null;
    inplay?: TwoWayTotalQuote | null;
  } | null;
  corner_line?: {
    opening?: TwoWayTotalQuote | null;
    closing?: TwoWayTotalQuote | null;
    inplay?: TwoWayTotalQuote | null;
  } | null;
};

type FullOddsResponse = {
  fixture_id?: number;
  bookmakers?: Array<{
    name?: string;
    slug?: string;
    odds?: Bet365FullOdds;
  }>;
};


const providerRequestTimes: number[] = [];

async function respectProviderRateLimit() {
  while (true) {
    const now = Date.now();
    while (providerRequestTimes.length && now - providerRequestTimes[0] >= 60000) {
      providerRequestTimes.shift();
    }
    if (providerRequestTimes.length < 9) {
      providerRequestTimes.push(now);
      return;
    }
    const waitMs = Math.max(250, 60250 - (now - providerRequestTimes[0]));
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

async function apiGet<T>(path: string): Promise<FiveDollarResponse<T>> {
  await respectProviderRateLimit();
  const key = process.env.FIVE_DOLLAR_FOOTBALL_API_KEY;
  if (!key) throw new Error('FIVE_DOLLAR_FOOTBALL_API_KEY is not configured');

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: 'no-store',
  });

  const data = await res.json() as FiveDollarResponse<T>;
  if (!res.ok || data.success === 0) {
    const code = data.error?.code ? ` ${data.error.code}` : '';
    const message = data.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`5DollarFootballAPI${code}: ${message}`);
  }
  return data;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function prematchLine(
  market: { opening?: number | null; closing?: number | null; inplay?: number | null } | null | undefined
): number | null {
  if (!market) return null;
  return finiteNumber(market.closing) ?? finiteNumber(market.opening);
}

function quote<T extends { line?: number | null }>(
  market: { opening?: T | null; closing?: T | null; inplay?: T | null } | null | undefined
): T | null {
  if (!market) return null;
  return market.closing ?? market.opening ?? null;
}

function preliminaryFavourite(fixture: FiveDollarFixture, asian: number | null): {
  favourite: 'HOME' | 'AWAY';
  handicap: number;
  handicapVerified: boolean;
} {
  if (asian !== null && asian < 0) return { favourite: 'HOME', handicap: asian, handicapVerified: true };
  if (asian !== null && asian > 0) return { favourite: 'AWAY', handicap: -Math.abs(asian), handicapVerified: true };

  const oneXtwo = fixture.odds?.['1x2']?.closing ?? fixture.odds?.['1x2']?.opening;
  const homeOdd = finiteNumber(oneXtwo?.home);
  const awayOdd = finiteNumber(oneXtwo?.away);
  const favourite: 'HOME' | 'AWAY' =
    homeOdd !== null && awayOdd !== null && awayOdd < homeOdd ? 'AWAY' : 'HOME';

  return { favourite, handicap: 0, handicapVerified: false };
}

async function fetchBet365FullOdds(fixtureId: number): Promise<Bet365FullOdds | null> {
  const response = await apiGet<FullOddsResponse>(`/fixtures/${fixtureId}/odds?bookmakers=bet365`);
  const rows = response.data?.bookmakers ?? [];
  const bet365 = rows.find(row =>
    String(row.slug ?? '').toLowerCase() === 'bet365' ||
    /bet\s*365/i.test(String(row.name ?? ''))
  );
  return bet365?.odds ?? null;
}

// Stake is a supplemental source only. Never replace verified Bet365 markets.
async function fetchStakeFtHandicap(fixtureId: number): Promise<{
  line: number; homeOdd: number; awayOdd: number; capturedAt: string;
} | null> {
  // An unsupported bookmaker or a missing market must not break the scan.
  try {
    const response = await apiGet<FullOddsResponse>(`/fixtures/${fixtureId}/odds?bookmakers=stake`);
    if (Number(response.data?.fixture_id) !== fixtureId) return null;
    const stake = (response.data?.bookmakers ?? []).find(row =>
      /^stake(?:\\.com)?$/i.test(String(row.slug ?? '').trim()) ||
      /^stake(?:\\.com)?$/i.test(String(row.name ?? '').trim())
    );
    if (!stake) return null;
    // Only a prematch closing/opening Asian handicap (never in-play).
    const ah = quote(stake.odds?.asian_handicap);
    const line = finiteNumber(ah?.line);
    const homeOdd = finiteNumber(ah?.home);
    const awayOdd = finiteNumber(ah?.away);
    if (line === null || line === 0 || Math.abs(line) > 5 ||
        !Number.isInteger(line * 4) ||
        homeOdd === null || awayOdd === null ||
        homeOdd < 1.75 || homeOdd > 2.05 ||
        awayOdd < 1.75 || awayOdd > 2.05) return null;
    return { line, homeOdd, awayOdd, capturedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

function enrichWithFullBet365Odds(match: TradingMatch, odds: Bet365FullOdds | null): TradingMatch | null {
  if (!odds) return null;

  const goal = quote(odds.goal_line);
  const corner = quote(odds.corner_line);
  const goalLine = finiteNumber(goal?.line);
  const cornerLine = finiteNumber(corner?.line);
  const goalOver = finiteNumber(goal?.over);
  const goalUnder = finiteNumber(goal?.under);
  const cornerOver = finiteNumber(corner?.over);
  const cornerUnder = finiteNumber(corner?.under);

  // A displayed qualified match must have the exact Bet365 line plus both-way prices.
  if ([goalLine, cornerLine, goalOver, goalUnder, cornerOver, cornerUnder].some(v => v === null)) {
    return null;
  }

  const ah = quote(odds.asian_handicap);
  const ahLine = finiteNumber(ah?.line);
  const homeAhOdd = finiteNumber(ah?.home);
  const awayAhOdd = finiteNumber(ah?.away);

  let favourite = match.favourite;
  let handicap = 0;
  let handicapVerified = false;

  // 5Dollar's Bet365 full odds are a true two-way spread: a negative line means
  // HOME gives the handicap; a positive line means AWAY gives it.
  // Keep the AH only when both side prices are present and sit in a realistic
  // main-market band (decimal 1.75-2.05 = HK 0.75-1.05).
  if (
    ahLine !== null &&
    ahLine !== 0 &&
    homeAhOdd !== null &&
    awayAhOdd !== null &&
    homeAhOdd >= 1.75 && homeAhOdd <= 2.05 &&
    awayAhOdd >= 1.75 && awayAhOdd <= 2.05
  ) {
    favourite = ahLine < 0 ? 'HOME' : 'AWAY';
    handicap = -Math.abs(ahLine);
    handicapVerified = true;
  }

  const enriched: TradingMatch = {
    ...match,
    prematchGoalLine: goalLine!,
    prematchCornerLine: cornerLine!,
    prematchGoalOverOdd: goalOver,
    prematchGoalUnderOdd: goalUnder,
    prematchCornerOverOdd: cornerOver,
    prematchCornerUnderOdd: cornerUnder,
    favourite,
    handicap,
    handicapVerified,
    handicapHomeOdd: homeAhOdd,
    handicapAwayOdd: awayAhOdd,
    sourceSummary:
      `5DollarFootballAPI · Bet365 FULL 2-way prices · ${handicapVerified ? 'AH verified' : 'AH unverified'} · fixture ${match.id}`,
  };

  return { ...enriched, ...evaluateV1(enriched) };
}

function fixtureToPreliminaryMatch(league: League, fixture: FiveDollarFixture): TradingMatch | null {
  const goalLine = prematchLine(fixture.odds?.goal_line);
  const cornerLine = prematchLine(fixture.odds?.corner_line);
  if (goalLine === null || cornerLine === null) return null;

  const asian = prematchLine(fixture.odds?.asian_handicap);
  const prelim = preliminaryFavourite(fixture, asian);

  const match: TradingMatch = {
    id: String(fixture.id ?? ''),
    league,
    home: fixture.teams?.home?.name ?? 'Home',
    away: fixture.teams?.away?.name ?? 'Away',
    homeLogo: null,
    awayLogo: null,
    minute: null,
    status: 'PRE',
    kickoff: fixture.kickoff_utc ?? null,
    scoreHome: 0,
    scoreAway: 0,
    cornersHome: 0,
    cornersAway: 0,
    prematchCornerLine: cornerLine,
    prematchGoalLine: goalLine,
    prematchCornerOverOdd: null,
    prematchCornerUnderOdd: null,
    prematchGoalOverOdd: null,
    prematchGoalUnderOdd: null,
    favourite: prelim.favourite,
    handicap: prelim.handicap,
    handicapVerified: false,
    handicapHomeOdd: null,
    handicapAwayOdd: null,
    favouriteCoveringHandicap: false,
    favouriteLosing: false,
    ftGoalOverClear: false,
    sourceSummary: `5DollarFootballAPI · Bet365 short-form qualification lines · fixture ${fixture.id ?? ''}`,
    sourceUrls: [],
  };

  return { ...match, ...evaluateV1(match) };
}

async function fetchTargetWindow(start: number, end: number) {
  const rows: FiveDollarFixture[] = [];
  let page = 1;

  while (true) {
    const path =
      `/fixtures?start_time=${start}&end_time=${end}` +
      `&status=scheduled&include=odds&page=${page}&per_page=50`;
    const response = await apiGet<FiveDollarFixture[]>(path);
    const batch = Array.isArray(response.data) ? response.data : [];
    rows.push(...batch);

    if (!response.pagination?.has_more || batch.length === 0) break;
    page += 1;
  }

  return rows.filter(fixture => LEAGUE_BY_ID.has(Number(fixture.league?.id)));
}

export type FiveDollarScanAudit = {
  fixtureId: string;
  league: League;
  home: string;
  away: string;
  kickoff: string | null;
  marketStatus: 'VERIFIED' | 'MISSING_GOAL_OR_CORNER';
};

export type FiveDollarScanResult = {
  matches: TradingMatch[];
  fixturesFound: number;
  fixturesWithCompleteMarkets: number;
  missingMarketCount: number;
  audit: FiveDollarScanAudit[];
};

export async function getFiveDollarScan(): Promise<FiveDollarScanResult> {
  const now = Math.floor(Date.now() / 1000);
  const horizonHours = Math.min(24, Math.max(1, Number(process.env.PREMATCH_SCAN_HOURS ?? 24)));
  const end = now + horizonHours * 60 * 60;

  const fixtures = await fetchTargetWindow(now, end);
  const unique = Array.from(
    new Map(fixtures.map(fixture => [String(fixture.id ?? ''), fixture])).values()
  ).filter(fixture => fixture.id != null);

  const prelimRows = unique.map(fixture => {
    const league = LEAGUE_BY_ID.get(Number(fixture.league?.id));
    if (!league) return { fixture, league: null as League | null, match: null as TradingMatch | null };
    return { fixture, league, match: fixtureToPreliminaryMatch(league, fixture) };
  });

  // Full Bet365 price calls are only made for fixtures that pass the V1 line gate.
  // This keeps the scan accurate without spending a full-odds request on every fixture.
  const matches: TradingMatch[] = [];
  const fullOddsMissing = new Set<string>();
  for (const row of prelimRows) {
    if (!row.match || row.match.state !== 'QUALIFIED') continue;
    const fixtureId = Number(row.fixture.id);
    const fullOdds = await fetchBet365FullOdds(fixtureId);
    let enriched = enrichWithFullBet365Odds(row.match, fullOdds);
    // Ask Stake only when Bet365 supplies both qualifying markets but FT AH is missing.
    // Do not silently mix prices from distinct bookmakers for goal/corner qualification.
    if (enriched && !enriched.handicapVerified && enriched.status === 'PRE' &&
        enriched.kickoff && new Date(enriched.kickoff).getTime() > Date.now()) {
      const stake = await fetchStakeFtHandicap(fixtureId);
      if (stake) {
        const favourite = stake.line < 0 ? 'HOME' : 'AWAY';
        const supplemented: TradingMatch = {
          ...enriched,
          favourite,
          handicap: -Math.abs(stake.line),
          handicapVerified: true,
          handicapHomeOdd: stake.homeOdd,
          handicapAwayOdd: stake.awayOdd,
          sourceSummary: `${enriched.sourceSummary} · FT AH: Stake (supplement; not Bet365) · snapshot ${stake.capturedAt}`,
        };
        enriched = { ...supplemented, ...evaluateV1(supplemented) };
      }
    }
    if (!enriched) {
      fullOddsMissing.add(String(row.fixture.id));
      continue;
    }
    if (enriched.state === 'QUALIFIED') matches.push(enriched);
  }

  matches.sort(
    (a, b) => new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime()
  );

  const audit: FiveDollarScanAudit[] = prelimRows.map(row => ({
    fixtureId: String(row.fixture.id ?? ''),
    league: row.league ?? 'MLS',
    home: row.fixture.teams?.home?.name ?? 'Home',
    away: row.fixture.teams?.away?.name ?? 'Away',
    kickoff: row.fixture.kickoff_utc ?? null,
    marketStatus:
      row.match == null
        ? 'MISSING_GOAL_OR_CORNER'
        : fullOddsMissing.has(String(row.fixture.id))
          ? 'MISSING_GOAL_OR_CORNER'
          : 'VERIFIED',
  }));

  const fixturesWithCompleteMarkets = audit.filter(a => a.marketStatus === 'VERIFIED').length;

  return {
    matches,
    fixturesFound: unique.length,
    fixturesWithCompleteMarkets,
    missingMarketCount: Math.max(0, unique.length - fixturesWithCompleteMarkets),
    audit,
  };
}
