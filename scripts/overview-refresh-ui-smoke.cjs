// Offline production overview verification. No Core, platform, model or user data.
// Run: node_modules/.bin/electron scripts/overview-refresh-ui-smoke.cjs
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-overview-refresh-'));
app.setPath('userData', path.join(dir, 'user-data'));

async function run() {
  const dom = process.env.SUBSCRIBE_FLOW_REFRESH_DOM || path.join(root, 'electron/renderer/scripts/core/dom.js');
  const scripts = [dom, ...['core/icons.js','core/format.js','core/catalog.js','core/tag-catalog.js','ui/tooltip.js','ui/components.js','views/overview.js'].map(file => path.join(root,'electron/renderer/scripts',file))];
  const styles = ['tokens.css','base.css','layout.css','components.css','views.css'].map(file=>`<link rel="stylesheet" href="${pathToFileURL(path.join(root,'electron/renderer/styles',file))}">`).join('');
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, `<!doctype html><html data-theme="light"><head><meta charset="utf-8">${styles}</head><body><div id="app"><div class="shell__body"><main class="workspace" style="height:100vh;padding:12px"><div id="test-host" style="display:contents"></div></main></div></div>${scripts.map(file=>`<script src="${pathToFileURL(file)}"></script>`).join('')}</body></html>`);
  const win = new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{nodeIntegration:false,contextIsolation:true}});
  const errors=[];
  win.webContents.on('console-message',event=>{if(event.level==='error') { errors.push(event.message); console.error(event.message); }});
  await win.loadFile(file);
  const evaluate = async code => { try { return await win.webContents.executeJavaScript(code); } catch(error) { throw new Error(error.message+'\nAssertion: '+code+'\n'+await win.webContents.executeJavaScript('document.body.innerText'));  } };
  const until = async expression => {
    const start=Date.now();
    while(!await evaluate(expression)) {
      if(Date.now()-start>10000) throw new Error('Timeout: '+expression+'\n'+await evaluate('document.body.innerText'));
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  await evaluate(`(() => {
    const host=document.getElementById('test-host'), positions=new Map();
    const scenario=window.RefreshTest={calls:[],pending:[],hold:false,fail:false,version:0,draws:0};
    const levels=['high','medium','low','none'];
    const item=(id,priority,date) => ({id:date+':'+priority+':'+id,title:date+' '+priority+' '+id+' v'+scenario.version,channelName:'离线验收来源',platform:'zhihu',priority,calendarDate:date,publishedAt:date,intakeMethod:'subscription',state:{read:false},tags:[]});
    function query(name,q) {
      scenario.calls.push({name,q:structuredClone(q)});
      let result;
      if(name==='sources') result={items:[]};
      else if(name==='calendar') result={month:q.month,total:260,priorities:{high:65,medium:65,low:65,none:65},days:[{date:q.month+'-20',total:260,priorities:{high:65,medium:65,low:65,none:65},items:[item(0,'high',q.month+'-20')]}]};
      else {
        const date=q.from || '2026-10-20', priority=q.priority || 'high';
        const all=Array.from({length:165},(_,i)=>item(i,priority,date));
        result={items:all.slice(q.offset||0,(q.offset||0)+q.limit),total:all.length,next_offset:(q.offset||0)+q.limit<all.length?(q.offset||0)+q.limit:null};
      }
      return new Promise((resolve,reject)=>{
        const done=()=>scenario.fail && name!=='sources'?reject(new Error('离线更新失败')):resolve(result);
        if(scenario.hold) scenario.pending.push({name,q,done}); else done();
      });
    }
    scenario.release=()=>scenario.pending.splice(0).forEach(request=>request.done());
    const state=scenario.state={now:new Date('2026-10-20T12:00:00+09:00').getTime(),route:{name:'overview'},overviewMode:'calendar',calendarMonth:'2026-10',selectedDate:'2026-10-20',filters:{quick:'all'},search:'',platforms:[{id:'zhihu'}],session:{capabilities:{canIntake:true}},client:{getCalendar:q=>query('calendar',q),listContents:q=>query('contents',q),listContentSources:q=>query('sources',q),getContent:id=>Promise.resolve({id,title:'详情 '+id})}};
    function draw(background) {
      if(state.route.name!=='overview') return;
      scenario.draws++;
      const node=SF.views.overview.render(state);
      (background && SF.dom.reconcileWithScroll ? SF.dom.reconcileWithScroll : SF.dom.renderWithScroll)(host,node,positions);
    }
    SF.app={state,renderView:name=>{if(name==='overview')draw(true);},renderContent:()=>draw(false),render:()=>draw(false),navigate:(name,params)=>{state.route.name=name;if(params?.mode)state.overviewMode=params.mode;draw(false);}};
    SF.views.inbox={detailBody:(_app,item)=>SF.dom.h('div',{'data-test-detail':item.id,text:item.title})};
    scenario.draw=()=>draw(true);
    scenario.refresh=(reasons=['content'])=>{SF.views.overview.invalidate(new Set(reasons));draw(true);};
    scenario.idle=()=>SF.views.overview.whenIdle();
    scenario.track=(selector)=>{scenario.tracked=document.querySelector(selector);return !!scenario.tracked;};
    scenario.click=label=>{const button=Array.from(host.querySelectorAll('button')).find(b=>b.textContent.trim()===label);if(!button || button.disabled)throw new Error('Missing button: '+label);button.click();};
    draw(false);
  })()`);
  await until(`document.querySelectorAll('[data-calendar-item]').length===20`);
  const count=selector=>evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const idle=()=>evaluate('RefreshTest.idle()');
  const refresh=async()=>{await evaluate('RefreshTest.refresh()'); await idle();};
  // Expand beyond Core's per-page cap, so a refresh must fetch multiple pages.
  for(let i=0;i<5;i++) {await evaluate(`RefreshTest.click('加载更多当日内容')`);await idle();}
  assert.equal(await count('[data-calendar-item]'),120);
  await evaluate(`RefreshTest.calendarCalls=RefreshTest.calls.filter(c=>c.name==='calendar').length;RefreshTest.hold=true;RefreshTest.version++;RefreshTest.track('[data-calendar-item]');RefreshTest.detached=0;RefreshTest.observer=new MutationObserver(records=>{RefreshTest.detached+=records.flatMap(r=>Array.from(r.removedNodes)).filter(node=>node===RefreshTest.tracked || node.contains?.(RefreshTest.tracked)).length;});RefreshTest.observer.observe(document.getElementById('test-host'),{subtree:true,childList:true});document.querySelector('.day-panel__list').scrollTop=150;RefreshTest.scroll=document.querySelector('.day-panel__list').scrollTop;RefreshTest.refresh()`);
  await until('RefreshTest.pending.length>=2');
  assert.equal(await count('[data-calendar-item]'),120,'Slow refresh retains loaded window');
  assert.equal(await evaluate(`document.querySelector('.day-panel__list').scrollTop`),await evaluate('RefreshTest.scroll'));
  assert.equal(await evaluate(`document.querySelector('.day-panel').textContent.includes('正在载入当日内容')`),false);
  const reconciles=await evaluate(`!!SF.dom.reconcileWithScroll`);
  if(reconciles) assert.equal(await evaluate('RefreshTest.tracked.isConnected'),true,'Background refresh reuses existing cards');
  // A second event during the first request must cause one follow-up query.
  await evaluate(`RefreshTest.refresh();RefreshTest.hold=false;RefreshTest.release()`);
  await idle();
  assert.equal(await count('[data-calendar-item]'),120);
  assert.equal(await evaluate(`RefreshTest.calls.filter(c=>c.name==='calendar').length-RefreshTest.calendarCalls`),2,'One coalesced follow-up satisfies an in-flight invalidation');
  if(reconciles) {
    assert.equal(await evaluate('RefreshTest.tracked.isConnected'),true);
    assert.equal(await evaluate('RefreshTest.detached'),0,'Existing cards must never leave the document during refresh');
  }
  await evaluate('RefreshTest.observer.disconnect()');
  assert.equal(await evaluate(`document.querySelector('[data-calendar-item]').textContent.includes('v1')`),true);
  assert.ok(await evaluate(`RefreshTest.calls.some(c=>c.name==='contents' && c.q.limit===100) && RefreshTest.calls.some(c=>c.name==='contents' && c.q.offset===100)`));
  assert.equal(await evaluate(`document.querySelector('.day-panel__list').scrollTop`),await evaluate('RefreshTest.scroll'));
  // Pure progress has no effect on calendar reads; inactive invalidation is lazy.
  let before=await evaluate('RefreshTest.calls.length');
  await evaluate(`SF.views.overview.invalidate(new Set(['runs','tagging']));RefreshTest.draw()`);await idle();
  assert.equal(await evaluate('RefreshTest.calls.length'),before);
  await evaluate(`RefreshTest.state.route.name='tags';window.hiddenDraws=RefreshTest.draws;SF.views.overview.invalidate(new Set(['content']))`);
  assert.equal(await evaluate('RefreshTest.calls.length'),before);
  assert.equal(await evaluate('RefreshTest.draws'),await evaluate('window.hiddenDraws'));
  await evaluate(`RefreshTest.state.route.name='overview';RefreshTest.draw()`);await idle();
  assert.ok(await evaluate('RefreshTest.calls.length')>before);
  // Leaving during a multi-page window refresh stops not-yet-started pages.
  await evaluate(`RefreshTest.hold=true;RefreshTest.refresh()`);await until('RefreshTest.pending.length>=2');
  before=await evaluate('RefreshTest.calls.length');
  await evaluate(`RefreshTest.state.route.name='tags';RefreshTest.hold=false;RefreshTest.release()`);await idle();
  assert.equal(await evaluate('RefreshTest.calls.length'),before,'Hidden views must not start the second window page');
  await evaluate(`RefreshTest.state.route.name='overview';RefreshTest.draw()`);await idle();
  assert.equal(await count('[data-calendar-item]'),120,'Reopening revalidates the cancelled visible window');
  // Error retains month/day data; an explicit retry recovers without a reset.
  await evaluate(`RefreshTest.fail=true;RefreshTest.refresh()`);await idle();
  assert.equal(await count('[data-calendar-item]'),120);
  assert.ok(await evaluate(`document.querySelector('.calendar-grid') && document.body.innerText.includes('月份更新失败')`));
  await evaluate(`RefreshTest.fail=false;RefreshTest.click('重试月份更新');RefreshTest.click('重试更新当日内容')`);await idle();
  assert.equal(await count('[data-calendar-item]'),120,'Retrying a failed refresh must revalidate the window rather than append another page');
  // Old date replies are not applied after selecting another date.
  await evaluate(`RefreshTest.hold=true;RefreshTest.refresh()`);await until('RefreshTest.pending.length>=2');
  await evaluate(`RefreshTest.state.selectedDate='2026-10-21';SF.app.renderContent()`);await until(`RefreshTest.pending.some(p=>p.q.from==='2026-10-21')`);
  await evaluate('RefreshTest.hold=false;RefreshTest.release()');await idle();
  assert.equal(await count('[data-calendar-item]'),20);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-calendar-item]')).every(el=>el.dataset.calendarItem.startsWith('2026-10-21:'))`),true);
  // Old filter / month replies cannot repaint a newer query.
  await evaluate(`RefreshTest.hold=true;RefreshTest.refresh()`);await until('RefreshTest.pending.length>=2');
  await evaluate(`RefreshTest.state.calendarMonth='2026-11';RefreshTest.state.selectedDate='2026-11-20';RefreshTest.state.filters.platform='zhihu';SF.app.renderContent()`);
  await until(`RefreshTest.pending.some(p=>p.q.month==='2026-11')`);
  await evaluate('RefreshTest.hold=false;RefreshTest.release()');await idle();
  assert.equal(await evaluate(`document.querySelector('.calendar-head__title').textContent`),'2026年11月');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-calendar-item]')).every(el=>el.dataset.calendarItem.startsWith('2026-11-20:'))`),true);
  // Mode switch while calendar refreshes cannot redraw priority with old data.
  await evaluate(`RefreshTest.hold=true;RefreshTest.refresh()`);await until('RefreshTest.pending.length>=2');
  await evaluate(`SF.app.navigate('overview',{mode:'priority'})`);await until(`RefreshTest.pending.filter(p=>p.q.priority).length===4`);
  await evaluate(`RefreshTest.hold=false;RefreshTest.release()`);await idle();
  assert.equal(await count('[data-priority-column]'),3);
  assert.equal(await count('[data-priority-item]'),60);
  assert.equal(await count('.calendar-grid'),0);
  for(let i=0;i<2;i++) {await evaluate(`document.querySelector('[data-priority-column="high"] .btn').click()`);await idle();}
  assert.equal(await count('[data-priority-column="high"] [data-priority-item]'),60);
  await evaluate(`document.querySelector('[data-priority-column="high"] .kanban__list').scrollTop=180;RefreshTest.boardScroll=document.querySelector('[data-priority-column="high"] .kanban__list').scrollTop;document.querySelector('[data-priority-item]').click()`);
  await until(`!!document.querySelector('[data-test-detail]')`);
  await evaluate(`RefreshTest.dialog=document.querySelector('.dialog');RefreshTest.track('[data-priority-column="high"]');RefreshTest.hold=true;RefreshTest.version++;RefreshTest.refresh()`);
  await until(`RefreshTest.pending.filter(p=>p.q.priority).length===4`);
  assert.equal(await count('[data-priority-item]'),100);
  assert.equal(await evaluate('RefreshTest.dialog.isConnected'),true);
  if(reconciles) assert.equal(await evaluate('RefreshTest.tracked.isConnected'),true);
  await evaluate('RefreshTest.hold=false;RefreshTest.release()');await idle();
  assert.equal(await count('[data-priority-column="high"] [data-priority-item]'),60);
  assert.equal(await evaluate(`document.querySelector('[data-priority-column="high"] .kanban__list').scrollTop`),await evaluate('RefreshTest.boardScroll'));
  assert.equal(await evaluate('RefreshTest.dialog.isConnected'),true);
  await evaluate(`RefreshTest.fail=true;RefreshTest.refresh()`);await idle();
  assert.equal(await count('[data-priority-column="high"] [data-priority-item]'),60);
  await evaluate(`RefreshTest.fail=false;Array.from(document.querySelectorAll('[data-priority-column="high"] button')).find(b=>b.textContent.trim()==='重试更新本栏').click()`);await idle();
  assert.equal(await count('[data-priority-column="high"] [data-priority-item]'),60,'A board refresh retry keeps the expanded window');
  await refresh();
  // Displaying one priority keeps already loaded columns in the same cache.
  before=await evaluate('RefreshTest.calls.length');
  await evaluate(`RefreshTest.state.filters.priority='high';SF.app.renderContent()`);await idle();
  assert.equal(await count('[data-priority-column]'),1);
  assert.equal(await count('[data-priority-item]'),60);
  assert.equal(await evaluate('RefreshTest.calls.length'),before);
  // Completion after route exit cannot render or issue a deferred follow-up.
  await evaluate(`RefreshTest.hold=true;RefreshTest.refresh()`);await until('RefreshTest.pending.length>=4');
  await evaluate(`RefreshTest.refresh();RefreshTest.state.route.name='inbox';window.routeDraws=RefreshTest.draws;RefreshTest.hold=false;RefreshTest.release()`);await idle();
  assert.equal(await evaluate('RefreshTest.draws'),await evaluate('window.routeDraws'));
  await evaluate(`RefreshTest.state.route.name='overview';RefreshTest.draw()`);await idle();
  assert.equal(await count('[data-priority-item]'),60);
  assert.deepEqual(errors,[]);
  const image=await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir,'overview-priority.png'),image.toPNG());
  console.log(JSON.stringify({overviewRefresh:'passed',productionReconcile:reconciles,slowRequestRetention:true,loadedWindowBeyond100:true,inflightInvalidation:true,errorRetention:true,dateFilterMonthModeRouteGuards:true,priorityWindow:true,scroll:true,detail:true,output:dir}));
  win.destroy();
}
app.whenReady().then(run).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
