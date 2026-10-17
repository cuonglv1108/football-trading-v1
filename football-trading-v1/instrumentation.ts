// One bounded, non-sensitive provider diagnostic per Node.js process startup.
// This does NOT run a scan, request Goals/Corners, or modify persisted match data.
// Remove after we verify subscription coverage and real FT Asian response shape.
let ran = false;

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NODE_ENV !== 'production' || ran) return;
  ran = true;
  const key = process.env.FIVE_DOLLAR_FOOTBALL_API_KEY;
  if (!key) {
    console.info('[FT_AH_PROBE]', JSON.stringify({step:'status',result:'KEY_MISSING'}));
    return;
  }
  const base = 'https://api.5dollarfootballapi.com/v1';
  async function providerGet(path: string) {
    const res = await fetch(base + path, {
      headers: { Authorization: 'Bearer ' + key },
      cache: 'no-store',
      signal: AbortSignal.timeout(9500),
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* return HTTP status */ }
    return { status: res.status, data };
  }
  const log = (value: Record<string, unknown>) => console.info('[FT_AH_PROBE]', JSON.stringify(value));
  try {
    const s = await providerGet('/status');
    const plan = String(s.data?.data?.plan ?? 'UNKNOWN').toLowerCase();
    log({ step:'subscription', http:s.status, plan,
      providerErrorCode: String(s.data?.error?.code ?? '') });
    // Free and Community normally do not cover the app's targeted MLS/Liga MX.
    // Do not spend further requests until membership is verified.
    if (s.status !== 200 || !['pro','ultra','business','education'].includes(plan)) return;
    const start = Math.floor(Date.now()/1000);
    const list = await providerGet('/fixtures?start_time=' + start +
      '&end_time=' + (start+86400) + '&status=scheduled&per_page=100');
    const fixtures = Array.isArray(list.data?.data) ? list.data.data : [];
    const ids = new Set([2540173422,2221499861,751043315,137325260]);
    const candidates = fixtures.filter((f:any) => ids.has(Number(f?.league?.id)) && f?.id != null);
    log({step:'fixtures',http:list.status,firstPageCount:fixtures.length,
      watchedLeagueCount:candidates.length,errorCode:String(list.data?.error?.code??'')});
    const target = candidates[0];
    if (!target) return;
    const ah = await providerGet('/fixtures/' + encodeURIComponent(String(target.id)) + '/odds?market=asian');
    const data = ah.data?.data;
    const direct = data?.odds?.asian_handicap;
    const books = Array.isArray(data?.bookmakers) ? data.bookmakers : [];
    const bet = books.find((b:any)=>String(b?.slug??'').toLowerCase()==='bet365');
    const market = direct ?? bet?.odds?.asian_handicap ?? null;
    const kinds = ['opening','closing','current','inplay'].filter(k=>market?.[k] !== undefined && market?.[k] !== null);
    log({step:'asian_market',http:ah.status,fixtureId:Number(target.id),
      leagueId:Number(target?.league?.id),shape:direct?'direct':bet?'bookmaker':'empty',
      observedSnapshots:kinds,hasMarket:!!market,
      errorCode:String(ah.data?.error?.code??'')});
  } catch(e) {
    // Never print request headers, full responses, or provider keys.
    log({step:'failed',reason:e instanceof Error?e.name:'UNKNOWN'});
  }
}
