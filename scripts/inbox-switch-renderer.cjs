// BUG-102: production Main/Renderer/Core, isolated database, controlled IPC latency.
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function verify({window, root}) {
  const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root, 'docs/verification/bug-102-switch');
  fs.mkdirSync(output, {recursive:true});
  const ev = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\nRenderer: ' + code); }
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async expression => {
    const start = Date.now();
    while (!await ev(expression)) {
      if (Date.now() - start > 12000) throw new Error('Timed out: ' + expression);
      await pause(25);
    }
  };
  const checks = [];
  const record = (name, details, ok = true) => {
    checks.push({name, ok, ...details});
    fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({checks}, null, 2));
    console.log((ok ? 'PASS ' : 'FAIL ') + name + ' ' + JSON.stringify(details));
    assert.ok(ok, name);
  };
  const shot = async name => fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG());
  window.setContentSize(1440, 960);
  await until(`!!window.SF?.app.state.session && document.querySelectorAll('.content-card').length === 17 && !!document.querySelector('.detail')`);
  await ev('SF.views.inbox.whenIdle()');
  await ev(`(() => {
    const client = SF.app.state.client;
    const list = client.listContents.bind(client), sources = client.listContentSources.bind(client);
    const T = window.switchTest = {pending:[], sourceReads:0, hold:true};
    client.listContents = async query => {
      const result = await list(query);
      if (!T.hold) return result;
      return new Promise((resolve,reject) => T.pending.push({query,result,resolve,reject}));
    };
    client.listContentSources = query => { T.sourceReads++; return sources(query); };
    T.geometry = () => {
      const rect = selector => { const r=document.querySelector(selector)?.getBoundingClientRect(); return r && {x:r.x,y:r.y,width:r.width,height:r.height}; };
      return {sheet:rect('.workspace'),main:rect('.workspace > .main'),title:rect('.view__title'),rows:getComputedStyle(document.querySelector('.app')).gridTemplateRows};
    };
    T.start = () => {
      T.before = T.geometry();
      T.nodes = ['.app','.sidebar','.topbar','.workspace','[data-view="inbox"]','.inbox__grid','.detail'].map(s => document.querySelector(s));
      T.frames = []; T.sampling = true;
      const generation = T.generation = (T.generation || 0) + 1;
      const sample = () => {if(generation!==T.generation || !T.sampling)return;T.frames.push({geometry:T.geometry(),skeletons:document.querySelectorAll('.skeleton-card').length,connected:T.nodes.every(n=>!n||n.isConnected)});requestAnimationFrame(sample);};
      requestAnimationFrame(sample);
    };
  })()`);
  const begin = async expression => {
    await ev('switchTest.start()');
    await ev(expression);
    await until('switchTest.pending.length > 0');
    await pause(180);
  };
  const stable = async name => {
    const data = await ev(`(() => {
      const T=switchTest, frames=T.frames, before=T.before;
      T.sampling=false;
      const same = g => ['sheet','main','title'].every(key => g[key] && (key==='title'?['x','y','height']:['x','y','width','height']).every(p=>Math.abs(g[key][p]-before[key][p])<1));
      return {frames:frames.length,skeletonFrames:frames.filter(f=>f.skeletons).length,disconnectedFrames:frames.filter(f=>!f.connected).length,
        movedFrames:frames.filter(f=>!same(f.geometry)).length,before,loading:T.geometry(),sourceReads:T.sourceReads,
        busy:document.querySelector('[data-view="inbox"]').getAttribute('aria-busy'),inert:!!document.querySelector('.inbox__grid[inert]')};
    })()`);
    record(name, data, data.frames>0 && !data.skeletonFrames && !data.disconnectedFrames && !data.movedFrames && data.sourceReads===0 && data.busy==='true' && data.inert);
  };
  const settle = async (index = 0) => {
    const expected = await ev(`(() => {const p=switchTest.pending.splice(${index},1)[0];p.resolve(p.result);return p.result.items.map(i=>i.id);})()`);
    await ev('SF.views.inbox.whenIdle()');
    const actual = await ev(`Array.from(document.querySelectorAll('.content-card')).map(n=>n.dataset.contentId)`);
    assert.deepEqual(actual, expected, 'result must match the latest actual Core query');
    assert.equal(await ev(`document.querySelector('[data-view="inbox"]').getAttribute('aria-busy')`), 'false');
    assert.equal(await ev(`!!document.querySelector('.inbox__grid[inert], .detail[inert]')`), false, 'settled content must be usable');
    if (expected.length && await ev('!!switchTest.nodes[6]')) {
      await ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      assert.equal(await ev(`['sheet','main','title'].every(key => (key==='title'?['x','y','height']:['x','y','width','height']).every(p=>Math.abs(switchTest.geometry()[key][p]-switchTest.before[key][p])<1))`), true, 'nonempty result must keep the same geometry');
    }
    return expected;
  };
  const reset = async () => {
    await ev(`switchTest.hold=false;SF.app.state.filters={quick:'unread',platform:null,channelId:null};SF.app.state.search='';SF.app.renderView('inbox')`);
    await ev('SF.views.inbox.whenIdle()');
    await ev(`SF.app.state.selectedId=document.querySelector('.content-card').dataset.contentId;SF.app.renderView('inbox');switchTest.hold=true`);
  };
  for (const fx of ['on','off']) {
    await ev(`document.documentElement.dataset.fx=${JSON.stringify(fx)}`);
    await begin(`Array.from(document.querySelectorAll('.inbox__toolbar .seg button')).find(b=>b.textContent.includes('GitHub')).click()`);
    await shot('top-' + fx + '-loading');
    await stable('top-platform-' + fx);
    if (fx === 'on') record('loading-content-read-only', {}, await ev(`(() => {const card=document.querySelectorAll('.content-card')[1],button=document.querySelector('.detail button');card.focus();const listBlocked=document.activeElement!==card;button.focus();return listBlocked&&document.activeElement!==button&&document.querySelector('.detail').inert;})()`));
    const ids = await settle();
    record('top-platform-' + fx + '-result', {ids}, ids.length===3 && ids.every(id=>id.startsWith('github:')));
    await reset();
  }
  await begin(`document.querySelector('[data-platform="zhihu"]').click()`);
  await stable('sidebar-platform');
  record('sidebar-result', {ids:await settle()});
  await reset();
  await ev(`document.querySelector('[aria-label="筛选来源"]').click()`);
  await until(`Array.from(document.querySelectorAll('.menu__item')).some(b=>b.textContent.includes('超长来源名'))`);
  await begin(`Array.from(document.querySelectorAll('.menu__item')).find(b=>b.textContent.includes('超长来源名')).click()`);
  await stable('source-dropdown');
  record('source-label-retained', {}, await ev(`document.querySelector('[aria-label="筛选来源"]').textContent.includes('超长来源名')`));
  record('source-result', {ids:await settle()});
  await reset();
  await ev(`document.querySelector('[aria-label="筛选优先级"]').click()`);
  await until(`!!document.querySelector('.menu__item[data-value="high"]')`);
  await begin(`document.querySelector('.menu__item[data-value="high"]').click()`);
  await stable('priority-dropdown');
  record('priority-result', {ids:await settle()});
  await reset();
  await begin(`document.querySelector('[data-quick="high"]').click()`);
  await stable('sidebar-quick-filter');
  record('quick-filter-result', {ids:await settle()});
  await reset();
  await ev(`document.documentElement.dataset.theme='dark';document.documentElement.dataset.fx='on'`);
  window.setContentSize(800, 700);
  await pause(100);
  await begin(`document.querySelector('[data-platform="github"]').click()`);
  await stable('narrow-dark-platform');
  await shot('narrow-dark-loading');
  record('narrow-dark-result', {ids:await settle()});
  window.setContentSize(1440, 960);
  await ev(`document.documentElement.dataset.theme='light'`);
  await reset();
  // Return B before A; a late A must not restore its rows or selection.
  await begin(`document.querySelector('[data-platform="github"]').click()`);
  await ev(`document.querySelector('[data-platform="zhihu"]').click()`);
  await until('switchTest.pending.length===2');
  const latest = await settle(1);
  await ev('(() => {const p=switchTest.pending.shift();p.resolve(p.result);})()');
  await pause(100);
  record('late-query-isolation', {}, JSON.stringify(await ev(`Array.from(document.querySelectorAll('.content-card')).map(n=>n.dataset.contentId)`))===JSON.stringify(latest));
  await reset();
  // Error retains the displayed snapshot, exposes retry, and does not silently claim an empty result.
  await begin(`document.querySelector('[data-platform="github"]').click()`);
  await ev(`switchTest.pending.shift().reject(new Error('BUG-102 isolated read failure'));void 0`);
  await ev('SF.views.inbox.whenIdle()');
  record('failed-switch-retains-content', {}, await ev(`document.querySelectorAll('.content-card').length===17 && !!document.querySelector('.detail') && document.body.textContent.includes('BUG-102 isolated read failure') && !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='重试筛选')`));
  await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='重试筛选').click()`);
  await until('switchTest.pending.length===1');
  record('retry-result', {ids:await settle()});
  await reset();
  await begin(`SF.app.state.search='no-match-bug-102-fixture';SF.app.renderView('inbox')`);
  await stable('empty-result-loading');
  const empty = await settle();
  record('empty-result-settled', {ids:empty}, empty.length===0 && await ev(`!!document.querySelector('[data-view="inbox"] .state') && !document.querySelector('.detail')`));
  await reset();
  await ev(`document.querySelector('[aria-label="关闭详情"]').click()`);
  await begin(`document.querySelector('[data-platform="github"]').click()`);
  await stable('closed-detail-loading');
  await settle();
  record('closed-detail-opens-on-result', {}, await ev(`!!document.querySelector('.detail')`));
  await reset();
  // An event during the switch invalidates the in-flight snapshot and forces a follow-up read.
  await begin(`document.querySelector('[data-platform="github"]').click()`);
  await ev(`SF.views.inbox.invalidate(new Set(['content']));const p=switchTest.pending.shift();p.resolve(p.result);void 0`);
  await until('switchTest.pending.length===1');
  record('invalidation-retains-pending-snapshot', {}, await ev(`document.querySelectorAll('.content-card').length===17 && document.querySelector('[data-view="inbox"]').getAttribute('aria-busy')==='true'`));
  record('invalidation-follow-up-result', {ids:await settle()});
  await reset();
  await begin(`document.querySelector('[data-platform="github"]').click()`);
  await ev(`SF.app.navigate('overview')`);
  await until(`SF.app.state.route.name==='overview'`);
  await ev(`switchTest.pending.shift().resolve({items:[],total:0});void 0`);
  await pause(100);
  record('late-result-after-navigation', {}, await ev(`SF.app.state.route.name==='overview' && !document.querySelector('[data-view="inbox"]')`));
  await shot('final-overview');
  console.log(JSON.stringify({inboxSwitch:'passed',checks:checks.length,output}));
}
module.exports = {verify};
if (require.main === module) {
  const root=path.resolve(__dirname,'..'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-m35-details-'));
  const python=JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json'),'utf8')).python;
  const seed=spawnSync(python,[path.join(root,'scripts/seed-m35-details.py'),folder],{encoding:'utf8'});
  if(seed.status!==0) {console.error(seed.stderr||seed.stdout);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=1;}
  else {
    const child=spawn(require('electron'),[root],{env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:folder,SUBSCRIBE_FLOW_RENDERER_SMOKE:'inboxswitch'},stdio:'inherit'});
    const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
    child.on('close',code=>{clearTimeout(timer);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=code??1;});
  }
}
