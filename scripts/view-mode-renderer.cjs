// BUG-102: internal mode changes and sidebar count updates must retain the active navigation.
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

async function verify({window, root}) {
  const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root, 'docs/verification/bug-102-view-modes');
  fs.mkdirSync(output, {recursive:true});
  const ev = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\nRenderer: ' + code); }
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async expression => {
    const start = Date.now();
    while (!await ev(expression)) {
      if (Date.now()-start>12000) throw new Error('Timed out: ' + expression);
      await pause(30);
    }
  };
  const checks = [];
  const check = (name, data) => {
    checks.push({name, ...data});
    fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({checks,failed:checks.filter(c=>!c.ok).length}, null, 2));
    console.log((data.ok ? 'PASS ' : 'FAIL ') + name + ' ' + JSON.stringify(data));
  };
  const shot = async name => fs.writeFileSync(path.join(output, name+'.png'), (await window.webContents.capturePage()).toPNG());
  window.setContentSize(1440, 960);
  await until(`!!window.SF?.app.state.session && document.querySelectorAll('.content-card').length>0`);
  await ev(`window.modeAudit = {
    appearance(node) {const s=getComputedStyle(node),p=getComputedStyle(node,'::before');return {background:s.backgroundColor,shadow:s.boxShadow,color:s.color,indicator:p.backgroundColor};},
    start() {
      const A=this; A.route=SF.app.state.route.name; A.frames=[];A.resets=0;A.attrs=[];
      A.nodes=['.app','.sidebar','.topbar','.workspace','[data-nav="'+A.route+'"]'].map(s=>document.querySelector(s));
      A.before=A.appearance(A.nodes[4]);
      A.observer=new MutationObserver(records=>records.forEach(r=>{
        if(r.type==='attributes' && r.target.dataset.nav===A.route) {
          A.attrs.push({before:r.oldValue,after:r.target.className});
          if(!(' '+r.oldValue+' ').includes(' is-active '))A.resets++;
        }
      }));
      A.observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['class'],attributeOldValue:true});
      const generation=A.generation=(A.generation||0)+1;
      A.running=true;
      const sample=()=>{
        if(!A.running||A.generation!==generation)return;
        const nav=document.querySelector('[data-nav="'+A.route+'"]');
        A.frames.push({connected:A.nodes.every(n=>n&&n.isConnected),active:nav?.classList.contains('is-active'),appearance:nav&&A.appearance(nav)});
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    },
    finish() {
      this.running=false;this.observer.disconnect();
      const data={frames:this.frames.length,disconnectedFrames:this.frames.filter(f=>!f.connected).length,
        inactiveFrames:this.frames.filter(f=>!f.active).length,
        appearanceChangedFrames:this.frames.filter(f=>JSON.stringify(f.appearance)!==JSON.stringify(this.before)).length,
        highlightResets:this.resets,before:this.before,after:this.appearance(document.querySelector('[data-nav="'+this.route+'"]'))};
      return {ok:data.frames>0&&!data.disconnectedFrames&&!data.inactiveFrames&&!data.appearanceChangedFrames&&!data.highlightResets,...data};
    }
  };void 0`);
  const go = async (route, params={}) => {
    await ev(`SF.app.navigate(${JSON.stringify(route)},${JSON.stringify(params)})`);
    await until(`!!document.querySelector('[data-view="${route}"]') && !!document.querySelector('[data-nav="${route}"].is-active')`);
    await pause(400);
  };
  const audit = async (name, action, ready) => {
    await ev('modeAudit.start()');
    await ev(action);
    if (ready) await until(ready);
    await pause(300);
    await until('modeAudit.frames.length>=6');
    check(name, await ev('modeAudit.finish()'));
  };
  const segClick = label => `Array.from(document.querySelectorAll('.seg button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`;
  for (const theme of ['light','dark']) {
    await ev(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await go('overview',{mode:'calendar'});
    await audit('overview-mode-'+theme, segClick('优先级模式'), `!!document.querySelector('[data-view="overview"][data-mode="priority"]')`);
    await audit('overview-return-'+theme, segClick('日历模式'), `!!document.querySelector('[data-view="overview"][data-mode="calendar"]')`);
    // Same cause also affects overview filter buttons that still call global render.
    await ev(`document.querySelector('[aria-label="日历优先级"]').click()`);
    await audit('overview-filter-'+theme, `document.querySelector('.menu__item[data-value="high"]').click()`);
    await go('channels',{tab:'list'});
    await audit('channels-mode-'+theme, segClick('优先级设置'), `SF.app.state.channelTab==='priorities' && !!document.querySelector('.source-priorities')`);
    await audit('channels-return-'+theme, segClick('渠道列表'), `SF.app.state.channelTab==='list'`);
    await go('tags',{tab:'list'});
    await audit('tags-mode-'+theme, segClick('AI 自动识别'), `SF.app.state.tagTab==='ai'`);
    await audit('tags-return-'+theme, segClick('标签列表'), `SF.app.state.tagTab==='list'`);
    // Count refresh is shared by notes/tags and background updates. It must not
    // remove/reapply the active class even when the displayed count is unchanged.
    for (const route of ['overview','channels','tags','notes']) {
      await go(route);
      if(route==='notes')await until(`document.querySelectorAll('.notes-toc__item').length>0`);
      await audit(route+'-sidebar-count-'+theme, 'SF.app.refreshSidebarCounts()');
    }
    await audit('notes-sort-'+theme, `(() => {const s=document.querySelector('[aria-label="笔记排序"]');s.value='title';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await audit('notes-filter-panel-'+theme, `Array.from(document.querySelectorAll('[data-view="notes"] button')).find(b=>b.textContent.trim()==='筛选').click()`);
    await shot('notes-'+theme);
  }
  // Click both modes while one frame's navigation work is still queued.
  await go('channels',{tab:'list'});
  await audit('rapid-mode-changes', segClick('优先级设置')+';'+segClick('渠道列表'), `SF.app.state.channelTab==='list'`);
  // History navigation to another mode is still an internal route transition.
  await ev(`SF.app.navigate('channels',{tab:'priorities'})`);
  await until(`location.hash==='#/channels?tab=priorities' && SF.app.state.channelTab==='priorities'`);
  await pause(300);
  await audit('mode-history-back', 'history.back()', `SF.app.state.channelTab==='list'`);
  // The notes count arriving after a local change must also keep its highlight.
  await go('notes');
  await ev(`(() => {
    const client=SF.app.state.client,original=client.listNotes.bind(client);
    window.noteCountOriginal=original;
    client.listNotes=async q=>{const r=await original(q);if(q.limit===1)return new Promise(resolve=>window.releaseNoteCount=()=>resolve(r));return r;};
    SF.app.state.noteCount=null;SF.views.notes.invalidate(new Set(['all']));SF.app.renderView('notes');
  })()`);
  await until(`typeof releaseNoteCount==='function'`);
  await audit('notes-late-count', `document.querySelector('[aria-label="笔记排序"]').value='created';document.querySelector('[aria-label="笔记排序"]').dispatchEvent(new Event('change',{bubbles:true}));releaseNoteCount();void 0`, `SF.app.state.noteCount>0`);
  await ev('SF.app.state.client.listNotes=noteCountOriginal;void 0');
  // Actual page navigation may replace the shell, but its new selected item
  // must be styled as selected at the first painted frame, without fading in.
  for (const target of ['overview','channels','tags','notes']) {
    await ev(`(() => {
      const A=window.routePaint={frames:[],running:true,target:${JSON.stringify(target)},expected:modeAudit.appearance(document.querySelector('.nav__item.is-active'))};
      const sample=()=>{
        if(!A.running)return;
        if(SF.app.state.route.name===A.target){const n=document.querySelector('[data-nav="'+A.target+'"]');A.frames.push({active:!!n?.classList.contains('is-active'),appearance:n&&modeAudit.appearance(n)});}
        requestAnimationFrame(sample);
      };requestAnimationFrame(sample);
      document.querySelector('[data-nav="'+A.target+'"]').click();
    })()`);
    await until(`SF.app.state.route.name===${JSON.stringify(target)} && !!document.querySelector('[data-view="${target}"]')`);
    await pause(300);
    await until('routePaint.frames.length>=6');
    check('page-navigation-'+target, await ev(`(() => {routePaint.running=false;const a=routePaint,bad=a.frames.filter(f=>!f.active||JSON.stringify(f.appearance)!==JSON.stringify(a.expected)).length;return {ok:a.frames.length>0&&bad===0,frames:a.frames.length,wrongHighlightFrames:bad};})()`));
  }
  const failed=checks.filter(c=>!c.ok);
  console.log(JSON.stringify({viewModes:failed.length?'failed':'passed',passed:checks.length-failed.length,failed:failed.length,output}));
  if(failed.length)throw new Error('Sidebar mode regression: '+failed.map(c=>c.name).join(', '));
}
module.exports={verify};
if(require.main===module){
  const root=path.resolve(__dirname,'..'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-m35-details-view-modes-'));
  const python=JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json'),'utf8')).python;
  const seed=spawnSync(python,[path.join(root,'scripts/seed-m35-details.py'),folder],{encoding:'utf8'});
  if(seed.status!==0){console.error(seed.stderr||seed.stdout);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=1;}
  else{
    const child=spawn(require('electron'),[root],{env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:folder,SUBSCRIBE_FLOW_RENDERER_SMOKE:'viewmodes'},stdio:'inherit'});
    const timer=setTimeout(()=>child.kill('SIGKILL'),150000);
    child.on('close',code=>{clearTimeout(timer);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=code??1;});
  }
}
