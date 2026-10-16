export type League = 'MLS' | 'Allsvenskan' | 'Liga MX' | 'Brazil Serie A' | 'Eredivisie' | 'Swiss Super League' | 'Danish Superliga' | 'Eliteserien';
export type MatchState = 'QUALIFIED' | 'WATCHING' | 'TRIGGER' | 'CANCELLED';
export type OutcomeGrade = 'PENDING' | 'FULL_WIN' | 'HALF_WIN' | 'PUSH' | 'HALF_LOSS' | 'FULL_LOSS' | 'UNRESOLVED';
export type MethodOutcomeStatus = 'PENDING' | 'SUCCESS' | 'FAIL' | 'UNRESOLVED';
export type H2ExecutionAction = 'PLAY_GOALS_AND_CORNERS' | 'PLAY_GOALS' | 'PLAY_CORNERS' | 'VERIFY_GOAL_LINE' | 'VERIFY_CORNER_LINE' | 'VERIFY_GOAL_AND_CORNER_LINES' | 'NO_ENTRY' | 'WAIT_HT_DATA';

export interface H2Prediction {
  market: 'H2_GOALS' | 'H2_CORNERS';
  direction: 'OVER';
  line: number | null;
  setupKey: string;
  active: boolean;
  note: string;
  grade?: OutcomeGrade;
  actual?: number | null;
}

export interface MethodOutcome {
  market: 'H2_GOALS' | 'H2_CORNERS';
  setupKey: string;
  benchmarkLine: number;
  actual: number | null;
  status: MethodOutcomeStatus;
  reason: string;
}

export interface MethodStats {
  key: string;
  market: 'H2_GOALS' | 'H2_CORNERS';
  samples: number;
  successes: number;
  failures: number;
  observedWinRate: number;
  smoothedWinRate: number;
  confidenceLabel: 'LOW_SAMPLE' | 'DEVELOPING' | 'ESTABLISHED';
}

export interface MethodOverallStats {
  samples: number;
  successes: number;
  failures: number;
  observedWinRate: number;
  smoothedWinRate: number;
  confidenceLabel: 'LOW_SAMPLE' | 'DEVELOPING' | 'ESTABLISHED';
}

export interface SetupStats {
  key: string;
  market: 'H2_GOALS' | 'H2_CORNERS';
  samples: number;
  fullWins: number;
  halfWins: number;
  pushes: number;
  halfLosses: number;
  fullLosses: number;
  observedAccuracy: number;
  smoothedAccuracy: number;
  confidenceLabel: 'LOW_SAMPLE' | 'DEVELOPING' | 'ESTABLISHED';
}

export interface TradingMatch {
  id: string;
  league: League;
  home: string;
  away: string;
  homeLogo?: string | null;
  awayLogo?: string | null;
  minute: number | null;
  status: 'PRE' | 'LIVE' | 'HT' | 'FT';
  kickoff?: string | null;
  scoreHome: number;
  scoreAway: number;
  cornersHome: number;
  cornersAway: number;
  prematchCornerLine: number;
  prematchGoalLine: number;
  prematchCornerOverOdd?: number | null;
  prematchCornerUnderOdd?: number | null;
  prematchGoalOverOdd?: number | null;
  prematchGoalUnderOdd?: number | null;
  favourite: 'HOME' | 'AWAY';
  handicap: number;
  handicapVerified?: boolean;
  handicapHomeOdd?: number | null;
  handicapAwayOdd?: number | null;
  favouriteCoveringHandicap: boolean;
  favouriteLosing: boolean;
  ftGoalOverClear: boolean;
  liveCornerLine?: number | null;
  liveGoalLine?: number | null;
  liveCornerOverOdd?: number | null;
  liveCornerUnderOdd?: number | null;
  liveGoalOverOdd?: number | null;
  liveGoalUnderOdd?: number | null;
  checkedAt?: string | null;
  state?: MatchState;
  reasons?: string[];
  winProbability?: number;
  notable?: boolean;
  notableScore?: number;
  sourceSummary?: string;
  sourceUrls?: string[];
  htAction?: 'H2_GOALS_AND_CORNERS' | 'H2_CORNERS' | 'NO_ENTRY' | 'NEED_INPUT';
  htAdvice?: string;
  htConfidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  htMissingInputs?: string[];
  htSourceSummary?: string;
  htSourceUrls?: string[];
  htCheckedAt?: string | null;
  htVerified?: boolean;
  htSourceType?: 'API_FOOTBALL' | 'MANUAL' | 'GPT_UNVERIFIED';
  htEvaluationType?: 'V1_TRIGGER' | 'V1_CANCEL_DATA' | 'NEED_INPUT';
  h2GoalsAssessment?: 'V1_SUPPORTED' | 'V1_NOT_SUPPORTED' | 'UNRESOLVED';
  h2CornersAssessment?: 'V1_SUPPORTED' | 'V1_NOT_SUPPORTED' | 'UNRESOLVED';
  htDataNote?: string;
  h2ExecutionAction?: H2ExecutionAction;
  h2ExecutionText?: string;
  h2ExecutionDetail?: string;
  htScoreHome?: number | null;
  htScoreAway?: number | null;
  htCornersHome?: number | null;
  htCornersAway?: number | null;
  redCardsHome?: number | null;
  redCardsAway?: number | null;
  ftScoreHome?: number | null;
  ftScoreAway?: number | null;
  ftCornersHome?: number | null;
  ftCornersAway?: number | null;
  ftCheckedAt?: string | null;
  ftVerified?: boolean;
  watchStatus?: 'EXPIRED_UNVERIFIED';
  ftSourceSummary?: string;
  ftSourceUrls?: string[];
  h2ActualGoals?: number | null;
  h2ActualCorners?: number | null;
  researchPhase?: 'HT' | 'FT' | 'MANUAL';
  h2Predictions?: H2Prediction[];
  setupStats?: SetupStats[];
  methodOutcomes?: MethodOutcome[];
}
