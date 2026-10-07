import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { evaluateV1 } from '../../../lib/rules';
import { League, TradingMatch } from '../../../lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_LEAGUES: League[] = ['MLS', 'Allsvenskan', 'Liga MX', 'Brazil Serie A'];
const SCAN_CACHE_MS = Number(process.env.GPT_SCAN_CACHE_MS ?? 6 * 60 * 60 * 1000);
const DAILY_WEB_CALL_CAP = Number(process.env.GPT_DAILY_WEB_CALL_CAP ?? 20);
const DAILY_PAID_SCAN_CAP = Number(process.env.GPT_DAILY_PAID_SCAN_CAP ?? 2);
const MAX_WEB_CALLS_PER_SCAN = Number(process.env.GPT_MAX_WEB_CALLS_PER_SCAN ?? 10);
const STATE_FILE = process.env.GPT_SCAN_STATE_FILE || '/data/v1-scan-state.json';

type ScanPayload = {
  updatedAt: string;
  mode: 'GPT_WEB_SCAN';
  dataSource: string;
  providerStatus: string;
  matches: TradingMatch[];
  cacheStatus?: 'HIT' | 'MISS' | 'STALE';
  nextRefreshAt?: string;
  scanStatus?: 'COMPLETE' | 'PARTIAL';
  fixturesFound?: number;
  fixturesVerified?: number;
  unverifiedCount?: number;
  webCallsThisScan?: number;
  dailyWebCalls?: number;
  dailyPaidScans?: number;
  budgetMessage?: string;
  inputTokensThisScan?: number;
  outputTokensThisScan?: number;
  estimatedCostUsd?: number;
};

type PersistedState = {
  cache?: { payload: ScanPayload; expiresAt: number };
  daily: { day: string; webCalls: number; paidScans: number; estimatedCostUsd?: number };
};

declare global {
  // eslint-disable-next-line no-var
  var __v1ScanInFlight: Promise<ScanPayload> | undefined;
}

function torontoDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function freshState(): PersistedState {
  return { daily: { day: torontoDay(), webCalls: 0, paidScans: 0, estimatedCostUsd: 0 } };
}

async function readState(): Promise<PersistedState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const state = JSON.parse(raw) as PersistedState;
    if (!state.daily || state.daily.day !== torontoDay()) {
      state.daily = { day: torontoDay(), webCalls: 0, paidScans: 0, estimatedCostUsd: 0 };
    }
    return state;
  } catch {
    return freshState();
  }
}

async function writeState(state: PersistedState) {
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    const temp = `${STATE_FILE}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state), 'utf8');
    await fs.rename(temp, STATE_FILE);
  } catch (error) {
    console.error('Could not persist GPT scan state', error);
  }
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

function countWebCalls(response: any): number {
  return Array.isArray(response?.output)
    ? response.output.filter((item: any) => item?.type === 'web_search_call').length
    : 0;
}

function parseJson(text: string) {
  const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Scanner returned no JSON');
  return JSON.parse(clean.slice(start, end + 1));
}

function nextTorontoMidnightIso() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const approx = new Date(`${map.year}-${map.month}-${map.day}T23:59:59-04:00`);
  return new Date(approx.getTime() + 1000).toISOString();
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const shouldScan = url.searchParams.get('scan') === '1';
  const state = await readState();

  if (state.cache && state.cache.expiresAt > Date.now()) {
    return NextResponse.json({
      ...state.cache.payload,
      cacheStatus: 'HIT',
      nextRefreshAt: new Date(state.cache.expiresAt).toISOString(),
      dailyWebCalls: state.daily.webCalls,
      dailyPaidScans: state.daily.paidScans,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  if (!shouldScan) {
    if (state.cache?.payload) {
      return NextResponse.json({
        ...state.cache.payload,
        cacheStatus: 'STALE',
        providerStatus: 'CACHE_STALE',
        nextRefreshAt: new Date(state.cache.expiresAt).toISOString(),
        dailyWebCalls: state.daily.webCalls,
        dailyPaidScans: state.daily.paidScans,
      }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
    }

    return NextResponse.json({
      updatedAt: '',
      mode: 'GPT_WEB_SCAN',
      dataSource: 'OpenAI web search',
      providerStatus: 'CACHE_EMPTY',
      matches: [],
      cacheStatus: 'HIT',
      dailyWebCalls: state.daily.webCalls,
      dailyPaidScans: state.daily.paidScans,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  if (globalThis.__v1ScanInFlight) {
    const shared = await globalThis.__v1ScanInFlight;
    return NextResponse.json({ ...shared, cacheStatus: 'HIT' }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      mode: 'GPT_WEB_SCAN',
      dataSource: 'OpenAI web search',
      matches: [],
      providerStatus: 'OPENAI_API_KEY_MISSING',
    }, { status: 200, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  const remainingCalls = Math.max(0, DAILY_WEB_CALL_CAP - state.daily.webCalls);
  const remainingScans = Math.max(0, DAILY_PAID_SCAN_CAP - state.daily.paidScans);

  if (remainingCalls <= 0 || remainingScans <= 0) {
    const fallback = state.cache?.payload;
    return NextResponse.json({
      ...(fallback ?? {
        updatedAt: new Date().toISOString(),
        mode: 'GPT_WEB_SCAN',
        dataSource: 'OpenAI web search',
        matches: [],
      }),
      cacheStatus: fallback ? 'STALE' : 'HIT',
      providerStatus: 'DAILY_BUDGET_REACHED',
      dailyWebCalls: state.daily.webCalls,
      dailyPaidScans: state.daily.paidScans,
      budgetMessage: 'Daily search budget reached. No paid scan was started.',
      nextRefreshAt: nextTorontoMidnightIso(),
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  const maxToolCalls = Math.min(MAX_WEB_CALLS_PER_SCAN, remainingCalls);
  const now = new Date();
  const until = new Date(now.getTime() + 72 * 60 * 60 * 1000);

  const prompt = `You are a fixture-first pre-match scanner for a private football trading app.

TIME WINDOW
START: ${now.toISOString()}
END: ${until.toISOString()}

SCAN ONLY
- MLS
- Allsvenskan
- Liga MX
- Brazil Serie A

V1 RULE — DO NOT MODIFY
A match qualifies only when BOTH are verified:
1) Full-time total corners line >= 10.0
2) Full-time Asian total goals line >= 2.75

ACCURACY PRIORITY
The biggest failure to avoid is silently missing a qualifying match.
Work fixture-first:
A. First discover the COMPLETE fixture list in the 72-hour window for all four leagues.
B. Keep an audit row for EVERY fixture you discovered. Never omit a fixture from the audit because odds are missing.
C. Verify FT Asian goals and FT total-corners lines. Prefer Bet365 when publicly verifiable; otherwise use a reputable odds source showing the exact market/line.
D. Search efficiently in batches: one search may cover several fixtures. Do not waste one search per fixture when a league/round odds page can verify several.
E. If one market is missing for a fixture, use remaining searches to repair those missing fields before spending searches elsewhere.
F. Never infer or guess a line. If either required market still cannot be verified, mark that fixture UNVERIFIED rather than silently dropping it.
G. QUALIFIED means corners >=10 AND goals >=2.75. NOT_QUALIFIED means both required lines were verified and at least one fails. UNVERIFIED means one or both required lines could not be verified.
H. Do not use xG, form, predictions, team strength, or any betting method outside V1.

You have a strict built-in web-tool-call limit for this scan. Use the searches carefully. If you cannot verify the full fixture list and all required lines before the tool limit, set scanStatus to PARTIAL. Only set COMPLETE when the fixture list is complete and every fixture is either QUALIFIED or NOT_QUALIFIED with both required lines verified.

Return VALID JSON ONLY:
{
  "scanStatus": "COMPLETE|PARTIAL",
  "fixturesFound": 0,
  "fixturesVerified": 0,
  "audit": [
    {
      "league": "MLS|Allsvenskan|Liga MX|Brazil Serie A",
      "home": "string",
      "away": "string",
      "kickoff": "ISO 8601 string",
      "status": "QUALIFIED|NOT_QUALIFIED|UNVERIFIED",
      "cornerLine": 10.0,
      "goalLine": 2.75,
      "missing": [],
      "sourceUrls": ["https://..."]
    }
  ],
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
      "sourceSummary": "short verification summary",
      "sourceUrls": ["https://..."]
    }
  ]
}

The matches array MUST contain every audit row marked QUALIFIED, and no other rows.`;

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
        tool_choice: 'required',
        max_tool_calls: maxToolCalls,
        max_output_tokens: 6500,
        input: prompt,
      }),
      cache: 'no-store',
    });

    const raw = await res.json();
    if (!res.ok) throw new Error(raw?.error?.message || `OpenAI HTTP ${res.status}`);

    const webCallsThisScan = countWebCalls(raw);
    const inputTokensThisScan = Number(raw?.usage?.input_tokens ?? 0);
    const outputTokensThisScan = Number(raw?.usage?.output_tokens ?? 0);
    // Current GPT-6 Luna Standard rates: $0.10/M input, $0.50/M output.
    // Web search is $0.01/call. This is an estimate shown for budget control.
    const estimatedCostUsd =
      webCallsThisScan * 0.01 +
      inputTokensThisScan * 0.10 / 1_000_000 +
      outputTokensThisScan * 0.50 / 1_000_000;

    // Count spend BEFORE parsing so a malformed/incomplete model response can never escape the daily guard.
    state.daily.webCalls += webCallsThisScan;
    state.daily.paidScans += 1;
    state.daily.estimatedCostUsd = Number(((state.daily.estimatedCostUsd ?? 0) + estimatedCostUsd).toFixed(6));
    await writeState(state);

    const responseText = extractText(raw);
    if (!responseText.trim()) {
      const incompleteReason = raw?.incomplete_details?.reason || raw?.status || 'no final JSON';
      throw new Error(`Scanner incomplete after ${webCallsThisScan} web calls (${incompleteReason})`);
    }

    let parsed: any;
    try {
      parsed = parseJson(responseText);
    } catch {
      const repairRes = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_SCAN_MODEL || 'gpt-6-luna',
          max_output_tokens: 5000,
          input: `Convert the following scanner output into valid JSON only. Do not add facts, do not search, do not infer missing data. Preserve all values exactly when present. Output exactly one JSON object matching the requested scanner schema.\n\n${responseText}`,
        }),
        cache: 'no-store',
      });

      const repairRaw = await repairRes.json();
      if (!repairRes.ok) throw new Error(repairRaw?.error?.message || `OpenAI repair HTTP ${repairRes.status}`);

      const repairInput = Number(repairRaw?.usage?.input_tokens ?? 0);
      const repairOutput = Number(repairRaw?.usage?.output_tokens ?? 0);
      const repairCost = repairInput * 0.10 / 1_000_000 + repairOutput * 0.50 / 1_000_000;
      state.daily.estimatedCostUsd = Number(((state.daily.estimatedCostUsd ?? 0) + repairCost).toFixed(6));
      await writeState(state);

      parsed = parseJson(extractText(repairRaw));
    }
    const rows = Array.isArray(parsed?.matches) ? parsed.matches : [];
    const audit = Array.isArray(parsed?.audit) ? parsed.audit : [];

    const matches: TradingMatch[] = rows
      .filter((m: any) =>
        ALLOWED_LEAGUES.includes(m.league) &&
        Number(m.cornerLine) >= 10 &&
        Number(m.goalLine) >= 2.75 &&
        typeof m.home === 'string' &&
        typeof m.away === 'string'
      )
      .map((m: any) => {
        const safeKickoff = typeof m.kickoff === 'string' ? m.kickoff : null;
        const stableKey = [m.league, m.home, m.away, safeKickoff ?? 'tbd']
          .join('-').replace(/\W+/g, '-').toLowerCase();
        const base: TradingMatch = {
          id: `gpt-${stableKey}`,
          league: m.league,
          home: m.home,
          away: m.away,
          minute: null,
          status: 'PRE',
          kickoff: safeKickoff,
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
          sourceSummary: typeof m.sourceSummary === 'string' ? m.sourceSummary : 'Web verified',
          sourceUrls: Array.isArray(m.sourceUrls)
            ? m.sourceUrls.filter((u: unknown) => typeof u === 'string')
            : [],
        };
        return { ...base, ...evaluateV1(base) };
      });

    const fixturesFound = Number(parsed?.fixturesFound) || audit.length;
    const fixturesVerified = Number(parsed?.fixturesVerified) ||
      audit.filter((x: any) => x?.status === 'QUALIFIED' || x?.status === 'NOT_QUALIFIED').length;
    const unverifiedCount = Math.max(0, fixturesFound - fixturesVerified);
    const scanStatus: 'COMPLETE' | 'PARTIAL' =
      parsed?.scanStatus === 'COMPLETE' && unverifiedCount === 0 ? 'COMPLETE' : 'PARTIAL';

    const payload: ScanPayload = {
      updatedAt: new Date().toISOString(),
      mode: 'GPT_WEB_SCAN',
      dataSource: 'OpenAI web search',
      providerStatus: 'CONNECTED',
      matches,
      cacheStatus: 'MISS',
      scanStatus,
      fixturesFound,
      fixturesVerified,
      unverifiedCount,
      webCallsThisScan,
      dailyWebCalls: state.daily.webCalls,
      dailyPaidScans: state.daily.paidScans,
      inputTokensThisScan,
      outputTokensThisScan,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
      budgetMessage: `Daily guard: ${state.daily.webCalls}/${DAILY_WEB_CALL_CAP} web calls, ${state.daily.paidScans}/${DAILY_PAID_SCAN_CAP} paid scans · est. ${(state.daily.estimatedCostUsd ?? 0).toFixed(3)} today.`,
    };

    state.cache = { payload, expiresAt: Date.now() + SCAN_CACHE_MS };
    await writeState(state);

    return {
      ...payload,
      nextRefreshAt: new Date(state.cache.expiresAt).toISOString(),
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
      dataSource: 'OpenAI web search',
      matches: state.cache?.payload?.matches ?? [],
      providerStatus: 'ERROR',
      cacheStatus: state.cache?.payload ? 'STALE' : 'HIT',
      providerError: error instanceof Error ? error.message : 'Unknown scanner error',
      scanStatus: 'PARTIAL',
      dailyWebCalls: state.daily.webCalls,
      dailyPaidScans: state.daily.paidScans,
      budgetMessage: `Daily guard: ${state.daily.webCalls}/${DAILY_WEB_CALL_CAP} web calls, ${state.daily.paidScans}/${DAILY_PAID_SCAN_CAP} paid scans · est. ${(state.daily.estimatedCostUsd ?? 0).toFixed(3)} today.`,
    }, { status: 200, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } finally {
    globalThis.__v1ScanInFlight = undefined;
  }
}
