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
6) Relevant H2 goal line range: 1.25 to 2.0
7) Relevant H2 corner line: 8.5 or higher

Use web search to verify the LIVE/HT state of this exact match if available:
- HT score
- HT corners
- current/live H2 goal line if publicly available
- current/live H2 corner line if publicly available
- whether the pre-match favourite is covering or losing
- whether FT Over Goals is already clearly settled/clear according to the user's rule context

Never guess live odds or corners. If a required live datum cannot be verified, set it to null and say what the user should manually enter.

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
  "sourceUrls": ["https://..."]
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
