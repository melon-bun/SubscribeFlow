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
  assert.deepEqual(received,{limit:20,offset:0,start:'2026-10-01',end:'2026-10-31T23:59:59Z',read:false,archived:false});
  assert.equal(result.next_offset,20);
  await assert.rejects(callUI(core,'listContents',[{priority:'high'}]),{code:'UNSUPPORTED_OPERATION'});
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
