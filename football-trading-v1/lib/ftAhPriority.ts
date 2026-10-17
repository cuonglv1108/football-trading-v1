import type { League } from './types';

// Requested trading priorities. This ordering affects only FT Asian Handicap
// recovery, never Goal/Corner scanning, HT/FT grading, or History.
export const FT_AH_PRIORITY_LEAGUES: readonly League[] = [
  'Brazil Serie A',
  'Allsvenskan',
  'Liga MX',
  'MLS',
];

export function isFtAhPriorityLeague(league: string): boolean {
  return FT_AH_PRIORITY_LEAGUES.includes(league as League);
}

export function ftAhPriorityRank(league: string): number {
  const index = FT_AH_PRIORITY_LEAGUES.indexOf(league as League);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

export function sortFtAhPriority<T extends { league: string; kickoff?: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    ftAhPriorityRank(a.league) - ftAhPriorityRank(b.league) ||
    (Date.parse(a.kickoff ?? '') || 0) - (Date.parse(b.kickoff ?? '') || 0)
  );
}
