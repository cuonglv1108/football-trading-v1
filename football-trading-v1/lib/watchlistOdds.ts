import type { TradingMatch } from './types';

const INVALIDATION = /\s*·\s*HANDICAP INVALIDATED\s*—\s*SAFEv\d+\s+rescan required/gi;

export function sanitizeOddsSnapshot(row: TradingMatch): TradingMatch {
  const source = typeof row.sourceSummary === 'string' ? row.sourceSummary : '';
  const cleaned = source.replace(INVALIDATION, '').trim();
  const legacyApiFootball = cleaned.startsWith('API-Football ·') &&
    !/SAFEv(?:9|[1-9]\d+) AH verified\b/.test(cleaned);

  if (!legacyApiFootball && source === cleaned) return row;
  return {
    ...row,
    sourceSummary: cleaned,
    // Old API-Football parser versions are not proof of a verified Asian handicap.
    handicapVerified: legacyApiFootball ? false : row.handicapVerified,
    favouriteCoveringHandicap: legacyApiFootball ? false : row.favouriteCoveringHandicap,
    favouriteLosing: legacyApiFootball ? false : row.favouriteLosing,
  };
}

function teamKey(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|afc|club|football)\b/g, '').replace(/[^a-z0-9]/g, '');
}

export function sameScheduledFixture(a: TradingMatch, b: TradingMatch) {
  const at = Date.parse(a.kickoff ?? '');
  const bt = Date.parse(b.kickoff ?? '');
  return a.league === b.league &&
    teamKey(a.home) === teamKey(b.home) &&
    teamKey(a.away) === teamKey(b.away) &&
    Number.isFinite(at) && Number.isFinite(bt) &&
    Math.abs(at - bt) <= 15 * 60 * 1000;
}

function lifecycleRank(m: TradingMatch) {
  return (m.ftVerified ? 100 : 0) + (m.htVerified ? 50 : 0) +
    (m.status === 'HT' ? 20 : 0) + (m.status === 'LIVE' ? 10 : 0) +
    (m.htSourceType === 'MANUAL' ? 5 : 0);
}

function refreshPreMatchOdds(previous: TradingMatch, fresh: TradingMatch): TradingMatch {
  // A prematch refresh must never change a verified HT/FT decision or overwrite it.
  if (previous.status !== 'PRE' || previous.htVerified ||
      previous.ftVerified || previous.htSourceType === 'MANUAL' ||
      previous.researchPhase === 'HT' || previous.researchPhase === 'FT') {
    return previous;
  }
  return {
    ...previous,
    // Keep local watch/history identity, even if API providers have different fixture IDs.
    homeLogo: fresh.homeLogo ?? previous.homeLogo,
    awayLogo: fresh.awayLogo ?? previous.awayLogo,
    prematchGoalLine: fresh.prematchGoalLine,
    prematchCornerLine: fresh.prematchCornerLine,
    prematchGoalOverOdd: fresh.prematchGoalOverOdd ?? null,
    prematchGoalUnderOdd: fresh.prematchGoalUnderOdd ?? null,
    prematchCornerOverOdd: fresh.prematchCornerOverOdd ?? null,
    prematchCornerUnderOdd: fresh.prematchCornerUnderOdd ?? null,
    favourite: fresh.favourite,
    handicap: fresh.handicap,
    handicapVerified: fresh.handicapVerified === true,
    prematchHandicapLine: fresh.prematchHandicapLine ?? null,
    handicapLineVerified: fresh.handicapLineVerified === true,
    handicapLineSource: fresh.handicapLineSource ?? null,
    handicapHomeOdd: fresh.handicapHomeOdd ?? null,
    handicapAwayOdd: fresh.handicapAwayOdd ?? null,
    sourceSummary: fresh.sourceSummary,
    sourceUrls: fresh.sourceUrls,
    state: fresh.state,
    reasons: fresh.reasons,
    winProbability: fresh.winProbability,
    notable: fresh.notable,
    notableScore: fresh.notableScore,
  };
}

// Intended for qualified prematch rows returned by the provider scan.
// Existing saved matches survive, while duplicate provider IDs for the same fixture do not.
export function mergeWatchlistOdds(current: TradingMatch[], incoming: TradingMatch[]): TradingMatch[] {
  const rows: TradingMatch[] = [];
  for (const input of current) {
    const match = sanitizeOddsSnapshot(input);
    const i = rows.findIndex(row => sameScheduledFixture(row, match) || row.id === match.id);
    if (i < 0) rows.push(match);
    else if (lifecycleRank(match) > lifecycleRank(rows[i])) rows[i] = match;
  }
  for (const input of incoming) {
    const fresh = sanitizeOddsSnapshot(input);
    const i = rows.findIndex(row => sameScheduledFixture(row, fresh) || row.id === fresh.id);
    if (i < 0) rows.push(fresh);
    else rows[i] = refreshPreMatchOdds(rows[i], fresh);
  }
  return rows.sort((a, b) => Date.parse(a.kickoff ?? '') - Date.parse(b.kickoff ?? ''));
}
