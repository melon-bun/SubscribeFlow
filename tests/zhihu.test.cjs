const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CoreClient}=require('../electron/main/core-client.cjs');
const {UID,OTHER,TOKEN,IDS}=require('../scripts/zhihu-fixture.cjs');
const root=path.resolve(__dirname,'..'),runtime=JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json')));
async function fixture(options={}) {
  const {ZhihuAPI}=await import('../electron/main/zhihu-api.mjs');
  const visits=[];
  const control={mode:'normal',end:true,pins:IDS.slice(0,4),failDetail:null};
  const author={id:UID,url_token:TOKEN,name:'真实作者',headline:'简介',avatar_url:'https://picx.zhimg.com/a.jpg'};
  // Mirrors the official /pins feed: rows carry identity, author and the content block array.
  const row=id=>({id,type:'pin',state:'normal',is_deleted:false,created:946684800,
    author,url:`/pins/${id}`,content:[{type:'text',content:'<p>想法第一段</p><p>完整第二段</p>'},{type:'image',url:'https://picx.zhimg.com/100/v2-x_720w.jpg'}]});
  const page={url:()=>'about:blank',goto:async value=>{visits.push(value);},evaluate:async script=>{
    const action=JSON.parse(script.slice(script.lastIndexOf(')(')+2,-1));
    if(control.mode==='risk')return {risk:true};
    return {url:'https://www.zhihu.com/people/'+TOKEN,risk:false,loginWall:false};
  }};
  const api=new ZhihuAPI(page,{delay:0,readTimeout:100,waitTimeout:5,fetch:async value=>{
    visits.push(value);
    if(control.mode==='rate')return new Response('{}',{status:429,headers:{'content-type':'application/json'}});
    if(control.mode==='auth')return new Response('{}',{status:401,headers:{'content-type':'application/json'}});
    const u=new URL(value);
    const json=d=>new Response(JSON.stringify(d),{headers:{'content-type':'application/json'}});
    if(u.hostname==='api.zhihu.com')return json({data:[{type:'search_result',object:author}]});
    if(u.pathname==='/api/v4/me')return json(author);
    const list=u.pathname.match(/^\/api\/v4\/members\/([^/]+)\/pins$/);
    if(list) {
      const offset=Number(u.searchParams.get('offset')||0);
      const size=Number(u.searchParams.get('limit')||20);
      const all=control.pins.map(row);
      const slice=all.slice(offset,offset+size);
      // is_end must reflect real exhaustion so an empty feed terminates instead of spinning.
      const isEnd=offset+slice.length>=all.length;
      return json({paging:{is_end:control.end?isEnd:false,totals:all.length},data:slice});
    }
    const one=u.pathname.match(/^\/api\/v4\/pins\/(\d+)$/);
    if(one) {
      if(one[1]===control.failDetail)return json({id:one[1],is_deleted:true,state:'deleted'});
      const found=control.pins.find(id=>String(id)===one[1]);
      return found?json(row(found)):json({id:one[1],is_deleted:true,state:'deleted'});
    }
    return json({error:{message:'unexpected',code:1}});
  },...options});
  return {api,visits,control};
}
test('Zhihu link/author validation and original publication preserve unknown precision',async()=>{
  const {parseItemURL,authorToken,validateRequest,publication,pinText}=await import('../electron/main/zhihu-api.mjs');
  // Rich-text blocks must reach Core as plain text: no markup, entities decoded, paragraphs kept.
  assert.equal(pinText('<p>第一段</p><p class="ztext-empty-paragraph"><br></p><p>第二段</p>'),'第一段\n\n第二段','空段落不产生多余空行');
  assert.equal(pinText('a &amp; b &lt;c&gt; &#65;'),'a & b <c> A');
  assert.equal(pinText('<p>  多余   空格 </p>'),'多余 空格');
  assert.equal(pinText(''),'');
  assert.equal(pinText(null),'');
  assert.equal(/[<>]/.test(pinText('<div>带<b>标签</b></div>')),false,'正文不得残留任何标签');
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
  // A page-level risk wall is still surfaced instead of being reported as an empty result.
  f.control.mode='risk';await assert.rejects(f.api.read('status'),e=>e.code==='INTERACTION_REQUIRED');
  f.control.mode='normal';
  const missing='9'.repeat(19);
  await assert.rejects(f.api.request({channel:'zhihu',operation:'read',id:missing,url:'https://www.zhihu.com/pin/'+missing}),e=>e.code==='NOT_FOUND');
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
  // Author exists and has pins, but the feed stops handing back new identities before is_end:
  // the scan must stop on its own bound and report gaps, never claim a complete history.
  f.control.pins=[IDS[0]];f.control.end=false;
  let page=await f.api.request(p);
  for(let i=0;i<6 && !page.terminal;i++)page=await f.api.request({...p,cursor:page.cursor});
  assert.equal(page.terminal,true);assert.equal(page.end_evidence,'scan_bound');
  f.control.pins=[IDS[0],IDS[0],IDS[1],IDS[2]];f.control.end=true;f.control.failDetail=IDS[0];
  page=await f.api.request(p);assert.equal(page.metrics.discovered,2);
  page=await f.api.request({...p,cursor:page.cursor});assert.equal(page.errors[0].code,'NOT_FOUND');
  page=await f.api.request({...p,cursor:page.cursor});assert.equal(page.items[0].id,IDS[1]);assert.equal(page.terminal,true);
  assert.equal(f.visits.some(u=>u.includes('/pins/'+IDS[2])),false,'失败不向窗口外补位');
});
test('Zhihu discovery reads the official pins feed and never parses profile DOM',async()=>{
  const f=await fixture(),p={channel:'zhihu',operation:'scan',uid:UID,url:'https://www.zhihu.com/people/'+TOKEN,job_id:'e'.repeat(32),limit:3,mode:'refresh'};
  const first=await f.api.request(p);
  assert.equal(first.metrics.profile_reads,1);assert.equal(first.metrics.discovered,3);
  assert.ok(f.visits.some(u=>u.includes('/api/v4/members/'+TOKEN+'/pins')),'发现阶段走接口分页');
  assert.equal(f.visits.some(u=>u.includes('/activities')),false,'不再依赖已失效的 activities');
  assert.equal(f.visits.some(u=>u.includes('/people/')),false,'不再导航作者主页做 DOM 解析');
  let done=await f.api.request({...p,cursor:first.cursor});
  const collected=[...done.items];
  while(!done.terminal){done=await f.api.request({...p,cursor:done.cursor});collected.push(...done.items);}
  assert.equal(collected.length,3,'窗口内的三条想法全部取回');
  assert.equal(collected[0].content,'想法第一段\n\n完整第二段','富文本正文必须转成纯文本并保留段落');
  assert.equal(collected[0].images[0],'https://picx.zhimg.com/100/v2-x_720w.jpg');
  assert.equal(collected[0].url,'https://www.zhihu.com/pin/'+IDS[0],'列表的 /pins/ 必须归一化为 /pin/');
  assert.equal(collected[0].published.precision,'second');
  assert.equal(collected[0].author.id,UID,'详情必须携带真实作者稳定 ID');
});
test('an author with an empty feed is a zero-result window, not a failure',async()=>{
  const f=await fixture(),p={channel:'zhihu',operation:'scan',uid:UID,url:'https://www.zhihu.com/people/'+TOKEN,job_id:'f'.repeat(32),limit:5,mode:'refresh'};
  f.control.pins=[];
  const page=await f.api.request(p);
  assert.equal(page.terminal,true);assert.equal(page.end_evidence,'profile_end');
  assert.equal(page.items.length,0);assert.equal(page.cursor,null);
});
