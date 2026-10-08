const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
if(!process.versions.electron) {
  const {spawn}=require('node:child_process'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-zhihu-session-'));
  (async()=>{try {
    for(const stage of ['first','restart'])await new Promise((resolve,reject)=>{
      const child=spawn(require('electron'),[__filename,stage],{stdio:'inherit',env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:folder}});
      const timer=setTimeout(()=>child.kill('SIGTERM'),30000);child.on('close',code=>{clearTimeout(timer);code===0 ? resolve() : reject(new Error('Zhihu session verification failed'));});
    });
  } catch(e){console.error(e);process.exitCode=1;}finally{fs.rmSync(folder,{recursive:true,force:true});}})();
} else {
  const {app,session}=require('electron');app.setPath('userData',process.env.SUBSCRIBE_FLOW_DATA_DIR);app.on('window-all-closed',()=>{});
  app.whenReady().then(async()=>{
    const {ZhihuSession,allowedPage}=require('../electron/main/zhihu-session.cjs');
    const service=new ZhihuSession();
    if(process.argv.includes('restart')) {
      const saved=await service.session.cookies.get({url:'https://www.zhihu.com',name:'m12_session_marker'});
      assert.equal(saved[0]?.value,'synthetic-only');assert.equal((await session.defaultSession.cookies.get({name:'m12_session_marker'})).length,0);
      await service.close();console.log(JSON.stringify({zhihuSession:'passed',persistedAcrossElectronProcesses:true,isolated:true,realPlatform:false}));app.exit(0);return;
    }
    assert.equal(allowedPage('https://www.zhihu.com/signin'),true);
    for(const url of ['https://zhihu.com.evil.test','https://u@www.zhihu.com','http://www.zhihu.com','https://www.zhihu.com:99','file:///tmp/x'])assert.equal(allowedPage(url),false);
    service.session.protocol.handle('https',()=>new Response('<html><body>隔离登录页</body></html>',{headers:{'content-type':'text/html'}}));
    await service.init();const prefs=service.view.webContents.getLastWebPreferences();assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.sandbox,true);assert.ok(!prefs.preload);assert.equal(prefs.webviewTag,false);
    assert.notEqual(service.session,session.defaultSession);assert.equal(service.host.isVisible(),false);
    let active=0,peak=0,calls=0;
    service.api.request=async()=>{calls++;active++;peak=Math.max(active,peak);await new Promise(r=>setTimeout(r,15));active--;return {authenticated:true};};
    await Promise.all([service.request({operation:'check'}),service.request({operation:'check'})]);assert.equal(peak,1);
    await service.openLogin();service.host.hide();
    await assert.rejects(service.request({operation:'check'}),e=>e.code==='INTERACTION_REQUIRED');assert.equal(calls,2);
    service.host.close();const c=new AbortController();c.abort();await assert.rejects(service.request({operation:'check'},c.signal),e=>e.code==='CANCELLED');
    await service.session.cookies.set({url:'https://www.zhihu.com',name:'m12_session_marker',value:'synthetic-only',secure:true,expirationDate:Date.now()/1000+86400});
    await service.close();console.log(JSON.stringify({zhihuSession:'first-pass',hidden:true,sandboxed:true,serial:true,loginReadingIsolated:true,cancel:true,realPlatform:false}));app.exit(0);
  }).catch(e=>{console.error(e);app.exit(1);});
}
