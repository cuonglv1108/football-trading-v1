import type { League, TradingMatch } from './types';
import type { FiveDollarAhLine } from './fiveDollarFootball';

function teamKey(name: string) {
  const cleaned = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|afc|club|football)\b/g, '').replace(/[^a-z0-9]/g, '');
  // Known official alias order, not a fuzzy/first-word match.
  if (cleaned === 'unampumas' || cleaned === 'pumasunam') return 'pumasunam';
  return cleaned;
}
export function sameAhFixture(
  match: Pick<TradingMatch, 'league' | 'home' | 'away' | 'kickoff'>,
  quote: Pick<FiveDollarAhLine, 'league' | 'home' | 'away' | 'kickoff'>
) {
  const a = Date.parse(match.kickoff ?? '');
  const b = Date.parse(quote.kickoff ?? '');
  return match.league === quote.league && teamKey(match.home) === teamKey(quote.home) &&
    teamKey(match.away) === teamKey(quote.away) &&
    Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 10 * 60 * 1000;
}

// A line-only quote must NEVER masquerade as full two-way bookmaker odds.
export function supplementFtAhLine(rows: TradingMatch[], sourceLines: FiveDollarAhLine[]): TradingMatch[] {
  return rows.map(match => {
    if (match.status !== 'PRE' || match.handicapVerified === true ||
        match.handicapLineVerified === true) return match;
    const candidates = sourceLines.filter(line => sameAhFixture(match, line));
    if (candidates.length !== 1) return match; // no guess on ambiguous matches
    const line = candidates[0];
    if (!Number.isFinite(line.homeLine) || Math.abs(line.homeLine) > 5 ||
        !Number.isInteger(line.homeLine * 4)) return match;

    return {
      ...match,
      prematchHandicapLine: line.homeLine,
      handicapLineVerified: true,
      handicapLineSource: line.source,
      sourceSummary: (match.sourceSummary ?? 'Pre-match') +
        ' · FT AH line: ' + line.source + ' (2-way odds not verified)',
    };
  });
}


export type DedicatedAhQuote = {
  homeLine: number;
  homeOdd: number | null;
  awayOdd: number | null;
  source: string;
};

// Handles BOTH documented provider response shapes without inferring a spread
// from 1X2 prices: data.odds.asian_handicap and data.bookmakers[].odds.asian_handicap.
export function parseDedicatedBet365Ah(data: unknown): DedicatedAhQuote | null {
  if (!data || typeof data !== 'object') return null;
  const root = data as Record<string, unknown>;
  const number = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const validLine = (line: number | null) =>
    line !== null && Math.abs(line) <= 5 && Number.isInteger(line * 4);
  const validPrice = (v: number | null) => v != null && v > 1 && v <= 20;
  const extract = (market: unknown): DedicatedAhQuote | null => {
    if (!market || typeof market !== 'object') return null;
    const quotes = market as Record<string, unknown>;
    for (const key of ['closing', 'current', 'opening']) {
      const raw = quotes[key];
      const fields = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
      const line = number(fields ? fields.line : raw);
      if (!validLine(line)) continue;
      const homeOdd = number(fields?.home);
      const awayOdd = number(fields?.away);
      const priced = validPrice(homeOdd) && validPrice(awayOdd);
      return {
        homeLine: line!,
        homeOdd: priced ? homeOdd : null,
        awayOdd: priced ? awayOdd : null,
        source: priced
          ? '5DollarFootballAPI · Bet365 dedicated FT Asian Handicap (two-way odds)'
          : '5DollarFootballAPI · Bet365 dedicated FT Asian Handicap (line only)',
      };
    }
    return null;
  };

  // Prefer official bookmaker row when present, since it establishes the source.
  const books = Array.isArray(root.bookmakers) ? root.bookmakers : [];
  const bet365 = books.find((b: unknown) => {
    if (!b || typeof b !== 'object') return false;
    const row = b as Record<string, unknown>;
    return String(row.slug ?? '').toLowerCase() === 'bet365' ||
      /^bet\s*365$/i.test(String(row.name ?? ''));
  }) as Record<string, unknown> | undefined;
  const odds = bet365?.odds as Record<string, unknown> | undefined;
  const bookmakerQuote = extract(odds?.asian_handicap);
  if (bookmakerQuote) return bookmakerQuote;

  // Dedicated ?market=asian endpoint is documented as data.odds (no bookmakers).
  const direct = root.odds as Record<string, unknown> | undefined;
  return extract(direct?.asian_handicap);
}
