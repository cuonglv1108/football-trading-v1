import { H2Prediction, MethodOutcome, MethodOverallStats, MethodStats, OutcomeGrade, SetupStats, TradingMatch } from './types';

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
  const goalLine = typeof match.liveGoalLine === 'number' && match.liveGoalLine > 0 ? match.liveGoalLine : null;
  const cornerLine = typeof match.liveCornerLine === 'number' && match.liveCornerLine > 0 ? match.liveCornerLine : null;

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
      active: cornerLine != null,
      note: cornerLine == null
        ? 'V1 corner setup triggered; exact H2 corner line was not verified.'
        : `V1 H2 Corners Over ${cornerLine}. H2 corner line is contextual, not a fixed 8.5+ gate.`,
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
      active: cornerLine != null,
      note: cornerLine == null
        ? 'V1 corner setup triggered; exact H2 corner line was not verified.'
        : `V1 H2 Corners Over ${cornerLine}. H2 corner line is contextual, not a fixed 8.5+ gate.`,
      grade: 'PENDING',
    });
  } else if (match.htAction === 'NO_ENTRY') {
    out.push({
      market: 'H2_GOALS',
      direction: 'OVER',
      line: goalLine,
      setupKey: 'CONTROL_NO_ENTRY_GOALS',
      active: false,
      note: goalLine == null
        ? 'No V1 trade. Research-only H2 Goals record; exact HT line was not verified.'
        : `No V1 trade. Research-only H2 Goals Over ${goalLine} for control comparison.`,
      grade: 'PENDING',
    });
    out.push({
      market: 'H2_CORNERS',
      direction: 'OVER',
      line: cornerLine,
      setupKey: 'CONTROL_NO_ENTRY_CORNERS',
      active: false,
      note: cornerLine == null
        ? 'No V1 trade. Research-only H2 Corners record; exact HT line was not verified.'
        : `No V1 trade. Research-only H2 Corners Over ${cornerLine} for control comparison.`,
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
      grade: p.line == null ? 'UNRESOLVED' : gradeAsianOver(actual, p.line),
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
    // Legacy GPT-search FT outcomes were not fixture/statistics verified; keep their
    // history visible but never include them in measured win-rate statistics.
    if (row.researchPhase !== 'FT' || row.ftVerified !== true ||
      !hasVerifiedHtEvidence(row) ||
      !/^API-Football fixture \d+/.test(row.ftSourceSummary ?? '')) continue;
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
      confidenceLabel: (samples >= 20 ? 'ESTABLISHED' : samples >= 8 ? 'DEVELOPING' : 'LOW_SAMPLE') as SetupStats['confidenceLabel'],
    };
  }).sort((a, b) => b.samples - a.samples);
}


function setupKeyForMarket(match: TradingMatch, market: 'H2_GOALS' | 'H2_CORNERS') {
  const prediction = (match.h2Predictions ?? []).find(p => p.market === market && p.setupKey);
  if (prediction?.setupKey) return prediction.setupKey;

  if (market === 'H2_GOALS') return 'HT_00_CORNERS_LE5_GOALS';
  if (match.favouriteLosing) return 'FAV_LOSING_CORNERS_LE5';
  if (match.favouriteCoveringHandicap) return 'FAV_COVERING_CORNERS_LE5';
  if (match.ftGoalOverClear) return 'FT_OVER_CLEAR_CORNERS_LE5';
  if (match.htAction === 'H2_GOALS_AND_CORNERS') return 'HT_00_CORNERS_LE5_CORNERS';
  return 'OTHER_CORNERS_LE5';
}

function reconstructedHtTotals(match: TradingMatch) {
  const directHtGoals =
    match.htScoreHome != null && match.htScoreAway != null
      ? match.htScoreHome + match.htScoreAway
      : null;
  const directHtCorners =
    match.htCornersHome != null && match.htCornersAway != null
      ? match.htCornersHome + match.htCornersAway
      : null;

  const ftGoals =
    match.ftScoreHome != null && match.ftScoreAway != null
      ? match.ftScoreHome + match.ftScoreAway
      : match.status === 'FT'
        ? match.scoreHome + match.scoreAway
        : null;
  const ftCorners =
    match.ftCornersHome != null && match.ftCornersAway != null
      ? match.ftCornersHome + match.ftCornersAway
      : match.status === 'FT'
        ? match.cornersHome + match.cornersAway
        : null;

  const htGoals = directHtGoals ??
    (ftGoals != null && match.h2ActualGoals != null && ftGoals >= match.h2ActualGoals
      ? ftGoals - match.h2ActualGoals
      : null);
  const htCorners = directHtCorners ??
    (ftCorners != null && match.h2ActualCorners != null && ftCorners >= match.h2ActualCorners
      ? ftCorners - match.h2ActualCorners
      : null);

  return { htGoals, htCorners, ftGoals, ftCorners };
}

function hasVerifiedHtEvidence(match: TradingMatch) {
  if (match.htVerified === true && match.htSourceType === 'API_FOOTBALL') return true;

  // Recovery path for FT snapshots created after a verified HT check but with the
  // HT flags/action lost during client merge. H2 actual values only exist when
  // an HT baseline had been available to the FT evaluator.
  const t = reconstructedHtTotals(match);
  return match.ftVerified === true &&
    match.researchPhase === 'FT' &&
    match.h2ActualGoals != null &&
    match.h2ActualCorners != null &&
    t.htGoals != null &&
    t.htCorners != null;
}

export function inferVerifiedHtAction(match: TradingMatch): TradingMatch['htAction'] | null {
  if (match.htAction === 'H2_GOALS_AND_CORNERS' || match.htAction === 'H2_CORNERS' || match.htAction === 'NO_ENTRY') {
    return match.htAction;
  }

  if (match.h2GoalsAssessment === 'V1_SUPPORTED' && match.h2CornersAssessment === 'V1_SUPPORTED') {
    return 'H2_GOALS_AND_CORNERS';
  }
  if (match.h2CornersAssessment === 'V1_SUPPORTED') {
    return 'H2_CORNERS';
  }

  if (!hasVerifiedHtEvidence(match)) return null;

  const { htGoals, htCorners } = reconstructedHtTotals(match);
  if (htGoals == null || htCorners == null) return null;

  if (htCorners > 5) return 'NO_ENTRY';
  if (htGoals === 0) return 'H2_GOALS_AND_CORNERS';

  const sh = match.htScoreHome;
  const sa = match.htScoreAway;
  if (sh == null || sa == null) {
    return match.favouriteLosing || match.favouriteCoveringHandicap || match.ftGoalOverClear
      ? 'H2_CORNERS'
      : 'NO_ENTRY';
  }

  const favouriteDiff = match.favourite === 'HOME' ? sh - sa : sa - sh;
  const favouriteLosing = match.favouriteLosing === true || favouriteDiff < 0;
  const favouriteCovering =
    match.favouriteCoveringHandicap === true ||
    (match.handicapVerified === true && Number.isFinite(match.handicap) && favouriteDiff + match.handicap > 0);
  const ftGoalOverClear =
    match.ftGoalOverClear === true ||
    (Number.isFinite(match.prematchGoalLine) && sh + sa > Math.ceil(match.prematchGoalLine));

  return favouriteLosing || favouriteCovering || ftGoalOverClear ? 'H2_CORNERS' : 'NO_ENTRY';
}

export function methodMatchStatus(match: TradingMatch): 'WIN' | 'LOSE' | 'NE' | null {
  const action = inferVerifiedHtAction(match);
  if (action === 'NO_ENTRY') return 'NE';
  if (action !== 'H2_CORNERS' && action !== 'H2_GOALS_AND_CORNERS') return null;

  const outcomes = evaluateMethodOutcomes(match)
    .filter(o => o.status === 'SUCCESS' || o.status === 'FAIL');

  if (!outcomes.length) return null;

  // A match marked WIN means every V1 market actually recommended at HT succeeded.
  // If any recommended leg fails, the match-level badge is LOSE.
  return outcomes.every(o => o.status === 'SUCCESS') ? 'WIN' : 'LOSE';
}

export function evaluateMethodOutcomes(match: TradingMatch): MethodOutcome[] {
  const out: MethodOutcome[] = [];
  const verifiedHt = hasVerifiedHtEvidence(match);
  const verifiedFt = match.ftVerified === true &&
    /^API-Football fixture \d+/.test(match.ftSourceSummary ?? '');

  const commonState = (
    market: 'H2_GOALS' | 'H2_CORNERS',
    benchmarkLine: number,
    actual: number | null,
    setupKey: string
  ): MethodOutcome | null => {
    if (!verifiedHt) {
      return {
        market, setupKey, benchmarkLine, actual: null, status: 'UNRESOLVED',
        reason: 'HT not verified',
      };
    }
    if (!verifiedFt) {
      return {
        market, setupKey, benchmarkLine, actual, status: 'PENDING',
        reason: 'Waiting FT',
      };
    }
    if (actual == null || !Number.isFinite(actual)) {
      return {
        market, setupKey, benchmarkLine, actual: null, status: 'UNRESOLVED',
        reason: 'Missing verified result',
      };
    }
    return null;
  };

  const inferredAction = inferVerifiedHtAction(match);

  const goalsSupported =
    match.h2GoalsAssessment === 'V1_SUPPORTED' || inferredAction === 'H2_GOALS_AND_CORNERS';

  if (goalsSupported) {
    const market: 'H2_GOALS' = 'H2_GOALS';
    const setupKey = setupKeyForMarket(match, market);
    const benchmarkLine = match.prematchGoalLine;
    const actual = match.h2ActualGoals ?? null;
    const unresolved = commonState(market, benchmarkLine, actual, setupKey);
    if (unresolved) {
      out.push(unresolved);
    } else {
      const success = (actual as number) > benchmarkLine;
      out.push({
        market,
        setupKey,
        benchmarkLine,
        actual,
        status: success ? 'SUCCESS' : 'FAIL',
        reason: success
          ? `H2 goals ${actual} > pre-match ${benchmarkLine}`
          : `H2 goals ${actual} ≤ pre-match ${benchmarkLine}`,
      });
    }
  }

  const cornersSupported =
    match.h2CornersAssessment === 'V1_SUPPORTED' ||
    inferredAction === 'H2_CORNERS' ||
    inferredAction === 'H2_GOALS_AND_CORNERS';

  if (cornersSupported) {
    const market: 'H2_CORNERS' = 'H2_CORNERS';
    const setupKey = setupKeyForMarket(match, market);
    const benchmarkLine = match.prematchCornerLine;
    const totals = reconstructedHtTotals(match);
    const htCorners = totals.htCorners;
    const h2Corners = match.h2ActualCorners ?? null;
    const finalCorners = totals.ftCorners ??
      (htCorners != null && h2Corners != null ? htCorners + h2Corners : null);

    const unresolved = commonState(market, benchmarkLine, finalCorners, setupKey);
    if (unresolved) {
      out.push(unresolved);
    } else {
      // V1 corner method success is based on the FINAL corner total:
      // verified HT corners + H2 corners must finish at least 1.0 corner
      // above the original pre-match FT corner line.
      // Example: pre 10.5 -> FT 12 is success; FT 11 is not.
      const margin = (finalCorners as number) - benchmarkLine;
      const success = margin >= 1;
      out.push({
        market,
        setupKey,
        benchmarkLine,
        actual: finalCorners,
        status: success ? 'SUCCESS' : 'FAIL',
        reason: success
          ? `FT corners ${finalCorners} = HT ${htCorners} + H2 ${h2Corners}; +${margin} vs pre-match ${benchmarkLine}`
          : `FT corners ${finalCorners} = HT ${htCorners} + H2 ${h2Corners}; +${margin} vs pre-match ${benchmarkLine}`,
      });
    }
  }

  return out;
}

function confidenceForSamples(samples: number): MethodStats['confidenceLabel'] {
  return samples >= 20 ? 'ESTABLISHED' : samples >= 8 ? 'DEVELOPING' : 'LOW_SAMPLE';
}

function smoothedRate(successes: number, samples: number) {
  const priorN = 8;
  return Math.round(((successes + priorN * 0.5) / (samples + priorN)) * 1000) / 10;
}

export function computeMethodStats(rows: TradingMatch[]): MethodStats[] {
  const map = new Map<string, { key: string; market: 'H2_GOALS' | 'H2_CORNERS'; successes: number; failures: number }>();

  for (const row of rows) {
    if (row.researchPhase !== 'FT' || row.ftVerified !== true ||
      !hasVerifiedHtEvidence(row) ||
      !/^API-Football fixture \d+/.test(row.ftSourceSummary ?? '')) continue;

    const outcomes = evaluateMethodOutcomes(row);
    for (const outcome of outcomes) {
      if (outcome.status !== 'SUCCESS' && outcome.status !== 'FAIL') continue;
      const id = `${outcome.market}|${outcome.setupKey}`;
      const bucket = map.get(id) ?? { key: outcome.setupKey, market: outcome.market, successes: 0, failures: 0 };
      if (outcome.status === 'SUCCESS') bucket.successes += 1;
      else bucket.failures += 1;
      map.set(id, bucket);
    }
  }

  return Array.from(map.values()).map(bucket => {
    const samples = bucket.successes + bucket.failures;
    return {
      key: bucket.key,
      market: bucket.market,
      samples,
      successes: bucket.successes,
      failures: bucket.failures,
      observedWinRate: samples ? Math.round((bucket.successes / samples) * 1000) / 10 : 0,
      smoothedWinRate: smoothedRate(bucket.successes, samples),
      confidenceLabel: confidenceForSamples(samples),
    };
  }).sort((a, b) => b.samples - a.samples);
}

export function computeMethodOverall(rows: TradingMatch[]): MethodOverallStats {
  let successes = 0;
  let failures = 0;

  for (const row of rows) {
    if (row.researchPhase !== 'FT' || row.ftVerified !== true ||
      !hasVerifiedHtEvidence(row) ||
      !/^API-Football fixture \d+/.test(row.ftSourceSummary ?? '')) continue;

    const outcomes = evaluateMethodOutcomes(row);
    for (const outcome of outcomes) {
      if (outcome.status === 'SUCCESS') successes += 1;
      else if (outcome.status === 'FAIL') failures += 1;
    }
  }

  const samples = successes + failures;
  return {
    samples,
    successes,
    failures,
    observedWinRate: samples ? Math.round((successes / samples) * 1000) / 10 : 0,
    smoothedWinRate: smoothedRate(successes, samples),
    confidenceLabel: confidenceForSamples(samples),
  };
}
