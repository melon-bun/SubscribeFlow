const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

// Standalone real-DOM regression. All data comes from in-page fixtures; no Core,
// daily database, network, login window or platform collection is started.
if (!process.versions.electron) {
  const {spawnSync} = require('node:child_process');
  const result = spawnSync(require('electron'), [__filename], {stdio:'inherit', env:process.env});
  process.exit(result.status == null ? 1 : result.status);
}

const {app, BrowserWindow} = require('electron');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-refresh-views-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();

async function verify() {
  await app.whenReady();
  const window = new BrowserWindow({show:false, width:1440, height:1000,
    webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false}});
  window.webContents.on('console-message', event => {
    if (event.level === 'error') console.error(event.message);
  });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({cancel:/^https?:/.test(details.url)});
  });
  const file = path.join(temporary, 'views.html');
  fs.writeFileSync(file, '<!doctype html><html><head><meta charset="utf-8">' +
    ['tokens','base','layout','components','views'].map(name => '<link rel="stylesheet" href="file://' + path.join(root, 'electron/renderer/styles', name + '.css') + '">').join('') +
    '<style>.shell__body{height:700px;display:flex}.inbox__grid{max-height:210px;overflow:auto}.detail__body{max-height:400px;overflow:auto}.channels-content{max-height:600px}</style>' +
    '</head><body><div class="shell__body"></div></body></html>');
  await window.loadFile(file);
  const evaluate = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\nRenderer: ' + code.slice(0,500)); }
  };
  const until = async (expression, timeout = 5000) => {
    const started = Date.now();
    while (!await evaluate(expression)) {
      if (Date.now() - started > timeout) throw new Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  for (const relative of ['core/dom','core/icons','core/format','core/catalog','core/tag-catalog','ui/tooltip','ui/components','ui/tag-controls','views/inbox','views/channels']) {
    const script = relative === 'core/dom' && process.env.SUBSCRIBE_FLOW_TEST_DOM
      ? process.env.SUBSCRIBE_FLOW_TEST_DOM : path.join(root, 'electron/renderer/scripts', relative + '.js');
    await evaluate(fs.readFileSync(script, 'utf8') + '\n//# sourceURL=' + script);
  }
  await evaluate(`(() => {
    const T = window.refreshTest = {reads:{contents:0,sources:0,channels:0,coverage:0}, pending:[]};
    T.realReconciler=typeof SF.dom.reconcileWithScroll==='function';
    if (!T.realReconciler) SF.dom.reconcileWithScroll=SF.dom.renderWithScroll;
    T.clone = value => JSON.parse(JSON.stringify(value));
    T.items = Array.from({length:20}, (_,i) => ({id:'item-'+i,title:'内容 '+i,summary:Array.from({length:25},(_,n)=>'正文段落 '+n).join('\\n'),
      kind:'pin',platform:'bilibili',channelName:'作者',channelId:'source-a',priority:'none',priorityOverride:null,tags:[],state:{read:false,deferred:false,archived:false},publishedAt:null}));
    T.sources = ['a','b'].map(id => ({id:'source-'+id,name:'作者 '+id,externalId:id,platform:'bilibili',enabled:true,
      frequency:'手动刷新',collectItems:10,capabilities:{canRefresh:true,canBackfill:true},schedule:{state:'manual'}}));
    const client = {
      listContents:query => {T.reads.contents++; return T.contentsHandler ? T.contentsHandler(query) : Promise.resolve(T.clone({items:T.items,total:T.items.length,next_offset:null}));},
      listContentSources:() => {T.reads.sources++;return Promise.resolve({items:[]});},
      listTags:() => Promise.resolve({items:[]}),
      listChannels:query => {T.reads.channels++;return T.channelsHandler ? T.channelsHandler(query) : Promise.resolve(T.clone({items:T.sources,total:T.sources.length}));},
      getSyncCoverage:id => {T.reads.coverage++;return Promise.resolve({label:'当前窗口',detail:'范围 '+id,complete:false});},
      savePrioritySettings:async value => {T.priorityWrite=value;},
    };
    const state = T.state = {client,route:{name:'inbox'},filters:{quick:'all'},search:'',selectedId:null,counts:{total:20},platforms:[],
      session:{capabilities:{canIntake:false,canManageChannels:true},channels:[],connections:[]},runs:[],channelTab:'list',now:Date.now()};
    const positions = new Map();
    T.mount = background => {
      const view=SF.views[state.route.name], result=view.render(state), nodes=result.main?[result.main,result.aside]:[result];
      const host=document.querySelector('.shell__body');
      const render=background && SF.dom.reconcileWithScroll || SF.dom.renderWithScroll;
      render(host,nodes,positions);
    };
    SF.app={state,renderContent:()=>T.mount(false),render:()=>T.mount(false),
      renderView:name=>{if(state.route.name===name)T.mount(true);},
      isPending:()=>false,act:(_key,work)=>work(),
      refreshData:async()=>{SF.views[state.route.name].invalidate(new Set(['all']));T.mount(true);await SF.views[state.route.name].whenIdle();},
      navigate:name=>{state.route.name=name;T.mount(false);}};
    T.mount(false);
  })()`);
  await until('document.querySelectorAll(".content-card").length===20');
  await evaluate('SF.views.inbox.whenIdle()');
  await evaluate(`(() => {
    const T=refreshTest;
    document.querySelector('.content-selection .check').click();
    T.detail=document.querySelector('.detail'); T.card=document.querySelector('.content-card');
    T.grid=document.querySelector('.inbox__grid'); T.grid.scrollTop=125;
    T.expand=document.querySelector('.detail__more-btn');T.expand.hidden=false;T.expand.click();T.expand.focus();
    T.contentsHandler=query=>new Promise((resolve,reject)=>T.pending.push({query,resolve,reject}));
    SF.views.inbox.invalidate(new Set(['content']));T.mount(true);
  })()`);
  assert.equal(await evaluate('!!document.querySelector(".skeleton")'), false);
  assert.equal(await evaluate('document.querySelectorAll(".content-card").length'),20);
  await evaluate('refreshTest.pending.shift().resolve(refreshTest.clone({items:refreshTest.items,total:20,next_offset:null})); void 0');
  await evaluate('SF.views.inbox.whenIdle()');
  assert.equal(await evaluate('document.querySelector(".content-selection .check").getAttribute("aria-checked")'),'true');
  if (await evaluate('refreshTest.realReconciler')) {
    assert.equal(await evaluate('refreshTest.detail===document.querySelector(".detail") && refreshTest.card===document.querySelector(".content-card")'),true);
    assert.equal(await evaluate('document.querySelector(".inbox__grid").scrollTop'),125);
    assert.equal(await evaluate('refreshTest.expand===document.activeElement && refreshTest.expand.getAttribute("aria-expanded")==="true"'),true);
  }
  await evaluate(`refreshTest.state.selectedId=null;refreshTest.mount(false);SF.views.inbox.invalidate(['content']);refreshTest.mount(true);refreshTest.pending.shift().resolve(refreshTest.clone({items:refreshTest.items,total:20}));void 0`);
  await evaluate('SF.views.inbox.whenIdle()');
  assert.equal(await evaluate('refreshTest.state.selectedId===null && !document.querySelector(".detail")'),true,
    'a background result must not reopen a closed detail panel');

  // Same-query invalidation during a request must issue a second read, while a
  // query change rejects the prior response even when it arrives last.
  await evaluate(`SF.views.inbox.invalidate(['content']);refreshTest.mount(true);SF.views.inbox.invalidate(['content']);refreshTest.pending.shift().resolve(refreshTest.clone({items:refreshTest.items,total:20}));void 0`);
  await until('refreshTest.pending.length===1');
  await evaluate('refreshTest.pending.shift().resolve(refreshTest.clone({items:refreshTest.items,total:20}));void 0');
  await evaluate('SF.views.inbox.whenIdle()');
  await evaluate(`refreshTest.state.search='old';refreshTest.mount(false);refreshTest.state.search='new';refreshTest.mount(false);void 0`);
  await until('refreshTest.pending.length===2');
  await evaluate(`refreshTest.pending[1].resolve(refreshTest.clone({items:[{...refreshTest.items[0],id:'new-result',title:'新查询'}],total:1}));void 0`);
  await until('document.querySelector("[data-content-id=new-result]")');
  await evaluate(`refreshTest.pending[0].resolve(refreshTest.clone({items:[{...refreshTest.items[0],id:'old-result',title:'旧查询'}],total:1}));refreshTest.pending=[];void 0`);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(await evaluate('!!document.querySelector("[data-content-id=new-result]")'),true);

  await evaluate(`SF.views.inbox.invalidate(['content']);refreshTest.mount(true);refreshTest.pending.shift().reject(new Error('离线夹具'));void 0`);
  await evaluate('SF.views.inbox.whenIdle()');
  assert.equal(await evaluate('!!document.querySelector("[data-content-id=new-result]") && document.body.innerText.includes("更新失败")'),true);
  await evaluate(`refreshTest.contentsHandler=null;refreshTest.state.search='';refreshTest.state.route.name='channels';refreshTest.mount(false);void 0`);
  await until('document.querySelectorAll("[data-channel-id]").length===2');
  await evaluate('SF.views.channels.whenIdle()');
  const before = await evaluate('({...refreshTest.reads})');
  await evaluate(`(() => {const T=refreshTest;T.row=document.querySelector('[data-channel-id]');T.search=document.querySelector('.channels__toolbar input');T.search.focus();
    T.state.runs=[{id:'run-a',channelId:'source-a',channelName:'作者 a',state:'running',items:1,newItems:1,pages:1,message:'已保存 1 条',acquisitionMetrics:{detail_requests:1}}];
    SF.views.channels.updateRuns(T.state);T.state.runs[0].items=2;T.state.runs[0].message='已保存 2 条';
    SF.views.channels.invalidate(new Set(['runs','content','tags']));T.mount(true);SF.views.channels.updateRuns(T.state);})();`);
  const after = await evaluate('({...refreshTest.reads})');
  assert.equal(after.channels,before.channels);
  assert.equal(after.coverage,before.coverage);
  assert.equal(await evaluate('document.body.innerText.includes("已保存 2 条")'),true);
  if (await evaluate('refreshTest.realReconciler')) {
    assert.equal(await evaluate('refreshTest.row===document.querySelector("[data-channel-id]") && refreshTest.search===document.activeElement'),true);
  }
  await evaluate(`refreshTest.state.runs[0].state='succeeded';SF.views.channels.updateRuns(refreshTest.state);void 0`);
  await evaluate('SF.views.channels.whenIdle()');
  const terminal = await evaluate('({...refreshTest.reads})');
  assert.equal(terminal.channels,before.channels);
  assert.equal(terminal.coverage,before.coverage+1,'only the completed source coverage is re-read');
  await evaluate(`refreshTest.channelsHandler=query=>new Promise((resolve,reject)=>refreshTest.pending.push({query,resolve,reject}));SF.views.channels.invalidate(['channels']);refreshTest.mount(true);void 0`);
  assert.equal(await evaluate('document.querySelectorAll("[data-channel-id]").length'),2);
  assert.equal(await evaluate('document.body.innerText.includes("正在载入渠道")'),false);
  await evaluate(`refreshTest.pending.shift().reject(new Error('渠道读取失败夹具'));void 0`);
  await evaluate('SF.views.channels.whenIdle()');
  assert.equal(await evaluate('document.querySelectorAll("[data-channel-id]").length===2 && document.body.innerText.includes("更新失败")'),true);

  await evaluate(`(() => {const input=document.querySelector('.channels__toolbar input');refreshTest.search=input;input.focus();input.value='old';input.dispatchEvent(new Event('input',{bubbles:true}));})();`);
  await until('refreshTest.pending.length===1');
  if (await evaluate('refreshTest.realReconciler')) {
    assert.equal(await evaluate('refreshTest.search===document.activeElement'),true,'search keeps its input while a new query loads');
  }
  await evaluate(`(() => {const input=document.querySelector('.channels__toolbar input');input.value='new';input.dispatchEvent(new Event('input',{bubbles:true}));})();`);
  await until('refreshTest.pending.length===2');
  await evaluate(`refreshTest.pending[1].resolve(refreshTest.clone({items:[{...refreshTest.sources[0],id:'source-new',name:'新来源'}],total:1}));void 0`);
  await until('document.querySelector("[data-channel-id=source-new]")');
  await evaluate(`refreshTest.pending[0].resolve(refreshTest.clone({items:[{...refreshTest.sources[0],id:'source-old',name:'旧来源'}],total:1}));refreshTest.pending=[];void 0`);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(await evaluate('!!document.querySelector("[data-channel-id=source-new]") && !document.querySelector("[data-channel-id=source-old]")'),true);

  console.log(JSON.stringify({refreshViews:'passed',backgroundKeepsData:true,staleQueriesIgnored:true,
    inFlightInvalidationDrained:true,errorsKeepData:true,runProgressAvoidsSourceReads:true,
    terminalCoverageReads:1,channelSearchKeepsFocus:true,realReconciler:await evaluate('refreshTest.realReconciler')}));
  window.destroy();
}

verify().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1);}).finally(()=>{
  try {fs.rmSync(temporary,{recursive:true,force:true});}catch {}
});
