const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict');
if(!process.versions.electron) {
  const {spawn}=require('node:child_process');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-session-'));
  (async()=>{
    try {
      for(const stage of ['first','restart']) await new Promise((resolve,reject)=>{
        const child=spawn(require('electron'),[__filename,stage],{stdio:'inherit',env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:folder}});
        const timer=setTimeout(()=>child.kill('SIGTERM'),30000);
        child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Session smoke failed'));});
      });
    } catch(e) {console.error(e.message);process.exitCode=1;}
    finally {fs.rmSync(folder,{recursive:true,force:true});}
  })();
} else {
  const {app,session}=require('electron');
  app.on('window-all-closed',()=>{}); // Keep acceptance alive after closing its login view.
  app.setPath('userData',process.env.SUBSCRIBE_FLOW_DATA_DIR);
  app.whenReady().then(async()=>{
    const {BilibiliSession,allowedPage}=require('../electron/main/bilibili-session.cjs');
    const {AcquisitionError}=require('../electron/main/bilibili-api.cjs');
    const service=new BilibiliSession();
    if(process.argv.includes('restart')) {
      const cookies=await service.session.cookies.get({name:'sf_acceptance_marker'});
      assert.equal(cookies[0]?.value,'synthetic-test-only');
      assert.equal((await session.defaultSession.cookies.get({name:'sf_acceptance_marker'})).length,0);
      console.log(JSON.stringify({sessionSmoke:'passed',persistedAcrossAppRestart:true,isolated:true}));
      await service.close();app.exit(0);return;
    }
    assert.ok(allowedPage('https://passport.bilibili.com/login'));
    for(const url of ['http://www.bilibili.com','https://bilibili.com.evil.test','file:///tmp/x','app://subscribe-flow','https://user@www.bilibili.com','https://www.bilibili.com:444/']) assert.equal(allowedPage(url),false);
    service.session.webRequest.onBeforeRequest({urls:['*://*.bilibili.com/*']},(_details,callback)=>callback({cancel:true}));
    service.openLogin();
    const wc=service.loginView.webContents, prefs=wc.getLastWebPreferences();
    assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.sandbox,true);
    assert.ok(!prefs.preload);assert.equal(prefs.webviewTag,false);
    assert.equal(wc.session,service.session);assert.notEqual(wc.session,session.defaultSession);
    service.login.close();
    assert.equal(service.login,null);
    let calls=0,active=0,peak=0;
    service.api.request=async()=>{
      calls++;active++;peak=Math.max(peak,active);
      await new Promise(r=>setTimeout(r,30));active--;
      if(calls===1) throw new AcquisitionError('ACCESS_FAILED','temporary fixture',true);
      return {code:0,data:{authenticated:true}};
    };
    await Promise.all([service.request({operation:'check'}),service.request({operation:'check'})]);
    assert.equal(calls,3);assert.equal(peak,1);
    calls=0;
    service.api.request=async()=>{calls++;throw new AcquisitionError('INTERACTION_REQUIRED','challenge fixture');};
    await assert.rejects(service.request({operation:'check'}),e=>e.code==='INTERACTION_REQUIRED');
    assert.equal(calls,1);
    const controller=new AbortController();controller.abort();
    await assert.rejects(service.request({operation:'check'},controller.signal),e=>e.code==='CANCELLED');
    assert.equal(calls,1);
    await service.session.cookies.set({url:'https://example.invalid/',name:'sf_acceptance_marker',value:'synthetic-test-only',expirationDate:Date.now()/1000+3600});
    await service.close();
    console.log(JSON.stringify({sessionSmoke:'first-pass',serial:true,boundedRetry:true,challengeNotRetried:true,remoteViewSandboxed:true,loginWindowClosed:true}));
    app.exit(0);
  }).catch(e=>{console.error(e);app.exit(1);});
}
