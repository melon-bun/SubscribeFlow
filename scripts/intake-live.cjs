// Small real-platform acceptance in a copy of an existing acceptance profile.
// Never opens or migrates the daily application database; never packages.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..');
const channel=process.argv.includes('--xhs')?'xiaohongshu':'bilibili';
if(!process.versions.electron) {
  const {spawn}=require('node:child_process');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-intake-live-'));
  const original=path.join(root,'runtime',channel+'-acceptance');
  for(const part of ['Partitions','Local State']) {
    const source=path.join(original,part);
    if(fs.existsSync(source)) fs.cpSync(source,path.join(folder,part),{recursive:true,filter:p=>!['Cache','Code Cache','GPUCache','DawnGraphiteCache'].includes(path.basename(p))});
  }
  const child=spawn(require('electron'),[__filename,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:folder}});
  const timer=setTimeout(()=>child.kill('SIGTERM'),150000);
  child.on('close',code=>{clearTimeout(timer);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=code??1;});
} else {
  const {app}=require('electron');
  app.setName(channel==='xiaohongshu'?'Subscribe Flow XHS Test':'Subscribe Flow B站验收');app.setPath('userData',process.env.SUBSCRIBE_FLOW_DATA_DIR);app.on('window-all-closed',()=>{});
  app.whenReady().then(async()=>{
    const {CoreClient}=require('../electron/main/core-client.cjs');
    const {ChannelSessions}=require('../electron/main/channel-sessions.cjs');
    const {BilibiliSession}=require('../electron/main/bilibili-session.cjs');
    const {XiaohongshuSession}=require('../electron/main/xiaohongshu-session.cjs');
    const {resolveRuntime}=require('../electron/main/runtime.cjs');
    const router=new ChannelSessions();
    router.register('bilibili',new BilibiliSession({offline:channel!=='bilibili'}));
    const xhs=router.register('xiaohongshu',new XiaohongshuSession({offline:channel!=='xiaohongshu'}));
    const core=new CoreClient({...resolveRuntime({packaged:false,root}),root,dataDir:app.getPath('userData'),schedulePolicy:{resource_gap:3},acquisition:(p,s)=>router.request(p,s)});
    const report={at:new Date().toISOString(),channel,realPlatform:true,isolatedDatabase:true,copiedAcceptanceSession:true};
    const recognize=async url=>{
      let task=await core.call('intake.start',{url});
      do {await new Promise(r=>setTimeout(r,200));task=await core.call('intake.get',{task_id:task.task_id});} while(['queued','running'].includes(task.state));
      if(['failed','cancelled'].includes(task.state)) throw Object.assign(new Error(task.error?.message||task.state),{code:task.error?.code});
      return task;
    };
    try {
      await core.start();
      let url='https://www.bilibili.com/video/BV1yEaJ6CEUk';
      if(channel==='xiaohongshu') {
        if(process.argv.includes('--login')) {
          const closed=new Promise(resolve=>{xhs.onChanged=resolve;});
          await xhs.openLogin();
          console.log(JSON.stringify({channel,state:'waiting_for_login',isolatedDatabase:true,instruction:'在验收窗口登录，完成后关闭窗口以继续验证'}));
          await closed;
        }
        const readiness=await core.call('connection.check',{connection_id:'xiaohongshu:default'});
        if(readiness.state!=='ready') throw Object.assign(new Error(readiness.reason),{code:'AUTH_REQUIRED'});
        // Obtain a fresh official signed URL for the already accepted public sample.
        const shared=await router.request({channel,operation:'detail',uid:'5c6391880000000012009893',id:'6abcd36d000000001203e7c6'});
        url=shared.note.url;
      }
      const task=await recognize(url);
      if(task.state!=='preview' || !task.preview.source.confirmed) throw new Error('Missing authoritative preview or author');
      if((await core.call('content.list')).total!==0) throw new Error('Preview wrote a content shell');
      const saved=await core.call('intake.save',{preview_id:task.preview_id,priority:'medium'});
      const before=await core.call('content.get',{item_id:saved.item_id});
      const again=await recognize(url);
      if(again.state!=='exists' || JSON.stringify(before)!==JSON.stringify(await core.call('content.get',{item_id:saved.item_id}))) throw new Error('Duplicate changed content');
      if((await core.call('subscription.list')).length!==0 || (await core.call('sync.list')).length!==0) throw new Error('Intake fabricated subscription/job');
      await core.restart();
      if((await core.call('content.list',{intake_method:'manual'})).total!==1) throw new Error('Restart did not preserve manual content');
      Object.assign(report,{state:'passed',id:saved.item_id,title:before.title,sourceId:task.preview.source.external_id,
        published:before.published,calendarBasis:before.calendar_basis,duplicateNoOp:true,subscriptionCount:0,restartPersisted:true});
    } catch(error) {Object.assign(report,{state:'blocked',code:error.code||'ACCESS_FAILED',message:error.message});process.exitCode=1;}
    finally {
      const out=path.join(root,'docs/verification/m13');fs.mkdirSync(out,{recursive:true});
      fs.writeFileSync(path.join(out,'live-'+channel+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
      await core.stop();await router.close();app.exit(process.exitCode||0);
    }
  }).catch(error=>{console.error(error.message);app.exit(1);});
}
