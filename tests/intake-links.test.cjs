const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {BilibiliAPI,parseItemURL}=require('../electron/main/bilibili-api.cjs');
const {CoreClient}=require('../electron/main/core-client.cjs');
const {callUI}=require('../electron/main/app-client.cjs');
const {bilibiliAPI,BVID}=require('../scripts/intake-fixture.cjs');
const root=path.resolve(__dirname,'..');
const runtime=JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json')));

test('Bili BV/AV/mobile/short forms normalize, foreign redirects and loops stop before visiting them',async()=>{
  for(const host of ['bilibili.com','www.bilibili.com','m.bilibili.com'])
    assert.equal(parseItemURL(`http://${host}/video/${BVID}?p=1`).bvid,BVID);
  const f=bilibiliAPI(),signal=new AbortController().signal;
  assert.equal((await f.api.request({operation:'resolve',url:'https://b23.tv/fixture'},signal)).data.bvid,BVID);
  assert.equal((await f.api.request({operation:'resolve',url:'https://www.bilibili.com/video/av123'},signal)).data.aid,123);
  for(const target of ['https://%', 'https://example.com/video/'+BVID,'https://www.bilibili.com.evil.test/video/'+BVID,'https://b23.tv/loop']) {
    const visited=[];
    const api=new BilibiliAPI(async url=>{visited.push(url);return new Response(null,{status:302,headers:{location:target}});});
    await assert.rejects(api.request({operation:'resolve',url:'https://b23.tv/loop'},signal),e=>e.code==='INVALID_INPUT');
    assert.equal(visited.length,1);
  }
  for(const raw of ['https://user@www.bilibili.com/video/'+BVID,'https://www.bilibili.com:99/video/'+BVID,'https://www.bilibili.com/video/invalid','javascript:alert(1)']) assert.throws(()=>parseItemURL(raw));
});

test('XHS standard/share/profile URLs preserve signatures, short redirects retain stable identity and read one note',async()=>{
  const {XiaohongshuAPI,parseItemURL,validateRequest}=await import('../electron/main/xiaohongshu-api.mjs');
  const id='1'.repeat(24),uid='2'.repeat(24),signed=`?xsec_token=one%2Btwo%3D&xsec_source=pc_share`;
  for(const p of [`/explore/${id}`,`/search_result/${id}`,`/discovery/item/${id}`,`/user/profile/${uid}/${id}`]) {
    const link=parseItemURL('https://www.xiaohongshu.com'+p+signed);
    assert.equal(link.id,id); assert.equal(new URL(link.url).searchParams.get('xsec_token'),'one+two=');
  }
  let current='https://www.xiaohongshu.com/explore';const visits=[];
  const page={url:()=>current,goto:async u=>{current=u;visits.push(u);},evaluate:async script=>{
    const action=JSON.parse(script.slice(script.lastIndexOf(')(')+2,-1));
    const base={loggedIn:true};
    if(action==='detail') return {...base,ready:true,contentPresent:true,id,authorId:uid,author:'真实页面作者',title:'笔记',content:'正文',dateText:'2000-01-02'};
    if(action==='share-copy') return {...base,shareText:`https://www.xiaohongshu.com/discovery/item/${id}?source=webshare&xsec_source=pc_share&xsec_token=shared%3D`};
    return base;
  }};
  const api=new XiaohongshuAPI(page,{delay:0,jitter:0,fetch:async()=>new Response(null,{status:302,headers:{location:`https://www.xiaohongshu.com/discovery/item/${id}${signed}`}})});
  const resolved=await api.request({channel:'xiaohongshu',operation:'resolve',url:'https://xhslink.com/a/fixture'});
  assert.equal(resolved.id,id);
  const result=await api.request({channel:'xiaohongshu',operation:'read',id,url:resolved.url});
  assert.equal(result.note.authorId,uid);assert.equal(result.note.published.precision,'date');assert.equal(result.note.published.value,'2000-01-02');
  assert.equal(visits.length,1);assert.ok(!visits[0].includes('/user/profile/'));
  assert.throws(()=>validateRequest({channel:'xiaohongshu',operation:'read',id:'3'.repeat(24),url:resolved.url}));
  assert.throws(()=>parseItemURL(`https://www.xiaohongshu.com/explore/${id}?xsec_token=a&xsec_token=b`));
  const foreign=new XiaohongshuAPI(page,{fetch:async()=>new Response(null,{status:302,headers:{location:'https://example.com'}})});
  await assert.rejects(foreign.request({channel:'xiaohongshu',operation:'resolve',url:'https://xhslink.com/a/fixture'}),e=>e.code==='INVALID_INPUT');
});

test('actual Core RPC through Bili private API previews without subscription, saves atomically, preserves duplicate and restart',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-intake-test-'));
  const f=bilibiliAPI();
  const core=new CoreClient({...runtime,root,dataDir:dir,schedulePolicy:{resource_gap:0},acquisition:(p,s)=>{const {channel,...input}=p;assert.equal(channel,'bilibili');return f.api.request(input,s);}});
  const settle=async url=>{
    let task=await callUI(core,'startIntake',[{url}]);
    for(let i=0;i<100 && ['queued','running'].includes(task.state);i++) {await new Promise(r=>setTimeout(r,10));task=await callUI(core,'getIntake',[task.task_id]);}
    return task;
  };
  try {
    await core.start();
    let task=await settle(`https://m.bilibili.com/video/${BVID}`);
    assert.equal(task.state,'preview');assert.notEqual(task.preview_id,task.preview.id);
    assert.equal(task.preview.source.external_id,'946974');
    assert.equal((await core.call('content.list')).total,0);assert.equal((await core.call('subscription.list')).length,0);
    const tag=await callUI(core,'createTag',[{name:'M13',color:'cyan'}]);
    const saved=await callUI(core,'saveIntake',[task.preview_id,{priority:'high',tagIds:[tag.id]}]);
    assert.equal(saved.status,'created');
    const before=await callUI(core,'getContent',[saved.item_id]);
    assert.equal(before.intakeMethod,'manual');assert.equal(before.calendarBasis,'manual_added_at');assert.equal(before.publishedAt.slice(0,4),'2000');
    assert.equal((await callUI(core,'listContents',[{platform:'bilibili',sourceId:before.sourceId,intakeMethod:'manual',priority:'high',tags:[tag.id]}])).total,1);
    assert.equal((await callUI(core,'getCalendar',[{month:before.calendarDate.slice(0,7),intakeMethod:'manual'}])).total,1);
    const readCount=f.visits.filter(u=>u.endsWith('/view')).length;
    task=await settle('https://b23.tv/fixture');assert.equal(task.state,'exists');
    assert.equal(f.visits.filter(u=>u.endsWith('/view')).length,readCount,'重复 BV 短链不得访问视频详情');
    task=await settle('https://www.bilibili.com/video/av123');assert.equal(task.state,'exists');
    assert.deepEqual(await callUI(core,'getContent',[saved.item_id]),before);
    await core.restart();assert.deepEqual(await callUI(core,'getContent',[saved.item_id]),before);
    assert.equal((await core.call('subscription.list')).length,0);assert.equal((await core.call('sync.list')).length,0);
  } finally {await core.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
