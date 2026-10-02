import { TradingMatch, MatchState } from './types';

export function evaluateV1(match: TradingMatch): { state: MatchState; reasons: string[] } {
  const reasons: string[] = [];

  if (match.prematchCornerLine < 10 || match.prematchGoalLine < 2.75) {
    return { state: 'CANCELLED', reasons: ['Không đạt filter pre-match V1'] };
  }

  if (match.status === 'PRE') {
    return { state: 'QUALIFIED', reasons: ['Đạt điều kiện pre-match'] };
  }

  if (match.status === 'LIVE') {
    return { state: 'WATCHING', reasons: ['Đang theo dõi tới HT'] };
  }

  if (match.status === 'HT') {
    const totalCorners = match.cornersHome + match.cornersAway;

    if (totalCorners > 5) {
      return { state: 'CANCELLED', reasons: ['HT corners > 5'] };
    }

    const isNilNil = match.scoreHome === 0 && match.scoreAway === 0;
    if (isNilNil) {
      reasons.push('0-0 HT + corners <= 5');
      reasons.push('Theo dõi Over Goals H2 + Over Corners H2');
      return { state: 'TRIGGER', reasons };
    }

    if (match.favouriteCoveringHandicap) {
      return { state: 'TRIGGER', reasons: ['Corners <= 5, cửa trên đang ăn handicap FT → theo dõi Over Corners'] };
    }

    if (match.ftGoalOverClear) {
      return { state: 'TRIGGER', reasons: ['Corners <= 5, Over Goals FT clear → theo dõi Over Corners'] };
    }

    if (match.favouriteLosing) {
      return { state: 'TRIGGER', reasons: ['Corners <= 5, cửa trên đang thua → theo dõi Over Corners'] };
    }

    return { state: 'WATCHING', reasons: ['HT chưa có trigger đủ rõ'] };
  }

  return { state: 'CANCELLED', reasons: ['Trận đã kết thúc'] };
}
