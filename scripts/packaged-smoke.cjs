// Black-box release acceptance. Debugging is enabled only by this test launch,
// on loopback, with disposable data. No test code/fixtures ship in the .app.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {CoreClient}=require('../electron/main/core-client.cjs');
const root=path.resolve(__dirname,'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=20000) {
  const start=Date.now();let error;
  while(Date.now()-start<timeout) {try {const value=await fn();if(value)return value;}catch(e){error=e;}await delay(100);}
  throw new Error('Packaged acceptance timed out'+(error?': '+error.message:''));
}
async function connect(url) {
  const socket=new WebSocket(url),pending=new Map();let next=0;
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data),request=pending.get(message.id);
    if(request){pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);}
  });
  socket.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Debug connection closed'));}pending.clear();});
  return {close:()=>socket.close(),send:(method,params={})=>new Promise((resolve,reject)=>{
    const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Debug timeout: '+method));},20000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  })};
}
async function port() {const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const number=server.address().port;await new Promise(r=>server.close(r));return number;}

async function verifyWechatUpgrade(executable,resources,folder,runtime) {
  const profile=path.join(folder,'wechat-v15-profile');fs.mkdirSync(profile);
  const database=path.join(profile,'subscribe-flow.sqlite3');
  // Only fixture generation uses source Python. Upgrade and all RPC assertions
  // below run the actual frozen binary copied out of the new package.
  const seed=spawnSync(runtime.python,['-c',`import json,pathlib,sys
sys.path[:0]=[sys.argv[2],str(pathlib.Path(sys.argv[2])/'src')]
from tests.test_wechat_identity_migration import WechatIdentityMigrationTests,FIRST,LATER,insert
case=WechatIdentityMigrationTests();case.path=pathlib.Path(sys.argv[1]);case.db=case.legacy(15)
case.seed('wxrank');case.seed('wechat',stamp=LATER);case.seed_subscription()
insert(case.db,'app_settings',id=1,version=1,updated_at=FIRST,payload=json.dumps({'channels':{'wxrank':{'credentialRef':'packaged-fixture-reference','revision':11,'enabled':True}}}))
for content_id,stamp,summary in [('wxrank:article:MzI4NTEyMzQ1Ng==_1000000001_1',FIRST,'旧列表笔记'),('wechat:article:MzI4NTEyMzQ1Ng==_1000000001_1',LATER,'人工笔记保留')]:
    insert(case.db,'content_notes',content_id=content_id,template='general',summary=summary,summary_origin='manual',takeaway='',version=stamp,created_at=stamp,updated_at=stamp)
case.db.commit();case.db.close()
`,database,path.join(root,'python')],{encoding:'utf8'});
  assert.equal(seed.status,0,seed.stderr);
  const biz='MzI4NTEyMzQ1Ng==',first=`wechat:article:${biz}_1000000001_1`;
  const articleUrl=mid=>`https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=${mid}&idx=1`;
  let visits=0;
  const options={coreExecutable:executable,root:path.join(resources,'app.asar'),dataDir:profile,
    schedulePolicy:{resource_gap:0},acquisition:async params=>{
      assert.equal(params.channel,'wechat');assert.ok(['resolve','read'].includes(params.operation));visits++;
      const mid=new URL(params.url).searchParams.get('mid');
      return {article:{id:`${biz}_${mid}_1`,url:articleUrl(mid),title:'包内微信人工收录',
        content:'包内隔离文章完整正文。',images:[],account:{id:biz,name:'同一个公众号',url:articleUrl(mid)},
        published:{value:'2026-10-20T09:00:00+08:00',precision:'second',provenance:'fixture'},acquisition_complete:true}};
    }};
  const core=new CoreClient(options);
  try {
    await core.start();
    const descriptors=(await core.call('channel.list')).filter(d=>['wechat','wxrank'].includes(d.channel));
    assert.equal(descriptors.length,1);assert.equal(descriptors[0].backend,'electron-session');
    for(const op of ['resolve_source','list_items','match_item_url','resolve_item','read_item'])assert.equal(descriptors[0].operations[op].supported,true,op);
    const connections=(await core.call('connection.list')).filter(c=>['wechat','wxrank'].includes(c.channel));
    assert.deepEqual(connections.map(c=>c.id),['wechat:default']);
    assert.equal((await core.call('content.list')).total,1);
    const item=await core.call('content.get',{item_id:first});
    assert.equal(item.summary,'已有完整正文');assert.equal(item.body_state,'full');
    assert.equal(item.intake_method,'subscription');assert.equal(item.source.external_id,biz);
    assert.equal((await core.call('source.list')).items.length,1);
    assert.equal((await core.call('note.get',{item_id:first})).summary,'人工笔记保留');
    const status=await core.call('wxrank.status');
    assert.equal(status.configured,false);assert.equal(status.usage.calls,1);assert.equal(status.usage.unknownCount,1);
    assert.equal(status.sources[0].backfill.checkpoint.state,'resume');
    const duplicate=await core.call('intake.start',{url:articleUrl('1000000001')});
    assert.equal((await until(async()=>{const t=await core.call('intake.get',{task_id:duplicate.task_id});return t.state!=='queued'&&t.state!=='running'&&t;})).state,'exists');
    const added=await core.call('intake.start',{url:articleUrl('1000000002')});
    const preview=await until(async()=>{const t=await core.call('intake.get',{task_id:added.task_id});return t.state!=='queued'&&t.state!=='running'&&t;});
    assert.equal(preview.state,'preview',JSON.stringify(preview.error));
    assert.equal((await core.call('intake.save',{preview_id:preview.preview_id})).status,'created');
    assert.equal((await core.call('content.list')).total,2);assert.equal((await core.call('subscription.list')).length,1);
    await core.call('wxrank.cache_clear');
    await core.restart();
    assert.equal((await core.call('content.list')).total,2);
    const restarted=await core.call('wxrank.status');
    assert.equal(restarted.sources[0].backfill.checkpoint.state,'resume');assert.equal(restarted.usage.calls,1);
    assert.equal((await core.call('schedule.list'))[0].state,'blocked');
  } finally {await core.stop();}
  const audit=spawnSync(runtime.python,['-c',`import json,sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    assert db.execute('PRAGMA user_version').fetchone()[0]==16
    assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
    assert db.execute('SELECT upstream_id FROM wechat_backend_identities').fetchone()[0]=='gh_demo0001'
    assert db.execute('SELECT count(*) FROM wechat_identity_migration_archive').fetchone()[0]>0
    assert db.execute('SELECT count(*) FROM paid_channel_sources').fetchone()[0]==0
    assert db.execute('SELECT count(*) FROM paid_channel_attempts').fetchone()[0]==1
print(json.dumps({'schema':16,'foreignKeys':True,'bindingAfterCacheClear':True,'conflictArchive':True}))
`,database],{encoding:'utf8'});assert.equal(audit.status,0,audit.stderr);
  assert.ok(fs.existsSync(database.replace(/\.sqlite3$/,'.before-v16.backup')));
  return {passed:true,fromSchema:15,toSchema:16,oneAdapter:true,oneConnection:true,oneSource:true,
    duplicatesMerged:true,fullBodyAndNotePreserved:true,manualWithoutPaidKey:true,
    duplicateIntake:true,restartPersisted:true,cursor:'resume',unknownChargeBlocked:true,
    paidAttempts:1,manualPageReads:visits,...JSON.parse(audit.stdout)};
}
async function launch(bundle,dataDir,work,expected='ready') {
  const number=await port();
  const args=['-n',...(process.env.SUBSCRIBE_FLOW_PACKAGED_FOREGROUND==='1'?[]:['-g']),'-W','-a',bundle,'--stdout',path.join(work,'stdout.log'),'--stderr',path.join(work,'stderr.log')];
  for(const [key,value] of Object.entries({SUBSCRIBE_FLOW_DATA_DIR:dataDir,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',
    SUBSCRIBE_FLOW_PYTHON:'/missing/python',PYTHONHOME:'/missing/python',PYTHONPATH:'/missing/src',
    SUBSCRIBE_FLOW_DIAGNOSTICS:'1',SUBSCRIBE_FLOW_DESKTOP_SMOKE:'1',SUBSCRIBE_FLOW_RENDERER_SMOKE:'offline'})) args.push('--env',`${key}=${value}`);
  args.push('--args','--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${number}`);
  const opener=spawn('/usr/bin/open',args,{cwd:work,env:{...process.env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},stdio:'ignore'});
  let closed=false;opener.once('close',()=>{closed=true;});
  const targets=await until(async()=>{if(closed)throw new Error('Desktop launcher exited');const rows=await(await fetch(`http://127.0.0.1:${number}/json/list`)).json();return rows.some(t=>t.url.split('#')[0]==='app://subscribe-flow/index.html')&&rows;});
  const version=await(await fetch(`http://127.0.0.1:${number}/json/version`)).json();
  const browser=await connect(version.webSocketDebuggerUrl);
  const page=await connect(targets.find(t=>t.url.split('#')[0]==='app://subscribe-flow/index.html').webSocketDebuggerUrl);
  const evaluate=async expression=>{
    const response=await page.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(response.exceptionDetails) throw new Error(response.exceptionDetails.text+': '+response.exceptionDetails.exception?.description);
    return response.result.value;
  };
  const processes=await browser.send('SystemInfo.getProcessInfo');
  const pid=processes.processInfo.find(p=>p.type==='browser').id;
  const app={page,browser,evaluate,pid,close:async()=>{
    try{await browser.send('Browser.close');}catch{/* Closing the connection is expected. */}
    await until(()=>closed,10000).catch(()=>{try{process.kill(pid,'SIGTERM');}catch{}});
    page.close();browser.close();
  }};
  try {
    // A newly signed local build can await the user's macOS Keychain consent.
    const startupWait=Number(process.env.SUBSCRIBE_FLOW_PACKAGED_STARTUP_WAIT_MS)||20000;
    await until(async()=>await evaluate(`!!window.SubscribeFlow && !!window.SF && SubscribeFlow.call('core.status',{}).then(s=>s.state===${JSON.stringify(expected)})`),startupWait);
    if(expected==='ready') await until(async()=>await evaluate('!!SF.app.state.session'),startupWait);
    return app;
  } catch(error){await app.close();throw error;}
}
async function main() {
  const info=JSON.parse(fs.readFileSync(path.join(root,'dist/build-info.json'),'utf8'));
  const output=process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT||path.join(root,'docs/verification/m7');fs.mkdirSync(output,{recursive:true});
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-packaged-'));
  const bundle=path.join(folder,'Moved Application','Subscribe Flow.app');
  fs.mkdirSync(path.dirname(bundle),{recursive:true});
  const copy=spawnSync('/usr/bin/ditto',[info.bundle,bundle]);assert.equal(copy.status,0,copy.stderr?.toString());
  const resources=path.join(bundle,'Contents/Resources'),executable=path.join(resources,'core/subscribe-flow-core');
  const expectedVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  const schema=Math.max(...fs.readdirSync(path.join(root,'python/src/subscribe_flow/storage/migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).map(name=>Number(name.split('_')[0])));
  assert.equal(info.version,expectedVersion);
  const plist=spawnSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(bundle,'Contents/Info.plist')],{encoding:'utf8'});
  assert.equal(plist.status,0);assert.equal(plist.stdout.trim(),expectedVersion);
  const {listPackage}=await import('@electron/asar');
  const entries=listPackage(path.join(resources,'app.asar'));
  assert.ok(entries.includes('/electron/renderer/index.html'));
  assert.ok(!entries.some(p=>/runtime-paths|^\/tests\/|^\/scripts\/|\.sqlite|\/diagnostics\//.test(p)));
  const dataDir=path.join(folder,'profile');fs.mkdirSync(dataDir);
  let app,core;
  const result={packagedSmoke:'pending',version:expectedVersion,schema,platform:'macOS x64',launchServices:true,minimalPath:true,externalPythonIgnored:true,productionIgnoresTestFlags:true};
  try {
    const runtime=JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json'),'utf8'));
    result.wechatUnified=await verifyWechatUpgrade(executable,resources,folder,runtime);
    // Seed through the actual frozen RPC server, using a clearly labelled test adapter response.
    let pendingRequest,entered;
    const coreOptions={coreExecutable:executable,root:path.join(resources,'app.asar'),dataDir,schedulePolicy:{resource_gap:0},acquisition:async(p,signal)=>{
      if(pendingRequest) return new Promise((resolve,reject)=>{entered=true;signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'CANCELLED'})),{once:true});});
      return {code:0,data:{page:{pn:p.page,ps:p.limit,count:3},list:{vlist:Array.from({length:3},(_,i)=>({bvid:`BV1xx411c7${i}0`,mid:946974,title:`M7 离线验收样本 ${i+1}`,created:1700000000}))}}};
    }};
    core=new CoreClient(coreOptions);await core.start();
    assert.equal((await core.call('core.hello',{protocol_version:'1.0'})).core_version,expectedVersion);
    const sub=await core.call('subscription.add',{locator:'946974',connection_id:'bilibili:default',confirmed:true});
    const sync=async()=>{
      const job=await core.call('sync.start',{subscription_id:sub.id});
      return until(async()=>{const j=await core.call('sync.get',{job_id:job.job_id});return !['queued','running'].includes(j.state)&&j;});
    };
    assert.equal((await sync()).new_items,3);assert.equal((await sync()).new_items,0);
    const items=(await core.call('content.list')).items;
    pendingRequest=true;entered=false;
    const active=await core.call('sync.start',{subscription_id:sub.id});await until(()=>entered);
    await core.call('sync.cancel',{job_id:active.job_id});
    await until(async()=>(await core.call('sync.get',{job_id:active.job_id})).state==='cancelled');
    pendingRequest=false;
    await core.stop();core=null;
    result.frozenCore={deduplication:true,cancellation:true,contents:3};
    // The shipped Python adapter must keep the locally captured JPEG, including
    // across a frozen-Core restart. This profile is separate from the v2 fixture.
    const cover='data:image/jpeg;base64,'+fs.readFileSync(path.join(root,'tests/fixtures/xhs-cover.jpg')).toString('base64');
    const xhsId='111111111111111111111111',xhsAuthor='123456789012345678901234';
    core=new CoreClient({...coreOptions,dataDir:path.join(folder,'cover-profile'),acquisition:async p=>{
      if(p.operation==='check')return {authenticated:true};
      return {items:[{id:xhsId,authorId:xhsAuthor,title:'本地封面验收',content:'隔离正文',thumbnail:cover,images:[],
        url:`https://www.xiaohongshu.com/discovery/item/${xhsId}?source=webshare&xsec_token=fixture&xsec_source=pc_share`,
        published:{value:null,precision:'unknown',provenance:'fixture'},acquisition_complete:true}],
        errors:[],metrics:{profile_reads:0,discovered:0,skipped:0,detail_requests:1},cursor:null,terminal:true,end_evidence:'profile_end'};
    }});await core.start();
    const xhsSub=await core.call('subscription.add',{locator:xhsAuthor,connection_id:'xiaohongshu:default',confirmed:true});
    const xhsRun=await core.call('sync.start',{subscription_id:xhsSub.id});
    const xhsJob=await until(async()=>{const j=await core.call('sync.get',{job_id:xhsRun.job_id});return !['queued','running'].includes(j.state)&&j;});
    assert.equal(xhsJob.state,'succeeded');assert.equal(xhsJob.new_items,1);
    assert.equal((await core.call('content.get',{item_id:'xiaohongshu:note:'+xhsId})).thumbnail,cover);
    await core.restart();
    assert.equal((await core.call('content.get',{item_id:'xiaohongshu:note:'+xhsId})).thumbnail,cover);
    await core.stop();core=null;result.xiaohongshuLocalCover=true;
    // Make a v2 database so the real installed binary, not test code, performs the upgrade.
    // Build the historical schema from its migrations. Removing selected new
    // tables left newer priority/paid tables behind and made this a false v2.
    const legacy=spawnSync(runtime.python,['-c',`import pathlib,sqlite3,sys
db=sqlite3.connect(sys.argv[1]);old=sqlite3.connect(':memory:')
migrations=pathlib.Path(sys.argv[3])
for name in ('001_initial.sql','002_scheduling.sql'):
    old.executescript((migrations/name).read_text())
for (name,) in old.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
    columns=[row[1] for row in old.execute('PRAGMA table_info("'+name+'")')]
    names=','.join('"'+column+'"' for column in columns)
    rows=db.execute('SELECT '+names+' FROM "'+name+'"').fetchall()
    old.executemany('INSERT INTO "'+name+'" ('+names+') VALUES ('+','.join('?' for _ in columns)+')',rows)
old.execute('UPDATE content_states SET read=1,archived=1 WHERE content_id=?',(sys.argv[2],))
old.execute('PRAGMA user_version=2');old.commit();old.backup(db)
old.close();db.close()`,path.join(dataDir,'subscribe-flow.sqlite3'),items[0].id,path.join(root,'python/src/subscribe_flow/storage/migrations')],{encoding:'utf8'});
    assert.equal(legacy.status,0,legacy.stderr);
    app=await launch(bundle,dataDir,folder);
    const call=(method,params={})=>app.evaluate(`SubscribeFlow.call(${JSON.stringify(method)},${JSON.stringify(params)})`);
    assert.equal(await app.evaluate('typeof require'),'undefined');
    assert.equal(await app.evaluate('SF.app.state.source'),'real');
    assert.equal((await call('content.list')).total,3);
    assert.deepEqual((await call('content.get',{item_id:items[0].id})).state,{read:false,archived:true,deferred:false});
    assert.ok(fs.existsSync(path.join(dataDir,`subscribe-flow.before-v${schema}.backup`)));
    await until(()=>app.evaluate('document.querySelectorAll(".content-card").length===2'));
    for(const theme of ['light','dark']) {
      const logo=await app.evaluate(`(() => {document.documentElement.dataset.theme=${JSON.stringify(theme)};const m=document.querySelector('.brand__mark'),i=m.querySelector('img');return {background:getComputedStyle(m).backgroundColor,width:i.getBoundingClientRect().width};})()`);
      assert.equal(logo.background,'rgb(255, 255, 255)');assert.equal(logo.width,34);
    }
    await app.evaluate(`document.documentElement.dataset.theme='light'`);
    result.whiteBrandLogo=true;
    const selected=await app.evaluate('SF.app.state.selectedId');
    await app.evaluate(`Array.from(document.querySelectorAll('.detail .state-btn')).find(b=>b.textContent.trim()==='稍后').click()`);
    await until(()=>app.evaluate('SF.app.state.counts.unread===1 && document.querySelectorAll(".content-card").length===1'));
    assert.equal((await call('content.get',{item_id:selected})).state.deferred,true);
    await call('subscription.update',{subscription_id:sub.id,sync_mode:'automatic',interval_seconds:259200});
    assert.equal((await call('schedule.list'))[0].state,'scheduled');
    await call('subscription.update',{subscription_id:sub.id,sync_mode:'manual'});
    assert.equal((await call('schedule.list'))[0].next_due,null);
    await app.page.send('Page.enable');
    fs.writeFileSync(path.join(output,'packaged-inbox.png'),Buffer.from((await app.page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    // M8 uses the frozen Core, production bridge and real priority board.
    const priorVersion=(await call('subscription.list'))[0].version;
    await call('priority.set_source',{subscription_id:sub.id,priority:'high'});
    await call('content.update',{item_id:selected,patch:{priority:'low'}});
    assert.equal((await call('subscription.list'))[0].version,priorVersion);
    assert.equal((await call('content.list',{priority:'high'})).total,2);
    await app.evaluate(`SF.app.state.filters={quick:'all',platform:null,channelId:null}; SF.app.navigate('overview',{mode:'priority'})`);
    await until(()=>app.evaluate(`document.querySelector('[data-priority-column="high"] .count-pill')?.textContent==='2' && document.querySelector('[data-priority-column="low"] .count-pill')?.textContent==='1'`));
    fs.writeFileSync(path.join(output,'packaged-priorities.png'),Buffer.from((await app.page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    result.priorityBoard=true;result.priorityInheritance=true;
    // M9 data and M10 channel capabilities must survive the shipped Core boundary.
    const tag=await call('tag.create',{name:'0.2.0 安装包验收',color:'blue'});
    await call('content.set_tags',{item_id:selected,tag_ids:[tag.id]});
    assert.equal((await call('content.list',{tags:[tag.id]})).total,1);
    const note=await call('note.save',{item_id:selected,template:'project',summary:'离线发布验收笔记',
      takeaway:'保留个人判断与原内容',verdict:'using',summary_origin:'manual',expected_version:null});
    assert.equal((await call('note.get',{item_id:selected})).summary,note.summary);
    assert.equal((await call('note.list',{sort:'updated'})).total,1);
    const settingsBefore=await call('getSettings',[]);
    await call('saveSettings',[{section:'summarization',patch:{enabled:false,length:'detailed',language:'zh-CN'}}]);
    assert.deepEqual((await call('getSettings',[])).tagging,settingsBefore.tagging);
    assert.deepEqual((await call('getSettings',[])).ai,settingsBefore.ai);
    result.notes=true;result.summarySettingsSeparate=true;
    const xhs=(await call('channel.list')).find(channel=>channel.channel==='xiaohongshu');
    assert.ok(xhs);assert.equal(xhs.backend,'electron-session');
    result.tags=true;result.xiaohongshuChannel=true;
    // Check the latest grouped paid configuration without making a paid call.
    const wxrank=await call('wxrank.status');
    assert.equal(wxrank.configured,false);assert.equal(wxrank.usage.calls,0);
    await app.evaluate(`SF.app.navigate('channels')`);
    await until(()=>app.evaluate(`!!document.querySelector('[data-refresh-key="wxrank-card"]')`));
    assert.equal(await app.evaluate(`document.querySelector('[data-refresh-key="wxrank-card"]').closest('.connection-row')?.dataset.connectionId`),'wechat:default');
    const wechatHead=`document.querySelector('.connection-row[data-connection-id="wechat:default"] > .connection-row__head')`;
    assert.equal(await app.evaluate(`${wechatHead}.getAttribute('aria-expanded')`),'false');
    await app.evaluate(`${wechatHead}.click()`);
    await until(()=>app.evaluate(`document.querySelector('[data-refresh-key="wxrank-card"]').getClientRects().length>0`));
    assert.ok(await app.evaluate(`document.querySelector('[data-refresh-key="wxrank-card"]').innerText.includes('在线付费 API')`));
    fs.writeFileSync(path.join(output,'packaged-channels.png'),Buffer.from((await app.page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await app.evaluate(`SF.app.navigate('tags',{tab:'list'})`);
    await until(()=>app.evaluate(`!!document.querySelector('.tags-toolbar')`));
    assert.equal(await app.evaluate(`getComputedStyle(document.querySelector('.tags-toolbar')).display`),'grid');
    assert.ok(await app.evaluate(`document.querySelector('.tags-toolbar').scrollWidth <= document.querySelector('.tags-toolbar').clientWidth+1`));
    fs.writeFileSync(path.join(output,'packaged-tags.png'),Buffer.from((await app.page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    result.wxrankGrouped=true;result.wxrankPaidWarning=true;result.tagsToolbar=true;
    // Regression: the shipped theme must not hide the AI page's wheel scrolling.
    await app.page.send('Emulation.setDeviceMetricsOverride',{width:1000,height:600,deviceScaleFactor:1,mobile:false});
    await app.evaluate(`SF.app.navigate('tags',{tab:'ai'})`);
    await until(()=>app.evaluate(`!!document.querySelector('.tags-ai')`));
    await app.evaluate(`SF.views.tags.whenIdle()`);
    await until(()=>app.evaluate(`!!document.querySelector('.tags-ai select[aria-label="选择连接"]')`));
    assert.equal(await app.evaluate(`[...document.querySelectorAll('.tags-ai button')].some(b=>b.textContent.includes('不选择这条连接'))`),false);
    result.recognitionUnselectRemoved=true;
    const aiPoint=await app.evaluate(`(() => {const p=document.querySelector('.tags-ai'),r=p.getBoundingClientRect();p.scrollTop=0;return {x:r.left+8,y:r.top+60,client:p.clientHeight,scroll:p.scrollHeight};})()`);
    assert.ok(aiPoint.scroll>aiPoint.client,'AI settings exceed the compact viewport');
    await app.page.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:aiPoint.x,y:aiPoint.y,deltaX:0,deltaY:500});
    await until(()=>app.evaluate(`document.querySelector('.tags-ai').scrollTop>0`));
    const aiAtBottom=`(() => {const p=document.querySelector('.tags-ai'),last=p.lastElementChild.getBoundingClientRect(),r=p.getBoundingClientRect();return last.bottom<=r.bottom&&last.bottom>=r.top;})()`;
    for(let i=0;i<20&&!(await app.evaluate(aiAtBottom));i++){
      await app.page.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:aiPoint.x,y:aiPoint.y,deltaX:0,deltaY:500});
      await delay(160);
    }
    await until(()=>app.evaluate(aiAtBottom));
    fs.writeFileSync(path.join(output,'packaged-tags-ai-bottom.png'),Buffer.from((await app.page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    result.tagsAiWheelScroll=true;result.tagsAiBottomReachable=true;
    await app.page.send('Emulation.clearDeviceMetricsOverride');
    // Find only the frozen child of the test-launched app; never touch another instance.
    const rows=spawnSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).stdout.split('\n');
    const child=rows.map(r=>r.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).find(m=>m&&Number(m[2])===app.pid&&path.basename(m[3])===path.basename(executable));
    assert.ok(child,'test app Core child');process.kill(Number(child[1]),'SIGKILL');
    await until(async()=>(await call('core.status')).state!=='ready');
    await until(async()=>(await call('core.status')).state==='ready',20000);
    assert.equal((await call('content.get',{item_id:selected})).state.deferred,true);
    result.upgradeBackup=true;result.exclusiveState=true;result.modeSwitch=true;result.automaticCrashRecovery=true;
    await app.close();app=null;
    // Real app restart, same persisted database.
    app=await launch(bundle,dataDir,folder);
    assert.equal((await call('content.list')).total,3);
    assert.equal((await call('content.get',{item_id:selected})).state.deferred,true);
    assert.equal((await call('subscription.list'))[0].sync_mode,'manual');
    assert.equal((await call('content.get',{item_id:selected})).priority,'low');
    assert.equal((await call('subscription.list'))[0].default_priority,'high');
    assert.equal((await call('content.list',{tags:[tag.id]})).total,1);
    assert.equal((await call('tag.list')).items[0].name,tag.name);
    assert.equal((await call('note.get',{item_id:selected})).verdict,'using');
    assert.equal((await call('getSettings',[])).summarization.length,'detailed');
    result.notesRestart=true;
    result.priorityRestart=true;result.appRestart=true;
    await app.close();app=null;
    // Fault injection only alters this disposable copy of the package.
    fs.renameSync(executable,executable+'.removed');
    app=await launch(bundle,dataDir,folder,'error');
    assert.match((await call('core.status')).message,/重新解压完整应用/);
    await until(()=>app.evaluate('document.body.innerText.includes("重新解压完整应用")'));
    fs.writeFileSync(path.join(output,'missing-core.png'),Buffer.from((await app.page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    result.missingCoreHint=true;
    await app.close();app=null;
    fs.renameSync(executable+'.removed',executable);
    const logs=fs.readFileSync(path.join(dataDir,'diagnostics/lifecycle.jsonl'),'utf8');
    assert.ok(logs.includes('"packaged":true'));
    assert.ok(!logs.includes(folder)&&!logs.includes('M7 离线')&&!logs.includes('946974'));
    result.redactedDiagnostics=true;result.packagedSmoke='passed';
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result));
  } finally {await app?.close();await core?.stop();fs.rmSync(folder,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
