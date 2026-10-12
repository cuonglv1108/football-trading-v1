import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const key = process.env.FIVE_DOLLAR_FOOTBALL_API_KEY;
  if (!key) return NextResponse.json({ ok: false, error: 'missing_key' });

  const res = await fetch('https://api.5dollarfootballapi.com/v1/status', {
    headers: { Authorization: 'Bearer ' + key },
    cache: 'no-store',
  });

  let data: any = null;
  try { data = await res.json(); } catch {}

  return NextResponse.json({
    ok: res.ok,
    status: res.status,
    plan: data?.data?.plan ?? data?.plan ?? null,
    errorCode: data?.error?.code ?? null,
    errorMessage: data?.error?.message ?? data?.message ?? null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
