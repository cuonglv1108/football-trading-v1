const BASE='https://api.5dollarfootballapi.com/v1';
const key=process.env.FIVE_DOLLAR_FOOTBALL_API_KEY;
const leagues=[
  ['MLS',[2221499861,751043315]],
  ['Allsvenskan',[112989244]],
  ['Liga MX',[2540173422]],
  ['Brazil Serie A',[3118717965]],
];

async function call(path){
  const r=await fetch(BASE+path,{headers:{Authorization:'Bearer '+key}});
  let body=null;
  try{body=await r.json();}catch{}
  return {ok:r.ok,status:r.status,body};
}
function n(v){const x=Number(v);return Number.isFinite(x)?x:null}
function line(m){return n(m?.closing) ?? n(m?.opening)}
function parseAh(x){
  if(x==null) return null;
  if(x<0) return {fav:'HOME',line:x};
  if(x>0) return {fav:'AWAY',line:-Math.abs(x)};
  return {fav:null,line:0};
}

if(!key){
  console.log('5D_RESULT '+JSON.stringify({ok:false,error:'missing key'}));
  process.exit(0);
}

const status=await call('/status');
console.log('5D_STATUS '+JSON.stringify({
  http:status.status,
  ok:status.ok,
  plan:status.body?.data?.plan ?? status.body?.plan ?? null,
  usage:status.body?.data?.usage ?? status.body?.usage ?? null,
  error:status.body?.error ?? null
}));
if(!status.ok) process.exit(0);

const now=Math.floor(Date.now()/1000);
const end=now+72*3600;
const rows=[];
for(const [league,ids] of leagues){
  for(const id of ids){
    const path='/leagues/'+id+'/fixtures?start_time='+now+'&end_time='+end+'&status=scheduled&include=odds&order=asc&page=1&per_page=50';
    const r=await call(path);
    console.log('5D_CALL '+JSON.stringify({league,id,http:r.status,ok:r.ok,count:Array.isArray(r.body?.data)?r.body.data.length:null,error:r.body?.error??null}));
    if(!r.ok||!Array.isArray(r.body?.data)) continue;
    for(const f of r.body.data){
      const goal=line(f?.odds?.goal_line);
      const corner=line(f?.odds?.corner_line);
      const ahRaw=line(f?.odds?.asian_handicap);
      const ah=parseAh(ahRaw);
      rows.push({
        league,
        id:f?.id,
        kickoff:f?.kickoff_utc,
        home:f?.teams?.home?.name,
        away:f?.teams?.away?.name,
        asianRaw:ahRaw,
        favourite:ah?.fav??null,
        handicap:ah?.line??null,
        goal,
        corner,
        v1:goal!=null&&corner!=null&&goal>=2.75&&corner>=10
      });
    }
  }
}
const dedup=[...new Map(rows.map(x=>[String(x.id),x])).values()];
console.log('5D_ROWS '+JSON.stringify(dedup));
console.log('5D_SUMMARY '+JSON.stringify({
  fixtures:dedup.length,
  complete:dedup.filter(x=>x.goal!=null&&x.corner!=null).length,
  qualified:dedup.filter(x=>x.v1).length
}));
process.exit(0);
