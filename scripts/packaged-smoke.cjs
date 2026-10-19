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
async function launch(bundle,dataDir,work,expected='ready') {
  const number=await port();
  const args=['-n','-g','-W','-a',bundle,'--stdout',path.join(work,'stdout.log'),'--stderr',path.join(work,'stderr.log')];
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
    await until(async()=>await evaluate(`!!window.SubscribeFlow && !!window.SF && SubscribeFlow.call('core.status',{}).then(s=>s.state===${JSON.stringify(expected)})`));
    if(expected==='ready') await until(async()=>await evaluate('!!SF.app.state.session'));
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
    // Make a v2 database so the real installed binary, not test code, performs the upgrade.
    const runtime=JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json'),'utf8'));
    const legacy=spawnSync(runtime.python,['-c',`import sqlite3,sys
db=sqlite3.connect(sys.argv[1]);db.executescript('''
ALTER TABLE content_states RENAME TO old_states;
CREATE TABLE content_states(content_id TEXT PRIMARY KEY REFERENCES contents(id) ON DELETE CASCADE,read INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,deferred INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
INSERT INTO content_states SELECT content_id,read,archived,deferred,updated_at FROM old_states;
DROP TABLE old_states;
ALTER TABLE subscriptions DROP COLUMN collect_items;
ALTER TABLE subscriptions DROP COLUMN default_priority;
DROP TABLE content_tags;
DROP TABLE content_tag_blocks;
DROP TABLE tags;
ALTER TABLE jobs DROP COLUMN acquisition_metrics;
DROP TRIGGER content_intake_immutable;
DROP INDEX content_intake_timeline;
ALTER TABLE contents DROP COLUMN manual_added_at;
ALTER TABLE contents DROP COLUMN intake_method;
-- v2 predates settings, reminders and tagging; keeping these tables makes
-- the upgrade fail with "table already exists" instead of testing a v2 file.
DROP TABLE tagging_tasks;
DROP TABLE content_events;
DROP TABLE reminder_run_state;
DROP TABLE app_settings;
PRAGMA user_version=2;
''');db.execute('UPDATE content_states SET read=1,archived=1 WHERE content_id=?',(sys.argv[2],));db.commit();db.close()`,path.join(dataDir,'subscribe-flow.sqlite3'),items[0].id],{encoding:'utf8'});
    assert.equal(legacy.status,0,legacy.stderr);
    app=await launch(bundle,dataDir,folder);
    const call=(method,params={})=>app.evaluate(`SubscribeFlow.call(${JSON.stringify(method)},${JSON.stringify(params)})`);
    assert.equal(await app.evaluate('typeof require'),'undefined');
    assert.equal(await app.evaluate('SF.app.state.source'),'real');
    assert.equal((await call('content.list')).total,3);
    assert.deepEqual((await call('content.get',{item_id:items[0].id})).state,{read:false,archived:true,deferred:false});
    assert.ok(fs.existsSync(path.join(dataDir,`subscribe-flow.before-v${schema}.backup`)));
    await until(()=>app.evaluate('document.querySelectorAll(".content-card").length===2'));
    const selected=await app.evaluate('SF.app.state.selectedId');
    await app.evaluate(`Array.from(document.querySelectorAll('.detail .op-btn')).find(b=>b.textContent.trim()==='稍后处理').click()`);
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
    const xhs=(await call('channel.list')).find(channel=>channel.channel==='xiaohongshu');
    assert.ok(xhs);assert.equal(xhs.backend,'electron-session');
    result.tags=true;result.xiaohongshuChannel=true;
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
