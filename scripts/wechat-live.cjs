// M14 real-platform acceptance against the user's own WeChat article link.
// Runs in a throwaway Electron profile and an isolated database: never opens or
// migrates the daily application database, never packages.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..');
const URL_ARG=process.argv.find(a=>a.startsWith('--url='));
const ARTICLE_URL=URL_ARG?URL_ARG.slice(6):'https://mp.weixin.qq.com/s/xU4gmCIp_MSONxdFXPwZ3g';
if(!process.versions.electron) {
  const {spawn}=require('node:child_process');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-wechat-live-'));
  const child=spawn(require('electron'),[__filename,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:folder}});
  const timer=setTimeout(()=>child.kill('SIGTERM'),180000);
  child.on('close',code=>{clearTimeout(timer);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=code??1;});
} else {
  const {app}=require('electron');
  app.setName('Subscribe Flow 微信验收');
  app.setPath('userData',process.env.SUBSCRIBE_FLOW_DATA_DIR);
  app.on('window-all-closed',()=>{});
  app.whenReady().then(async()=>{
    const {CoreClient}=require('../electron/main/core-client.cjs');
    const {ChannelSessions}=require('../electron/main/channel-sessions.cjs');
    const {BilibiliSession}=require('../electron/main/bilibili-session.cjs');
    const {XiaohongshuSession}=require('../electron/main/xiaohongshu-session.cjs');
    const {ZhihuSession}=require('../electron/main/zhihu-session.cjs');
    const {WechatSession}=require('../electron/main/wechat-session.cjs');
    const {resolveRuntime}=require('../electron/main/runtime.cjs');
    const router=new ChannelSessions();
    router.register('bilibili',new BilibiliSession({offline:true}));
    router.register('xiaohongshu',new XiaohongshuSession({offline:true}));
    router.register('zhihu',new ZhihuSession({offline:true}));
    const wechat=new WechatSession({apiOptions:{minGap:1500}});
    router.register('wechat',wechat);
    const core=new CoreClient({...resolveRuntime({packaged:false,root}),root,dataDir:app.getPath('userData'),
      schedulePolicy:{resource_gap:0},acquisition:(p,s)=>router.request(p,s)});
    const report={at:new Date().toISOString(),channel:'wechat',realPlatform:true,isolatedDatabase:true,url:ARTICLE_URL};
    const recognize=async url=>{
      const started=await core.call('intake.start',{url});
      let task=started;
      do {await new Promise(r=>setTimeout(r,200));task=await core.call('intake.get',{task_id:started.task_id});} while(['queued','running'].includes(task.state));
      if(['failed','cancelled'].includes(task.state)) throw Object.assign(new Error(task.error?.message||task.state),{code:task.error?.code});
      return task;
    };
    try {
      await core.start();
      const channel=(await core.call('channel.list')).find(d=>d.channel==='wechat');
      report.operations=Object.keys(channel.operations).filter(op=>channel.operations[op].supported);
      report.readiness=(await core.call('connection.check',{connection_id:'wechat:default',operation:'read_item'})).state;
      const task=await recognize(ARTICLE_URL);
      if(task.state!=='preview') throw new Error('Missing preview');
      const preview=task.preview;
      if(!preview.source.confirmed || preview.source.kind!=='account' || !preview.summary?.trim()) throw new Error('Missing confirmed account or body');
      if((await core.call('content.list')).total!==0) throw new Error('Preview wrote a content shell');
      const saved=await core.call('intake.save',{preview_id:task.preview_id,priority:'medium'});
      const before=await core.call('content.get',{item_id:saved.item_id});
      // A parameter-form link only resolves when it still carries the
      // platform's own chksm signature, which the app does not compute. Record
      // what WeChat answers for the unsigned alias instead of assuming it works.
      const alias=`https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(preview.source.external_id)}&mid=${preview.external_id.split('_')[1]}&idx=${preview.external_id.split('_')[2]}&scene=27`;
      let unsignedAlias=null;
      try { const aliasTask=await recognize(alias); unsignedAlias={state:aliasTask.state,preview:!!aliasTask.preview}; }
      catch(error) { unsignedAlias={state:'failed',code:error.code,message:error.message}; }
      const again=await recognize(ARTICLE_URL);
      if(again.state!=='exists') throw new Error('Duplicate changed content');
      if(JSON.stringify(before)!==JSON.stringify(await core.call('content.get',{item_id:saved.item_id}))) throw new Error('Duplicate modified the record');
      if((await core.call('content.list')).total!==1) throw new Error('Refused link created a record');
      if((await core.call('subscription.list')).length!==0 || (await core.call('sync.list')).length!==0) throw new Error('Intake fabricated subscription/job');
      await core.restart();
      if((await core.call('content.list',{intake_method:'manual'})).total!==1) throw new Error('Restart did not preserve manual content');
      Object.assign(report,{state:'passed',id:saved.item_id,title:before.title,sourceId:preview.source.external_id,
        sourceName:preview.source.name,sourceUrl:preview.source.url,thumbnail:!!before.thumbnail,
        published:before.published,bodyChars:before.summary?.length||0,duplicateSameRecord:true,unsignedAlias,
        calendarBasis:before.calendar_basis,duplicateNoOp:true,subscriptionCount:0,restartPersisted:true});
    } catch(error) {
      Object.assign(report,{state:'blocked',code:error.code||'ACCESS_FAILED',message:error.message});
      process.exitCode=1;
    } finally {
      const out=path.join(root,'docs/verification/m14');
      fs.mkdirSync(out,{recursive:true});
      fs.writeFileSync(path.join(out,'live-wechat.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify(report));
      await core.stop();await router.close();app.exit(process.exitCode||0);
    }
  }).catch(error=>{console.error(error.message);app.exit(1);});
}