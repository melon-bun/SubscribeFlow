const {test} = require('node:test');
const assert = require('node:assert/strict');
const {callUI, contentDTO} = require('../electron/main/app-client.cjs');
const {openSavedLink} = require('../electron/main/external-links.cjs');

test('display DTO preserves missing dates, date precision and cover without invented priority', () => {
  const base={id:'c',source:{channel:'test',kind:'author',external_id:'1',name:'Author'},published:{value:null,precision:'unknown',timezone:null},thumbnail:null,state:{read:false}};
  assert.equal(contentDTO(base,[]).publishedAt,null);
  const item=contentDTO({...base,published:{value:'2026-10-04',precision:'date',timezone:'UTC'},thumbnail:'https://example.com/cover.jpg'},[]);
  assert.equal(item.publishedAt,'2026-10-04');
  assert.equal(item.publishedPrecision,'date');
  assert.equal(item.publishedTimezone,'UTC');
  assert.equal(item.cover,'https://example.com/cover.jpg');
  assert.equal(item.priority,null);
});

test('calendar and inbox pagination map to bounded Core queries', async () => {
  let received;
  const core={call:async (name,params)=>{
    if(name==='subscription.list') return [];
    assert.equal(name,'content.list'); received=params;
    return {items:[],total:23,next_offset:20};
  }};
  const result=await callUI(core,'listContents',[{limit:20,offset:0,from:'2026-10-01',to:'2026-10-31T23:59:59Z',state:'unread'}]);
  assert.deepEqual(received,{limit:20,offset:0,start:'2026-10-01',end:'2026-10-31T23:59:59Z',read:false,archived:false,deferred:false});
  assert.equal(result.next_offset,20);
  await callUI(core,'listContents',[{priority:'high',state:'unread',limit:20,offset:20}]);
  assert.deepEqual(received,{limit:20,offset:20,priority:'high',read:false,archived:false,deferred:false});
  // 非法取值属于入参错误，不静默降级，否则用户会看到错的筛选结果。
  await assert.rejects(callUI(core,'listContents',[{tagMode:'sometimes'}]),{message:'标签筛选方式需为任一符合或全部符合'});
  await assert.rejects(callUI(core,'listContents',[{tags:['']}]),{message:'标签列表无效'});
});

test('tag filters reach the Core query and never widen an empty selection', async () => {
  let received;
  const core={call:async (name,params)=>{
    if(name==='subscription.list') return [];
    assert.ok(name==='content.list'||name==='content.calendar'); received=params;
    return name==='content.calendar' ? {month:params.month,total:0,priorities:{},days:[]} : {items:[],total:0,next_offset:null};
  }};
  await callUI(core,'listContents',[{tags:['t1'],limit:20,offset:0}]);
  assert.deepEqual(received,{limit:20,offset:0,tags:['t1']});
  // 只有显式要求「全部符合」才下发 all；默认即任一符合，不额外传参。
  await callUI(core,'listContents',[{tags:['t1','t2'],tagMode:'all',limit:20}]);
  assert.deepEqual(received,{limit:20,tags:['t1','t2'],tag_mode:'all'});
  await callUI(core,'listContents',[{tags:[],limit:20}]);
  assert.equal('tags' in received,false);
  await callUI(core,'getCalendar',[{month:'2026-10',tags:['t1'],tagMode:'all'}]);
  assert.deepEqual(received,{month:'2026-10',tags:['t1'],tag_mode:'all'});
});

test('source search and resolution stay separate from confirmed creation', async () => {
  const calls=[];
  const core={call:async (name,params)=>{
    calls.push([name,params]);
    if(name==='connection.list') return [{id:'c',channel:'test'}];
    if(name==='subscription.add') { assert.equal(params.confirmed,false); throw new Error('confirmation required'); }
    return {items:[]};
  }};
  await callUI(core,'searchSources',[{connectionId:'c',text:'author'}]);
  await callUI(core,'resolveSource',[{connectionId:'c',text:'1'}]);
  assert.deepEqual(calls.map(c=>c[0]),['source.search','source.resolve']);
  await assert.rejects(callUI(core,'createChannel',[{platform:'test',link:'1'}]),/confirmation required/);
});

test('calendar maps shared filters to a full monthly summary without pagination', async () => {
  let received;
  const summary={month:'2026-10',total:125,priorities:{high:125,medium:0,low:0,none:0},days:[]};
  const core={call:async (name,params)=>{
    if(name==='subscription.list') return [{id:'sub',source_id:'source'}];
    assert.equal(name,'content.calendar'); received=params; return summary;
  }};
  assert.deepEqual(await callUI(core,'getCalendar',[{month:'2026-10',platform:'test',channelId:'sub',priority:'high',state:'unread',keyword:'Title'}]),summary);
  assert.deepEqual(received,{month:'2026-10',channel:'test',source_id:'source',priority:'high',query:'Title',read:false,archived:false,deferred:false});
  await assert.rejects(callUI(core,'getCalendar',[{month:'2026-10',limit:100}]),{code:'UNSUPPORTED_OPERATION'});
});

test('external opening resolves a saved ID and rejects schemes, credentials and arbitrary URLs', async () => {
  let url='https://example.com/video', opened;
  const core={call:async name=>name==='content.get'?{url}:[{id:'s',url}]};
  const open=async value=>{opened=value;};
  await openSavedLink(core,'content.open',{item_id:'c'},open);
  assert.equal(opened,url);
  await openSavedLink(core,'source.open',{subscription_id:'s'},open);
  await assert.rejects(openSavedLink(core,'source.open',{subscription_id:'missing'},open));
  await assert.rejects(openSavedLink(core,'content.open',{item_id:'c',url:'https://evil.example'},open));
  for(url of ['file:///etc/passwd','javascript:alert(1)','https://user:pass@example.com']) {
    await assert.rejects(openSavedLink(core,'content.open',{item_id:'c'},open));
  }
});

test('coverage requires compatible terminal evidence; committed windows never claim full history', async () => {
  let progress=[], version=1;
  const core={call:async name=>({
    'sync.coverage':{progress},
    'subscription.list':[{id:'s',version,connection_id:'c'}],
    'connection.list':[{id:'c',version:1}],
    'sync.list':[{subscription_id:'s',mode:'refresh',pages:1,snapshot:{subscription_version:1,connection_version:1,connection_id:'c'}}],
  })[name]};
  let result=await callUI(core,'getSyncCoverage',['s']);
  assert.equal(result.complete,false);
  assert.equal(result.label,'仅已采集窗口');
  version=2;
  result=await callUI(core,'getSyncCoverage',['s']);
  assert.equal(result.label,'尚无有效覆盖记录');
  progress=[{compatible:false,payload:{complete:true,coverage:'history_end'}}];
  assert.equal((await callUI(core,'getSyncCoverage',['s'])).complete,false);
  progress[0].compatible=true;
  assert.equal((await callUI(core,'getSyncCoverage',['s'])).complete,true);
});

test('collection ceiling round-trips through the bridge and rejects out-of-range input', async () => {
  const sub={id:'s',channel:'test',name:'A',url:'https://example.com',source:{external_id:'1'},status:'active',version:1,connection_id:'c',interval_seconds:86400,sync_mode:'manual',collect_items:25};
  const calls=[];
  const core={call:async (name,params)=>{
    calls.push([name,params]);
    if(name==='channel.list') return [];
    return {...sub};
  }};
  const updateOf=()=>calls.filter(c=>c[0]==='subscription.update').at(-1)[1];
  const updated=await callUI(core,'updateChannel',['s',{collectItems:25}]);
  assert.deepEqual(updateOf(),{subscription_id:'s',collect_items:25});
  assert.equal(updated.collectItems,25);
  // A null clears the ceiling back to the Core defaults instead of failing the round trip.
  await callUI(core,'updateChannel',['s',{collectItems:null}]);
  assert.deepEqual(updateOf(),{subscription_id:'s',collect_items:0});
  for(const bad of [-1,51,1.5,'25',true]){
    await assert.rejects(callUI(core,'updateChannel',['s',{collectItems:bad}]),/collectItems/);
  }
});

test('omitting pageBudget lets the Core derive it; an explicit one is range checked', async () => {
  const seen=[];
  const core={call:async (name,params)=>{ seen.push([name,params]); return {job_id:'j'}; }};
  await callUI(core,'startChannelRun',['s',{kind:'backfill'}]);
  assert.deepEqual(seen.at(-1)[1],{subscription_id:'s',mode:'backfill'});
  await callUI(core,'startChannelRun',['s',{kind:'recent',pageBudget:3}]);
  assert.deepEqual(seen.at(-1)[1],{subscription_id:'s',mode:'refresh',page_budget:3});
  for(const bad of [0,101,2.5,'3',true]){
    await assert.rejects(callUI(core,'startChannelRun',['s',{pageBudget:bad}]),/分页预算/);
  }
});
