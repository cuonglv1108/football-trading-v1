/**
 * API-Football Bet365 PRE-MATCH full-time Asian Handicap market normalization.
 *
 * Some pre-match feeds give both selections the SAME signed handicap:
 *   "Home -1.25" / "Away -1.25" (one shared HOME-referenced line).
 * Other feeds give opposite team-referenced signs:
 *   "Home -1.25" / "Away +1.25".
 * Neither convention establishes the bookmaker's MAIN line.
 */
export type FtAhCandidate = { line: number; homeOdd: number; awayOdd: number };
export type FtAhMarketResult = {
  marketFound: boolean;
  totalLines: number;
  candidates: FtAhCandidate[];
  snapshotAt: string | null;
  convention: 'SHARED_HOME_LINE' | 'SIGNED_SIDES' | 'UNKNOWN';
};

const FT_MARKET = /^asian handicap(?:\s*[-–:]?\s*(?:full time|ft))?$/i;
function numeric(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function lineOf(entry: any): number | null {
  const v = entry?.handicap;
  const raw = v != null && String(v).trim() !== ''
    ? String(v).trim()
    : String(entry?.value ?? '').replace(/^(?:home|away)\b/i, '').trim();
  const nums = raw.match(/[+-]?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  let line: number | null = null;
  if (nums.length === 1) line = nums[0];
  else if (nums.length === 2 && Math.abs(nums[0] - nums[1]) === 0.5 &&
    Math.sign(nums[0]) === Math.sign(nums[1])) line = (nums[0] + nums[1]) / 2;
  return line != null && Math.abs(line) <= 5 && Number.isInteger(line * 4)
    ? line : null;
}
function pairedOdds(values: any[], shared: boolean): FtAhCandidate[] {
  const entries = values.map(v => ({
    side: /^home\b/i.test(String(v?.value ?? '')) ? 'HOME'
      : /^away\b/i.test(String(v?.value ?? '')) ? 'AWAY' : 'OTHER',
    line: lineOf(v), odd: numeric(v?.odd),
  })).filter(v => v.side !== 'OTHER' && v.line != null && v.odd != null &&
    v.odd > 1.01 && v.odd <= 20);
  const home = entries.filter(v => v.side === 'HOME');
  const away = entries.filter(v => v.side === 'AWAY');
  const results = new Map<string,FtAhCandidate>();
  for (const h of home) for (const a of away) {
    if (Math.abs((h.line ?? 0) - (shared ? (a.line ?? 0) : -(a.line ?? 0))) > 0.001) continue;
    const ho = h.odd!, ao = a.odd!;
    // A plausible 2-way market must have approximately 100%+ margin.
    // This removes accidental cross-line combinations, not alternate valid lines.
    const book = 1/ho + 1/ao;
    if (book < 0.97 || book > 1.25) continue;
    const line = h.line!;
    results.set([line,ho,ao].join(':'), {line,homeOdd:ho,awayOdd:ao});
  }
  return [...results.values()];
}
function quoteScore(q: FtAhCandidate) {
  // Only SORT candidate lines for review. Never declare the nearest 1.90 MAIN.
  return Math.abs(q.homeOdd - 1.9) + Math.abs(q.awayOdd - 1.9);
}
export function parseApiFootballBet365FtAh(rows: any[]): FtAhMarketResult {
  const marketRows: Array<{values:any[]; updated:string|null}> = [];
  for (const row of rows) for (const bookmaker of row?.bookmakers ?? []) {
    if (!/^bet365$/i.test(String(bookmaker?.name ?? '').trim())) continue;
    for (const bet of bookmaker?.bets ?? []) {
      if (!FT_MARKET.test(String(bet?.name ?? '').trim())) continue;
      marketRows.push({
        values: Array.isArray(bet?.values) ? bet.values : [],
        updated: typeof row?.update === 'string' ? row.update : null,
      });
    }
  }
  if (!marketRows.length) return {
    marketFound:false,totalLines:0,candidates:[],snapshotAt:null,convention:'UNKNOWN',
  };
  // Use the latest market snapshot only; never mix prices from different times.
  marketRows.sort((a,b) => (Date.parse(b.updated ?? '') || 0)-(Date.parse(a.updated ?? '') || 0));
  const latest = marketRows[0];
  const sharedPairs = pairedOdds(latest.values, true);
  const signedPairs = pairedOdds(latest.values, false);
  // API-Football may encode both outcomes against the same HOME handicap.
  // Prefer the convention with more internally coherent matched quotes.
  const shared = sharedPairs.length >= signedPairs.length;
  const selected = (shared ? sharedPairs : signedPairs).sort((a,b)=>
    quoteScore(a)-quoteScore(b) || a.line-b.line
  );
  return {
    marketFound:true,totalLines:selected.length,candidates:selected.slice(0,5),
    snapshotAt:latest.updated,convention: selected.length
      ? (shared ? 'SHARED_HOME_LINE' : 'SIGNED_SIDES') : 'UNKNOWN',
  };
}
