import { NextRequest, NextResponse } from 'next/server';
import { TradingMatch } from '../../../lib/types';
import { saveResearchBatch } from '../../../lib/researchStore';
import { buildH2Predictions, gradeMatchPredictions } from '../../../lib/outcomes';
import { deriveH2Execution } from '../../../lib/h2Execution';
import { collectVerifiedFt } from '../../../lib/verifiedFt';
import { fetchVerifiedHt } from '../../../lib/verifiedHt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const MAX_BATCH_MATCHES = 10;
let ftJobRunning = false;
let htJobRunning = false;

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function htEvaluate(match: TradingMatch, row: any): TradingMatch {
  const verified = row.htVerified === true && row.htSourceType === 'API_FOOTBALL';
  const scoreHome = verified ? nullableNumber(row.scoreHome) : null;
  const scoreAway = verified ? nullableNumber(row.scoreAway) : null;
  const cornersHome = verified ? nullableNumber(row.cornersHome) : null;
  const cornersAway = verified ? nullableNumber(row.cornersAway) : null;
  const totalCorners = cornersHome != null && cornersAway != null ? cornersHome + cornersAway : null;
  const is00 = scoreHome === 0 && scoreAway === 0;
  const favouriteCovering = verified && row.favouriteCoveringHandicap === true;
  const favouriteLosing = verified && row.favouriteLosing === true;
  const goalClear = verified && row.ftGoalOverClear === true;

  let htAction: TradingMatch['htAction'] = 'NEED_INPUT';
  let htEvaluationType: TradingMatch['htEvaluationType'] = 'NEED_INPUT';
  let h2GoalsAssessment: TradingMatch['h2GoalsAssessment'] = 'UNRESOLVED';
  let h2CornersAssessment: TradingMatch['h2CornersAssessment'] = 'UNRESOLVED';
  let reason = 'HT score/corners are not sufficiently verified for V1.';

  if (totalCorners != null && totalCorners > 5) {
    htAction = 'NO_ENTRY';
    htEvaluationType = 'V1_CANCEL_DATA';
    h2GoalsAssessment = 'V1_NOT_SUPPORTED';
    h2CornersAssessment = 'V1_NOT_SUPPORTED';
    reason = `V1 cancelled: HT corners ${totalCorners} > 5. Snapshot retained as control/training data.`;
  } else if (totalCorners != null && totalCorners <= 5 && is00) {
    htAction = 'H2_GOALS_AND_CORNERS';
    htEvaluationType = 'V1_TRIGGER';
    h2GoalsAssessment = 'V1_SUPPORTED';
    h2CornersAssessment = 'V1_SUPPORTED';
    reason = `V1 trigger: HT 0-0 and corners ${totalCorners} <= 5 -> H2 Goals + H2 Corners.`;
  } else if (totalCorners != null && totalCorners <= 5 && (favouriteCovering || favouriteLosing || goalClear)) {
    htAction = 'H2_CORNERS';
    htEvaluationType = 'V1_TRIGGER';
    h2GoalsAssessment = 'V1_NOT_SUPPORTED';
    h2CornersAssessment = 'V1_SUPPORTED';
    reason = `V1 trigger: HT corners ${totalCorners} <= 5 plus favourite/FT-goals condition -> H2 Corners.`;
  }

  const checkedAt = new Date().toISOString();
  const base: TradingMatch = {
    ...match,
    status: htEvaluationType === 'NEED_INPUT' ? match.status : 'HT',
    scoreHome: scoreHome ?? match.scoreHome,
    scoreAway: scoreAway ?? match.scoreAway,
    cornersHome: cornersHome ?? match.cornersHome,
    cornersAway: cornersAway ?? match.cornersAway,
    htScoreHome: scoreHome,
    htScoreAway: scoreAway,
    htCornersHome: cornersHome,
    htCornersAway: cornersAway,
    liveGoalLine: nullableNumber(row.liveGoalLine),
    liveCornerLine: nullableNumber(row.liveCornerLine),
    favouriteCoveringHandicap: favouriteCovering,
    favouriteLosing,
    ftGoalOverClear: goalClear,
    redCardsHome: nullableNumber(row.redCardsHome) ?? 0,
    redCardsAway: nullableNumber(row.redCardsAway) ?? 0,
    htAction,
    htVerified: verified,
    htSourceType: verified ? 'API_FOOTBALL' : 'GPT_UNVERIFIED',
    htAdvice: reason,
    htConfidence: verified && totalCorners != null && scoreHome != null && scoreAway != null ? 'MEDIUM' : 'LOW',
    htMissingInputs: Array.isArray(row.missingInputs) ? row.missingInputs : [],
    htSourceSummary: typeof row.sourceSummary === 'string' ? row.sourceSummary : 'HT not verified',
    htSourceUrls: Array.isArray(row.sourceUrls) ? row.sourceUrls.filter((x: unknown) => typeof x === 'string') : [],
    htCheckedAt: htEvaluationType === 'NEED_INPUT' ? null : checkedAt,
    checkedAt,
    researchPhase: htEvaluationType === 'NEED_INPUT' ? undefined : 'HT',
    htEvaluationType,
    h2GoalsAssessment,
    h2CornersAssessment,
    htDataNote: reason,
  };

  const execution = deriveH2Execution(base);
  return {
    ...base,
    h2ExecutionAction: execution.action,
    h2ExecutionText: execution.text,
    h2ExecutionDetail: execution.detail,
    h2Predictions: buildH2Predictions(base),
  };
}


function ftEvaluate(match: TradingMatch, row: any): TradingMatch {
  const ftScoreHome = nullableNumber(row.scoreHome);
  const ftScoreAway = nullableNumber(row.scoreAway);
  const ftCornersHome = nullableNumber(row.cornersHome);
  const ftCornersAway = nullableNumber(row.cornersAway);
  const matchEnded = row.matchEnded === true;

  const recoveredHtScoreHome = nullableNumber(row.htScoreHome) ?? match.htScoreHome ?? null;
  const recoveredHtScoreAway = nullableNumber(row.htScoreAway) ?? match.htScoreAway ?? null;
  const recoveredHtCornersHome = nullableNumber(row.htCornersHome) ?? match.htCornersHome ?? null;
  const recoveredHtCornersAway = nullableNumber(row.htCornersAway) ?? match.htCornersAway ?? null;

  const htGoals = recoveredHtScoreHome != null && recoveredHtScoreAway != null
    ? recoveredHtScoreHome + recoveredHtScoreAway : null;
  const htCorners = recoveredHtCornersHome != null && recoveredHtCornersAway != null
    ? recoveredHtCornersHome + recoveredHtCornersAway : null;
  const ftGoals = ftScoreHome != null && ftScoreAway != null ? ftScoreHome + ftScoreAway : null;
  const ftCorners = ftCornersHome != null && ftCornersAway != null ? ftCornersHome + ftCornersAway : null;

  // Inconsistent HT/FT snapshots must not be silently clamped to zero.
  const h2ActualGoals = htGoals != null && ftGoals != null && ftGoals >= htGoals ? ftGoals - htGoals : null;
  const h2ActualCorners = htCorners != null && ftCorners != null && ftCorners >= htCorners ? ftCorners - htCorners : null;
  const checkedAt = new Date().toISOString();

  const validFinal = matchEnded &&
    [ftScoreHome, ftScoreAway, ftCornersHome, ftCornersAway].every(n => n != null && Number.isInteger(n) && n >= 0) &&
    /^API-Football fixture \d+/.test(String(row.sourceSummary ?? ''));
  if (!validFinal) {
    return {
      ...match,
      kickoff: typeof row.scheduledKickoff === 'string' && row.scheduledKickoff ? row.scheduledKickoff : match.kickoff,
      status: match.status === 'FT' ? 'HT' : match.status,
      ftVerified: false,
      ftSourceSummary: typeof row.sourceSummary === 'string' ? row.sourceSummary : 'FT not verified',
      ftSourceUrls: Array.isArray(row.sourceUrls) ? row.sourceUrls.filter((x: unknown) => typeof x === 'string') : [],
      checkedAt,
    };
  }

  const base: TradingMatch = {
    ...match,
    status: 'FT',
    watchStatus: undefined,
    scoreHome: ftScoreHome ?? match.scoreHome,
    scoreAway: ftScoreAway ?? match.scoreAway,
    cornersHome: ftCornersHome ?? match.cornersHome,
    cornersAway: ftCornersAway ?? match.cornersAway,
    ftScoreHome,
    ftScoreAway,
    ftCornersHome,
    ftCornersAway,
    htScoreHome: recoveredHtScoreHome,
    htScoreAway: recoveredHtScoreAway,
    htCornersHome: recoveredHtCornersHome,
    htCornersAway: recoveredHtCornersAway,
    redCardsHome: nullableNumber(row.redCardsHome) ?? (match.redCardsHome ?? 0),
    redCardsAway: nullableNumber(row.redCardsAway) ?? (match.redCardsAway ?? 0),
    h2ActualGoals,
    h2ActualCorners,
    ftCheckedAt: checkedAt,
    ftVerified: true,
    checkedAt,
    researchPhase: 'FT',
    ftSourceSummary: typeof row.sourceSummary === 'string' ? row.sourceSummary : 'FT batch web verification',
    ftSourceUrls: Array.isArray(row.sourceUrls) ? row.sourceUrls.filter((x: unknown) => typeof x === 'string') : [],
  };

  return {
    ...base,
    h2Predictions: gradeMatchPredictions(base),
  };
}


export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const phase = body?.phase === 'FT' ? 'FT' : 'HT';
    const matches = (Array.isArray(body?.matches) ? body.matches : []).slice(0, MAX_BATCH_MATCHES) as TradingMatch[];
    if (!matches.length) return NextResponse.json({ providerStatus: 'NO_MATCHES', results: [] });

    if (phase === 'HT') {
      if (!process.env.API_FOOTBALL_KEY) {
        return NextResponse.json({
          providerStatus: 'HT_DATA_PROVIDER_MISSING', results: [],
          message: 'HT Batch blocked before GPT cost: reliable live statistics provider not configured. Do not follow old GPT HT recommendations.',
          webCalls: 0, estimatedCostUsd: 0,
        });
      }
      if (htJobRunning) return NextResponse.json({
        providerStatus: 'HT_CHECK_ALREADY_RUNNING', results: [],
        message: 'HT Batch already running. No duplicate provider requests.',
        webCalls: 0, estimatedCostUsd: 0,
      });
      htJobRunning = true;
      try {
        const results: TradingMatch[] = [];
        let verifiedCount = 0;
        for (const match of matches) {
          const report = await fetchVerifiedHt(match);
          if (report.providerStatus === 'CONNECTED' && report.snapshot) {
            const snap = report.snapshot;
            const isFavouriteHome = match.favourite === 'HOME';
            const diff = isFavouriteHome ? snap.scoreHome - snap.scoreAway : snap.scoreAway - snap.scoreHome;
            const favVerified = match.handicapVerified === true &&
              Number.isFinite(match.handicap);
            const favouriteCoveringHandicap = favVerified && diff + match.handicap > 0;
            const favouriteLosing = favVerified && diff < 0;
            const ftGoalOverClear = (snap.scoreHome + snap.scoreAway) > Math.ceil(match.prematchGoalLine);
            results.push(htEvaluate(match, {
              ...snap, favouriteCoveringHandicap, favouriteLosing, ftGoalOverClear,
            }));
            verifiedCount++;
          } else {
            results.push(htEvaluate(match, {
              htVerified: false, scoreHome: null, scoreAway: null,
              cornersHome: null, cornersAway: null,
              sourceSummary: report.advice || 'HT not verified',
              missingInputs: ['Verified HT score', 'Verified HT corners'],
            }));
          }
        }
        const snapshots = results.filter(m => m.htVerified === true);
        if (snapshots.length) await saveResearchBatch(snapshots);
        return NextResponse.json({
          providerStatus: 'CONNECTED', phase: 'HT', results,
          verifiedCount, pendingCount: results.length - verifiedCount,
          webCalls: 0, estimatedCostUsd: 0,
        }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
      } finally {
        htJobRunning = false;
      }
    }

    if (ftJobRunning) return NextResponse.json({
      providerStatus: 'FT_CHECK_ALREADY_RUNNING', message: 'FT verification is already running.',
      results: [], webCalls: 0, estimatedCostUsd: 0,
    });
    ftJobRunning = true;
    try {
      const report = await collectVerifiedFt(matches);
      if (report.providerStatus !== 'CONNECTED') return NextResponse.json({
        providerStatus: report.providerStatus, message: report.message,
        results: [], webCalls: 0, estimatedCostUsd: 0,
      });
      const byId = new Map(report.rows.map(row => [row.id, row]));
      const results = matches.map(match => ftEvaluate(match,
        byId.get(match.id) ?? { id: match.id, matchEnded: false, sourceSummary: 'No verified fixture', sourceUrls: [] }));
      const verified = results.filter(m => m.status === 'FT' && m.ftVerified === true);
      if (verified.length) await saveResearchBatch(verified);
      return NextResponse.json({
        providerStatus: 'CONNECTED', phase: 'FT', results,
        verifiedCount: verified.length, pendingCount: results.length - verified.length,
        providerRequests: report.requests, cachedResults: report.cached, cooldownSkipped: report.deferred,
        webCalls: 0, estimatedCostUsd: 0,
      }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
    } finally {
      ftJobRunning = false;
    }
  } catch (error) {
    console.error('V1 batch verification error', error);
    return NextResponse.json({
      providerStatus: 'ERROR', results: [],
      message: error instanceof Error ? error.message : 'Unknown batch verification error',
    }, { status: 200 });
  }
}
