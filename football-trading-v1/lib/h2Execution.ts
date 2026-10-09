import { TradingMatch } from './types';

export type H2ExecutionAction =
  | 'PLAY_GOALS_AND_CORNERS'
  | 'PLAY_GOALS'
  | 'PLAY_CORNERS'
  | 'VERIFY_GOAL_LINE'
  | 'VERIFY_CORNER_LINE'
  | 'VERIFY_GOAL_AND_CORNER_LINES'
  | 'NO_ENTRY'
  | 'WAIT_HT_DATA';

export function deriveH2Execution(match: Pick<TradingMatch, 'htAction' | 'liveGoalLine' | 'liveCornerLine'>) {
  const goalLine = typeof match.liveGoalLine === 'number' ? match.liveGoalLine : null;
  const cornerLine = typeof match.liveCornerLine === 'number' ? match.liveCornerLine : null;

  if (!match.htAction || match.htAction === 'NEED_INPUT') {
    return {
      action: 'WAIT_HT_DATA' as H2ExecutionAction,
      text: 'WAIT HT DATA',
      detail: 'Need verified HT score and corners before choosing the H2 market.',
    };
  }

  if (match.htAction === 'NO_ENTRY') {
    return {
      action: 'NO_ENTRY' as H2ExecutionAction,
      text: 'NO ENTRY',
      detail: 'Current HT snapshot does not trigger the V1 H2 setup.',
    };
  }

  if (match.htAction === 'H2_CORNERS') {
    if (cornerLine == null) {
      return {
        action: 'VERIFY_CORNER_LINE' as H2ExecutionAction,
        text: 'VERIFY H2 CORNER LINE',
        detail: 'V1 points to H2 Corners. Get the exact H2 corner line before execution.',
      };
    }
    return {
      action: 'PLAY_CORNERS' as H2ExecutionAction,
      text: `H2 OVER CORNERS ${cornerLine}`,
      detail: 'V1 corner setup is confirmed and the exact H2 corner line is available.',
    };
  }

  // 0-0 + HT corners <= 5: both H2 markets are supported by the user's V1.
  const goalInTrackedRange = goalLine != null && goalLine >= 1.25 && goalLine <= 2;

  if (goalLine == null && cornerLine == null) {
    return {
      action: 'VERIFY_GOAL_AND_CORNER_LINES' as H2ExecutionAction,
      text: 'VERIFY H2 GOAL + CORNER LINES',
      detail: 'V1 supports both markets, but both exact H2 lines are still missing.',
    };
  }
  if (goalLine == null) {
    return {
      action: 'VERIFY_GOAL_LINE' as H2ExecutionAction,
      text: 'VERIFY H2 GOAL LINE',
      detail: `H2 Corners line is ${cornerLine}. V1 also supports H2 Goals; verify the exact goal line.`,
    };
  }
  if (cornerLine == null) {
    return {
      action: 'VERIFY_CORNER_LINE' as H2ExecutionAction,
      text: 'VERIFY H2 CORNER LINE',
      detail: goalInTrackedRange
        ? `H2 Goals line is ${goalLine}. V1 also supports H2 Corners; verify the exact corner line.`
        : `H2 goal line ${goalLine} is outside the tracked 1.25-2.0 range; verify the H2 corner line.`,
    };
  }
  if (goalInTrackedRange) {
    return {
      action: 'PLAY_GOALS_AND_CORNERS' as H2ExecutionAction,
      text: `H2 OVER GOALS ${goalLine} + CORNERS ${cornerLine}`,
      detail: 'Both V1 H2 markets are supported and both exact lines are available.',
    };
  }

  return {
    action: 'PLAY_CORNERS' as H2ExecutionAction,
    text: `H2 OVER CORNERS ${cornerLine}`,
    detail: `H2 goal line ${goalLine} is outside the currently tracked 1.25-2.0 range, so execute the corner side only.`,
  };
}
