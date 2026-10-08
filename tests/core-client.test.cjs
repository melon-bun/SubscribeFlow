const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {CoreClient} = require('../electron/main/core-client.cjs');
const {callUI} = require('../electron/main/app-client.cjs');
const {startFreshJob, jobEvidence} = require('../scripts/live-job.cjs');

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
    assert.equal((await callUI(core, 'getSession', [])).capabilities.canManageTags, true);
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

test('M11 optional intake stays unsupported on existing channels through real RPC without acquisition', async () => {
  let acquisitions=0;
  await fixture(async core => {
    const session=await callUI(core,'getSession',[]);
    assert.equal(session.capabilities.canIntake,false);
    assert.ok(session.channels.every(channel=>channel.contract_version==='1.1'));
    await assert.rejects(callUI(core,'startIntake',[{url:'https://www.bilibili.com/video/BV1xx411c700'}]), e=>e.code==='UNSUPPORTED_OPERATION');
    await assert.rejects(callUI(core,'getIntake',['missing']), e=>e.code==='NOT_FOUND');
    await assert.rejects(callUI(core,'cancelIntake',['missing']), e=>e.code==='NOT_FOUND');
    await assert.rejects(callUI(core,'saveIntake',['missing',{}]), e=>e.code==='PREVIEW_EXPIRED');
    assert.deepEqual(await callUI(core,'listContentSources',[]),{items:[],total:0});
    assert.equal((await core.call('content.list',{intake_method:'manual',timezone:'Asia/Tokyo'})).total,0);
    assert.equal(acquisitions,0);
  },async()=>{acquisitions++;throw new Error('No platform request expected');});
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

test('live acceptance retries a persisted waiting job and proves a new acquisition occurred', async () => {
  let blocked=true, requests=0;
  await fixture(async core=>{
    const sub=await core.call('subscription.add',{locator:'946974',connection_id:'bilibili:default',confirmed:true});
    const wait=async id=>{
      for(let i=0;i<100;i++) {const job=await core.call('sync.get',{job_id:id});if(!['queued','running'].includes(job.state))return job;await new Promise(r=>setTimeout(r,20));}
      throw new Error('Test job did not settle');
    };
    const first=await startFreshJob(core,{subscription_id:sub.id});
    assert.equal((await wait(first.job_id)).state,'waiting');
    await core.restart();blocked=false;
    const reused=await core.call('sync.start',{subscription_id:sub.id});
    assert.equal(reused.created,false);assert.equal(reused.job_id,first.job_id);assert.equal(requests,1);
    const fresh=await startFreshJob(core,{subscription_id:sub.id});
    assert.notEqual(fresh.job_id,first.job_id);assert.equal(fresh.created,true);
    assert.equal((await wait(fresh.job_id)).state,'succeeded');
    assert.equal(requests,2);assert.equal((await core.call('sync.get',{job_id:first.job_id})).state,'cancelled');
    assert.equal((await core.call('content.list')).total,1);
  },async p=>{requests++;return blocked?{code:-352}:{code:0,data:{page:{pn:p.page,ps:p.limit,count:1},list:{vlist:[{bvid:'BV1xx411c700',mid:946974,title:'Live acceptance regression fixture',created:1700000000}]}}};});
});

test('bounded acceptance preserves coverage and reports item failures independently of login', () => {
  const window={id:'new-window',mode:'backfill',page_budget:10,state:'succeeded',pages:10,items:200,new_items:200,
    item_errors:0,error:null,coverage:'window_only',created_at:'2026-10-05T09:20:47Z',updated_at:'2026-10-05T09:21:16Z'};
  const evidence=jobEvidence(window);
  assert.equal(evidence.state,'succeeded');assert.equal(evidence.coverage,'window_only');assert.equal(evidence.pageBudget,10);
  assert.throws(()=>jobEvidence({...window,error:{code:'INTERACTION_REQUIRED',message:'challenge'}}),e=>e.code==='INTERACTION_REQUIRED');
  assert.throws(()=>jobEvidence({...window,state:'partial',coverage:'possible_gaps',items:193,new_items:193,item_errors:7}),
    e=>e.evidence.itemErrors===7 && e.evidence.error===null && e.evidence.items===193);
  assert.throws(()=>jobEvidence({...window,state:'partial',coverage:'possible_gaps'}));
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
    // still retain every record; processing states are mutually exclusive.
    const deferred=saved.items[1], archived=saved.items[2];
    await callUI(core,'updateContent',[deferred.id,{state:{deferred:true}}]);
    await callUI(core,'updateContent',[archived.id,{state:{archived:true}}]);
    let inbox=await callUI(core,'listContents',[{state:'unread'}]);
    assert.equal(inbox.total,17);
    assert.ok(inbox.items.every(c=>![item.id,deferred.id,archived.id].includes(c.id)));
    assert.deepEqual(await callUI(core,'getCounts',[]),{total:20,unread:17,read:1,deferred:1,archived:1,high:0,medium:0,low:0,none:20});
    assert.equal((await callUI(core,'listContents',[{}])).total,20);
    // Selecting a new state clears the old one; clearing an inactive flag is harmless.
    await callUI(core,'updateContent',[deferred.id,{state:{read:true}}]);
    assert.deepEqual((await core.call('content.get',{item_id:deferred.id})).state,{read:true,archived:false,deferred:false});
    assert.deepEqual(await callUI(core,'getCounts',[]),{total:20,unread:17,read:2,deferred:0,archived:1,high:0,medium:0,low:0,none:20});
    await assert.rejects(callUI(core,'updateContent',[deferred.id,{state:{read:true,deferred:true}}]),e=>e.code==='INVALID_INPUT');
    await callUI(core,'updateContent',[deferred.id,{state:{deferred:false}}]);
    assert.equal((await callUI(core,'listContents',[{state:'unread'}])).total,17);
    await callUI(core,'updateContent',[deferred.id,{state:{read:false}}]);
    await callUI(core,'updateContent',[archived.id,{state:{archived:false}}]);
    assert.equal((await callUI(core,'getCounts',[])).unread,19);
    // Priority changes remain independent from collection snapshots and processing.
    await callUI(core,'savePrioritySettings',[{id:sub.id,priority:'high'}]);
    assert.equal((await core.call('subscription.list'))[0].version,sub.version);
    assert.ok((await core.call('sync.coverage',{subscription_id:sub.id})).progress.every(p=>p.compatible));
    assert.equal((await callUI(core,'getCounts',[])).high,20);
    await callUI(core,'updateContent',[item.id,{priority:'low'}]);
    await callUI(core,'savePrioritySettings',[{id:sub.id,priority:'medium'}]);
    assert.equal((await callUI(core,'getContent',[item.id])).priority,'low');
    assert.equal((await callUI(core,'listContents',[{priority:'medium',state:'unread'}])).total,19);
    await assert.rejects(core.call('priority.set_source',{subscription_id:sub.id,priority:true}));
    await assert.rejects(callUI(core,'updateContent',[item.id,{priority:'urgent'}]),e=>e.code==='INVALID_INPUT');
    await assert.rejects(callUI(core,'bulkUpdate',[[item.id,'missing'],{priority:'high'}]),e=>e.code==='NOT_FOUND');
    assert.equal((await callUI(core,'getContent',[item.id])).priority,'low');
    job=await core.call('sync.start',{subscription_id:sub.id,mode:'detail',item_key:item.id});
    assert.equal((await wait(job.job_id)).state,'succeeded');
    assert.equal((await core.call('content.get',{item_id:item.id})).summary,'详情补充');
    await core.restart();
    job=await core.call('sync.start',{subscription_id:sub.id});
    assert.equal((await wait(job.job_id)).new_items,0);
    assert.equal((await core.call('content.get',{item_id:item.id})).state.read,true);
    assert.equal((await callUI(core,'getContent',[item.id])).priority,'low');
    await callUI(core,'updateContent',[item.id,{priority:null}]);
    assert.equal((await callUI(core,'getContent',[item.id])).priority,'medium');
    await callUI(core,'savePrioritySettings',[{id:sub.id,priority:null}]);
    assert.equal((await callUI(core,'listContents',[{priority:'none'}])).total,20);
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

test('real sidecar tag lifecycle, filtering and restart survival through the whitelisted bridge', async () => {
  const acquisition = async p => {
    if (p.operation === 'check') return {code:0, data:{authenticated:true}};
    if (p.operation === 'search') return {code:0, data:{numResults:1, result:[{mid:946974, uname:'测试作者'}]}};
    return {code:0, data:{page:{pn:p.page, ps:p.limit, count:4}, list:{vlist:Array.from({length:4},(_,i)=>({
      bvid:'BV1tag411c'+String(i).padStart(2,'0'), mid:946974, title:'标签验证 '+i, created:1700000000+i*86400,
    }))}}};
  };
  await fixture(async core => {
    const sub = await callUI(core, 'createChannel', [{platform:'bilibili', link:'946974', confirmed:true}]);
    const wait = async id => {
      let job;
      for (let i=0;i<100;i++) {
        job = await core.call('sync.get',{job_id:id});
        if (!['running','queued'].includes(job.state)) return job;
        await new Promise(r => setTimeout(r,20));
      }
      throw new Error('job did not finish');
    };
    assert.equal((await wait((await core.call('sync.start',{subscription_id:sub.id, mode:'backfill', page_budget:1})).job_id)).state, 'succeeded');

    // 建标签：颜色受控、重名被拒、默认色可取
    const travel = await callUI(core, 'createTag', [{name:'旅行', color:'cyan', synonyms:['出游']}]);
    assert.equal(travel.color, 'cyan');
    assert.equal(travel.contentCount, 0);
    await callUI(core,'createTag',[{name:'Travel'}]);
    // 大小写不同的重名由唯一索引拦下，不会静默合并成同一个标签
    await assert.rejects(callUI(core,'createTag',[{name:'travel'}]), error => error.code === 'CONFLICT');
    await assert.rejects(callUI(core,'createTag',[{name:'TRAVEL'}]), error => error.code === 'CONFLICT');
    await assert.rejects(callUI(core,'createTag',[{name:'配色', color:'chartreuse'}]));
    const food = await callUI(core, 'createTag', [{name:'美食'}]);
    assert.equal(food.color, 'slate');

    const items = await callUI(core, 'listContents', [{limit:10}]);
    assert.equal(items.total, 4);

    // 人工打标经过统一服务，origin 为 manual
    await callUI(core, 'setContentTags', [items.items[0].id, [travel.id]]);
    await callUI(core, 'setContentTags', [items.items[1].id, [travel.id, food.id]]);
    const tagged = await callUI(core, 'getContent', [items.items[0].id]);
    assert.deepEqual(tagged.tags.map(t => [t.name, t.origin]), [['旅行','manual']]);

    // 任一符合命中 2 条，全部符合只命中同时带两个标签的那 1 条
    assert.equal((await callUI(core,'listContents',[{tags:[travel.id]}])).total, 2);
    assert.equal((await callUI(core,'listContents',[{tags:[travel.id, food.id]}])).total, 2);
    assert.equal((await callUI(core,'listContents',[{tags:[travel.id, food.id], tagMode:'all'}])).total, 1);
    await assert.rejects(callUI(core,'listContents',[{tags:[travel.id], tagMode:'sometimes'}]));

    // 批量打标与优先级可组合
    await callUI(core, 'bulkSetTags', [[items.items[2].id, items.items[3].id], [food.id]]);
    await callUI(core, 'bulkUpdate', [[items.items[2].id], {priority:'high'}]);
    assert.equal((await callUI(core,'listContents',[{tags:[food.id], priority:'high'}])).total, 1);

    // 标签视图：使用次数、改名不丢关联、删除如实回报影响条数
    const list = await callUI(core, 'listTags', []);
    assert.equal(list.total, 3);
    assert.equal(list.items.find(t => t.id === food.id).contentCount, 3);
    assert.equal((await callUI(core,'listTagContents',[travel.id, {}])).total, 2);
    await callUI(core, 'updateTag', [travel.id, {description:'可清空的描述'}]);
    assert.equal((await callUI(core, 'updateTag', [travel.id, {description:''}])).description, '');
    await assert.rejects(core.call('tag.update', {tag_id:travel.id, name:''}));
    await assert.rejects(core.call('tag.update', {tag_id:'', description:''}));
    assert.equal((await callUI(core,'listTagContents',[travel.id, {state:'unread', priority:'none'}])).total, 2);
    assert.equal((await callUI(core,'listTagContents',[travel.id, {state:'read'}])).total, 0);
    assert.equal((await callUI(core,'listTagContents',[travel.id, {priority:'high'}])).total, 0);
    await callUI(core, 'updateTag', [travel.id, {name:'出行'}]);
    assert.equal((await callUI(core,'listTagContents',[travel.id, {}])).total, 2);
    const removed = await callUI(core, 'removeTag', [food.id]);
    assert.equal(removed.detachedContents, 3);
    assert.equal((await callUI(core,'getContent',[items.items[0].id])).tags.length, 1);

    // 停用不再作为新归类候选，但已有归类仍可检索
    await callUI(core, 'setTagEnabled', [travel.id, false]);
    assert.equal((await callUI(core,'listTags',[{enabled:false}])).total, 1);
    // 美食已删除，剩下启用的是 Travel 一个
    assert.equal((await callUI(core,'listTags',[{enabled:true}])).total, 1);
    assert.equal((await callUI(core,'listContents',[{tags:[travel.id]}])).total, 2);

    // 重启后全部结果一致
    await core.restart();
    const after = await callUI(core, 'listTags', []);
    assert.equal(after.total, 2);
    assert.equal(after.items.find(t => t.id === travel.id).name, '出行');
    assert.equal((await callUI(core,'getContent',[items.items[0].id])).tags[0].name, '出行');

    // 内容上的标签全部来自用户标签库，每条都带来源标记，不会混入平台话题
    const raw = await core.call('content.get', {item_id: items.items[0].id});
    const owned = new Set((await callUI(core,'listTags',[])).items.map(t => t.id));
    assert.ok(raw.tags.length > 0);
    for (const tag of raw.tags) {
      assert.ok(owned.has(tag.id), `标签 ${tag.id} 不在用户标签库中`);
      assert.equal(tag.origin, 'manual');
    }
    assert.ok(!JSON.stringify(raw.payload || {}).includes('hashtag'));
  }, acquisition);
});
