import type { League } from './types';
import type { FtAhLookupTarget, FtAhLookupResult } from './fiveDollarFootball';
import { isFtAhPriorityLeague } from './ftAhPriority';
import { sameAhFixture } from './ftAsianRecovery';

const BASE_URL = 'https://v3.football.api-sports.io';
const IDS: Partial<Record<League, number>> = {
  'Brazil Serie A': 71, Allsvenskan: 113, 'Liga MX': 262, MLS: 253,
};

type LookupResult = FtAhLookupResult & { bookmaker?: string; candidates?: Array<{line:number;homeOdd:number;awayOdd:number}> };
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
  const raw = value?.handicap != null ? String(value.handicap).trim() :
    String(value?.value ?? '').replace(/^(?:home|away)\b/i, '').trim();
  // Preserve quarter lines such as -1.5,-2.0 => -1.75.
  const nums = raw.match(/[+-]?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (nums.length === 2 && Math.abs(nums[0]-nums[1]) === 0.5 &&
      Math.sign(nums[0]) === Math.sign(nums[1])) return (nums[0]+nums[1])/2;
  return nums.length === 1 ? nums[0] : null;
}
function pricePair(values: any[]) {
  const usable = values.map((v: any) => ({
    side: /^home\b/i.test(String(v?.value ?? '')) ? 'HOME' :
      /^away\b/i.test(String(v?.value ?? '')) ? 'AWAY' : 'OTHER',
    line: lineIn(v), odd: toNumber(v?.odd), main: v?.main === true,
  })).filter(x => x.side !== 'OTHER' && x.line != null && x.odd != null &&
      x.odd >= 1.65 && x.odd <= 2.40 && Math.abs(x.line) <= 5 &&
      Number.isInteger(x.line * 4));
  const candidates: Array<{ homeLine:number; homeOdd:number; awayOdd:number; main:boolean }> = [];
  for (const h of usable.filter(q => q.side === 'HOME')) {
    for (const a of usable.filter(q => q.side === 'AWAY')) {
      if (Math.abs(h.line! + a.line!) > 0.001) continue;
      candidates.push({ homeLine:h.line!, homeOdd:h.odd!, awayOdd:a.odd!,
        main: h.main && a.main });
    }
  }
  // API-Sports 'main' can mark duplicate prices for ONE selection, not
  // necessarily both HOME and AWAY. Prefer the uniquely marked pair; never
  // infer the main spread from odds balance when several lines remain.
  const marked = candidates.filter(x => x.main);
  if (marked.length === 1) return marked[0];
  return candidates.length === 1 ? candidates[0] : null;
}
// Return only short, non-sensitive market diagnostics; never expose API keys or full feeds.
function candidateLines(rows: any[]): Array<{line:number; homeOdd:number; awayOdd:number}> {
  const found = new Map<string,{line:number;homeOdd:number;awayOdd:number}>();
  for (const item of rows) for (const book of item?.bookmakers ?? []) {
    if (!/^bet365$/i.test(String(book?.name ?? '').trim())) continue;
    for (const bet of book?.bets ?? []) {
      if (!/^asian handicap(?:\\s*(?:full time|ft))?$/i.test(String(bet?.name ?? '').trim())) continue;
      const values=Array.isArray(bet?.values)?bet.values:[];
      const home=values.filter((v:any)=>/^home\\b/i.test(String(v?.value ?? '')));
      const away=values.filter((v:any)=>/^away\\b/i.test(String(v?.value ?? '')));
      for (const h of home) for (const a of away) {
        const hl=lineIn(h),al=lineIn(a),ho=toNumber(h.odd),ao=toNumber(a.odd);
        if (hl==null || al==null || ho==null || ao==null) continue;
        if (Math.abs(hl+al)>0.001 || !Number.isInteger(hl*4) ||
            Math.abs(hl)>5 || ho<=1 || ao<=1 || ho>20 || ao>20) continue;
        found.set([hl,ho,ao].join(':'),{line:hl,homeOdd:ho,awayOdd:ao});
      }
    }
  }
  return [...found.values()].sort((a,b)=>
    Math.abs(a.homeOdd-a.awayOdd)-Math.abs(b.homeOdd-b.awayOdd)).slice(0,12);
}

function diagnoseBet365Ah(rows: any[]): string {
  const descriptions: string[] = [];
  for (const item of rows) for (const book of item?.bookmakers ?? []) {
    if (!/^bet365$/i.test(String(book?.name ?? '').trim())) continue;
    for (const bet of book?.bets ?? []) {
      if (!/asian handicap/i.test(String(bet?.name ?? ''))) continue;
      const name=String(bet.name ?? '').slice(0,55);
      const values=Array.isArray(bet.values) ? bet.values : [];
      const samples=values.slice(0,16).map((v:any) =>
        String(v?.value ?? '?').slice(0,24) + (v?.handicap == null ? '' : ' ['+String(v.handicap).slice(0,16)+']') +
        '@'+String(v?.odd ?? '?').slice(0,8) + (v?.main === true ? '*' : '')
      );
      descriptions.push(name+': '+(samples.join(', ') || '(empty)'));
    }
  }
  return descriptions.length ? descriptions.slice(0,3).join(' | ').slice(0,750) :
    'No Bet365 Asian Handicap market in returned API-Football odds';
}

function mainFtAhBookmakers(rows: any[]) {
  const candidates: Array<{
    bookmaker: string; rank:number; homeLine:number; homeOdd:number; awayOdd:number;
  }> = [];
  let ambiguous = false;
  for (const item of rows) for (const book of item?.bookmakers ?? []) {
    const name = String(book?.name ?? '');
    // Do not substitute 1xBet/other bookmaker lines for the Bet365 main spread.
    if (!/^bet365$/i.test(name)) continue;
    const rank = 0;
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
      // Query Bet365 directly first: unfiltered fixture pages may omit this
      // bookmaker even though its market is available through the filter.
      const bookmakerList=await get('/odds/bookmakers?search=Bet365');
      marketRequests++;
      const bet365=(bookmakerList.response??[]).find((b:any)=>
        /^bet365$/i.test(String(b?.name??'').trim()));
      const all:any[]=[];
      if (Number.isSafeInteger(Number(bet365?.id)) && Number(bet365.id)>0) {
        const directOdds=await get('/odds?fixture='+fid+'&bookmaker='+Number(bet365.id));
        marketRequests++;
        all.push(...(directOdds.response??[]));
      }
      if (!mainFtAhBookmakers(all).quote) {
        const first=await get('/odds?fixture='+fid+'&page=1');
        marketRequests++;
        all.push(...(first.response??[]));
        if (!mainFtAhBookmakers(all).quote && Number(first.paging?.total??1)>1) {
          const next=await get('/odds?fixture='+fid+'&page=2');
          marketRequests++;
          all.push(...(next.response??[]));
        }
      }
      const {quote,ambiguous}=mainFtAhBookmakers(all);
      if (!quote) {
        lookups.push({ id:target.id,status:ambiguous?'AMBIGUOUS_MARKET':'NO_MARKET',
          error:(ambiguous?'Main Asian Spread cannot be identified: ':'Market missing: ')+diagnoseBet365Ah(all),
          candidates:candidateLines(all) });
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
