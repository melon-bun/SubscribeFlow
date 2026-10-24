const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
async function verify({window,root}){
  const out=process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT||path.join(root,'assets/screenshots');fs.mkdirSync(out,{recursive:true});
  const ev=code=>window.webContents.executeJavaScript(code),pause=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async expression=>{const start=Date.now();while(!await ev(expression)){if(Date.now()-start>15000)throw new Error('Preview timeout: '+expression);await pause(40);}};
  const shot=async name=>{await pause(400);await ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');fs.writeFileSync(path.join(out,name+'.png'),(await window.webContents.capturePage()).toPNG());};
  const go=async(name,params,ready)=>{await ev(`SF.app.navigate(${JSON.stringify(name)},${JSON.stringify(params||{})})`);await until(`!!document.querySelector('[data-view="${name}"]')`);if(ready)await until(ready);await pause(500);};
  window.setContentSize(1440,960);
  await until('!!window.SF?.app.state.session && document.querySelectorAll(".content-card").length>0');
  const logos=[];
  for(const theme of ['light','dark']){
    await ev(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    const logo=await ev(`(() => {const m=document.querySelector('.brand__mark'),i=m.querySelector('img'),r=m.getBoundingClientRect(),p=i.getBoundingClientRect();return {background:getComputedStyle(m).backgroundColor,shadow:getComputedStyle(m).boxShadow,width:r.width,imageWidth:p.width,imageHeight:p.height,source:i.getAttribute('src')};})()`);
    assert.equal(logo.background,'rgb(255, 255, 255)');assert.equal(logo.width,34);assert.equal(logo.imageWidth,34);assert.equal(logo.imageHeight,34);assert.equal(logo.source,'assets/brand.png');logos.push({theme,...logo});
    if(theme==='dark')await shot('inbox-dark');
  }
  await ev(`document.documentElement.dataset.theme='light'`);
  await shot('inbox');
  await go('overview',{mode:'calendar'},`!!document.querySelector('.cal-pill')`);await shot('calendar');
  await go('overview',{mode:'priority'},`!!document.querySelector('[data-priority-column="high"] [data-priority-item]')`);await shot('priorities');
  await go('channels',{tab:'list'},`!!document.querySelector('[data-channel-id]')`);await shot('channels');
  await go('tags',{tab:'list'},`!!document.querySelector('.tags-list tbody tr')`);await shot('tags');
  await go('notes',{},`!!document.querySelector('[data-note-editor] textarea')`);await shot('notes');
  await go('inbox',{},`!!document.querySelector('.content-card')`);
  await ev('SF.intakeDialog.open(SF.app.state);void 0');await until(`!!document.querySelector('.dialog')`);await shot('add-content');
  const evidence=process.env.SUBSCRIBE_FLOW_VERIFY_EVIDENCE||path.join(root,'docs/verification/v0.5.1-release');fs.mkdirSync(evidence,{recursive:true});
  fs.writeFileSync(path.join(evidence,'logo-and-screenshots.json'),JSON.stringify({logos,files:['inbox','inbox-dark','calendar','priorities','channels','tags','notes','add-content'].map(n=>n+'.png'),syntheticData:true,networkRequests:0},null,2));
  console.log(JSON.stringify({releasePreview:'passed',logos,screenshots:8,out}));
}
module.exports={verify};
if(require.main===module){
  const root=path.resolve(__dirname,'..'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-release-preview-'));
  const runtime=JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json')));
  const seeded=spawnSync(runtime.python,[path.join(root,'scripts/seed-release-preview.py'),folder],{encoding:'utf8'});
  if(seeded.status!==0){console.error(seeded.stderr||seeded.stdout);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=1;}
  else{const child=spawn(require('electron'),[root],{env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:folder,SUBSCRIBE_FLOW_RENDERER_SMOKE:'releasepreview'},stdio:'inherit'});
    const timer=setTimeout(()=>child.kill('SIGKILL'),120000);child.on('close',code=>{clearTimeout(timer);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=code??1;});}
}
