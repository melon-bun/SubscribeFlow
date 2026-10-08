const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CoreClient}=require('../electron/main/core-client.cjs');
const {UID,OTHER,TOKEN,IDS}=require('../scripts/zhihu-fixture.cjs');
const root=path.resolve(__dirname,'..'),runtime=JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json')));
async function fixture(options={}) {
  const {ZhihuAPI}=await import('../electron/main/zhihu-api.mjs');
  let url='about:blank';const visits=[],control={mode:'normal',end:true,pins:IDS.slice(0,4),failDetail:null};
  const author={id:UID,url_token:TOKEN,name:'真实作者',headline:'简介'};
  const page={url:()=>url,goto:async value=>{url=value;visits.push(value);},evaluate:async script=>{
    const action=JSON.parse(script.slice(script.lastIndexOf(')(')+2,-1));
    if(control.mode==='risk')return {risk:true};
    if(action==='profile')return {ready:true,token:TOKEN,pins:control.pins.map(id=>({id})),invalid:[],end:control.end};
    if(action==='detail' && url.endsWith('/'+control.failDetail))return {unavailable:true};
    if(action==='detail')return {ready:true,contentPresent:true,id:url.split('/').pop(),author:{id:UID,urlToken:TOKEN,name:'真实作者'},content:'想法第一段\n\n完整第二段',images:[],created:946684800,dateText:'编辑于昨天'};
    return {};
  }};
  const api=new ZhihuAPI(page,{delay:0,readTimeout:100,waitTimeout:5,fetch:async value=>{
    if(control.mode==='rate')return new Response('{}',{status:429,headers:{'content-type':'application/json'}});
    if(control.mode==='auth')return new Response('{}',{status:401,headers:{'content-type':'application/json'}});
    const u=new URL(value),data=u.pathname.includes('search_v3') ? {data:[{type:'search_result',object:author}]} : author;
    return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
  },...options});
  return {api,visits,control};
}
test('Zhihu link/author validation and original publication preserve unknown precision',async()=>{
  const {parseItemURL,authorToken,validateRequest,publication}=await import('../electron/main/zhihu-api.mjs');
  for(const host of ['www.zhihu.com','zhihu.com'])assert.deepEqual(parseItemURL(`http://${host}/pin/${IDS[0]}/?utm_source=x#share`),{id:IDS[0],url:'https://www.zhihu.com/pin/'+IDS[0]});
  for(const u of ['https://www.zhihu.com/question/1','https://zhuanlan.zhihu.com/p/1','https://zhihu.com.evil/pin/1','https://user@www.zhihu.com/pin/1','https://www.zhihu.com:99/pin/1','file:///pin/1','https://www.zhihu.com/pin/1 x'])assert.throws(()=>parseItemURL(u));
  assert.equal(authorToken('https://www.zhihu.com/people/'+TOKEN),TOKEN);assert.throws(()=>authorToken('https://evil.com/people/'+TOKEN));
  assert.throws(()=>validateRequest({channel:'zhihu',operation:'read',url:'https://www.zhihu.com/pin/1',id:'2'}));
  assert.throws(()=>validateRequest({channel:'zhihu',operation:'check',script:'bad'}));
  assert.equal(publication({created:946684800,updated:1791482400}).value,'2000-01-01T00:00:00.000Z');
  for(const dateText of ['昨天','编辑于 2026-10-09','发布于 2 小时前','发布于 2000-02-30'])assert.equal(publication({dateText}).precision,'unknown');
  assert.equal(publication({dateText:'发布于 2000-01-02'}).precision,'date');
  assert.equal(publication({dateText:'发布于 2000-01-02 10:15'}).precision,'minute');
});
test('Zhihu scan counts known/pinned identities in first N; replay/cancel/ownership errors are explicit',async()=>{
  const f=await fixture(),job='c'.repeat(32),p={channel:'zhihu',operation:'scan',uid:UID,url:'https://www.zhihu.com/people/'+TOKEN,job_id:job,limit:2,mode:'refresh',known_ids:[IDS[0]]};
  const first=await f.api.request(p);
  assert.equal(first.metrics.discovered,2);assert.equal(first.metrics.skipped,1);assert.equal(first.terminal,false);
  const end=await f.api.request({...p,cursor:first.cursor,known_ids:undefined});
  assert.equal(end.items[0].id,IDS[1]);assert.equal(end.end_evidence,'item_limit');assert.equal(end.terminal,true);
  assert.equal(f.visits.some(u=>u.endsWith('/'+IDS[0]) || u.endsWith('/'+IDS[2])),false);
  await assert.rejects(f.api.request({...p,cursor:first.cursor}),e=>e.code==='INVALID_CURSOR');
  const all=await f.api.request({...p,known_ids:IDS.slice(0,2)});assert.equal(all.terminal,true);assert.equal(all.items.length,0);
  const n=await f.api.request(p);f.api.abortScan(job);await assert.rejects(f.api.request({...p,cursor:n.cursor}),e=>e.code==='INVALID_CURSOR');
  await assert.rejects(f.api.request({...p,uid:OTHER}),e=>e.code==='SCHEMA_CHANGED');
  await assert.rejects(f.api.request({channel:'zhihu',operation:'detail',uid:OTHER,id:IDS[0],url:'https://www.zhihu.com/pin/'+IDS[0]}),e=>e.code==='SCHEMA_CHANGED');
});
test('Zhihu auth/risk/rate/timeout/cancellation do not masquerade as empty success',async()=>{
  const f=await fixture();f.control.mode='auth';assert.deepEqual(await f.api.request({channel:'zhihu',operation:'check'}),{authenticated:false});
  await assert.rejects(f.api.request({channel:'zhihu',operation:'search',query:'作者',limit:5}),e=>e.code==='AUTH_REQUIRED');
  f.control.mode='rate';await assert.rejects(f.api.request({channel:'zhihu',operation:'search',query:'作者',limit:5}),e=>e.code==='RATE_LIMITED');
  f.control.mode='risk';await assert.rejects(f.api.request({channel:'zhihu',operation:'read',id:IDS[0],url:'https://www.zhihu.com/pin/'+IDS[0]}),e=>e.code==='INTERACTION_REQUIRED');
  await assert.rejects(f.api.bounded(new Promise(()=>{}),undefined,5),e=>e.code==='TIMEOUT');
  const c=new AbortController();const pending=f.api.bounded(new Promise(()=>{}),c.signal,100);c.abort();await assert.rejects(pending,e=>e.code==='CANCELLED');
});
test('actual Zhihu adapter/Core: manual/auto duplicate both orders, filters, identity, dates and restart',async()=>{
  const f=await fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-zhihu-core-'));
  const core=new CoreClient({...runtime,root,dataDir:dir,schedulePolicy:{resource_gap:0},acquisition:(p,s)=>{assert.equal(p.channel,'zhihu');return f.api.request(p,s);}});
  const settle=async url=>{
    let t=await core.call('intake.start',{url});for(let i=0;i<200 && ['queued','running'].includes(t.state);i++){await new Promise(r=>setTimeout(r,10));t=await core.call('intake.get',{task_id:t.task_id});}return t;
  };
  const run=async id=>{
    const started=await core.call('sync.start',{subscription_id:id,mode:'initial'});let j;
    for(let i=0;i<200;i++){j=await core.call('sync.get',{job_id:started.job_id});if(!['queued','running'].includes(j.state))break;await new Promise(r=>setTimeout(r,10));}return j;
  };
  try {
    await core.start();const desc=(await core.call('channel.list')).find(d=>d.channel==='zhihu');assert.equal(desc.operations.list_items.full_history,false);
    let t=await settle('https://zhihu.com/pin/'+IDS[0]+'?share=1');assert.equal(t.state,'preview');assert.equal(t.preview.source.external_id,UID);assert.equal((await core.call('content.list')).total,0);
    const tag=await core.call('tag.create',{name:'想法标签',color:'cyan'});
    const saved=await core.call('intake.save',{preview_id:t.preview_id,priority:'high',tag_ids:[tag.id]});
    const before=await core.call('content.get',{item_id:saved.item_id});assert.equal(before.intake_method,'manual');assert.equal(before.calendar_basis,'manual_added_at');assert.equal((await core.call('subscription.list')).length,0);
    const sub=await core.call('subscription.add',{locator:'https://www.zhihu.com/people/'+TOKEN,connection_id:'zhihu:default',confirmed:true});
    await core.call('subscription.update',{subscription_id:sub.id,collect_items:2});
    const job=await run(sub.id);assert.equal(job.state,'succeeded');assert.equal(job.new_items,1);assert.equal(job.acquisition_metrics.skipped,1);
    assert.deepEqual(await core.call('content.get',{item_id:saved.item_id}),before,'后续订阅绝不改写手动记录');
    const automatic=await core.call('content.get',{item_id:'zhihu:pin:'+IDS[1]});assert.equal(automatic.intake_method,'subscription');assert.equal(automatic.calendar_basis,'published_at');
    const readCount=f.visits.length;t=await settle('https://www.zhihu.com/pin/'+IDS[1]);assert.equal(t.state,'exists');assert.equal(f.visits.length,readCount);
    assert.deepEqual(await core.call('content.get',{item_id:automatic.id}),automatic);
    assert.equal((await core.call('content.list',{channel:'zhihu',intake_method:'manual',tags:[tag.id],source_id:sub.source_id})).total,1);
    const again=await run(sub.id);assert.equal(again.new_items,0);assert.equal(again.acquisition_metrics.detail_requests,0);
    await core.restart();assert.deepEqual(await core.call('content.get',{item_id:saved.item_id}),before);assert.equal((await core.call('content.list')).total,2);
  } finally {await core.stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test('Zhihu stalled scans retain gaps; failed detail stays inside the selected window',async()=>{
  const f=await fixture(),p={channel:'zhihu',operation:'scan',uid:UID,url:'https://www.zhihu.com/people/'+TOKEN,job_id:'d'.repeat(32),limit:2,mode:'backfill'};
  f.control.pins=[];f.control.end=false;
  let page=await f.api.request(p);
  for(let i=0;i<2;i++)page=await f.api.request({...p,cursor:page.cursor});
  assert.equal(page.terminal,true);assert.equal(page.end_evidence,'scan_bound');assert.equal(page.items.length,0);
  f.control.pins=[IDS[0],IDS[0],IDS[1],IDS[2]];f.control.end=true;f.control.failDetail=IDS[0];
  page=await f.api.request(p);assert.equal(page.metrics.discovered,2);
  page=await f.api.request({...p,cursor:page.cursor});assert.equal(page.errors[0].code,'NOT_FOUND');
  page=await f.api.request({...p,cursor:page.cursor});assert.equal(page.items[0].id,IDS[1]);assert.equal(page.terminal,true);
  assert.equal(f.visits.some(u=>u.endsWith('/'+IDS[2])),false,'失败不向窗口外补位');
});
