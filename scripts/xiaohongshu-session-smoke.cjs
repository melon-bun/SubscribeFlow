const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
if(!process.versions.electron) {
  const {spawn}=require('node:child_process');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-xhs-session-'));
  (async()=>{
    try {
      for(const stage of ['first','restart'])await new Promise((resolve,reject)=>{
        const child=spawn(require('electron'),[__filename,stage],{stdio:'inherit',env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:folder}});
        const timer=setTimeout(()=>child.kill('SIGTERM'),30000);
        child.on('close',code=>{clearTimeout(timer);code===0 ? resolve() : reject(new Error('XHS session acceptance failed'));});
      });
    }catch(e){console.error(e.message);process.exitCode=1;}finally{fs.rmSync(folder,{recursive:true,force:true});}
  })();
}else{
  const {app,session}=require('electron');
  app.on('window-all-closed',()=>{});app.setPath('userData',process.env.SUBSCRIBE_FLOW_DATA_DIR);
  app.whenReady().then(async()=>{
    const {XiaohongshuSession,allowedPage}=require('../electron/main/xiaohongshu-session.cjs');
    const service=new XiaohongshuSession({apiOptions:{delay:0,jitter:0}});
    require('./xiaohongshu-fixture.cjs').install(service.session);
    try {
      assert.ok(allowedPage('https://www.xiaohongshu.com/explore'));
      for(const url of ['http://www.xiaohongshu.com','https://xiaohongshu.com.evil.test','app://subscribe-flow','https://user@www.xiaohongshu.com','https://www.xiaohongshu.com:444/'])assert.equal(allowedPage(url),false);
      if(process.argv.includes('restart')) {
        assert.deepEqual(await service.request({operation:'check'}),{authenticated:true});
        assert.equal(service.host.isVisible(),false);
        assert.equal((await session.defaultSession.cookies.get({name:'fixture_session'})).length,0);
        console.log(JSON.stringify({xhsSession:'passed',persistedAcrossAppRestart:true,isolated:true}));return;
      }
      await assert.rejects(service.request({operation:'check'}),e=>e.code==='AUTH_REQUIRED');
      assert.equal(service.host.isVisible(),false);
      const wc=service.view.webContents,prefs=wc.getLastWebPreferences();
      assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.sandbox,true);assert.ok(!prefs.preload);
      assert.equal(wc.getBackgroundThrottling(),false);assert.equal(wc.session,service.session);assert.notEqual(wc.session,session.defaultSession);
      const size=await wc.executeJavaScript('({width:document.documentElement.clientWidth,height:document.documentElement.clientHeight})');assert.ok(size.width>=800 && size.height>=600);
      await service.openLogin();assert.equal(service.host.isVisible(),true);
      await assert.rejects(service.request({operation:'check'}),e=>e.code==='INTERACTION_REQUIRED');
      await wc.executeJavaScript("document.querySelector('#fixture-login').click()");service.host.close();
      assert.equal(service.host.isVisible(),false);assert.equal(wc.isDestroyed(),false);
      assert.deepEqual(await service.request({operation:'check'}),{authenticated:true});
      let active=0,peak=0;
      const original=service.api.request.bind(service.api);
      service.api.request=async(...args)=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,20));return await original(...args);}finally{active--;}};
      await Promise.all([service.request({operation:'check'}),service.request({operation:'check'})]);assert.equal(peak,1);
      service.api.page.evaluate=()=>new Promise(()=>{});
      service.api.readTimeout=50;
      await assert.rejects(service.request({operation:'check'}),e=>e.code==='TIMEOUT');assert.equal(service.host,null);
      for(let i=0;i<100 && !wc.isDestroyed();i++)await new Promise(r=>setTimeout(r,10));assert.equal(wc.isDestroyed(),true);
      assert.deepEqual(await service.request({operation:'check'}),{authenticated:true});
      console.log(JSON.stringify({xhsSession:'first-pass',hiddenLayout:true,remoteSandbox:true,loginCloseHides:true,serial:true,timeoutRecreatesPage:true}));
    }finally{await service.close();app.quit();}
  }).catch(e=>{console.error(e);app.exit(1);});
}
