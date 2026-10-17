import type { League } from './types';
import type { FtAhLookupTarget, FtAhLookupResult } from './fiveDollarFootball';
import { isFtAhPriorityLeague } from './ftAhPriority';
import { sameAhFixture } from './ftAsianRecovery';

const BASE_URL = 'https://v3.football.api-sports.io';
const IDS: Partial<Record<League, number>> = {
  'Brazil Serie A': 71, Allsvenskan: 113, 'Liga MX': 262, MLS: 253,
};

type LookupResult = FtAhLookupResult & { bookmaker?: string };
type ProviderResponse = {
  response?: any[];
  paging?: { total?: number };
  errors?: unknown;
};
async function get(path: string) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY is not configured');
  const res = await fetch(BASE_URL + path, {
    headers: { 'x-apisports-key': key },
    cache: 'no-store', signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('API-Football HTTP ' + res.status);
  const body = await res.json() as ProviderResponse;
  if (body.errors && typeof body.errors === 'object' && Object.keys(body.errors as object).length) {
    throw new Error('API-Football returned provider errors');
  }
  return body;
}
const toNumber = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function lineIn(value: any): number | null {
  if (value?.handicap != null) return toNumber(value.handicap);
  const str = String(value?.value ?? '').trim();
  const n = str.match(/[+-]?\d+(?:\.\d+)?/);
  return n ? Number(n[0]) : null;
}
function pricePair(values: any[]) {
  const usable = values.map((v: any) => ({
    side: /^home\b/i.test(String(v?.value ?? '')) ? 'HOME' :
      /^away\b/i.test(String(v?.value ?? '')) ? 'AWAY' : 'OTHER',
    line: lineIn(v), odd: toNumber(v?.odd), main: v?.main === true,
  })).filter(x => x.side !== 'OTHER' && x.line != null && x.odd != null &&
      x.odd > 1 && x.odd <= 20 && Math.abs(x.line) <= 5 &&
      Number.isInteger(x.line * 4));
  const candidates: Array<{ homeLine:number; homeOdd:number; awayOdd:number; main:boolean }> = [];
  for (const h of usable.filter(q => q.side === 'HOME')) {
    for (const a of usable.filter(q => q.side === 'AWAY')) {
      if (Math.abs(h.line! + a.line!) > 0.001) continue;
      candidates.push({ homeLine:h.line!, homeOdd:h.odd!, awayOdd:a.odd!,
        main: h.main && a.main });
    }
  }
  const marked = candidates.filter(x => x.main);
  if (marked.length === 1) return marked[0];
  if (marked.length > 1) return null;
  // Without explicit main markers, we only trust an unambiguous ONE-pair market.
  return candidates.length === 1 ? candidates[0] : null;
}
function mainFtAhBookmakers(rows: any[]) {
  const candidates: Array<{
    bookmaker: string; rank:number; homeLine:number; homeOdd:number; awayOdd:number;
  }> = [];
  let ambiguous = false;
  for (const item of rows) for (const book of item?.bookmakers ?? []) {
    const name = String(book?.name ?? '');
    const rank = /^bet365$/i.test(name) ? 0 :
      /^stake(?:\.com)?$/i.test(name) ? 1 :
      /pinnacle/i.test(name) ? 2 : 10;
    for (const bet of book?.bets ?? []) {
      const market = String(bet?.name ?? '').trim();
      if (!/^asian handicap(?:\s*(?:full time|ft))?$/i.test(market)) continue;
      const values = Array.isArray(bet?.values) ? bet.values : [];
      const chosen = pricePair(values);
      if (chosen) candidates.push({ bookmaker:name, rank, ...chosen });
      else if (values.length) ambiguous = true;
    }
  }
  candidates.sort((a,b)=>a.rank-b.rank || a.bookmaker.localeCompare(b.bookmaker));
  return { quote:candidates[0] ?? null, ambiguous };
}

export async function getApiFootballDedicatedFtAh(
  targets: FtAhLookupTarget[]
): Promise<{ lookups: LookupResult[]; fixturePages: number; marketRequests: number; provider: string }> {
  let fixturePages=0, marketRequests=0;
  const lookups: LookupResult[]=[];
  const validTargets = targets.filter(m => isFtAhPriorityLeague(m.league)).slice(0,4);
  for (const target of validTargets) {
    const leagueId=IDS[target.league];
    if (!leagueId) continue;
    try {
      let matched:any[]=[];
      const numericId=Number(target.id);
      if (Number.isSafeInteger(numericId) && numericId>0 && numericId<100000000) {
        const direct=await get('/fixtures?id='+numericId);
        fixturePages++;
        matched=(direct.response ?? []).filter(f=>sameAhFixture(target,{
          league:target.league,home:String(f?.teams?.home?.name??''),
          away:String(f?.teams?.away?.name??''),kickoff:f?.fixture?.date??null,
        }));
      }
      if (!matched.length) {
        const season=Number(process.env.API_FOOTBALL_SEASON ?? new Date(target.kickoff??'').getUTCFullYear());
        const date=new Date(target.kickoff??'').toISOString().slice(0,10);
        const listing=await get('/fixtures?league='+leagueId+'&season='+season+'&date='+date);
        fixturePages++;
        matched=(listing.response??[]).filter(f=>sameAhFixture(target,{
          league:target.league,home:String(f?.teams?.home?.name??''),
          away:String(f?.teams?.away?.name??''),kickoff:f?.fixture?.date??null,
        }));
      }
      if (matched.length!==1) {
        lookups.push({ id:target.id,status:matched.length>1?'AMBIGUOUS_FIXTURE':'NO_FIXTURE' });
        continue;
      }
      const fid=Number(matched[0]?.fixture?.id);
      if (!Number.isSafeInteger(fid) || fid<=0) {
        lookups.push({id:target.id,status:'NO_FIXTURE'});continue;
      }
      const first=await get('/odds?fixture='+fid+'&page=1');
      marketRequests++;
      const all=[...(first.response??[])];
      if (!mainFtAhBookmakers(all).quote && Number(first.paging?.total??1)>1) {
        const next=await get('/odds?fixture='+fid+'&page=2');
        marketRequests++;
        all.push(...(next.response??[]));
      }
      const {quote,ambiguous}=mainFtAhBookmakers(all);
      if (!quote) {
        lookups.push({ id:target.id,status:ambiguous?'AMBIGUOUS_MARKET':'NO_MARKET',
          error:ambiguous?'More than one FT Asian Handicap line; main line not identifiable':'Provider has no verified FT Asian Handicap main market' });
        continue;
      }
      lookups.push({ id:target.id,status:'FOUND_PRICED',
        line:quote.homeLine,homeOdd:quote.homeOdd,awayOdd:quote.awayOdd,
        source:'API-Football · '+quote.bookmaker+' · verified FT Asian Handicap 2-way',
        bookmaker:quote.bookmaker });
    } catch(error) {
      lookups.push({ id:target.id,status:'PROVIDER_ERROR',
        error:error instanceof Error?error.message.slice(0,160):'Provider error' });
    }
  }
  return {lookups,fixturePages,marketRequests,provider:'API-Football'};
}
