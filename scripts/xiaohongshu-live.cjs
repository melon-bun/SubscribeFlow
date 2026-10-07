// Read-only real-platform acceptance in its own persistent application profile.
const path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'..');
if(!process.versions.electron) {
  const {spawn}=require('node:child_process');
  const profile=path.join(root,'runtime/xiaohongshu-acceptance');fs.mkdirSync(profile,{recursive:true});
  const child=spawn(require('electron'),[__filename,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:profile}});
  child.on('close',code=>{process.exitCode=code ?? 1;});
}else{
  const {app}=require('electron');
  app.setName('Subscribe Flow XHS Test');app.setPath('userData',process.env.SUBSCRIBE_FLOW_DATA_DIR);
  app.on('window-all-closed',()=>{});
  if(!app.requestSingleInstanceLock()){
    console.error('小红书验收会话仍在运行，请关闭登录或验收窗口后再继续。');app.exit(1);
  }
  app.whenReady().then(async()=>{
    const {XiaohongshuSession}=require('../electron/main/xiaohongshu-session.cjs');
    const {BilibiliSession}=require('../electron/main/bilibili-session.cjs');
    const {ChannelSessions}=require('../electron/main/channel-sessions.cjs');
    const {CoreClient}=require('../electron/main/core-client.cjs');
    const {resolveRuntime}=require('../electron/main/runtime.cjs');
    const channels=new ChannelSessions();
    const service=channels.register('xiaohongshu',new XiaohongshuSession());
    channels.register('bilibili',new BilibiliSession({offline:true}));
    const core=new CoreClient({...resolveRuntime({packaged:false,root}),root,dataDir:app.getPath('userData'),
      acquisition:(p,s)=>channels.request(p,s),schedulePolicy:{resource_gap:0}});
    const output=path.join(root,'docs/verification/m10-xiaohongshu');fs.mkdirSync(output,{recursive:true});
    const arg=name=>{const i=process.argv.indexOf(name);return i<0 ? null : process.argv[i+1];};
    const record=data=>{const report={at:new Date().toISOString(),realPlatform:true,...data};fs.writeFileSync(path.join(output,'live-latest.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,`live-${data.stage || 'error'}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report));};
    const finish=async(code=0)=>{await core.stop();await channels.close();app.exit(code);};
    try {
      await core.start();
      if(process.argv.includes('--login')) {
        service.onChanged=async()=>{
          try{const r=await core.call('connection.check',{connection_id:'xiaohongshu:default'});record({stage:'login',readiness:r});await finish(r.state==='ready' ? 0 : 1);}
          catch(e){record({stage:'login',state:'blocked',code:e.code,message:e.message});await finish(1);}
        };
        await service.openLogin();record({stage:'login',state:'waiting_for_user',instruction:'请在小红书官方窗口登录，完成后关闭窗口。'});return;
      }
      const readiness=await core.call('connection.check',{connection_id:'xiaohongshu:default'});
      if(readiness.state!=='ready'){record({stage:'connection',state:'blocked',readiness});await finish(1);return;}
      const query=arg('--query'),uid=arg('--uid');
      if(query){const result=await core.call('source.search',{connection_id:'xiaohongshu:default',query});record({stage:'search',state:'passed',candidates:result.items,hidden:!service.host.isVisible()});}
      const shareNote=arg('--share-note');
      if(shareNote){
        const before=(await core.call('content.list',{channel:'xiaohongshu',limit:1})).total;
        const result=await channels.request({channel:'xiaohongshu',operation:'detail',uid,id:shareNote});
        const link=new URL(result.note.url);
        await service.api.goto(link.href);
        const opened=await service.api.wait('detail',s=>s.ready && s.contentPresent);
        if(opened.id!==shareNote || opened.authorId!==uid)throw new Error('分享链接打开后身份不匹配');
        const after=(await core.call('content.list',{channel:'xiaohongshu',limit:1})).total;
        if(before!==after)throw new Error('只读分享验证意外修改了内容数量');
        record({stage:'share',state:'passed',uid,id:shareNote,sharePath:link.pathname,
          source:link.searchParams.get('source'),xsecSource:link.searchParams.get('xsec_source'),
          tokenPresent:!!link.searchParams.get('xsec_token'),opened:true,hidden:!service.host.isVisible(),
          captureRestored:await service.view.webContents.executeJavaScript('!window.__SF_XHS_SHARE_CAPTURE__'),contentCount:after});
        await finish();return;
      }
      if(uid){
        const limit=Number(arg('--limit') || 2);if(!Number.isInteger(limit) || limit<1 || limit>50)throw new Error('limit must be 1..50');
        const sub=await core.call('subscription.add',{connection_id:'xiaohongshu:default',locator:uid,confirmed:true});
        await core.call('subscription.update',{subscription_id:sub.id,collect_items:limit});
        const runs=[];
        for(let repeat=0;repeat<2;repeat++){
          const started=await core.call('sync.start',{subscription_id:sub.id});let job;
          do{await new Promise(r=>setTimeout(r,250));job=await core.call('sync.get',{job_id:started.job_id});}while(['queued','running'].includes(job.state));
          runs.push({id:job.id,state:job.state,items:job.items,new_items:job.new_items,item_errors:job.item_errors,coverage:job.coverage,error:job.error,metrics:job.acquisition_metrics});
          console.log(JSON.stringify({stage:'collection-progress',repeat:repeat+1,...runs.at(-1)}));
          if(job.state!=='succeeded')break;
        }
        await core.restart();
        const contents=await core.call('content.list',{channel:'xiaohongshu',limit:100});
        const passed=runs.every(r=>r.state==='succeeded' && r.item_errors===0);
        record({stage:'collection',state:passed ? 'passed' : 'blocked',uid,limit,runs,
          hidden:!!service.host && !service.host.isVisible(),restartContentCount:contents.total,
          notes:contents.items.map(c=>({id:c.id,title:c.title,published:c.payload?.published || c.published}))});
        await finish(passed ? 0 : 1);return;
      }
      if(!query && !uid)record({stage:'connection',state:'passed',readiness});
      await finish();
    }catch(e){record({state:'blocked',code:e.code || 'ACCESS_FAILED',message:e.message});await finish(1);}
  }).catch(e=>{console.error(e.message);app.exit(1);});
}
