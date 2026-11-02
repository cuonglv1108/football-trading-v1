import type { League } from './types';
import type { FtAhLookupTarget, FtAhLookupResult } from './fiveDollarFootball';
import { isFtAhPriorityLeague } from './ftAhPriority';
import { sameAhFixture } from './ftAsianRecovery';
import { parseApiFootballBet365FtAh } from './ftAsianMarkets';

const BASE_URL = 'https://v3.football.api-sports.io';
const IDS: Partial<Record<League, number>> = {
  'Brazil Serie A': 71, Allsvenskan: 113, 'Liga MX': 262, MLS: 253,
};

type LookupResult = FtAhLookupResult & { bookmaker?: string; candidates?: Array<{line:number;homeOdd:number;awayOdd:number}>; totalCandidates?: number; snapshotAt?: string | null };
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
      // Prefer the filtered Bet365 feed. Never blend FT with 1H/corner markets.
      const bookmakerList=await get('/odds/bookmakers?search=Bet365');
      marketRequests++;
      const bet365=(bookmakerList.response??[]).find((b:any)=>
        /^bet365$/i.test(String(b?.name??'').trim()));
      const rows:any[]=[];
      if (Number.isSafeInteger(Number(bet365?.id)) && Number(bet365.id)>0) {
        const directOdds=await get('/odds?fixture='+fid+'&bookmaker='+Number(bet365.id));
        marketRequests++;
        rows.push(...(directOdds.response??[]));
      }
      let market=parseApiFootballBet365FtAh(rows);
      if (!market.marketFound) {
        // Only use unfiltered pages if Bet365 FT AH wasn't returned directly.
        const first=await get('/odds?fixture='+fid+'&page=1');
        marketRequests++;
        rows.push(...(first.response??[]));
        market=parseApiFootballBet365FtAh(rows);
        if (!market.marketFound && Number(first.paging?.total??1)>1) {
          const next=await get('/odds?fixture='+fid+'&page=2');
          marketRequests++;
          rows.push(...(next.response??[]));
          market=parseApiFootballBet365FtAh(rows);
        }
      }
      const context = { candidates:market.candidates, totalCandidates:market.totalLines,
        snapshotAt:market.snapshotAt };
      if (!market.marketFound) {
        lookups.push({ id:target.id,status:'NO_MARKET',...context,
          error:'API-Football did not return Bet365 full-time Asian Handicap' });
        continue;
      }
      if (market.totalLines !== 1) {
        lookups.push({ id:target.id,status:'AMBIGUOUS_MARKET',...context,
          error:market.totalLines===0
            ? 'Bet365 FT handicap responses could not be matched into valid home/away pairs'
            : 'Bet365 API returned '+market.totalLines+' FT handicap lines without a reliable main-line identifier' });
        continue;
      }
      const quote=market.candidates[0];
      if (!quote || quote.homeOdd < 1.65 || quote.homeOdd > 2.4 ||
          quote.awayOdd < 1.65 || quote.awayOdd > 2.4) {
        lookups.push({ id:target.id,status:'AMBIGUOUS_MARKET',...context,
          error:'Only a priced alternative was found, not a plausible main FT Asian Spread' });
        continue;
      }
      lookups.push({ id:target.id,status:'FOUND_PRICED',
        line:quote.line,homeOdd:quote.homeOdd,awayOdd:quote.awayOdd,
        source:'API-Football · Bet365 · one FT Asian Handicap pair',
        bookmaker:'Bet365',...context });
    } catch(error) {
      lookups.push({ id:target.id,status:'PROVIDER_ERROR',
        error:error instanceof Error?error.message.slice(0,160):'Provider error' });
    }
  }
  return {lookups,fixturePages,marketRequests,provider:'API-Football'};
}
