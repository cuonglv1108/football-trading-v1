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
