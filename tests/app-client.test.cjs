const {test} = require('node:test');
const assert = require('node:assert/strict');
const {callUI, contentDTO} = require('../electron/main/app-client.cjs');
const {openSavedLink} = require('../electron/main/external-links.cjs');

test('replacement backend capabilities drive the source UI and platform filters stay unique',async()=>{
  const descriptors=[{channel:'test',backend:'old',operations:{list_items:{supported:false}}},
    {channel:'test',backend:'replacement',page_size:1,budget_unit:'details',default_refresh_budget:8,default_backfill_budget:30,
      operations:{list_items:{supported:true,pagination:'bounded_scan'},get_item_detail:{supported:true}}}];
  const core={call:async name=>{
    if(name==='channel.list')return descriptors;
    if(name==='subscription.list')return [{id:'s',channel:'test',backend:'replacement',name:'Author',url:'https://example.com',status:'active'}];
    if(name==='schedule.list')return [];
    if(name==='content.list')return {total:2};
    throw new Error(name);
  }};
  const channel=(await callUI(core,'listChannels',[])).items[0];
  assert.equal(channel.capabilities.canRefresh,true);assert.equal(channel.incrementalDetails,true);assert.equal(channel.defaultRefreshBudget,8);
  descriptors[1].budget_unit='items';
  const windowed=(await callUI(core,'listChannels',[])).items[0];
  assert.equal(windowed.checkedItems,true);assert.equal(windowed.incrementalDetails,true);
  assert.deepEqual(await callUI(core,'listPlatforms',[]),[{id:'test',count:2}]);
});

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

test('every event the Core emits is forwarded, and every subscribed event is exposed', () => {
  const fs=require('node:fs');
  const path=require('node:path');
  const root=path.resolve(__dirname,'..');
  // Core 里实际 emit 出去的事件名。这张清单是真实的，漏转发就是静默失效。
  const emitted=new Set();
  const walk=dir=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const full=path.join(dir,entry.name);
      if(entry.isDirectory()) walk(full);
      else if(entry.name.endsWith('.py')) {
        for(const match of fs.readFileSync(full,'utf8').matchAll(/\.emit\(\s*["']([a-z_.]+)["']/g)) emitted.add(match[1]);
      }
    }
  };
  walk(path.join(root,'python/src/subscribe_flow'));
  assert.ok(emitted.size >= 5, `未从 Core 解析到事件：${[...emitted]}`);

  // 主进程按白名单转发：这里漏掉任何一个，对应界面的缓存就会静默停在旧值。
  const main=fs.readFileSync(path.join(root,'electron/main/index.cjs'),'utf8');
  // 只认转发白名单本身：别名字符串表里也出现同样的事件名，不能算作已转发。
  const allowBlock=main.match(/if \(!\[([^\]]+)\]\.includes\(event\)\) return;/);
  assert.ok(allowBlock, '未能从主进程解析出事件转发白名单');
  const forwarded=new Set([...allowBlock[1].matchAll(/'([a-z_.]+)'/g)].map(m=>m[1]));
  const missed=[...emitted].filter(e=>!forwarded.has(e));
  assert.deepEqual(missed,[], `Core 发出但主进程未转发：${missed}`);

  // 渲染层订阅的事件必须在 preload 里开放，否则订阅会抛「事件订阅无效」。
  const app=fs.readFileSync(path.join(root,'electron/renderer/scripts/app.js'),'utf8');
  const subscribed=new Set([...app.matchAll(/client\.on\(\s*["']([a-z_.]+)["']/g)].map(m=>m[1]));
  const preload=fs.readFileSync(path.join(root,'electron/preload/index.cjs'),'utf8');
  const eventBlock=preload.match(/events = new Set\(\[([^\]]+)\]/);
  assert.ok(eventBlock, '未能从 preload 解析出 events 白名单');
  const exposed=new Set([...eventBlock[1].matchAll(/'([a-z_.]+)'/g)].map(m=>m[1]));
  const blocked=[...subscribed].filter(e=>!exposed.has(e));
  assert.deepEqual(blocked,[], `渲染层在订阅但 preload 未开放：${blocked}`);
});
