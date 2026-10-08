const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function verify({window, core, root, mode}) {
  const evaluate = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\nRenderer assertion: ' + code); }
  };
  const until = async (expression, timeout = 15000) => {
    const start = Date.now();
    while (!(await evaluate(expression))) {
      if (Date.now() - start > timeout) throw new Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 70));
    }
  };
  const click = async label => evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!b || b.disabled) throw new Error('Missing/enabled button: ' + ${JSON.stringify(label)});
    b.click();
  })()`);
  const screenshot = async name => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await evaluate(`Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`);
    const output=process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root,'docs/verification');
    fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage()).toPNG());
  };
  await until(`!!window.SF?.app.state.session && !!document.querySelector('[data-view="inbox"] .state')`);
  assert.equal(await evaluate(`SF.app.state.source`),'real');
  assert.equal(await evaluate(`typeof require`),'undefined');
  if (mode === 'offline') {
    // M11 foundation is callable from the actual isolated Renderer. Real link
    // readers belong to M13, so existing adapters must refuse without fetching.
    assert.equal(await evaluate(`SF.app.state.session.capabilities.canIntake`),false);
    const intakeErrors=await evaluate(`(async()=>{
      const methods=[['startIntake',[{url:'https://www.bilibili.com/video/BV1xx411c700'}]],['getIntake',['missing']],['cancelIntake',['missing']],['saveIntake',['missing',{}]]];
      const results=[];
      for(const [name,args] of methods) { try { await SF.app.state.client[name].apply(null,args); results.push('unexpected success'); } catch(error) { results.push(error.code); } }
      const sources=await SF.app.state.client.listContentSources();
      const raw=await SubscribeFlow.request('intake.get',{task_id:'missing'});
      if(raw.ok || raw.error.code!=='NOT_FOUND') throw new Error('Raw intake bridge error was lost');
      const unsubscribe=SubscribeFlow.on('intake.changed',()=>{});unsubscribe();
      return {results,sourceCount:sources.total};
    })()`);
    assert.deepEqual(intakeErrors,{results:['UNSUPPORTED_OPERATION','NOT_FOUND','NOT_FOUND','PREVIEW_EXPIRED'],sourceCount:0});
    await require('./intake-smoke.cjs').verifyIntakeDates({evaluate,until,click,screenshot,core,root});
    // Review regression for the Minimax enhancement: a dismissed connection
    // warning must not hide a changed reason or a later task result.
    await evaluate(`window.savedConnection = SF.app.state.session.connection; SF.app.state.session.connection = {state:'blocked',dependency:'unknown',authentication:'required',detail:'验收：请登录'}; SF.app.renderContent()`);
    await click('关闭提示');
    assert.equal(await evaluate(`!!document.querySelector('.status-bar')`),false);
    await evaluate(`SF.app.renderContent()`);
    assert.equal(await evaluate(`!!document.querySelector('.status-bar')`),false);
    await evaluate(`SF.app.state.session.connection.detail='验收：网络中断'; SF.app.renderContent()`);
    assert.equal(await evaluate(`!!document.querySelector('.status-bar')`),true);
    await click('关闭提示');
    await evaluate(`SF.app.state.runs=[{id:'minimax-review',state:'waiting'}]; SF.app.renderContent()`);
    assert.equal(await evaluate(`!!document.querySelector('.status-bar')`),true);
    await evaluate(`SF.app.state.runs=[{id:'minimax-review',state:'running',channelName:'验收',message:'验收'}]; SF.app.renderContent()`);
    assert.equal(await evaluate(`!!document.querySelector('.status-bar [aria-label="关闭提示"]')`),false);
    await evaluate(`SF.app.state.runs=[]; SF.app.state.session.connection=window.savedConnection; delete window.savedConnection; SF.app.renderContent()`);
  }
  if (mode === 'offline') await screenshot('m5-empty.png');
  await evaluate(`document.querySelector('[data-nav="channels"]').click()`);
  await until(`!!document.querySelector('[data-view="channels"] .channels__toolbar')`);
  await click('添加渠道或创作者');
  await evaluate(`document.querySelector('#source-input').value = '946974'; document.querySelector('#source-input').dispatchEvent(new Event('input', {bubbles:true}));`);
  await click('解析 UID / 主页');
  if (mode === 'live' && process.env.SUBSCRIBE_FLOW_LIVE_SKIP_SEARCH !== '1') {
    await until(`!!document.querySelector('#source-confirm') && !document.querySelector('#source-confirm').disabled`);
    await evaluate(`document.querySelector('#source-input').value = '影视飓风'; document.querySelector('#source-input').dispatchEvent(new Event('input', {bubbles:true}));`);
    await click('搜索作者');
    await until(`Array.from(document.querySelectorAll('.source-results button')).some(b => b.dataset.sourceId === '946974') || !!document.querySelector('.dialog .field__error')?.textContent`,75000);
    const searchError = await evaluate(`document.querySelector('.dialog .field__error').textContent`);
    if (searchError) { await screenshot('m5-live-search-error.png'); throw new Error(searchError); }
    await screenshot('m5-live-search.png');
    await evaluate(`Array.from(document.querySelectorAll('.source-results button')).find(b => b.dataset.sourceId === '946974').click()`);
  }
  await until(`!!document.querySelector('#source-confirm') && !document.querySelector('#source-confirm').disabled`);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim()==='确认添加').disabled`),true);
  if (mode === 'offline') await screenshot('m5-source-confirm.png');
  await evaluate(`document.querySelector('#source-confirm').click()`);
  await click('确认添加');
  await until(`!document.querySelector('.dialog') && !!document.querySelector('[data-channel-id]')`);
  assert.equal((await core.call('subscription.list')).length,1);
  assert.equal(await evaluate(`document.querySelectorAll('.table__ops button').length`),4);
  assert.equal(await evaluate(`!!document.querySelector('[aria-label="设置采集条数"]')`),true);
  assert.equal(await evaluate(`!!document.querySelector('[aria-label="查看来源内容"]')`),false);
  if (mode === 'offline') {
    assert.equal((await core.call('subscription.list'))[0].sync_mode,'manual');
    // The collection ceiling is edited in items and stored on the subscription.
    await click('设置采集条数');
    await until(`!!document.querySelector('#collect-items')`);
    await evaluate(`document.querySelector('#collect-items').value='51'`);
    await click('保存采集条数');
    assert.ok(await evaluate(`document.querySelector('.dialog .field__error').textContent.includes('50')`));
    await evaluate(`document.querySelector('#collect-items').value='35'`);
    await screenshot('collect-items.png');
    await click('保存采集条数');
    await until(`!document.querySelector('.dialog') && !!document.querySelector('[aria-label="设置采集条数"]')`);
    assert.equal((await core.call('subscription.list'))[0].collect_items,35);
    // 35 items is two whole pages of 20, so the Core derives the job budget.
    await core.call('sync.start',{subscription_id:(await core.call('subscription.list'))[0].id,mode:'refresh'});
    assert.equal((await core.call('sync.list'))[0].page_budget,2);
    await click('手动刷新');
    await until(`!!document.querySelector('#refresh-interval')`);
    assert.equal(await evaluate(`document.querySelector('#refresh-interval').value`),'24');
    await evaluate(`(() => { const mode=document.querySelector('[aria-label="同步模式"]'); mode.value='automatic'; mode.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await screenshot('m6-sync-settings.png');
    await evaluate(`document.querySelector('#refresh-interval').value='73'`);
    await click('保存同步设置');
    assert.ok(await evaluate(`document.querySelector('.dialog .field__error').textContent.includes('72')`));
    await evaluate(`document.querySelector('#refresh-interval').value='72'`);
    await click('保存同步设置');
    await until(`!document.querySelector('.dialog') && document.body.innerText.includes('每 72 小时')`);
    assert.equal((await core.call('subscription.list'))[0].interval_seconds,259200);
    await screenshot('m6-automatic-schedule.png');
    await click('每 72 小时');
    await until(`!!document.querySelector('#refresh-interval')`);
    await evaluate(`(() => { const mode=document.querySelector('[aria-label="同步模式"]'); mode.value='manual'; mode.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await click('保存同步设置');
    await until(`!document.querySelector('.dialog') && document.body.innerText.includes('手动刷新')`);
    assert.equal((await core.call('schedule.list'))[0].next_due,null);
    assert.equal((await core.call('subscription.list'))[0].interval_seconds,259200);
    assert.equal(await evaluate(`SubscribeFlow.call('system.power',{suspended:true}).then(()=>false,()=>true)`),true);
  }
  await evaluate(`document.querySelector('[role="switch"]').click()`);
  await until(`document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'false'`);
  await evaluate(`document.querySelector('[role="switch"]').click()`);
  await until(`document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true'`);
  await click('刷新来源');
  await until(`SF.app.state.runs.length > 0 && ['waiting','failed','succeeded','partial'].includes(SF.app.state.runs[0].state)`,90000);
  if(mode === 'live') {
    const latest = (await core.call('sync.list'))[0];
    await until(`!!document.querySelector('[data-channel-id]') && !!document.querySelector('[data-run-id]')`);
    await screenshot(latest.state === 'succeeded' ? 'm5-live-channels.png' : 'm5-live-fetch-error.png');
    if (latest.state !== 'succeeded') {
      console.log(JSON.stringify({rendererLive:'blocked',state:latest.state,error:latest.error}));
      throw new Error('Live collection did not succeed');
    }
  } else {
    assert.equal((await core.call('sync.list'))[0].state,'waiting');
    await until(`!!document.querySelector('[data-channel-id]') && !!document.querySelector('[data-run-id]')`);
    await screenshot('m5-dependency.png');
    await click('取消任务');
    await until(`SF.app.state.runs[0]?.state === 'cancelled'`);
    await core.stop();
    const runtime=JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json'),'utf8'));
    const day=await evaluate('SF.fmt.ymd(Date.now())');
    const seed=spawnSync(runtime.python,[path.join(root,'python/tests/seed_renderer.py'),core.dataDir,day],{encoding:'utf8'});
    assert.equal(seed.status,0,seed.stderr);
    await core.start();
    await until(`SF.app.state.counts.total === 25 && !!document.querySelector('[data-run-id]')`);
    await screenshot('m5-partial.png');
  }
  await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
  await until(`document.querySelectorAll('.content-card').length > 0`);
  const platformCount=(await core.call('channel.list')).length;
  assert.equal(await evaluate(`document.querySelectorAll('.chips .chip').length`),platformCount+1);
  assert.equal(await evaluate(`document.querySelectorAll('.chips .chip__count').length`),platformCount+1);
  if (mode === 'live') {
    await click('补充详情');
    await until(`SF.app.state.runs[0]?.kind === 'detail' && ['succeeded','failed','partial','waiting'].includes(SF.app.state.runs[0].state)`,75000);
    assert.equal((await core.call('sync.list'))[0].state,'succeeded');
    await until(`!!document.querySelector('.detail-preview') && !!document.querySelector('.content-card')`);
  }
  await screenshot(mode==='live'?'m5-live-inbox.png':'m5-offline-inbox.png');
  if(mode==='offline') await require('./list-state-smoke.cjs').verifyListState({evaluate,until,click,screenshot,core,window});
  const firstId=await evaluate('SF.app.state.selectedId');
  const total=(await core.call('content.list',{limit:1})).total;
  const card=id=>'.content-card[data-content-id=' + JSON.stringify(id) + ']';
  const absent=id=>`!document.querySelector(${JSON.stringify(card(id))})`;
  const title=()=>evaluate(`document.querySelector('.view__title h1').textContent`);
  assert.equal(await evaluate('SF.app.state.filters.quick'),'unread');
  await evaluate(`Array.from(document.querySelectorAll('.detail .op-btn')).find(b => b.textContent.trim()==='已读').click()`);
  await until(`SF.app.state.counts.unread === ${total-1} && document.querySelectorAll('.content-card').length > 0 && ${absent(firstId)}`);
  assert.equal(await evaluate(`document.querySelector('[data-nav="inbox"] .count-pill').textContent`),String(total-1));
  assert.equal((await core.call('content.get',{item_id:firstId})).state.read,true);
  // Invalidations and server-side filters must update the actual list, not just counts.
  await evaluate(`document.querySelector('[data-quick="read"]').click()`);
  await until(`document.querySelectorAll('.content-card').length === 1`);
  assert.equal(await title(),'已读');
  assert.equal(await evaluate(`!!document.querySelector('[data-nav="inbox"].is-active')`),false);
  // Same hash, different scope: the inbox nav must actively reset the filter.
  await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
  await until(`SF.app.state.filters.quick === 'unread' && document.querySelectorAll('.content-card').length > 0 && ${absent(firstId)}`);
  assert.equal(await title(),'收件箱');
  if(mode === 'offline') {
    // Each independent processing action leaves inbox, and undo returns it.
    for(const [field,label,heading] of [['deferred','稍后处理','稍后处理'],['archived','归档','已归档']]) {
      const id=await evaluate('SF.app.state.selectedId');
      // 检查与点击必须在同一次求值里完成：处理后该内容离开列表，详情会随之关闭。
      await until(`(() => { const b = Array.from(document.querySelectorAll('.detail .op-btn'))
        .find(b => b.textContent.trim()===${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
      await until(`SF.app.state.counts.unread === 23 && document.querySelectorAll('.content-card').length > 0 && ${absent(id)}`);
      assert.equal((await core.call('content.get',{item_id:id})).state[field],true);
      await evaluate(`document.querySelector('[data-quick="${field}"]').click()`);
      await until(`document.querySelectorAll('.content-card').length === 1 && !!document.querySelector(${JSON.stringify(card(id))})`);
      assert.equal(await title(),heading);
      await evaluate(`Array.from(document.querySelectorAll('.detail .op-btn')).find(b => b.textContent.trim()===${JSON.stringify(label)}).click()`);
      await until(`SF.app.state.counts.unread === 24 && document.querySelectorAll('.content-card').length === 0 && !!document.querySelector('.view__body .state')`);
      await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
      await until(`document.querySelectorAll('.content-card').length === 20 && !!document.querySelector(${JSON.stringify(card(id))})`);
    }
    const menuId=await evaluate('SF.app.state.selectedId');
    await evaluate(`document.querySelector(${JSON.stringify(card(menuId) + ' [aria-label="更多操作"]')}).click()`);
    await click('标记为已读');
    await until(`SF.app.state.counts.unread === 23 && document.querySelectorAll('.content-card').length > 0 && ${absent(menuId)}`);
    await evaluate(`document.querySelector('[data-quick="read"]').click()`);
    await until(`document.querySelectorAll('.content-card').length === 2`);
    await evaluate(`document.querySelector(${JSON.stringify(card(menuId) + ' [aria-label="更多操作"]')}).click()`);
    await click('标记为未读');
    await until(`SF.app.state.counts.unread === 24 && document.querySelectorAll('.content-card').length === 1`);
    await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
    await until(`document.querySelectorAll('.content-card').length === 20`);
    await click('下一页');
    await until(`document.querySelectorAll('.content-card').length === 4`);
    const lastPage=await evaluate(`Array.from(document.querySelectorAll('.content-card')).map(c=>c.dataset.contentId)`);
    // 勾选逐个进行：每次点击都会重绘列表，下标要在点击前确认存在。
    for(let i=0;i<4;i++) {
      await until(`!!document.querySelectorAll('.content-selection > [role="checkbox"]')[${i}]`);
      await evaluate(`document.querySelectorAll('.content-selection > [role="checkbox"]')[${i}].click()`);
      await until(`document.querySelectorAll('.content-selection > [role="checkbox"][aria-checked="true"]').length===${i+1}`);
    }
    await evaluate(`Array.from(document.querySelectorAll('.inbox__toolbar button')).find(b=>b.textContent.trim()==='归档').click()`);
    await until(`SF.app.state.counts.unread === 20 && document.querySelectorAll('.content-card').length === 20 && document.body.innerText.includes('第 1 页')`);
    for(const id of lastPage) {
      assert.ok(await evaluate(absent(id)));
      assert.equal((await core.call('content.get',{item_id:id})).state.archived,true);
    }
    assert.equal(await evaluate(`document.querySelector('[data-nav="inbox"] .count-pill').textContent`),'20');
    await screenshot('bug-001-inbox-after-processing.png');
    // Clearing a search must preserve inbox scope instead of exposing processed items.
    await evaluate(`const search=document.querySelector('.topbar__search input'); search.value='NO_MATCH_BUG_001'; search.dispatchEvent(new Event('input',{bubbles:true}));`);
    await until(`document.querySelectorAll('.content-card').length === 0 && document.body.innerText.includes('当前没有待处理内容')`);
    await click('清除筛选');
    await until(`SF.app.state.search === '' && document.querySelectorAll('.content-card').length === 20`);
    assert.equal(await evaluate('SF.app.state.filters.quick'),'unread');
    assert.ok(await evaluate(absent(firstId)));
  }
  await evaluate(`document.querySelector('[data-quick="all"]').click()`);
  await until(`document.querySelectorAll('.content-card').length > 1`);
  assert.equal(await title(),'全部更新');
  if(mode === 'offline') {
    // BUG-005: processing choices replace one another on the same note.
    await evaluate(`document.querySelector(${JSON.stringify(card(firstId))}).click()`);
    for(const [field,label] of [['deferred','稍后处理'],['archived','归档']]) {
      await until(`Array.from(document.querySelectorAll('.detail .op-btn')).some(b=>b.textContent.trim()===${JSON.stringify(label)})`);
      await evaluate(`Array.from(document.querySelectorAll('.detail .op-btn')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
      await until(`SF.app.state.selectedId === ${JSON.stringify(firstId)} && document.querySelectorAll('.detail .op-btn[aria-pressed="true"]').length === 1 && document.querySelector('.detail .op-btn[aria-pressed="true"]')?.textContent.trim() === ${JSON.stringify(label)}`);
      assert.deepEqual((await core.call('content.get',{item_id:firstId})).state,{read:false,archived:field==='archived',deferred:field==='deferred'});
    }
    await screenshot('bug-005-single-processing-state.png');
    // The card menu must use the same exclusive write path as the detail panel.
    await evaluate(`document.querySelector(${JSON.stringify(card(firstId) + ' [aria-label="更多操作"]')}).click()`);
    await click('标记为已读');
    await until(`SF.app.state.counts.read === 1 && SF.app.state.counts.archived === 4 && document.querySelector('.detail .op-btn[aria-pressed="true"]')?.textContent.trim() === '已读'`);
    assert.deepEqual((await core.call('content.get',{item_id:firstId})).state,{read:true,archived:false,deferred:false});
    await until(`Array.from(document.querySelectorAll('.detail .op-btn')).some(b=>b.textContent.trim()==='已读')`);
    await evaluate(`Array.from(document.querySelectorAll('.detail .op-btn')).find(b=>b.textContent.trim()==='已读').click()`);
    await until(`SF.app.state.counts.unread === 21 && document.querySelectorAll('.detail .op-btn[aria-pressed="true"]').length === 0`);
    assert.deepEqual((await core.call('content.get',{item_id:firstId})).state,{read:false,archived:false,deferred:false});
    await until(`Array.from(document.querySelectorAll('.detail .op-btn')).some(b=>b.textContent.trim()==='已读')`);
    await evaluate(`Array.from(document.querySelectorAll('.detail .op-btn')).find(b=>b.textContent.trim()==='已读').click()`);
    await until(`SF.app.state.counts.unread === 20 && SF.app.state.counts.read === 1 && document.querySelector('.detail .op-btn[aria-pressed="true"]')?.textContent.trim() === '已读'`);
    assert.equal(await evaluate(`document.querySelectorAll('.content-card').length`),20);
    await click('下一页');
    await until(`document.querySelectorAll('.content-card').length === 5`);
    assert.ok(await evaluate(`document.body.innerText.includes('发布时间未知')`));
  }
  await evaluate(`document.querySelector('[data-nav="overview"]').click()`);
  await until(`!!document.querySelector('.calendar-grid')`);
  await screenshot(mode==='live'?'m5-live-calendar.png':'m5-offline-calendar.png');
  if (mode === 'offline') {
    window.setSize(900,760);
    await screenshot('m5-calendar-compact.png');
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`));
    window.setSize(1440,1000);
  }
  const month=await evaluate('SF.app.state.calendarMonth');
  await click('上个月');
  await until(`!!document.querySelector('.calendar-grid') && SF.app.state.calendarMonth !== ${JSON.stringify(month)}`);
  await click('今天');
  await until(`!!document.querySelector('.calendar-grid') && SF.app.state.calendarMonth === ${JSON.stringify(month)}`);
  if(mode==='offline') await require('./priority-smoke.cjs').verifyPriorities({evaluate,until,click,screenshot,core,window,firstId});
  if(mode==='offline') await require('./calendar-smoke.cjs').verifyCalendar({evaluate,until,click,screenshot,core,window,firstId});
  if(mode==='offline') await require('./tags-smoke.cjs').verifyTags({evaluate,until,click,screenshot,core,window,firstId});
  // An actual sidecar crash must show the recovery action without fabricating empty data.
  core.child.kill('SIGKILL');
  await core.exited;
  await until(`SF.app.state.coreStatus.state === 'stopped'`);
  await click('重启核心服务');
  await until(`SF.app.state.coreStatus.state === 'ready'`);
  assert.equal((await core.call('content.get',{item_id:firstId})).state.read,true);
  if(mode === 'offline') {
    await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
    await until(`document.querySelectorAll('.content-card').length === 20 && SF.app.state.counts.unread === 20`);
    assert.ok(await evaluate(absent(firstId)));
    assert.equal((await core.call('content.list',{limit:1})).total,25);
  }
  await window.reload();
  await until(`!!window.SF?.app.state.session && SF.app.state.counts.total > 0`);
  assert.equal((await core.call('subscription.list')).length,1);
  assert.equal((await core.call('content.get',{item_id:firstId})).state.read,true);
  if (mode === 'offline') {
    // Bare HTML must explain the missing desktop environment without a fake fallback.
    const {BrowserWindow} = require('electron');
    const bare = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    try {
      await bare.loadFile(path.join(root,'electron/renderer/index.html'));
      assert.ok(await bare.webContents.executeJavaScript(`document.body.innerText.includes('请通过桌面应用启动')`));
      assert.equal(await bare.webContents.executeJavaScript(`document.querySelectorAll('button').length`),0);
    } finally { bare.destroy(); }
  }
  // Unsubscribing retains saved content; the action must be reflected in the page.
  await evaluate(`document.querySelector('[data-nav="channels"]').click()`);
  await until(`!!document.querySelector('[data-channel-id]')`);
  const totalBefore=(await core.call('content.list')).total;
  await click('取消追踪');
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim()==='取消追踪').click()`);
  await until(`!document.querySelector('[data-channel-id]') && document.body.innerText.includes('还没有添加任何来源')`);
  assert.equal((await core.call('subscription.list')).length,0);
  assert.equal((await core.call('content.list')).total,totalBefore);
  console.log(JSON.stringify({rendererSmoke:'passed',mode,search:mode==='live'?(process.env.SUBSCRIBE_FLOW_LIVE_SKIP_SEARCH==='1'?'skipped':'passed'):'offline',contents:(await core.call('content.list')).total,realBridge:true,restartPersisted:true,reloadPersisted:true}));
}
module.exports={verify};

if(require.main === module) {
  const root=path.resolve(__dirname,'..');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-renderer-'));
  const mode=process.argv.includes('--xhs')?'xhs':process.argv.includes('--live')?'live':'offline';
  const child=spawn(require('electron'),[root],{env:{...process.env,SUBSCRIBE_FLOW_RENDERER_SMOKE:mode,SUBSCRIBE_FLOW_LIVE_SKIP_SEARCH:process.argv.includes('--uid-only')?'1':'0',SUBSCRIBE_FLOW_DATA_DIR:folder},stdio:'inherit'});
  const timer=setTimeout(()=>child.kill('SIGTERM'),180000);
  child.on('close',code=>{clearTimeout(timer);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=code??1;});
}
