import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BASE = 'https://api.5dollarfootballapi.com/v1';

async function apiGet(path: string, key: string) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${key}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

function latestLine(market: any): number | null {
  const raw = market?.closing ?? market?.current ?? market?.opening ?? null;
  if (raw == null) return null;
  if (typeof raw === 'object') {
    const v = raw.line ?? null;
    return Number.isFinite(Number(v)) ? Number(v) : null;
  }
  return Number.isFinite(Number(raw)) ? Number(raw) : null;
}

function relevantLeague(name: string) {
  const n = name.toLowerCase();
  return (
    n.includes('major league soccer') ||
    n === 'mls' ||
    n.includes('liga mx') ||
    (n.includes('serie a') && (n.includes('brazil') || n.includes('brasil'))) ||
    n.includes('allsvenskan')
  );
}

export async function GET() {
  const key = process.env.FIVE_DOLLAR_FOOTBALL_API_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return NextResponse.json({ ok: false, error: 'No test API key configured' }, { status: 500 });

  const status = await apiGet('/status', key);
  if (!status.ok) {
    return NextResponse.json({
      ok: false,
      authStatus: status.status,
      error: status.body?.error ?? status.body?.message ?? '5Dollar auth/status request failed',
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  const now = Math.floor(Date.now() / 1000);
  const windows: any[] = [];
  for (let i = 0; i < 3; i++) {
    const start = now + i * 24 * 3600;
    const end = start + 24 * 3600;
    const r = await apiGet(`/fixtures?start_time=${start}&end_time=${end}&include=odds&per_page=100`, key);
    windows.push({ start, end, ok: r.ok, status: r.status, body: r.body });
  }

  const rows = windows.flatMap(w => Array.isArray(w.body?.data) ? w.body.data : []);
  const relevant = rows
    .filter((x: any) => relevantLeague(String(x?.league?.name ?? '')))
    .map((x: any) => {
      const goal = latestLine(x?.odds?.goal_line);
      const corner = latestLine(x?.odds?.corner_line);
      const ah = latestLine(x?.odds?.asian_handicap);
      return {
        id: x?.id,
        league: x?.league?.name ?? null,
        kickoff_utc: x?.kickoff_utc ?? null,
        home: x?.teams?.home?.name ?? null,
        away: x?.teams?.away?.name ?? null,
        asian_handicap: ah,
        goal_line: goal,
        corner_line: corner,
        v1Qualified: goal != null && corner != null && goal >= 2.75 && corner >= 10,
      };
    })
    .sort((a: any, b: any) => String(a.kickoff_utc).localeCompare(String(b.kickoff_utc)));

  const stLouis = rows
    .filter((x: any) => /st\.?\s*louis/i.test(String(x?.teams?.home?.name ?? '') + ' ' + String(x?.teams?.away?.name ?? '')))
    .map((x: any) => ({
      id: x?.id,
      league: x?.league?.name ?? null,
      kickoff_utc: x?.kickoff_utc ?? null,
      home: x?.teams?.home?.name ?? null,
      away: x?.teams?.away?.name ?? null,
      odds: {
        asian_handicap: x?.odds?.asian_handicap ?? null,
        goal_line: x?.odds?.goal_line ?? null,
        corner_line: x?.odds?.corner_line ?? null,
      },
    }));

  return NextResponse.json({
    ok: true,
    provider: '5DollarFootballAPI',
    statusSummary: {
      success: status.body?.success ?? null,
      plan: status.body?.data?.plan ?? status.body?.plan ?? null,
      usage: status.body?.data?.usage ?? status.body?.usage ?? null,
    },
    windowStatuses: windows.map(w => ({ start: w.start, end: w.end, status: w.status, ok: w.ok, error: w.body?.error ?? null })),
    relevantFixtureCount: relevant.length,
    qualifiedCount: relevant.filter((x: any) => x.v1Qualified).length,
    relevant,
    stLouis,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
