export type League = 'MLS' | 'Allsvenskan' | 'Liga MX';
export type MatchState = 'QUALIFIED' | 'WATCHING' | 'TRIGGER' | 'CANCELLED';

export interface TradingMatch {
  id: string;
  league: League;
  home: string;
  away: string;
  minute: number | null;
  status: 'PRE' | 'LIVE' | 'HT' | 'FT';
  kickoff?: string | null;
  scoreHome: number;
  scoreAway: number;
  cornersHome: number;
  cornersAway: number;
  prematchCornerLine: number;
  prematchGoalLine: number;
  favourite: 'HOME' | 'AWAY';
  handicap: number;
  favouriteCoveringHandicap: boolean;
  favouriteLosing: boolean;
  ftGoalOverClear: boolean;
  liveCornerLine?: number | null;
  liveGoalLine?: number | null;
  checkedAt?: string | null;
  state?: MatchState;
  reasons?: string[];
  winProbability?: number;
  notable?: boolean;
  notableScore?: number;
}
