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
  if (!res.ok) throw new Error(`API-Football HTTP ${res.status}`);
  return data;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const fixture = Number(url.searchParams.get('fixture'));
    if (!Number.isFinite(fixture)) {
      return NextResponse.json({ error: 'fixture required' }, { status: 400 });
    }

    const book = await apiGet('/odds/bookmakers?search=Bet365');
    const exact = (book.response ?? []).find((b: any) => /^bet365$/i.test(String(b?.name ?? '').trim()));
    const bookmakerId = Number(exact?.id);
    if (!Number.isFinite(bookmakerId)) throw new Error('Bet365 not found');

    const [odds, fixtureData] = await Promise.all([
      apiGet(`/odds?fixture=${fixture}&bookmaker=${bookmakerId}`),
      apiGet(`/fixtures?id=${fixture}`),
    ]);

    const rows = (odds.response ?? []).map((row: any) => {
      const bookmaker = (row.bookmakers ?? []).find((b: any) => b?.id === bookmakerId);
      const bets = (bookmaker?.bets ?? []).filter((b: any) => /asian handicap|goals over\/under|corner/i.test(String(b?.name ?? '')));
      return {
        update: row.update ?? null,
        bookmaker: bookmaker ? { id: bookmaker.id, name: bookmaker.name } : null,
        bets: bets.map((b: any) => ({
          id: b.id,
          name: b.name,
          values: b.values,
        })),
      };
    });

    const fx = fixtureData.response?.[0];
    return NextResponse.json({
      fixture,
      teams: {
        home: fx?.teams?.home?.name ?? null,
        away: fx?.teams?.away?.name ?? null,
      },
      bookmaker: exact,
      rows,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'debug failed' }, { status: 500 });
  }
}
