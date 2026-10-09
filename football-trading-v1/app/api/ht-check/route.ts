import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

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
  const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('HT scanner returned no JSON');
  return JSON.parse(clean.slice(start, end + 1));
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      providerStatus: 'OPENAI_API_KEY_MISSING',
      advice: 'OPENAI_API_KEY is not connected yet.',
    }, { status: 200 });
  }

  try {
    const match = await req.json();
    const prompt = `You are the HT decision assistant for a private football trading app.

The user has already qualified this match pre-match using ONLY this V1 rule:
- FT total corners line >= 10
- FT Asian total goals line >= 2.75

Match:
League: ${match.league}
Home: ${match.home}
Away: ${match.away}
Kickoff: ${match.kickoff}
Pre-match total corners: ${match.prematchCornerLine}
Pre-match Asian total goals: ${match.prematchGoalLine}
Pre-match favourite: ${match.favourite}
Pre-match handicap: ${match.handicap}

Your job is ONLY to evaluate the H2 path using the user's exact V1 HT theory below. Do not introduce xG, possession models, form, expected corners, tipster methods, or any external betting system.

V1 HT rules:
1) If HT total corners <= 5 AND score is 0-0:
   -> H2 OVER GOALS + H2 OVER CORNERS
2) If HT total corners <= 5 AND favourite is covering the FT handicap:
   -> H2 OVER CORNERS
3) If HT total corners <= 5 AND FT Over Goals is already clear:
   -> H2 OVER CORNERS
4) If HT total corners <= 5 AND favourite is losing:
   -> H2 OVER CORNERS
5) If HT total corners > 5:
   -> NO V1 ENTRY / CANCEL for this setup.
6) Relevant H2 goal line range currently tracked: 1.25 to 2.0
7) H2 corner line is CONTEXTUAL, not a fixed 8.5+ requirement. When HT has only 2-3 corners, an H2 corner line around 7-8 can be completely normal and can still qualify if the V1 trigger conditions are aligned. Record the exact H2 corner line, but do NOT reject a valid V1 corner setup only because the line is below 8.5.

Use web search to verify the LIVE/HT state of this exact match. PRIORITY ORDER:
1) Verify that the match is actually at halftime (HT, halftime, interval, or 45'+ with the first half ended).
2) Verify the HT score.
3) Verify HT corners for both teams.
4) Only after that, look for current H2 goal/corner lines and favourite state if needed.

IMPORTANT DECISION RULES:
- H2 live lines are OPTIONAL for deciding the V1 action. They help execution, but missing H2 lines must NOT force NEED_INPUT if the HT score/corners already trigger a V1 rule.
- If verified HT corners > 5 -> action NO_ENTRY immediately.
- If verified HT corners <= 5 AND verified HT score is 0-0 -> action H2_GOALS_AND_CORNERS immediately. Do NOT require favourite state or live H2 lines.
- If HT corners <= 5 and score is not 0-0, then use favourite covering / favourite losing / FT Over clear to decide H2_CORNERS.
- Return NEED_INPUT only when the verified HT score/corners are insufficient to determine any V1 rule.
- IMPORTANT: even when action is NO_ENTRY, still evaluate the snapshot for research/history. Set evaluationType to V1_CANCEL_DATA, explain exactly why V1 cancelled, and mark H2 goals/corners as V1_SUPPORTED, V1_NOT_SUPPORTED, or UNRESOLVED based ONLY on the user's existing V1 rules. Do not invent a new betting system.
- A NO_ENTRY snapshot is still valuable training data and must include dataNote.
- Search specifically for this exact fixture using team names + halftime/HT + corners. Prefer live-score/stat sources over prediction pages.
- Never treat a pre-HT update (for example minute 40-44) as a verified halftime state.
- Never guess live odds or corners. Missing optional data should be null and listed in missingInputs, but should not cancel an otherwise valid V1 decision.

Return ONLY valid JSON:
{
  "scoreHome": number|null,
  "scoreAway": number|null,
  "cornersHome": number|null,
  "cornersAway": number|null,
  "liveGoalLine": number|null,
  "liveCornerLine": number|null,
  "favouriteCoveringHandicap": boolean|null,
  "favouriteLosing": boolean|null,
  "ftGoalOverClear": boolean|null,
  "action": "H2_GOALS_AND_CORNERS"|"H2_CORNERS"|"NO_ENTRY"|"NEED_INPUT",
  "confidence": "HIGH"|"MEDIUM"|"LOW",
  "reason": "short explanation using only the V1 rules",
  "missingInputs": ["..."],
  "sourceSummary": "short source description",
  "sourceUrls": ["https://..."],
  "evaluationType": "V1_TRIGGER|V1_CANCEL_DATA|NEED_INPUT",
  "h2GoalsAssessment": "V1_SUPPORTED|V1_NOT_SUPPORTED|UNRESOLVED",
  "h2CornersAssessment": "V1_SUPPORTED|V1_NOT_SUPPORTED|UNRESOLVED",
  "dataNote": "short structured research note describing what V1 says and what this snapshot is useful for later analysis"
}`;

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_SCAN_MODEL || 'gpt-6-luna',
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        max_tool_calls: 5,
        max_output_tokens: 3500,
        input: prompt,
      }),
      cache: 'no-store',
    });

    const raw = await res.json();
    if (!res.ok) throw new Error(raw?.error?.message || `OpenAI HTTP ${res.status}`);

    const parsed = parseJson(extractText(raw));
    return NextResponse.json({
      providerStatus: 'CONNECTED',
      checkedAt: new Date().toISOString(),
      ...parsed,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    console.error('GPT HT check error', error);
    return NextResponse.json({
      providerStatus: 'ERROR',
      advice: error instanceof Error ? error.message : 'Unknown HT scanner error',
    }, { status: 200 });
  }
}
