import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BASE_URL = 'https://v3.football.api-sports.io';

async function apiGet(path: string) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY missing');
  const res = await fetch(BASE_URL + path, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store',
  });
  const data = await res.json();
  if (!res.ok) throw new Error('API-Football HTTP ' + res.status);
  return data;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const fixture = Number(url.searchParams.get('fixture'));
    if (!Number.isFinite(fixture)) return NextResponse.json({ error: 'fixture required' }, { status: 400 });

    const books = await apiGet('/odds/bookmakers?search=Bet365');
    const bookmaker = (books.response ?? []).find((b: any) => /^bet365$/i.test(String(b?.name ?? '').trim()));
    if (!bookmaker) throw new Error('Bet365 not found');

    const odds = await apiGet('/odds?fixture=' + fixture + '&bookmaker=' + bookmaker.id);
    const out = (odds.response ?? []).map((row: any) => {
      const b = (row.bookmakers ?? []).find((x: any) => x?.id === bookmaker.id);
      return {
        update: row.update ?? null,
        bookmaker: b ? { id: b.id, name: b.name } : null,
        bets: (b?.bets ?? [])
          .filter((bet: any) => /asian handicap/i.test(String(bet?.name ?? '')) && !/half/i.test(String(bet?.name ?? '')))
          .map((bet: any) => ({ id: bet.id, name: bet.name, values: bet.values }))
      };
    });

    return NextResponse.json({ fixture, bookmaker, rows: out }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'debug failed' }, { status: 500 });
  }
}
