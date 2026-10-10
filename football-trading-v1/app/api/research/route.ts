import { NextRequest, NextResponse } from 'next/server';
import { listResearch, saveResearch } from '../../../lib/researchStore';
import { buildH2Predictions, computeSetupStats, gradeMatchPredictions } from '../../../lib/outcomes';
import { TradingMatch } from '../../../lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function combineResearch(rows: TradingMatch[]) {
  const byMatch = new Map<string, { ht?: TradingMatch; ft?: TradingMatch; other?: TradingMatch }>();

  for (const row of rows) {
    const current = byMatch.get(row.id) ?? {};
    if (row.researchPhase === 'HT') current.ht = row;
    else if (row.researchPhase === 'FT') current.ft = row;
    else if (!current.other) current.other = row;
    byMatch.set(row.id, current);
  }

  const combined: TradingMatch[] = [];
  for (const group of byMatch.values()) {
    if (group.ft) {
      const ht = group.ht;
      const ft = group.ft;
      const verifiedHt = ht && ht.htEvaluationType !== 'NEED_INPUT';
      const htScoreHome = ft.htScoreHome ?? (verifiedHt ? ht?.htScoreHome ?? null : null);
      const htScoreAway = ft.htScoreAway ?? (verifiedHt ? ht?.htScoreAway ?? null : null);
      const htCornersHome = ft.htCornersHome ?? (verifiedHt ? ht?.htCornersHome ?? null : null);
      const htCornersAway = ft.htCornersAway ?? (verifiedHt ? ht?.htCornersAway ?? null : null);

      const ftGoals = ft.ftScoreHome != null && ft.ftScoreAway != null
        ? ft.ftScoreHome + ft.ftScoreAway
        : ft.scoreHome + ft.scoreAway;
      const ftCorners = ft.ftCornersHome != null && ft.ftCornersAway != null
        ? ft.ftCornersHome + ft.ftCornersAway
        : ft.cornersHome + ft.cornersAway;
      const htGoals = htScoreHome != null && htScoreAway != null ? htScoreHome + htScoreAway : null;
      const htCornerTotal = htCornersHome != null && htCornersAway != null ? htCornersHome + htCornersAway : null;

      const mergedBase: TradingMatch = {
        ...(ht ?? ft),
        ...ft,
        htScoreHome,
        htScoreAway,
        htCornersHome,
        htCornersAway,
        htAction: ft.htAction ?? ht?.htAction,
        htAdvice: ft.htAdvice ?? ht?.htAdvice,
        htConfidence: ft.htConfidence ?? ht?.htConfidence,
        htEvaluationType: ft.htEvaluationType ?? ht?.htEvaluationType,
        h2GoalsAssessment: ft.h2GoalsAssessment ?? ht?.h2GoalsAssessment,
        h2CornersAssessment: ft.h2CornersAssessment ?? ht?.h2CornersAssessment,
        htDataNote: ft.htDataNote ?? ht?.htDataNote,
        htMissingInputs: ft.htMissingInputs ?? ht?.htMissingInputs,
        htSourceSummary: ft.htSourceSummary ?? ht?.htSourceSummary,
        htSourceUrls: ft.htSourceUrls?.length ? ft.htSourceUrls : ht?.htSourceUrls,
        htCheckedAt: ft.htCheckedAt ?? ht?.htCheckedAt,
        liveGoalLine: ft.liveGoalLine ?? ht?.liveGoalLine ?? null,
        liveCornerLine: ft.liveCornerLine ?? ht?.liveCornerLine ?? null,
        favouriteCoveringHandicap: ft.favouriteCoveringHandicap ?? ht?.favouriteCoveringHandicap ?? false,
        favouriteLosing: ft.favouriteLosing ?? ht?.favouriteLosing ?? false,
        ftGoalOverClear: ft.ftGoalOverClear ?? ht?.ftGoalOverClear ?? false,
        h2ActualGoals: htGoals != null ? Math.max(0, ftGoals - htGoals) : null,
        h2ActualCorners: htCornerTotal != null ? Math.max(0, ftCorners - htCornerTotal) : null,
        researchPhase: 'FT',
      };

      const predictions = (ft.h2Predictions?.length ? ft.h2Predictions : ht?.h2Predictions?.length ? ht.h2Predictions : buildH2Predictions(mergedBase));
      const gradedPredictions = gradeMatchPredictions({ ...mergedBase, h2Predictions: predictions });
      combined.push({ ...mergedBase, h2Predictions: gradedPredictions });
    } else if (group.ht) {
      combined.push({
        ...group.ht,
        h2Predictions: group.ht.h2Predictions?.length ? group.ht.h2Predictions : buildH2Predictions(group.ht),
      });
    } else if (group.other) {
      combined.push(group.other);
    }
  }

  return combined.sort((a, b) =>
    new Date(b.checkedAt ?? b.ftCheckedAt ?? b.htCheckedAt ?? 0).getTime() -
    new Date(a.checkedAt ?? a.ftCheckedAt ?? a.htCheckedAt ?? 0).getTime()
  );
}

export async function GET() {
  const rawRows = (await listResearch(500)).filter(row => {
    if (row.status !== 'FT' && row.researchPhase !== 'FT') return true;
    if (row.ftVerified === true) return true;
    const sh = row.ftScoreHome ?? row.scoreHome;
    const sa = row.ftScoreAway ?? row.scoreAway;
    const ch = row.ftCornersHome ?? row.cornersHome;
    const ca = row.ftCornersAway ?? row.cornersAway;
    return !(sh === 0 && sa === 0 && ch === 0 && ca === 0);
  });
  const rows = combineResearch(rawRows);
  const stats = computeSetupStats(rows);
  return NextResponse.json({ rows, stats }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}

export async function POST(req: NextRequest) {
  try {
    const snapshot = await req.json();
    await saveResearch(snapshot);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Could not save research snapshot',
    }, { status: 200 });
  }
}
