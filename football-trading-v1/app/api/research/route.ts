import { NextRequest, NextResponse } from 'next/server';
import { deleteResearchMatch, deleteResearchPhase, listResearch, saveResearch } from '../../../lib/researchStore';
import { buildH2Predictions, computeMethodOverall, computeMethodStats, computeSetupStats, evaluateMethodOutcomes, gradeMatchPredictions } from '../../../lib/outcomes';
import { TradingMatch } from '../../../lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// One historical HT snapshot lost its captured Bet365 lines during the old
// HT->FT merge bug. Restore only the exact lines that were already verified
// for that fixture so the final record can be graded correctly.
function restoreLegacyBet365Lines(row: TradingMatch): TradingMatch {
  // User-confirmed Bet365 HT live total-corners line for RB Bragantino vs Cruzeiro.
  if (String(row.id) === '1492402' && row.htAction === 'H2_CORNERS') {
    return {
      ...row,
      liveCornerLine: row.liveCornerLine ?? 11.5,
      h2Predictions: (row.h2Predictions ?? []).map(p =>
        p.market === 'H2_CORNERS' && p.line == null
          ? { ...p, line: 11.5, active: true }
          : p
      ),
    };
  }

  if (String(row.id) === '1490537') {
    return {
      ...row,
      liveGoalLine: row.liveGoalLine ?? 1.5,
      liveCornerLine: row.liveCornerLine ?? 10.5,
      htAction: row.htAction ?? 'H2_GOALS_AND_CORNERS',
      h2GoalsAssessment: row.h2GoalsAssessment ?? 'V1_SUPPORTED',
      h2CornersAssessment: row.h2CornersAssessment ?? 'V1_SUPPORTED',
    };
  }

  if (String(row.id) === '1492402') {
    return {
      ...row,
      liveCornerLine: row.liveCornerLine ?? 11.5,
      htAction: row.htAction ?? 'H2_CORNERS',
      h2CornersAssessment: row.h2CornersAssessment ?? 'V1_SUPPORTED',
    };
  }

  return row;
}

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
      // Older web-search FT snapshots may have plausible-looking but unverified data.
      // Do not publish their grades or count them in research statistics.
      const trustedFt = ft.ftVerified === true &&
        /^API-Football fixture \d+/.test(ft.ftSourceSummary ?? '') &&
        [ft.ftScoreHome, ft.ftScoreAway, ft.ftCornersHome, ft.ftCornersAway]
          .every(v => v != null && Number.isInteger(v) && v >= 0);
      const verifiedHt = ht && ht.htVerified === true && ht.htSourceType === 'API_FOOTBALL';
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

      const predictions = (verifiedHt && ht?.h2Predictions?.length ? ht.h2Predictions : buildH2Predictions(mergedBase));
      const gradedPredictions = trustedFt && (verifiedHt || (ft.htVerified === true && ft.htSourceType === 'API_FOOTBALL'))
        ? gradeMatchPredictions({ ...mergedBase, h2Predictions: predictions })
        : predictions.map(p => ({ ...p, actual: null, grade: 'UNRESOLVED' as const }));
      const mergedFinal: TradingMatch = {
        ...mergedBase,
        ftVerified: trustedFt,
        htVerified: Boolean(verifiedHt || (ft.htVerified === true && ft.htSourceType === 'API_FOOTBALL')),
        h2ActualGoals: trustedFt ? mergedBase.h2ActualGoals : null,
        h2ActualCorners: trustedFt ? mergedBase.h2ActualCorners : null,
        h2Predictions: gradedPredictions,
      };
      combined.push({
        ...mergedFinal,
        methodOutcomes: evaluateMethodOutcomes(mergedFinal),
      });
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
  const rawRows = (await listResearch(500)).map(restoreLegacyBet365Lines).filter(row => {
    if (row.status !== 'FT' && row.researchPhase !== 'FT') return true;
    if (row.ftVerified === true) return true;
    const sh = row.ftScoreHome ?? row.scoreHome;
    const sa = row.ftScoreAway ?? row.scoreAway;
    const ch = row.ftCornersHome ?? row.cornersHome;
    const ca = row.ftCornersAway ?? row.cornersAway;
    return !(sh === 0 && sa === 0 && ch === 0 && ca === 0);
  });
  // History is a final-result view: keep HT snapshots internally only until FT arrives,
  // but return one consolidated verified FT record per match.
  const rows = combineResearch(rawRows).filter(row => row.researchPhase === 'FT' && row.ftVerified === true);
  const stats = computeSetupStats(rows);
  const methodStats = computeMethodStats(rows);
  const methodOverall = computeMethodOverall(rows);
  return NextResponse.json({ rows, stats, methodStats, methodOverall }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
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


export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const scope = url.searchParams.get('scope')?.trim().toLowerCase();

    if (scope === 'ht') {
      const deleted = await deleteResearchPhase('HT');
      return NextResponse.json(
        { ok: true, deleted, scope: 'HT' },
        { headers: { 'Cache-Control': 'no-store, max-age=0' } }
      );
    }

    const id = url.searchParams.get('id')?.trim();
    if (!id) {
      return NextResponse.json({ ok: false, error: 'Missing match id' }, { status: 400 });
    }

    const deleted = await deleteResearchMatch(id);
    return NextResponse.json(
      { ok: true, deleted, id },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Could not delete history data',
    }, { status: 200 });
  }
}
