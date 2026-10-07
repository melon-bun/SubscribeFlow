// Read-only live acceptance. App-owned profile only; never imports Chrome cookies.
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname,'..');
const {startFreshJob, jobEvidence} = require('./live-job.cjs');
if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const profile = path.join(root,'runtime','bilibili-acceptance');
  fs.mkdirSync(profile,{recursive:true});
  const child = spawn(require('electron'),[__filename,...process.argv.slice(2)],{
    stdio:'inherit',env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:profile},
  });
  child.on('close',code => { process.exitCode = code ?? 1; });
} else {
  const {app} = require('electron');
  app.on('window-all-closed',()=>{}); // Flush and check the session before quitting.
  app.setName('Subscribe Flow B站验收');
  app.setPath('userData',process.env.SUBSCRIBE_FLOW_DATA_DIR);
  if (!app.requestSingleInstanceLock()) app.exit(1);
  app.whenReady().then(async () => {
    const {BilibiliSession} = require('../electron/main/bilibili-session.cjs');
    const {CoreClient} = require('../electron/main/core-client.cjs');
    const runtime = JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json'),'utf8'));
    const service = new BilibiliSession();
    const {ChannelSessions} = require('../electron/main/channel-sessions.cjs');
    const channels = new ChannelSessions(); channels.register('bilibili',service);
    if (process.argv.includes('--login')) {
      service.onChanged = async () => {
        try { console.log(JSON.stringify({connection:await service.request({operation:'check'})})); }
        catch (e) { console.error(e.code,e.message); }
        await service.close(); app.quit();
      };
      service.openLogin(); return;
    }
    const core = new CoreClient({...runtime,coreExecutable:process.env.SUBSCRIBE_FLOW_ACCEPTANCE_CORE,
      root,dataDir:app.getPath('userData'),acquisition:(p,s) => channels.request(p,s)});
    const timer = setTimeout(() => app.exit(1),180000);
    try {
      await core.start();
      console.log(JSON.stringify({backend:(await core.call('channel.list'))[0].backend,readiness:await core.call('connection.check',{connection_id:'bilibili:default'})}));
      const sub = await core.call('subscription.add',{connection_id:'bilibili:default',locator:'946974',confirmed:true});
      const wait = async id => {
        let job;
        do { await new Promise(r=>setTimeout(r,100)); job=await core.call('sync.get',{job_id:id}); } while(['running','queued'].includes(job.state));
        return jobEvidence(job);
      };
      const list = await startFreshJob(core,{subscription_id:sub.id,mode:'backfill',page_budget:2});
      console.log(JSON.stringify({list:await wait(list.job_id)}));
      const items=await core.call('content.list',{limit:1});
      const detail=await startFreshJob(core,{subscription_id:sub.id,mode:'detail',item_key:items.items[0].id});
      console.log(JSON.stringify({detail:await wait(detail.job_id)}));
      const search=await core.call('source.search',{connection_id:'bilibili:default',query:'影视飓风'});
      console.log(JSON.stringify({searchCandidates:search.items.length,matched:search.items.some(s=>s.external_id==='946974')}));
      for(let i=0;i<3;i++) {
        const job=await startFreshJob(core,{subscription_id:sub.id});
        console.log(JSON.stringify({repeat:i+1,...await wait(job.job_id)}));
      }
      await core.restart();
      console.log(JSON.stringify({restartContentCount:(await core.call('content.list',{limit:1})).total,live:'passed'}));
    } catch (error) { console.error(JSON.stringify({live:'blocked',code:error.code,message:error.message,evidence:error.evidence})); process.exitCode=1; }
    finally { clearTimeout(timer); await core.stop(); await service.close(); app.exit(process.exitCode || 0); }
  }).catch(e=>{console.error(e.message); app.exit(1);});
}
