import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { TradingMatch } from '../../../lib/types';
import { saveResearchBatch } from '../../../lib/researchStore';
import { buildH2Predictions, gradeMatchPredictions } from '../../../lib/outcomes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LIVE_BUDGET_FILE = process.env.V1_LIVE_BUDGET_FILE || '/data/v1-live-budget.json';
const DAILY_WEB_CALL_CAP = Number(process.env.V1_LIVE_DAILY_WEB_CALL_CAP ?? 8);
const MAX_HT_WEB_CALLS = Number(process.env.V1_HT_BATCH_MAX_WEB_CALLS ?? 4);
const MAX_FT_WEB_CALLS = Number(process.env.V1_FT_BATCH_MAX_WEB_CALLS ?? 3);
const MAX_BATCH_MATCHES = 10;

type Budget = { day: string; webCalls: number; estimatedCostUsd: number };

function torontoDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function readBudget(): Promise<Budget> {
  try {
    const raw = await fs.readFile(LIVE_BUDGET_FILE, 'utf8');
    const data = JSON.parse(raw) as Budget;
    if (data.day !== torontoDay()) return { day: torontoDay(), webCalls: 0, estimatedCostUsd: 0 };
    return data;
  } catch {
    return { day: torontoDay(), webCalls: 0, estimatedCostUsd: 0 };
  }
}

async function writeBudget(budget: Budget) {
  await fs.mkdir(path.dirname(LIVE_BUDGET_FILE), { recursive: true });
  const temp = `${LIVE_BUDGET_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(budget), 'utf8');
  await fs.rename(temp, LIVE_BUDGET_FILE);
}

function extractText(response: any): string {
  if (typeof response?.output_text === 'string') return response.output_text;
  const chunks: string[] = [];
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n');
}

function parseJson(text: string) {
  const clean = text.replace(/\`\`\`json/gi, '').replace(/\`\`\`/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Live batch returned no JSON');
  return JSON.parse(clean.slice(start, end + 1));
}

function countWebCalls(response: any) {
  return Array.isArray(response?.output)
    ? response.output.filter((item: any) => item?.type === 'web_search_call').length
    : 0;
}

function htEvaluate(match: TradingMatch, row: any): TradingMatch {
  const scoreHome = Number.isFinite(Number(row.scoreHome)) ? Number(row.scoreHome) : null;
  const scoreAway = Number.isFinite(Number(row.scoreAway)) ? Number(row.scoreAway) : null;
  const cornersHome = Number.isFinite(Number(row.cornersHome)) ? Number(row.cornersHome) : null;
  const cornersAway = Number.isFinite(Number(row.cornersAway)) ? Number(row.cornersAway) : null;
  const totalCorners = cornersHome != null && cornersAway != null ? cornersHome + cornersAway : null;
  const is00 = scoreHome === 0 && scoreAway === 0;
  const favouriteCovering = row.favouriteCoveringHandicap === true;
  const favouriteLosing = row.favouriteLosing === true;
  const goalClear = row.ftGoalOverClear === true;

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
    status: 'HT',
    scoreHome: scoreHome ?? match.scoreHome,
    scoreAway: scoreAway ?? match.scoreAway,
    cornersHome: cornersHome ?? match.cornersHome,
    cornersAway: cornersAway ?? match.cornersAway,
    htScoreHome: scoreHome,
    htScoreAway: scoreAway,
    htCornersHome: cornersHome,
    htCornersAway: cornersAway,
    liveGoalLine: Number.isFinite(Number(row.liveGoalLine)) ? Number(row.liveGoalLine) : null,
    liveCornerLine: Number.isFinite(Number(row.liveCornerLine)) ? Number(row.liveCornerLine) : null,
    favouriteCoveringHandicap: favouriteCovering,
    favouriteLosing,
    ftGoalOverClear: goalClear,
    redCardsHome: Number.isFinite(Number(row.redCardsHome)) ? Number(row.redCardsHome) : 0,
    redCardsAway: Number.isFinite(Number(row.redCardsAway)) ? Number(row.redCardsAway) : 0,
    htAction,
    htAdvice: reason,
    htConfidence: totalCorners != null && scoreHome != null && scoreAway != null ? 'HIGH' : 'LOW',
    htMissingInputs: Array.isArray(row.missingInputs) ? row.missingInputs : [],
    htSourceSummary: typeof row.sourceSummary === 'string' ? row.sourceSummary : 'HT batch web verification',
    htSourceUrls: Array.isArray(row.sourceUrls) ? row.sourceUrls.filter((x: unknown) => typeof x === 'string') : [],
    htCheckedAt: checkedAt,
    checkedAt,
    researchPhase: 'HT',
    htEvaluationType,
    h2GoalsAssessment,
    h2CornersAssessment,
    htDataNote: reason,
  };

  return {
    ...base,
    h2Predictions: buildH2Predictions(base),
  };
}

function ftEvaluate(match: TradingMatch, row: any): TradingMatch {
  const ftScoreHome = Number.isFinite(Number(row.scoreHome)) ? Number(row.scoreHome) : null;
  const ftScoreAway = Number.isFinite(Number(row.scoreAway)) ? Number(row.scoreAway) : null;
  const ftCornersHome = Number.isFinite(Number(row.cornersHome)) ? Number(row.cornersHome) : null;
  const ftCornersAway = Number.isFinite(Number(row.cornersAway)) ? Number(row.cornersAway) : null;

  const htGoals = match.htScoreHome != null && match.htScoreAway != null
    ? match.htScoreHome + match.htScoreAway : null;
  const htCorners = match.htCornersHome != null && match.htCornersAway != null
    ? match.htCornersHome + match.htCornersAway : null;
  const ftGoals = ftScoreHome != null && ftScoreAway != null ? ftScoreHome + ftScoreAway : null;
  const ftCorners = ftCornersHome != null && ftCornersAway != null ? ftCornersHome + ftCornersAway : null;

  const h2ActualGoals = htGoals != null && ftGoals != null ? Math.max(0, ftGoals - htGoals) : null;
  const h2ActualCorners = htCorners != null && ftCorners != null ? Math.max(0, ftCorners - htCorners) : null;
  const checkedAt = new Date().toISOString();

  const base: TradingMatch = {
    ...match,
    status: 'FT',
    scoreHome: ftScoreHome ?? match.scoreHome,
    scoreAway: ftScoreAway ?? match.scoreAway,
    cornersHome: ftCornersHome ?? match.cornersHome,
    cornersAway: ftCornersAway ?? match.cornersAway,
    ftScoreHome,
    ftScoreAway,
    ftCornersHome,
    ftCornersAway,
    redCardsHome: Number.isFinite(Number(row.redCardsHome)) ? Number(row.redCardsHome) : (match.redCardsHome ?? 0),
    redCardsAway: Number.isFinite(Number(row.redCardsAway)) ? Number(row.redCardsAway) : (match.redCardsAway ?? 0),
    h2ActualGoals,
    h2ActualCorners,
    ftCheckedAt: checkedAt,
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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ providerStatus: 'OPENAI_API_KEY_MISSING', results: [] });

  try {
    const body = await req.json();
    const phase = body?.phase === 'FT' ? 'FT' : 'HT';
    const matches = (Array.isArray(body?.matches) ? body.matches : []).slice(0, MAX_BATCH_MATCHES) as TradingMatch[];
    if (!matches.length) return NextResponse.json({ providerStatus: 'NO_MATCHES', results: [] });

    const budget = await readBudget();
    const remaining = Math.max(0, DAILY_WEB_CALL_CAP - budget.webCalls);
    if (remaining <= 0) {
      return NextResponse.json({
        providerStatus: 'DAILY_LIVE_BUDGET_REACHED',
        results: [],
        budget,
      });
    }

    const maxCalls = Math.min(remaining, phase === 'HT' ? MAX_HT_WEB_CALLS : MAX_FT_WEB_CALLS);
    const compact = matches.map(m => ({
      id: m.id, league: m.league, home: m.home, away: m.away, kickoff: m.kickoff,
      favourite: m.favourite, handicap: m.handicap,
    }));

    const phaseInstructions = phase === 'HT'
      ? `For EVERY match, verify the actual halftime state. Return scoreHome, scoreAway, cornersHome, cornersAway, liveGoalLine if visible, liveCornerLine if visible, favouriteCoveringHandicap if verifiable, favouriteLosing if verifiable, ftGoalOverClear if clearly verifiable, redCardsHome, redCardsAway, missingInputs, sourceSummary, sourceUrls. Prioritize exact HT score/corners over optional live odds. Never guess. A red card is research context only; do not create a new V1 rule from it.`
      : `For EVERY match, verify the FINAL full-time state. Return scoreHome, scoreAway, cornersHome, cornersAway, redCardsHome, redCardsAway, missingInputs, sourceSummary, sourceUrls. Never guess. Prefer official/live-score/stat pages.`;

    const prompt = `You are a low-cost batch data collector for a private football V1 research app.
Do NOT invent betting logic. Your only job is to collect verified match data for multiple fixtures in as few web searches as possible.
Batch searches are preferred over one search per fixture.

PHASE: ${phase}
MATCHES:
${JSON.stringify(compact)}

${phaseInstructions}

Return valid JSON only:
{
  "rows": [
    {
      "id": "same id supplied",
      "scoreHome": number|null,
      "scoreAway": number|null,
      "cornersHome": number|null,
      "cornersAway": number|null,
      "liveGoalLine": number|null,
      "liveCornerLine": number|null,
      "favouriteCoveringHandicap": boolean|null,
      "favouriteLosing": boolean|null,
      "ftGoalOverClear": boolean|null,
      "redCardsHome": number|null,
      "redCardsAway": number|null,
      "missingInputs": [],
      "sourceSummary": "short",
      "sourceUrls": ["https://..."]
    }
  ]
}
Include one row for every supplied id even when some fields are null.`;

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_SCAN_MODEL || 'gpt-6-luna',
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        max_tool_calls: maxCalls,
        max_output_tokens: 5000,
        input: prompt,
      }),
      cache: 'no-store',
    });

    const raw = await res.json();
    if (!res.ok) throw new Error(raw?.error?.message || `OpenAI HTTP ${res.status}`);

    const webCalls = countWebCalls(raw);
    const inputTokens = Number(raw?.usage?.input_tokens ?? 0);
    const outputTokens = Number(raw?.usage?.output_tokens ?? 0);
    const estimatedCostUsd = webCalls * 0.01 + inputTokens * 0.10 / 1_000_000 + outputTokens * 0.50 / 1_000_000;

    budget.webCalls += webCalls;
    budget.estimatedCostUsd = Number((budget.estimatedCostUsd + estimatedCostUsd).toFixed(6));
    await writeBudget(budget);

    const parsed = parseJson(extractText(raw));
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const byId = new Map(rows.map((row: any) => [String(row.id), row]));

    const results = matches.map(match => {
      const row = byId.get(match.id) ?? { id: match.id, missingInputs: ['match data not verified'] };
      return phase === 'HT' ? htEvaluate(match, row) : ftEvaluate(match, row);
    });

    await saveResearchBatch(results);

    return NextResponse.json({
      providerStatus: 'CONNECTED',
      phase,
      results,
      webCalls,
      inputTokens,
      outputTokens,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
      dailyLiveWebCalls: budget.webCalls,
      dailyLiveEstimatedCostUsd: budget.estimatedCostUsd,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    console.error('V1 live batch error', error);
    return NextResponse.json({
      providerStatus: 'ERROR',
      results: [],
      error: error instanceof Error ? error.message : 'Unknown live batch error',
    }, { status: 200 });
  }
}
