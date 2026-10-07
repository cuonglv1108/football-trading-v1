import { NextResponse } from 'next/server';
import { evaluateV1 } from '../../../lib/rules';
import { League, TradingMatch } from '../../../lib/types';

export const dynamic = 'force-dynamic';

const ALLOWED_LEAGUES: League[] = ['MLS', 'Allsvenskan', 'Liga MX', 'Brazil Serie A'];

type ScanPayload = {
  updatedAt: string;
  mode: 'GPT_WEB_SCAN';
  dataSource: string;
  providerStatus: string;
  matches: TradingMatch[];
  cacheStatus?: 'HIT' | 'MISS';
  nextRefreshAt?: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __v1ScanCache: { payload: ScanPayload; expiresAt: number } | undefined;
  // eslint-disable-next-line no-var
  var __v1ScanInFlight: Promise<ScanPayload> | undefined;
}

const SCAN_CACHE_MS = Number(process.env.GPT_SCAN_CACHE_MS ?? 6 * 60 * 60 * 1000);

function cachedPayload(): ScanPayload | null {
  const hit = globalThis.__v1ScanCache;
  if (!hit || hit.expiresAt <= Date.now()) return null;
  return {
    ...hit.payload,
    cacheStatus: 'HIT',
    nextRefreshAt: new Date(hit.expiresAt).toISOString(),
  };
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
  const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Scanner returned no JSON');
  return JSON.parse(clean.slice(start, end + 1));
}

export async function GET(request: Request) {
  const cached = cachedPayload();
  if (cached) {
    return NextResponse.json(cached, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  const url = new URL(request.url);
  const shouldScan = url.searchParams.get('scan') === '1';

  if (!shouldScan) {
    return NextResponse.json({
      updatedAt: '',
      mode: 'GPT_WEB_SCAN',
      dataSource: 'OpenAI web search',
      providerStatus: 'CACHE_EMPTY',
      matches: [],
      cacheStatus: 'HIT',
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  if (globalThis.__v1ScanInFlight) {
    const shared = await globalThis.__v1ScanInFlight;
    return NextResponse.json({
      ...shared,
      cacheStatus: 'HIT',
      nextRefreshAt: globalThis.__v1ScanCache
        ? new Date(globalThis.__v1ScanCache.expiresAt).toISOString()
        : undefined,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      mode: 'GPT_WEB_SCAN',
      matches: [],
      providerStatus: 'OPENAI_API_KEY_MISSING',
    }, { status: 200, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  const now = new Date();
  const until = new Date(now.getTime() + 72 * 60 * 60 * 1000);

  const prompt = `You are the pre-match web scanner for a private football trading app.

Scan ONLY these leagues for fixtures kicking off between:
START: ${now.toISOString()}
END: ${until.toISOString()}
Leagues: MLS, Allsvenskan, Liga MX, Brazil Serie A.

The user's V1 qualification rule is exact and must not be changed:
- Full-time total corners line must be >= 10.0
- Full-time Asian total goals line must be >= 2.75
- BOTH conditions are required.
- Do not add xG, team-form, probability models, or any other method.
- Prefer Bet365 lines where publicly verifiable. If Bet365 is unavailable, use a reputable odds source that clearly shows the same market/line.
- Never guess a line. If either line cannot be verified, omit that match.
- Return ONLY matches that qualify. Do not return failed matches.
- Search the web as needed to verify fixture time and both lines.

Return valid JSON only, exactly in this shape:
{
  "matches": [
    {
      "league": "MLS|Allsvenskan|Liga MX|Brazil Serie A",
      "home": "string",
      "away": "string",
      "kickoff": "ISO 8601 string",
      "cornerLine": 10.0,
      "goalLine": 2.75,
      "favourite": "HOME|AWAY",
      "handicap": -0.75,
      "sourceSummary": "short source description",
      "sourceUrls": ["https://..."]
    }
  ]
}
If none can be verified, return {"matches":[]}.`;

  const runScan = async (): Promise<ScanPayload> => {
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
    const rows = Array.isArray(parsed?.matches) ? parsed.matches : [];

    const matches: TradingMatch[] = rows
      .filter((m: any) =>
        ALLOWED_LEAGUES.includes(m.league) &&
        Number(m.cornerLine) >= 10 &&
        Number(m.goalLine) >= 2.75 &&
        typeof m.home === 'string' &&
        typeof m.away === 'string'
      )
      .map((m: any, index: number) => {
        const base: TradingMatch = {
          id: `gpt-${String(m.league).replace(/\s+/g, '-').toLowerCase()}-${String(m.home).replace(/\W+/g, '-').toLowerCase()}-${String(m.away).replace(/\W+/g, '-').toLowerCase()}-${index}`,
          league: m.league,
          home: m.home,
          away: m.away,
          minute: null,
          status: 'PRE',
          kickoff: m.kickoff ?? null,
          scoreHome: 0,
          scoreAway: 0,
          cornersHome: 0,
          cornersAway: 0,
          prematchCornerLine: Number(m.cornerLine),
          prematchGoalLine: Number(m.goalLine),
          favourite: m.favourite === 'AWAY' ? 'AWAY' : 'HOME',
          handicap: Number.isFinite(Number(m.handicap)) ? Number(m.handicap) : 0,
          favouriteCoveringHandicap: false,
          favouriteLosing: false,
          ftGoalOverClear: false,
          sourceSummary: typeof m.sourceSummary === 'string' ? m.sourceSummary : 'Web search',
          sourceUrls: Array.isArray(m.sourceUrls) ? m.sourceUrls.filter((u: unknown) => typeof u === 'string') : [],
        };
        return { ...base, ...evaluateV1(base) };
      });

    const payload: ScanPayload = {
      updatedAt: new Date().toISOString(),
      mode: 'GPT_WEB_SCAN',
      dataSource: 'OpenAI web search',
      providerStatus: 'CONNECTED',
      matches,
      cacheStatus: 'MISS',
    };

    globalThis.__v1ScanCache = {
      payload,
      expiresAt: Date.now() + SCAN_CACHE_MS,
    };

    return {
      ...payload,
      nextRefreshAt: new Date(globalThis.__v1ScanCache.expiresAt).toISOString(),
    };
  };

  try {
    globalThis.__v1ScanInFlight = runScan();
    const payload = await globalThis.__v1ScanInFlight;
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    console.error('GPT web scanner error', error);
    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      mode: 'GPT_WEB_SCAN',
      matches: [],
      providerStatus: 'ERROR',
      providerError: error instanceof Error ? error.message : 'Unknown scanner error',
    }, { status: 200, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } finally {
    globalThis.__v1ScanInFlight = undefined;
  }
}
