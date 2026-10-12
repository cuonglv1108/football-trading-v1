import { League, TradingMatch } from './types';
import { evaluateV1 } from './rules';

const BASE_URL = 'https://api.5dollarfootballapi.com/v1';

const LEAGUES: Array<{ league: League; ids: number[] }> = [
  { league: 'MLS', ids: [2221499861, 751043315] },
  { league: 'Allsvenskan', ids: [112989244] },
  { league: 'Liga MX', ids: [2540173422] },
  { league: 'Brazil Serie A', ids: [3118717965] },
];

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

async function apiGet<T>(path: string): Promise<FiveDollarResponse<T>> {
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

function favouriteFromFixture(fixture: FiveDollarFixture, asian: number | null): {
  favourite: 'HOME' | 'AWAY';
  handicap: number;
  handicapVerified: boolean;
} {
  if (asian !== null && asian < 0) {
    return { favourite: 'HOME', handicap: asian, handicapVerified: true };
  }
  if (asian !== null && asian > 0) {
    return { favourite: 'AWAY', handicap: -Math.abs(asian), handicapVerified: true };
  }

  const oneXtwo = fixture.odds?.['1x2']?.closing ?? fixture.odds?.['1x2']?.opening;
  const homeOdd = finiteNumber(oneXtwo?.home);
  const awayOdd = finiteNumber(oneXtwo?.away);
  const favourite: 'HOME' | 'AWAY' =
    homeOdd !== null && awayOdd !== null && awayOdd < homeOdd ? 'AWAY' : 'HOME';

  return { favourite, handicap: 0, handicapVerified: false };
}

function fixtureToMatch(league: League, fixture: FiveDollarFixture): TradingMatch | null {
  const goalLine = prematchLine(fixture.odds?.goal_line);
  const cornerLine = prematchLine(fixture.odds?.corner_line);
  if (goalLine === null || cornerLine === null) return null;

  const asian = prematchLine(fixture.odds?.asian_handicap);
  const handicap = favouriteFromFixture(fixture, asian);

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
    favourite: handicap.favourite,
    handicap: handicap.handicap,
    handicapVerified: handicap.handicapVerified,
    favouriteCoveringHandicap: false,
    favouriteLosing: false,
    ftGoalOverClear: false,
    sourceSummary:
      `5DollarFootballAPI · Bet365 · short-form lines · ${handicap.handicapVerified ? 'AH verified' : 'AH unavailable/pick'} · fixture ${fixture.id ?? ''}`,
    sourceUrls: [],
  };

  return { ...match, ...evaluateV1(match) };
}

async function fetchLeagueWindow(league: League, leagueId: number, start: number, end: number) {
  const path =
    `/leagues/${leagueId}/fixtures?start_time=${start}&end_time=${end}` +
    '&status=scheduled&include=odds&order=asc&page=1&per_page=50';

  const response = await apiGet<FiveDollarFixture[]>(path);
  const fixtures = Array.isArray(response.data) ? response.data : [];

  return fixtures.map(fixture => ({
    league,
    fixture,
    match: fixtureToMatch(league, fixture),
  }));
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
  const horizonHours = Number(process.env.PREMATCH_SCAN_HOURS ?? 72);
  const end = now + horizonHours * 60 * 60;

  const requests = LEAGUES.flatMap(({ league, ids }) =>
    ids.map(id => fetchLeagueWindow(league, id, now, end))
  );

  const groups = await Promise.all(requests);
  const rows = groups.flat();

  const deduped = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const id = String(row.fixture.id ?? '');
    if (id && !deduped.has(id)) deduped.set(id, row);
  }

  const unique = Array.from(deduped.values());
  const matches = unique
    .map(row => row.match)
    .filter(Boolean) as TradingMatch[];

  matches.sort(
    (a, b) => new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime()
  );

  const audit: FiveDollarScanAudit[] = unique.map(row => ({
    fixtureId: String(row.fixture.id ?? ''),
    league: row.league,
    home: row.fixture.teams?.home?.name ?? 'Home',
    away: row.fixture.teams?.away?.name ?? 'Away',
    kickoff: row.fixture.kickoff_utc ?? null,
    marketStatus: row.match ? 'VERIFIED' : 'MISSING_GOAL_OR_CORNER',
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
