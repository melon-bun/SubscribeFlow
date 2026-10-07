const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ChannelSessions}=require('../electron/main/channel-sessions.cjs');
const UID='123456789012345678901234';
const IDS=['111111111111111111111111','222222222222222222222222','333333333333333333333333'];
function fixture({profiles,login=true,detailFail,detailDate}={}) {
  let url='https://www.xiaohongshu.com/explore', round=0;
  const visits=[];
  profiles ||= [{authorId:UID,notes:IDS.map(id=>({id,title:id,url:`https://www.xiaohongshu.com/explore/${id}?xsec_token=fixture`})),end:true}];
  const page={url:()=>url,goto:async value=>{visits.push(value);url=value;if(value.includes('/user/profile/'))round=0;},evaluate:async script=>{
    const action=JSON.parse(script.slice(script.lastIndexOf(')(')+2,-1));
    const base={loggedIn:login,loginWall:!login,risk:false};
    if(action==='profile')return {...base,...profiles[Math.min(round,profiles.length-1)]};
    if(action==='scroll'){round++;return base;}
    if(action==='users')return {...base,users:[{id:UID,name:'同名作者',url:`https://www.xiaohongshu.com/user/profile/${UID}`},{id:IDS[0],name:'同名作者',url:`https://www.xiaohongshu.com/user/profile/${IDS[0]}`}],empty:false};
    if(action==='detail') {
      const id=new URL(url).pathname.split('/').pop();if(detailFail)throw detailFail;
      return {...base,id,authorId:UID,ready:true,title:'笔记 '+id,content:'正文',rawTime:detailDate ? null : Date.now()-7*86400000,dateText:detailDate || '',images:[],tags:[]};
    }
    if(action==='share-copy')return {...base,shareText:`7 【笔记分享】 https://www.xiaohongshu.com/discovery/item/${new URL(url).pathname.split('/').pop()}?source=webshare&xhsshare=pc_web&xsec_token=fixture-share-token%3D&xsec_source=pc_share`};
    return base;
  }};
  return {page,visits};
}
async function setup(options) {
  const {XiaohongshuAPI}=await import('../electron/main/xiaohongshu-api.mjs');
  const f=fixture(options);return {...f,api:new XiaohongshuAPI(f.page,{delay:0,jitter:0,readTimeout:20,waitTimeout:5})};
}
const scanParams={channel:'xiaohongshu',operation:'scan',uid:UID,job_id:'a'.repeat(32),limit:8,mode:'refresh'};

test('channel router isolates faults and accepts a replacement transport',async()=>{
  let replacementClosed=false;
  const router=new ChannelSessions();router.register('broken',{request:()=>Promise.reject(new Error('bad page')),close:()=>{throw new Error('bad shutdown');}});
  router.register('replacement',{request:p=>p.operation,openLogin:()=>({opened:true}),close:async()=>{replacementClosed=true;}});
  await assert.rejects(router.request({channel:'broken',operation:'check'}));
  assert.equal(await router.request({channel:'replacement',operation:'check'}),'check');
  assert.deepEqual(await router.login('replacement:default'),{opened:true});
  assert.throws(()=>router.request({channel:'unknown'}),e=>e.code==='DEPENDENCY_UNAVAILABLE');
  const closing=await router.close();assert.equal(closing[0].status,'rejected');assert.equal(replacementClosed,true);
});
test('nickname search preserves separate identities and logout performs no navigation',async()=>{
  const {api}=await setup();const result=await api.request({channel:'xiaohongshu',operation:'search',query:'同名',limit:20});
  assert.equal(result.users.length,2);assert.notEqual(result.users[0].id,result.users[1].id);
  const f=await setup({login:false});await assert.rejects(f.api.request({channel:'xiaohongshu',operation:'search',query:'同名',limit:20}),e=>e.code==='AUTH_REQUIRED');
  assert.equal(f.visits.length,0);
});
test('pre-filtered profile IDs avoid detail visits, including old pinned notes',async()=>{
  const f=await setup();let result=await f.api.request({...scanParams,known_ids:[IDS[0],IDS[2]]});
  assert.deepEqual(result.metrics,{profile_reads:1,discovered:3,skipped:2,detail_requests:0});
  assert.equal(result.items.length,0);assert.ok(result.cursor);
  result=await f.api.request({...scanParams,cursor:result.cursor});
  assert.equal(result.items[0].id,IDS[1]);assert.equal(result.terminal,true);
  assert.equal(f.visits.filter(url=>url.includes('/explore/')).length,1);
  assert.ok(Date.parse(result.items[0].published.value)<Date.now()-48*3600000,'older updates are not discarded by a demo window');
});
test('all-known first batch continues scrolling to discover a later new note',async()=>{
  const note=id=>({id,url:`https://www.xiaohongshu.com/explore/${id}?xsec_token=fixture`});
  const f=await setup({profiles:[{authorId:UID,notes:[note(IDS[0])],end:false},{authorId:UID,notes:[note(IDS[0]),note(IDS[1])],end:true}]});
  let r=await f.api.request({...scanParams,known_ids:[IDS[0]]});assert.equal(r.terminal,false);
  r=await f.api.request({...scanParams,cursor:r.cursor});assert.equal(r.metrics.discovered,1);assert.equal(r.metrics.skipped,0);
  r=await f.api.request({...scanParams,cursor:r.cursor});assert.equal(r.items[0].id,IDS[1]);
});
test('ambiguous dates remain unknown and China date labels do not shift to the previous day',async()=>{
  for(const [label,value,precision] of [['2026-01-02','2026-01-02','date'],['2天前',null,'unknown'],['编辑于 2026-01-02',null,'unknown']]) {
    const f=await setup({detailDate:label});let r=await f.api.request({...scanParams,limit:1});r=await f.api.request({...scanParams,limit:1,cursor:r.cursor});
    assert.equal(r.items[0].published.value,value);assert.equal(r.items[0].published.precision,precision);assert.equal(r.items[0].published.raw_label,label);
  }
});
test('profile signatures stay private and failed notes retain retry eligibility',async()=>{
  const f=await setup({detailFail:new Error('fixture token must not escape')});let r=await f.api.request({...scanParams,limit:1});
  r=await f.api.request({...scanParams,limit:1,cursor:r.cursor});
  assert.equal(r.items.length,0);assert.equal(r.errors.length,1);assert.equal(r.terminal,true);
  assert.ok(!JSON.stringify(r).includes('fixture token'));assert.ok(!JSON.stringify(r).includes('xsec_token'));
});
test('official copied share URL is preserved and wrong identity or signature is rejected',async()=>{
  const {shareURL}=await import('../electron/main/xiaohongshu-api.mjs');
  const url=`https://www.xiaohongshu.com/discovery/item/${IDS[0]}?source=webshare&xhsshare=pc_web&xsec_token=share%3D&xsec_source=pc_share`;
  assert.equal(shareURL('7 【笔记】 😆 '+url,IDS[0]),url);
  for(const candidate of [url.replace(IDS[0],IDS[1]),url.replace('pc_share','pc_user'),url.replace('xsec_token=share%3D&',''),url+'&xsec_token=other',url.replace('www.xiaohongshu.com','evil.test')])
    assert.throws(()=>shareURL(candidate,IDS[0]),e=>e.code==='SCHEMA_CHANGED');
  const f=await setup();let r=await f.api.request({...scanParams,limit:1});r=await f.api.request({...scanParams,limit:1,cursor:r.cursor});
  assert.match(r.items[0].url,/\/discovery\/item\//);assert.equal(new URL(r.items[0].url).searchParams.get('xsec_source'),'pc_share');
});
test('cancellation and an unreadable page release the operation within a bound',async()=>{
  const f=await setup();const c=new AbortController();c.abort();await assert.rejects(f.api.request(scanParams,c.signal));
  f.page.evaluate=()=>new Promise(()=>{});
  await assert.rejects(f.api.request({channel:'xiaohongshu',operation:'check'}),e=>e.code==='TIMEOUT');
});
test('request validation rejects arbitrary scripts, URLs and mismatched cursors',async()=>{
  const {validateRequest,trustedURL}=await import('../electron/main/xiaohongshu-api.mjs');
  for(const p of [{...scanParams,url:'https://other.test'},{...scanParams,known_ids:['bad']},{...scanParams,script:'secret'},{...scanParams,uid:'bad'}])assert.throws(()=>validateRequest(p));
  for(const url of ['http://www.xiaohongshu.com/','https://www.xiaohongshu.com.evil.test/','https://user@www.xiaohongshu.com/'])assert.throws(()=>trustedURL(url));
  const f=await setup();const r=await f.api.request(scanParams);
  await assert.rejects(f.api.request({...scanParams,cursor:r.cursor,job_id:'b'.repeat(32)}),e=>e.code==='SCHEMA_CHANGED');
});
