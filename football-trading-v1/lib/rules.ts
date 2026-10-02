import { TradingMatch, MatchState } from './types';

function clamp(value: number, min = 5, max = 95) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function estimateV1Probability(match: TradingMatch): number {
  let score = 50;

  // Pre-match strength from the user's V1 filters.
  score += Math.max(-12, Math.min(10, (match.prematchCornerLine - 10) * 7));
  score += Math.max(-10, Math.min(8, (match.prematchGoalLine - 2.75) * 8));

  const handicapStrength = Math.abs(match.handicap);
  if (handicapStrength >= 1) score += 4;
  else if (handicapStrength >= 0.75) score += 2;

  if (match.status === 'LIVE') {
    if (match.scoreHome === match.scoreAway) score += 3;
    if ((match.cornersHome + match.cornersAway) <= 4 && (match.minute ?? 0) >= 30) score += 4;
    if (typeof match.liveCornerLine === 'number' && match.liveCornerLine >= 7.5) score += 2;
    if (typeof match.liveGoalLine === 'number' && match.liveGoalLine >= 1.5) score += 2;
  }

  if (match.status === 'HT') {
    const totalCorners = match.cornersHome + match.cornersAway;
    if (totalCorners <= 5) score += 8;
    else score -= 18;

    if (match.scoreHome === 0 && match.scoreAway === 0) score += 12;
    if (typeof match.liveCornerLine === 'number' && match.liveCornerLine >= 7.5) score += 2;
    if (typeof match.liveGoalLine === 'number' && match.liveGoalLine >= 1.5) score += 2;
    if (match.favouriteCoveringHandicap || match.favouriteLosing || match.ftGoalOverClear) score += 4;
  }

  if (match.status === 'FT') score = 0;

  return clamp(score);
}

export function notableScore(match: TradingMatch): number {
  if (match.status !== 'PRE') return 0;
  if (match.prematchCornerLine < 10 || match.prematchGoalLine < 2.75) return 0;

  let score = 50;
  score += Math.min(18, Math.max(0, (match.prematchCornerLine - 10) * 12));
  score += Math.min(16, Math.max(0, (match.prematchGoalLine - 2.75) * 12));
  score += Math.min(8, Math.abs(match.handicap) * 5);
  return clamp(score, 0, 100);
}

export function evaluateV1(match: TradingMatch): {
  state: MatchState;
  reasons: string[];
  winProbability: number;
  notable: boolean;
  notableScore: number;
} {
  const reasons: string[] = [];
  const probability = estimateV1Probability(match);
  const preScore = notableScore(match);
  const notable = match.status === 'PRE' && preScore >= 62;

  if (match.prematchCornerLine < 10 || match.prematchGoalLine < 2.75) {
    return {
      state: 'CANCELLED',
      reasons: ['Không đạt filter pre-match V1'],
      winProbability: probability,
      notable: false,
      notableScore: preScore,
    };
  }

  if (match.status === 'PRE') {
    return {
      state: 'QUALIFIED',
      reasons: [notable ? 'Trận đáng chú ý theo V1' : 'Đạt điều kiện pre-match'],
      winProbability: probability,
      notable,
      notableScore: preScore,
    };
  }

  if (match.status === 'LIVE') {
    return {
      state: 'WATCHING',
      reasons: ['Đang theo dõi tới HT'],
      winProbability: probability,
      notable: false,
      notableScore: preScore,
    };
  }

  if (match.status === 'HT') {
    const totalCorners = match.cornersHome + match.cornersAway;

    if (totalCorners > 5) {
      return {
        state: 'CANCELLED',
        reasons: ['HT corners > 5'],
        winProbability: probability,
        notable: false,
        notableScore: preScore,
      };
    }

    const isNilNil = match.scoreHome === 0 && match.scoreAway === 0;
    if (isNilNil) {
      reasons.push('0-0 HT + corners <= 5');
      reasons.push('Theo dõi Over Goals H2 + Over Corners H2');
      return {
        state: 'TRIGGER',
        reasons,
        winProbability: probability,
        notable: false,
        notableScore: preScore,
      };
    }

    if (match.favouriteCoveringHandicap) {
      return {
        state: 'TRIGGER',
        reasons: ['Corners <= 5, cửa trên đang ăn handicap FT → theo dõi Over Corners'],
        winProbability: probability,
        notable: false,
        notableScore: preScore,
      };
    }

    if (match.ftGoalOverClear) {
      return {
        state: 'TRIGGER',
        reasons: ['Corners <= 5, Over Goals FT clear → theo dõi Over Corners'],
        winProbability: probability,
        notable: false,
        notableScore: preScore,
      };
    }

    if (match.favouriteLosing) {
      return {
        state: 'TRIGGER',
        reasons: ['Corners <= 5, cửa trên đang thua → theo dõi Over Corners'],
        winProbability: probability,
        notable: false,
        notableScore: preScore,
      };
    }

    return {
      state: 'WATCHING',
      reasons: ['HT chưa có trigger đủ rõ'],
      winProbability: probability,
      notable: false,
      notableScore: preScore,
    };
  }

  return {
    state: 'CANCELLED',
    reasons: ['Trận đã kết thúc'],
    winProbability: probability,
    notable: false,
    notableScore: preScore,
  };
}
