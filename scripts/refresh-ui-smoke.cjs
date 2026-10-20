// Production renderer + offline transport. No live platform, model or user database.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const root=process.env.SUBSCRIBE_FLOW_RENDERER_ROOT||path.resolve(__dirname,'..');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-refresh-'));
const output=process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT||path.join(data,'evidence');
app.setPath('userData',path.join(data,'profile'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{preload:path.join(__dirname,'refresh-ui-stub.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=2) errors.push(message);});
  const evaluate=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{
    const start=Date.now();
    while(!(await evaluate(expression))) {
      if(Date.now()-start>10000) throw new Error('等待超时 '+expression+'\n'+(await evaluate('document.body.innerText')).slice(0,3000));
      await sleep(30);
    }
  };
  await win.loadFile(path.join(root,'electron/renderer/index.html'),{hash:'/inbox'});
  await until(`document.querySelectorAll('.content-card').length===20 && !!document.querySelector('.detail')`);
  await sleep(100);
  // Observe intermediate frames as well as the final result.
  await evaluate(`window.auditWorkspace=document.querySelector('.workspace'); window.auditCard=document.querySelector('.content-card'); window.auditDetail=document.querySelector('.detail'); window.auditFrames=0; window.auditReplaced=0; window.auditDone=false;
    window.auditObserver=new MutationObserver(records=>{for(const record of records) for(const node of record.removedNodes) if(node===auditWorkspace) auditReplaced++;}); auditObserver.observe(document.querySelector('.shell__body'),{childList:true});
    function sample(){if(document.querySelector('.skeleton-card'))auditFrames++;if(!auditDone)requestAnimationFrame(sample);} requestAnimationFrame(sample); void 0`);
  const before=await evaluate('RefreshFixture.calls()');
  for(let i=0;i<5;i++){await evaluate('RefreshFixture.progress(false)');await sleep(180);}
  await until(`document.querySelector('.status-bar').textContent.includes('已采集 5 条')`);
  const after=await evaluate('RefreshFixture.calls()');
  for(const name of ['listContents','getContent','listTags','getCounts','listPlatforms','getSession']) assert.equal(after[name],before[name],'纯进度不查询 '+name);
  assert.equal(await evaluate('auditWorkspace.isConnected && auditCard.isConnected && auditDetail.isConnected'),true);
  // An inserted result retains the scrolled item, detail, focus and text selection.
  await evaluate(`window.auditList=document.querySelector('.inbox__grid'); auditList.scrollTop=250;window.auditAnchor=Array.from(auditList.querySelectorAll('[data-content-id]')).find(n=>n.getBoundingClientRect().bottom>auditList.getBoundingClientRect().top); window.auditTop=auditAnchor.getBoundingClientRect().top;
    window.auditInput=document.querySelector('.topbar__search input'); auditInput.focus(); auditInput.value='未提交搜索'; auditInput.setSelectionRange(1,3);
    RefreshFixture.progress(true,'zhihu');void 0`);
  await sleep(190);
  assert.equal(await evaluate(`document.querySelectorAll('.content-card').length===20 && !document.querySelector('.skeleton-card') && auditWorkspace.isConnected`),true,'慢查询期间保留内容');
  await until(`!!document.querySelector('[data-content-id="new-6"]') && SF.app.state.counts.total===41`);
  assert.equal(await evaluate('auditCard.isConnected && auditDetail.isConnected'),true);
  assert.equal(await evaluate(`document.activeElement===auditInput && auditInput.value==='未提交搜索' && auditInput.selectionStart===1 && auditInput.selectionEnd===3`),true);
  assert.ok(Math.abs(await evaluate('auditAnchor.getBoundingClientRect().top-auditTop'))<=1,'新卡片插入保留阅读锚点');
  fs.writeFileSync(path.join(output,'content-arrived.png'),(await win.webContents.capturePage()).toPNG());
  await evaluate(`auditInput.value='';auditInput.blur();
    window.auditText=document.querySelector('.detail__summary').firstChild;window.auditRange=document.createRange();auditRange.setStart(auditText,2);auditRange.setEnd(auditText,12);getSelection().removeAllRanges();getSelection().addRange(auditRange);window.auditSelected=getSelection().toString();window.auditReadCount=RefreshFixture.calls().listContents;RefreshFixture.emit('content.changed',{ids:['fixture-0']});void 0`);
  await until(`RefreshFixture.calls().listContents>auditReadCount`);
  await evaluate(`SF.views.inbox.whenIdle()`);
  assert.equal(await evaluate(`getSelection().toString()===auditSelected && auditText.isConnected`),true,'后台刷新保留正文选区');
  // Continual events must not postpone every read until collection stops.
  const startCalls=(await evaluate('RefreshFixture.calls()')).listContents;
  for(let i=0;i<35;i++){await evaluate(`RefreshFixture.progress(true,${JSON.stringify('xiaohongshu')})`);await sleep(35);}
  assert.ok((await evaluate('RefreshFixture.calls()')).listContents>startCalls,'持续事件受最大等待约束');
  await evaluate(`RefreshFixture.finish('succeeded');RefreshFixture.emit('scheduler.changed',{});void 0`);
  await until(`SF.app.state.counts.total===76 && document.querySelector('.status-bar').textContent.includes('采集完成') && !!document.querySelector('[data-content-id="new-41"]')`);
  // Failed/cancelled terminal states are not hidden behind the debounce window.
  for(const state of ['failed','cancelled','interrupted']) {
    await evaluate(`RefreshFixture.finish(${JSON.stringify(state)})`);
    await until(`SF.app.state.runs[0].state===${JSON.stringify(state)}`);
  }
  const result=await evaluate(`window.auditDone=true;auditObserver.disconnect();({workspaceReplacements:auditReplaced,skeletonPaintFrames:auditFrames,workspaceConnected:auditWorkspace.isConnected,total:SF.app.state.counts.total,calls:RefreshFixture.calls()})`);
  assert.equal(result.workspaceReplacements,0);assert.equal(result.skeletonPaintFrames,0);assert.equal(result.workspaceConnected,true);
  // A failed background read retains the populated view and later recovers.
  await evaluate(`RefreshFixture.fail();RefreshFixture.progress(true);void 0`);
  await until(`document.body.textContent.includes('后台读取模拟失败')`);
  assert.equal(await evaluate(`document.querySelectorAll('.content-card').length===20 && auditWorkspace.isConnected`),true);
  await evaluate(`RefreshFixture.progress(false);RefreshFixture.emit('content.changed',{ids:['new-42']});void 0`);
  await until(`!!document.querySelector('[data-content-id="new-42"]')`);
  // Late content results must not reconstruct an active settings page.
  await evaluate(`RefreshFixture.delay(600);RefreshFixture.progress(true);void 0`);
  await sleep(180);
  await evaluate(`SF.app.navigate('settings');void 0`);
  await until(`SF.app.state.route.name==='settings'`);
  // The fixture intentionally has no settings data; route protection is the invariant here.
  await sleep(800);
  assert.equal(await evaluate(`!document.querySelector('.workspace') && SF.app.state.route.name==='settings'`),true);
  // Generic boundary replacement must handle replacing the current insertion cursor.
  const dom=await evaluate(`(() => {
    const host=document.createElement('div');document.body.append(host);const h=SF.dom.h;
    const draw=label=>h('div.block',{'data-refresh-key':'b','data-refresh-boundary':'true'},h('button',{onclick:()=>host.dataset.clicked=label},label));
    host.append(draw('old'));SF.dom.reconcileWithScroll(host,[draw('new')],new Map());host.querySelector('button').click();
    const boundary=host.dataset.clicked==='new'&&host.textContent==='new';
    host.textContent='';host.append(h('div.x',{'data-refresh-key':'a'},'a'),h('div.x',{'data-refresh-key':'c'},'c'));const kept=host.lastChild;
    SF.dom.reconcileWithScroll(host,[h('div.x',{'data-refresh-key':'c'},'updated'),h('div.x',{'data-refresh-key':'a'},'a')],new Map());
    const keyed=host.firstChild===kept&&host.firstChild.textContent==='updated';host.remove();return {boundary,keyed};
  })()`);
  assert.deepEqual(dom,{boundary:true,keyed:true});
  assert.deepEqual(errors,[],'Renderer 无异常');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({productionRenderer:true,offline:true,progressNoContentQueries:true,focusSelection:true,textSelection:true,scrollAnchor:true,continuousEvents:true,terminalStates:true,errorRecovery:true,lateRouteGuard:true,dom,...result},null,2));
  console.log(JSON.stringify({refreshUiSmoke:'passed',...result,output}));
  win.destroy();app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
