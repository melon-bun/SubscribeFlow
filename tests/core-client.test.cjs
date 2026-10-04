const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {CoreClient} = require('../electron/main/core-client.cjs');
const {callUI} = require('../electron/main/app-client.cjs');

const root = path.resolve(__dirname, '..');
const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
async function fixture(run, acquisition, options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-test-'));
  const core = new CoreClient({...runtime, opencli: '/missing/opencli', root, dataDir: folder, acquisition,
    schedulePolicy:{resource_gap:0}, ...options});
  try { await core.start(); await run(core); }
  finally { await core.stop(); fs.rmSync(folder, {recursive: true, force: true}); }
}

test('real sidecar handshake, persistent subscription, UI mapping and controlled restart', async () => {
  await fixture(async core => {
    const channels = await core.call('channel.list');
    assert.equal(channels[0].channel, 'bilibili');
    const sub = await callUI(core, 'createChannel', [{platform: 'bilibili', link:'946974', confirmed:true}]);
    assert.equal(sub.platform, 'bilibili');
    const list = await callUI(core, 'listChannels', []);
    assert.equal(list.total, 1);
    await assert.rejects(callUI(core, 'createRule', [{}]), error => error.code === 'UNSUPPORTED_OPERATION');
    await assert.rejects(core.call('content.list', {limit:true}));
    await assert.rejects(core.call('os.system', {command:'invalid'}));
    const readiness = await core.call('connection.check', {connection_id:'bilibili:default'});
    assert.equal(readiness.state, 'blocked');
    assert.equal((await core.call('content.list')).total, 0);
    await core.restart();
    assert.equal((await core.call('subscription.list'))[0].id, sub.id);
  });
});

test('automatic mode persists, dispatches an overdue plan through real RPC and stops in manual mode', async () => {
  let calls=0;
  await fixture(async core=>{
    const sub=await callUI(core,'createChannel',[{platform:'bilibili',link:'946974',confirmed:true}]);
    assert.equal(sub.syncMode,'manual');
    assert.equal(sub.intervalSeconds,86400);
    await assert.rejects(callUI(core,'updateChannel',[sub.id,{syncMode:'automatic',intervalSeconds:259201}]),e=>e.code==='INVALID_INPUT');
    await callUI(core,'updateChannel',[sub.id,{syncMode:'automatic',intervalSeconds:259200}]);
    assert.equal((await core.call('schedule.list'))[0].state,'scheduled');
    await core.stop();
    const seed=spawnSync(runtime.python,['-c',"import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('UPDATE schedules SET next_due=0'); db.commit()",path.join(core.dataDir,'subscribe-flow.sqlite3')],{encoding:'utf8'});
    assert.equal(seed.status,0,seed.stderr);
    await core.start();
    let job;
    for(let i=0;i<100;i++) {
      job=(await core.call('sync.list'))[0];
      if(job?.state==='succeeded') break;
      await new Promise(r=>setTimeout(r,20));
    }
    assert.equal(job?.state,'succeeded');
    assert.equal(job.trigger,'automatic');
    assert.equal(calls,1);
    assert.equal((await core.call('content.list')).total,1);
    await callUI(core,'updateChannel',[sub.id,{syncMode:'manual'}]);
    const listed=(await callUI(core,'listChannels',[])).items[0];
    assert.equal(listed.syncMode,'manual');
    assert.equal(listed.intervalSeconds,259200);
    assert.equal(listed.schedule.next_due,null);
  }, async p=>{
    assert.equal(p.operation,'list'); calls++;
    return {code:0,data:{page:{pn:p.page,ps:p.limit,count:1},list:{vlist:[{bvid:'BV1xx411c700',mid:946974,title:'Automatic fixture',created:1700000000}]}}};
  },{schedulePolicy:{startup_delay:0,tick_seconds:0.02,resource_gap:0}});
});

test('unexpected exit recovers automatically with a bounded restart policy', async () => {
  await fixture(async core=>{
    const sub=await core.call('subscription.add',{locator:'946974',connection_id:'bilibili:default',confirmed:true});
    core.child.kill('SIGKILL');
    await core.exited;
    for(let i=0;i<100 && !core.ready;i++) await new Promise(r=>setTimeout(r,20));
    assert.equal(core.ready,true);
    assert.equal(core.restartAttempts,1);
    assert.equal((await core.call('subscription.list'))[0].id,sub.id);
    for(let attempt=2;attempt<=3;attempt++) {
      core.child.kill('SIGKILL'); await core.exited;
      for(let i=0;i<100 && !core.ready;i++) await new Promise(r=>setTimeout(r,20));
      assert.equal(core.ready,true);
      assert.equal(core.restartAttempts,attempt);
    }
    core.child.kill('SIGKILL'); await core.exited;
    await new Promise(r=>setTimeout(r,150));
    assert.equal(core.ready,false);
    assert.equal(core.child,null);
  },undefined,{autoRestart:true,restartDelays:[20,40,80]});
});

test('unexpected sidecar exit rejects pending requests and allows explicit restart', async () => {
  await fixture(async core => {
    const pending = core.call('connection.check', {connection_id:'bilibili:default'});
    core.child.kill('SIGKILL');
    await assert.rejects(pending);
    await core.exited;
    assert.equal(core.ready, false);
    await core.restart();
    assert.equal((await core.call('content.list')).total, 0);
  });
});

test('malformed protocol input does not contaminate subsequent JSON Lines', async () => {
  await fixture(async core => {
    core.child.stdin.write('this is not json\n');
    assert.equal((await core.call('content.list')).total, 0);
  });
});

test('private browser RPC commits a large API page, details and repeated refresh without losing read state',async () => {
  const requests=[];
  const acquisition=async p => {
    requests.push(p);
    if(p.operation==='check') return {code:0,data:{authenticated:true}};
    if(p.operation==='search') return {code:0,data:{numResults:1,result:[{mid:946974,uname:'测试作者'}]}};
    if(p.operation==='detail') return {code:0,data:{bvid:p.bvid,title:'更新标题',desc:'详情补充',pubdate:1700000000}};
    return {code:0,data:{page:{pn:p.page,ps:p.limit,count:20},list:{vlist:Array.from({length:20},(_,i)=>({
      bvid:'BV1xx411c7' + String(i).padStart(2,'0'),mid:946974,title:'测试视频 '+i,created:1700000000,description:'大响应验证'.repeat(1800),
    }))}}};
  };
  await fixture(async core=>{
    const connection=await core.call('connection.check',{connection_id:'bilibili:default'});
    assert.equal(connection.authentication,'available');
    const result=await core.call('source.search',{connection_id:'bilibili:default',query:'测试'});
    assert.equal(result.items[0].external_id,'946974');
    const sub=await core.call('subscription.add',{connection_id:'bilibili:default',locator:'946974',confirmed:true});
    const wait=async id=>{
      let job;
      for(let i=0;i<100;i++) {
        job=await core.call('sync.get',{job_id:id});
        if(!['running','queued'].includes(job.state)) return job;
        await new Promise(r=>setTimeout(r,20));
      }
      throw new Error('job did not finish');
    };
    let job=await core.call('sync.start',{subscription_id:sub.id,mode:'backfill',page_budget:1});
    assert.equal((await wait(job.job_id)).state,'succeeded');
    const saved=await core.call('content.list');
    assert.equal(saved.total,20);
    const progress=(await core.call('sync.coverage',{subscription_id:sub.id})).progress;
    assert.ok(progress.length>0 && progress.every(p=>p.compatible));
    const item=saved.items[0];
    await core.call('content.update',{item_id:item.id,patch:{read:true}});
    // Inbox and its count share the same unprocessed scope; all-content queries
    // still retain every record, including independently overlapping states.
    const deferred=saved.items[1], archived=saved.items[2];
    await callUI(core,'updateContent',[deferred.id,{state:{deferred:true}}]);
    await callUI(core,'updateContent',[archived.id,{state:{archived:true}}]);
    let inbox=await callUI(core,'listContents',[{state:'unread'}]);
    assert.equal(inbox.total,17);
    assert.ok(inbox.items.every(c=>![item.id,deferred.id,archived.id].includes(c.id)));
    assert.deepEqual(await callUI(core,'getCounts',[]),{total:20,unread:17,read:1,deferred:1,archived:1});
    assert.equal((await callUI(core,'listContents',[{}])).total,20);
    // Clearing only one of two active flags must not return a record to inbox.
    await callUI(core,'updateContent',[deferred.id,{state:{read:true}}]);
    await callUI(core,'updateContent',[deferred.id,{state:{deferred:false}}]);
    assert.equal((await callUI(core,'listContents',[{state:'unread'}])).total,17);
    await callUI(core,'updateContent',[deferred.id,{state:{read:false}}]);
    await callUI(core,'updateContent',[archived.id,{state:{archived:false}}]);
    assert.equal((await callUI(core,'getCounts',[])).unread,19);
    job=await core.call('sync.start',{subscription_id:sub.id,mode:'detail',item_key:item.id});
    assert.equal((await wait(job.job_id)).state,'succeeded');
    assert.equal((await core.call('content.get',{item_id:item.id})).summary,'详情补充');
    await core.restart();
    job=await core.call('sync.start',{subscription_id:sub.id});
    assert.equal((await wait(job.job_id)).new_items,0);
    assert.equal((await core.call('content.get',{item_id:item.id})).state.read,true);
    assert.ok(requests.every(p=>!('url' in p) && !('script' in p)));
  },acquisition);
});

test('cancelling a live Core job aborts Main acquisition and releases the shared resource',async () => {
  let entered, aborted;
  const entry=new Promise(resolve=>{entered=resolve;});
  const abort=new Promise(resolve=>{aborted=resolve;});
  const acquisition=(p,signal)=>new Promise((resolve,reject)=>{
    entered();
    signal.addEventListener('abort',()=>{aborted(); reject(Object.assign(new Error('cancelled'),{code:'CANCELLED'}));},{once:true});
  });
  await fixture(async core=>{
    const sub=await core.call('subscription.add',{connection_id:'bilibili:default',locator:'946974',confirmed:true});
    const job=await core.call('sync.start',{subscription_id:sub.id});
    await entry;
    await core.call('sync.cancel',{job_id:job.job_id});
    await Promise.race([abort,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Main request not cancelled')),2000))]);
    assert.equal((await core.call('sync.get',{job_id:job.job_id})).state,'cancelled');
    core.acquisition=async()=>({code:0,data:{authenticated:true}});
    assert.equal((await core.call('connection.check',{connection_id:'bilibili:default'})).state,'ready');
  },acquisition);
});
