const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
if(!process.versions.electron) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-cover-'));
  const child=require('node:child_process').spawn(require('electron'),[__filename],{env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:folder},stdio:'inherit'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
  child.on('close',code=>{clearTimeout(timer);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=code??1;});
} else {
  const {app,session,nativeImage,BrowserWindow}=require('electron');
  app.setPath('userData',process.env.SUBSCRIBE_FLOW_DATA_DIR);app.on('window-all-closed',()=>{});
  app.whenReady().then(async()=>{
    const {captureCover,allowedCover}=require('../electron/main/cover-snapshot.cjs');
    const isolated=session.fromPartition('persist:cover-fixture');
    const {IDS}=require('./xiaohongshu-fixture.cjs').install(isolated);
    const out=process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT||path.resolve(__dirname,'../docs/verification/v0.5.2-local/cover');
    fs.mkdirSync(out,{recursive:true});
    for(const bad of ['file:///tmp/a.jpg','http://sns-webpic-qc.xhscdn.com/a','https://localhost/a','https://user:pass@sns-webpic-qc.xhscdn.com/a','https://sns-webpic-qc.xhscdn.com:444/a'])assert.equal(allowedCover(bad),false);
    for(const id of IDS){
      const data=await captureCover(isolated,'https://sns-webpic-qc.xhscdn.com/'+id);
      assert.match(data,/^data:image\/jpeg;base64,/);
      const image=nativeImage.createFromDataURL(data);fs.writeFileSync(path.join(out,id+'.jpg'),image.toJPEG(95));
      assert.deepEqual(image.getSize(),{width:192,height:144});
      const pixels=image.toBitmap(),edge=[...pixels.subarray(0,3)],center=[...pixels.subarray((72*192+96)*4,(72*192+96)*4+3)];
      console.log(JSON.stringify({id,edge,center,size:image.getSize()}));
      assert.ok(Math.max(...edge)-Math.min(...edge)>100);assert.ok(center.every(x=>x>240));
      assert.equal(BrowserWindow.getAllWindows().length,0);
    }
    const controller=new AbortController();controller.abort();
    await assert.rejects(captureCover(isolated,'https://sns-webpic-qc.xhscdn.com/'+IDS[0],controller.signal));
    assert.equal(BrowserWindow.getAllWindows().length,0);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({status:'passed',covers:3,pixels:[192,144],hidden:true,windowCleanup:true,abortedCapture:true},null,2)+'\n');
    app.exit(0);
  }).catch(e=>{console.error(e);app.exit(1);});
}
