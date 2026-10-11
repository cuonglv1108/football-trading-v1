const BASE='https://api.5dollarfootballapi.com/v1';
const key=process.env.FIVE_DOLLAR_FOOTBALL_API_KEY || process.env.API_FOOTBALL_KEY;

async function api(path){
  const r=await fetch(BASE+path,{headers:{Authorization:'Bearer '+key}});
  let body=null; try{body=await r.json();}catch{}
  return {ok:r.ok,status:r.status,body};
}
function line(m){
  const v=m?.closing ?? m?.current ?? m?.opening ?? null;
  if(v==null) return null;
  if(typeof v==='object') return Number.isFinite(Number(v.line))?Number(v.line):null;
  return Number.isFinite(Number(v))?Number(v):null;
}
function relevant(name){
  const n=String(name||'').toLowerCase();
  return n.includes('major league soccer')||n==='mls'||n.includes('liga mx')||(n.includes('serie a')&&(n.includes('brazil')||n.includes('brasil')))||n.includes('allsvenskan');
}
(async()=>{
  try{
    if(!key){console.log('5DTEST no key'); return;}
    const s=await api('/status');
    console.log('5DTEST status',JSON.stringify({http:s.status,ok:s.ok,plan:s.body?.data?.plan??s.body?.plan??null,success:s.body?.success??null,error:s.body?.error??s.body?.message??null}));
    if(!s.ok) return;
    const now=Math.floor(Date.now()/1000);
    const all=[];
    for(let i=0;i<3;i++){
      const start=now+i*86400,end=start+86400;
      const r=await api('/fixtures?start_time='+start+'&end_time='+end+'&include=odds&per_page=100');
      console.log('5DTEST window',i+1,JSON.stringify({http:r.status,ok:r.ok,count:Array.isArray(r.body?.data)?r.body.data.length:null,error:r.body?.error??r.body?.message??null}));
      if(Array.isArray(r.body?.data)) all.push(...r.body.data);
    }
    const rows=all.filter(x=>relevant(x?.league?.name)).map(x=>{
      const g=line(x?.odds?.goal_line),c=line(x?.odds?.corner_line),ah=line(x?.odds?.asian_handicap);
      return {id:x?.id,league:x?.league?.name,home:x?.teams?.home?.name,away:x?.teams?.away?.name,kickoff:x?.kickoff_utc,ah,goal:g,corner:c,v1:g!=null&&c!=null&&g>=2.75&&c>=10};
    });
    console.log('5DTEST relevant',JSON.stringify(rows));
    console.log('5DTEST summary',JSON.stringify({relevant:rows.length,qualified:rows.filter(x=>x.v1).length}));
  }catch(e){console.log('5DTEST fatal',e?.message||String(e));}
})();