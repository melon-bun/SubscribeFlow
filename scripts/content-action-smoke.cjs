// Measure real content actions against an isolated SQLite backup. Never writes the daily database.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = process.env.SUBSCRIBE_FLOW_ACTION_OUTPUT || path.join(os.tmpdir(), 'subscribe-flow-actions.json');

if (!process.versions.electron) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-actions-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json')));
  const seed = spawnSync(runtime.python, ['-c', `
import sqlite3,sys
from pathlib import Path
from subscribe_flow.bootstrap import Core
source=Path.home()/'Library/Application Support/Subscribe Flow/subscribe-flow.sqlite3'
target=Path(sys.argv[1])/'subscribe-flow.sqlite3'
if source.exists():
    src=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)
    dest=sqlite3.connect(target);src.backup(dest);dest.close();src.close()
c=Core(target)
c.settings.update('priority',{'smart':{'enabled':False}})
c.database.close();c.lease.close()
`, folder], {encoding:'utf8', env:{...process.env, PYTHONPATH:path.join(root, 'python/src')}});
  if (seed.status !== 0) { fs.rmSync(folder,{recursive:true,force:true}); throw new Error(seed.stderr); }
  const child = spawn(require('electron'), [__filename], {stdio:'inherit', env:{...process.env,
    SUBSCRIBE_FLOW_RENDERER_SMOKE:'uishot', SUBSCRIBE_FLOW_DATA_DIR:folder}});
  child.on('close', code => { fs.rmSync(folder,{recursive:true,force:true}); process.exitCode=code ?? 1; });
  return;
}

require(path.join(root, 'scripts/ui-shot-renderer.cjs')).verify = async ({window, core}) => {
  const evaluate = code => window.webContents.executeJavaScript(code);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async expression => {
    const start=Date.now();
    while (!await evaluate(expression)) {
      if (Date.now()-start>30000) throw new Error('Timed out: '+expression);
      await pause(15);
    }
  };
  await until('!!window.SF?.app.state.session && !!document.querySelector(".shell__body")');
  await evaluate(`SF.app.state.filters={quick:'unread'};SF.app.navigate('inbox');SF.app.refreshData(true)`);
  await until('document.querySelectorAll(".content-card").length > 1');
  await evaluate(`SF.app.state.selectedId=document.querySelector('.content-card').dataset.contentId;SF.app.renderContent()`);
  await until('!!document.querySelector(".priority-grid")');
  await pause(400);
  const calls=[];
  const original=core.call.bind(core);
  core.call=async (method,params,...rest) => {
    const start=performance.now();
    try { return await original(method,params,...rest); }
    finally { calls.push({method,ms:Math.round((performance.now()-start)*10)/10}); }
  };
  await evaluate(`(() => {
    window.actionProbe={};
    for(const name of ['renderWithScroll','reconcileWithScroll']) {
      const original=SF.dom[name];
      SF.dom[name]=function(...args) {
        const start=performance.now();
        try {return original.apply(this,args);}
        finally {if(actionProbe.active) actionProbe.renders.push({name,ms:performance.now()-start});}
      };
    }
    const original=SF.app.state.client.updateContent;
    SF.app.state.client.updateContent=async function(...args) {
      const result=await original.apply(this,args);
      actionProbe.writeMs=performance.now()-actionProbe.start;
      return result;
    };
  })()`);
  const results=[];
  async function action(name, selector) {
    calls.length=0;
    await evaluate(`(() => {
      const P=actionProbe;
      P.id=SF.app.state.selectedId;P.start=performance.now();P.renders=[];P.active=true;P.writeMs=null;
      P.beforeCounts={...SF.app.state.counts};
      P.detail=document.querySelector('.detail');P.body=document.querySelector('.detail__body');
      P.card=document.querySelector('[data-content-id="'+P.id+'"]');
      P.body.scrollTop=120;P.scroll=P.body.scrollTop;
      document.querySelector(${JSON.stringify(selector)}).click();
    })()`);
    await until(`actionProbe.writeMs!==null && !SF.app.isPending('content:'+actionProbe.id)`);
    const result=await evaluate(`({writeMs:actionProbe.writeMs,settledMs:performance.now()-actionProbe.start,
      detailRetained:actionProbe.detail===document.querySelector('.detail'),
      bodyRetained:actionProbe.body===document.querySelector('.detail__body'),
      cardRetained:actionProbe.card===document.querySelector('[data-content-id="'+actionProbe.id+'"]'),
      scrollRetained:actionProbe.scroll===document.querySelector('.detail__body')?.scrollTop,
      selectedChanged:SF.app.state.selectedId!==actionProbe.id,
      beforeCounts:actionProbe.beforeCounts,afterCounts:{...SF.app.state.counts},
      renders:actionProbe.renders})`);
    await pause(300);
    result.calls=[...calls];
    const saved=await original('content.get',{item_id:await evaluate('actionProbe.id')});
    result.savedState=saved.state;result.savedPriority=saved.priority_override;
    results.push({name,...result});
    await evaluate('actionProbe.active=false');
    return result;
  }
  for (const level of ['high','medium','low']) {
    const r=await action('priority-'+level,'.priority-opt--'+level);
    assert.equal(r.savedPriority,level);
    if(process.env.SUBSCRIBE_FLOW_ASSERT_SMOOTH) {
      assert.equal(r.detailRetained,true,'priority must retain reading panel');
      assert.equal(r.bodyRetained,true,'priority must retain body and scroll');
      assert.equal(r.scrollRetained,true);
      assert.ok(!r.calls.some(c=>['connection.list','schedule.status','sync.list'].includes(c.method)), 'content write must not fetch unrelated session/jobs');
      assert.ok(!r.renders.some(r=>r.name==='renderWithScroll'), 'content write must not replace entire shell');
    }
  }
  const archived=await action('archive','.state-group .state-btn:last-child');
  assert.equal(archived.savedState.archived,true);
  assert.equal(archived.afterCounts.unread,archived.beforeCounts.unread-1);
  assert.equal(archived.afterCounts.archived,archived.beforeCounts.archived+1);
  await evaluate(`SF.app.state.filters={quick:'unread'};SF.app.state.selectedId=null;SF.app.renderContent();SF.views.inbox.whenIdle()`);
  await until('document.querySelectorAll(".content-card").length > 1');
  await evaluate(`SF.app.state.selectedId=document.querySelector('.content-card').dataset.contentId;SF.app.renderContent()`);
  await until('!!document.querySelector(".detail")');
  const removed=await action('archive-from-inbox','.state-group .state-btn:last-child');
  assert.equal(removed.savedState.archived,true);
  assert.equal(removed.afterCounts.unread,removed.beforeCounts.unread-1);
  assert.equal(removed.afterCounts.archived,removed.beforeCounts.archived+1);
  assert.equal(removed.selectedChanged,true,'archived content must leave unread list and select next');
  await evaluate(`SF.app.state.filters={quick:'all',priority:'high'};SF.app.state.selectedId=null;SF.app.renderContent();SF.views.inbox.whenIdle()`);
  await until('document.querySelectorAll(".content-card").length > 1');
  await evaluate(`SF.app.state.selectedId=document.querySelector('.content-card').dataset.contentId;SF.app.renderContent()`);
  const reclassified=await action('priority-leaves-filter','.priority-opt--low');
  assert.equal(reclassified.savedPriority,'low');
  assert.equal(reclassified.selectedChanged,true,'changed priority must leave its former filter');
  await evaluate(`SF.app.state.filters={quick:'all'};SF.app.renderContent();SF.views.inbox.whenIdle()`);
  await until('!!document.querySelector(".detail")');
  const auto=await action('restore-auto','.priority-opt--inherit');
  assert.equal(auto.savedPriority,null);
  // A failed write must keep the persisted selection/value and allow retry.
  const failureId=await evaluate('SF.app.state.selectedId');
  const beforeFailure=await original('content.get',{item_id:failureId});
  await evaluate(`(() => {
    actionProbe.originalUpdate=SF.app.state.client.updateContent;
    SF.app.state.client.updateContent=async()=>{throw new Error('隔离写入失败测试');};
    actionProbe.id=SF.app.state.selectedId;
    actionProbe.activePriority=document.querySelector('.priority-grid .is-active').className;
    document.querySelector('.priority-opt--low').click();
  })()`);
  await until(`!SF.app.isPending('content:'+actionProbe.id) && !document.querySelector('.priority-opt--low').disabled`);
  assert.equal(await evaluate('document.querySelector(".priority-grid .is-active").className===actionProbe.activePriority'),true);
  const afterFailure=await original('content.get',{item_id:failureId});
  assert.equal(afterFailure.priority_override,beforeFailure.priority_override);
  await evaluate('SF.app.state.client.updateContent=actionProbe.originalUpdate;void 0');
  const report={at:new Date().toISOString(),results,failedWriteControlsRecovered:true};
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify(report,null,2));
  console.log('[content-actions] '+JSON.stringify({passed:true,results:results.map(r=>({
    name:r.name,writeMs:Math.round(r.writeMs),settledMs:Math.round(r.settledMs),
    rpcCount:r.calls.length,fullRebuilds:r.renders.filter(r=>r.name==='renderWithScroll').length,
  })),failedWriteControlsRecovered:true}));
};
require(path.join(root, 'electron/main/index.cjs'));
