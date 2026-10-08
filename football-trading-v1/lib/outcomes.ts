import { H2Prediction, OutcomeGrade, SetupStats, TradingMatch } from './types';

function simpleOver(actual: number, line: number): 'WIN' | 'PUSH' | 'LOSS' {
  if (actual > line) return 'WIN';
  if (actual === line) return 'PUSH';
  return 'LOSS';
}

export function gradeAsianOver(actual: number | null | undefined, line: number | null | undefined): OutcomeGrade {
  if (actual == null || line == null || !Number.isFinite(actual) || !Number.isFinite(line)) return 'UNRESOLVED';

  const normalized = Math.round(line * 4) / 4;
  const frac = Math.round((normalized - Math.floor(normalized)) * 100);

  const settlePair = (a: 'WIN' | 'PUSH' | 'LOSS', b: 'WIN' | 'PUSH' | 'LOSS'): OutcomeGrade => {
    if (a === 'WIN' && b === 'WIN') return 'FULL_WIN';
    if ((a === 'WIN' && b === 'PUSH') || (a === 'PUSH' && b === 'WIN')) return 'HALF_WIN';
    if (a === 'PUSH' && b === 'PUSH') return 'PUSH';
    if ((a === 'LOSS' && b === 'PUSH') || (a === 'PUSH' && b === 'LOSS')) return 'HALF_LOSS';
    if (a === 'LOSS' && b === 'LOSS') return 'FULL_LOSS';
    return 'UNRESOLVED';
  };

  if (frac === 25) {
    return settlePair(simpleOver(actual, Math.floor(normalized)), simpleOver(actual, Math.floor(normalized) + 0.5));
  }
  if (frac === 75) {
    return settlePair(simpleOver(actual, Math.floor(normalized) + 0.5), simpleOver(actual, Math.floor(normalized) + 1));
  }

  const result = simpleOver(actual, normalized);
  return result === 'WIN' ? 'FULL_WIN' : result === 'PUSH' ? 'PUSH' : 'FULL_LOSS';
}

export function buildH2Predictions(match: TradingMatch): H2Prediction[] {
  const out: H2Prediction[] = [];
  const goalLine = typeof match.liveGoalLine === 'number' ? match.liveGoalLine : null;
  const cornerLine = typeof match.liveCornerLine === 'number' ? match.liveCornerLine : null;

  if (match.htAction === 'H2_GOALS_AND_CORNERS') {
    out.push({
      market: 'H2_GOALS',
      direction: 'OVER',
      line: goalLine,
      setupKey: 'HT_00_CORNERS_LE5_GOALS',
      active: goalLine != null && goalLine >= 1.25 && goalLine <= 2,
      note: goalLine == null
        ? 'V1 goal setup triggered; exact H2 goal line was not verified.'
        : goalLine >= 1.25 && goalLine <= 2
          ? `V1 H2 Goals Over ${goalLine}`
          : `Goal setup triggered, but H2 line ${goalLine} is outside V1 range 1.25-2.0.`,
      grade: 'PENDING',
    });
    out.push({
      market: 'H2_CORNERS',
      direction: 'OVER',
      line: cornerLine,
      setupKey: 'HT_00_CORNERS_LE5_CORNERS',
      active: cornerLine != null && cornerLine >= 8.5,
      note: cornerLine == null
        ? 'V1 corner setup triggered; exact H2 corner line was not verified.'
        : cornerLine >= 8.5
          ? `V1 H2 Corners Over ${cornerLine}`
          : `Corner setup triggered, but H2 line ${cornerLine} is below V1 range 8.5+.`,
      grade: 'PENDING',
    });
  } else if (match.htAction === 'H2_CORNERS') {
    const setupKey = match.favouriteLosing
      ? 'FAV_LOSING_CORNERS_LE5'
      : match.favouriteCoveringHandicap
        ? 'FAV_COVERING_CORNERS_LE5'
        : match.ftGoalOverClear
          ? 'FT_OVER_CLEAR_CORNERS_LE5'
          : 'OTHER_CORNERS_LE5';

    out.push({
      market: 'H2_CORNERS',
      direction: 'OVER',
      line: cornerLine,
      setupKey,
      active: cornerLine != null && cornerLine >= 8.5,
      note: cornerLine == null
        ? 'V1 corner setup triggered; exact H2 corner line was not verified.'
        : cornerLine >= 8.5
          ? `V1 H2 Corners Over ${cornerLine}`
          : `Corner setup triggered, but H2 line ${cornerLine} is below V1 range 8.5+.`,
      grade: 'PENDING',
    });
  }

  return out;
}

export function gradeMatchPredictions(match: TradingMatch): H2Prediction[] {
  return (match.h2Predictions ?? []).map(p => {
    const actual = p.market === 'H2_GOALS' ? match.h2ActualGoals : match.h2ActualCorners;
    return {
      ...p,
      actual: actual ?? null,
      grade: p.active ? gradeAsianOver(actual, p.line) : 'UNRESOLVED',
    };
  });
}

function gradeScore(grade: OutcomeGrade): number | null {
  if (grade === 'FULL_WIN') return 1;
  if (grade === 'HALF_WIN') return 0.75;
  if (grade === 'PUSH') return 0.5;
  if (grade === 'HALF_LOSS') return 0.25;
  if (grade === 'FULL_LOSS') return 0;
  return null;
}

export function computeSetupStats(rows: TradingMatch[]): SetupStats[] {
  const map = new Map<string, { key: string; market: 'H2_GOALS' | 'H2_CORNERS'; grades: OutcomeGrade[] }>();

  for (const row of rows) {
    if (row.researchPhase !== 'FT') continue;
    for (const p of row.h2Predictions ?? []) {
      if (!p.active || !p.grade) continue;
      const score = gradeScore(p.grade);
      if (score == null) continue;
      const id = `${p.market}|${p.setupKey}`;
      const bucket = map.get(id) ?? { key: p.setupKey, market: p.market, grades: [] };
      bucket.grades.push(p.grade);
      map.set(id, bucket);
    }
  }

  return Array.from(map.values()).map(bucket => {
    const samples = bucket.grades.length;
    const totalScore = bucket.grades.reduce((sum, g) => sum + (gradeScore(g) ?? 0), 0);
    const observedAccuracy = samples ? Math.round((totalScore / samples) * 1000) / 10 : 0;

    // Neutral prior keeps tiny samples from looking unrealistically certain.
    const priorN = 8;
    const smoothedAccuracy = Math.round(((totalScore + priorN * 0.5) / (samples + priorN)) * 1000) / 10;

    return {
      key: bucket.key,
      market: bucket.market,
      samples,
      fullWins: bucket.grades.filter(g => g === 'FULL_WIN').length,
      halfWins: bucket.grades.filter(g => g === 'HALF_WIN').length,
      pushes: bucket.grades.filter(g => g === 'PUSH').length,
      halfLosses: bucket.grades.filter(g => g === 'HALF_LOSS').length,
      fullLosses: bucket.grades.filter(g => g === 'FULL_LOSS').length,
      observedAccuracy,
      smoothedAccuracy,
      confidenceLabel: samples >= 20 ? 'ESTABLISHED' : samples >= 8 ? 'DEVELOPING' : 'LOW_SAMPLE',
    };
  }).sort((a, b) => b.samples - a.samples);
}
