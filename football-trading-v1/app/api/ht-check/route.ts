import { NextRequest, NextResponse } from 'next/server';
import { TradingMatch } from '../../../lib/types';
import { fetchVerifiedHt } from '../../../lib/verifiedHt';
import { deriveH2Execution } from '../../../lib/h2Execution';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const match = await req.json() as TradingMatch;
    const result = await fetchVerifiedHt(match);
    if (result.providerStatus !== 'CONNECTED' || !result.snapshot) {
      return NextResponse.json({
        providerStatus: result.providerStatus,
        action: 'NEED_INPUT',
        evaluationType: 'NEED_INPUT',
        advice: result.advice || 'Verified halftime data are not available. No entry.',
        h2ExecutionAction: 'WAIT_HT_DATA',
        h2ExecutionText: 'WAIT VERIFIED HT DATA',
        liveGoalLine: null, liveCornerLine: null,
        htVerified: false,
        webCalls: 0, estimatedCostUsd: 0,
      }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
    }
    const snap = result.snapshot;
    const total = snap.cornersHome + snap.cornersAway;
    const is00 = snap.scoreHome === 0 && snap.scoreAway === 0;
    const favouriteDiff = match.favourite === 'HOME'
      ? snap.scoreHome - snap.scoreAway : snap.scoreAway - snap.scoreHome;
    const handicapConfirmed = match.handicapVerified === true && Number.isFinite(match.handicap);
    const favouriteCoveringHandicap = handicapConfirmed && favouriteDiff + match.handicap > 0;
    const favouriteLosing = handicapConfirmed && favouriteDiff < 0;
    const ftGoalOverClear = Number.isFinite(match.prematchGoalLine) &&
      snap.scoreHome + snap.scoreAway > Math.ceil(match.prematchGoalLine);

    const action: TradingMatch['htAction'] = total > 5
      ? 'NO_ENTRY'
      : is00
        ? 'H2_GOALS_AND_CORNERS'
        : favouriteCoveringHandicap || favouriteLosing || ftGoalOverClear
          ? 'H2_CORNERS'
          : 'NO_ENTRY';
    const evaluationType = action === 'NO_ENTRY' ? 'V1_CANCEL_DATA' : 'V1_TRIGGER';
    const reason = total > 5
      ? `NO ENTRY: verified HT corners ${snap.cornersHome}-${snap.cornersAway} = ${total}, above V1 limit of 5.`
      : action === 'H2_GOALS_AND_CORNERS'
        ? `V1 HT 0-0 with ${total} corners (<=5). Verify actual H2 goal and corner lines before executing.`
        : action === 'H2_CORNERS'
          ? `V1 corner-only condition with ${total} HT corners. Verify actual H2 corner line before executing.`
          : `NO ENTRY: ${total} HT corners but no other V1 condition was met.`;

    const execution = deriveH2Execution({
      htAction: action,
      liveGoalLine: null,
      liveCornerLine: null,
    });

    return NextResponse.json({
      providerStatus: 'CONNECTED', ...snap,
      action, evaluationType,
      confidence: 'MEDIUM', reason, dataNote: reason,
      h2GoalsAssessment: action === 'H2_GOALS_AND_CORNERS' ? 'V1_SUPPORTED' : 'V1_NOT_SUPPORTED',
      h2CornersAssessment: action === 'H2_GOALS_AND_CORNERS' || action === 'H2_CORNERS'
        ? 'V1_SUPPORTED' : 'V1_NOT_SUPPORTED',
      favouriteCoveringHandicap, favouriteLosing, ftGoalOverClear,
      missingInputs: action === 'NO_ENTRY' ? [] : action === 'H2_GOALS_AND_CORNERS'
        ? ['Exact H2 goal line', 'Exact H2 corner line'] : ['Exact H2 corner line'],
      h2ExecutionAction: execution.action,
      h2ExecutionText: execution.text,
      h2ExecutionDetail: execution.detail,
      webCalls: 0, estimatedCostUsd: 0,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    return NextResponse.json({
      providerStatus: 'ERROR', action: 'NEED_INPUT', htVerified: false,
      advice: error instanceof Error ? error.message : 'HT verification error',
    }, { status: 200 });
  }
}
