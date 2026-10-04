const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function verify({window, core, root, mode}) {
  const evaluate = code => window.webContents.executeJavaScript(code);
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
    fs.mkdirSync(path.join(root,'docs/verification'),{recursive:true});
    fs.writeFileSync(path.join(root,'docs/verification', name), (await window.webContents.capturePage()).toPNG());
  };
  await until(`!!window.SF?.app.state.session && !!document.querySelector('[data-view="inbox"] .state')`);
  assert.equal(await evaluate(`SF.app.state.source`),'real');
  assert.equal(await evaluate(`typeof require`),'undefined');
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
    await until(`Array.from(document.querySelectorAll('.source-results button')).some(b => b.textContent.includes('UID 946974')) || !!document.querySelector('.dialog .field__error')?.textContent`,75000);
    const searchError = await evaluate(`document.querySelector('.dialog .field__error').textContent`);
    if (searchError) { await screenshot('m5-live-search-error.png'); throw new Error(searchError); }
    await screenshot('m5-live-search.png');
    await evaluate(`Array.from(document.querySelectorAll('.source-results button')).find(b => b.textContent.includes('UID 946974')).click()`);
  }
  await until(`!!document.querySelector('#source-confirm') && !document.querySelector('#source-confirm').disabled`);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim()==='确认添加').disabled`),true);
  if (mode === 'offline') await screenshot('m5-source-confirm.png');
  await evaluate(`document.querySelector('#source-confirm').click()`);
  await click('确认添加');
  await until(`!document.querySelector('.dialog') && !!document.querySelector('[data-channel-id]')`);
  assert.equal((await core.call('subscription.list')).length,1);
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
  if (mode === 'live') {
    await click('补充详情');
    await until(`SF.app.state.runs[0]?.kind === 'detail' && ['succeeded','failed','partial','waiting'].includes(SF.app.state.runs[0].state)`,75000);
    assert.equal((await core.call('sync.list'))[0].state,'succeeded');
    await until(`!!document.querySelector('.detail-preview') && !!document.querySelector('.content-card')`);
  }
  await screenshot(mode==='live'?'m5-live-inbox.png':'m5-offline-inbox.png');
  const firstId=await evaluate('SF.app.state.selectedId');
  await evaluate(`Array.from(document.querySelectorAll('.detail .op-btn')).find(b => b.textContent.trim()==='已读').click()`);
  await until(`document.querySelector('.op-btn[aria-pressed="true"]')?.textContent.trim() === '已读'`);
  assert.equal((await core.call('content.get',{item_id:firstId})).state.read,true);
  // Invalidations and server-side filters must update the actual list, not just counts.
  await evaluate(`document.querySelector('[data-quick="read"]').click()`);
  await until(`document.querySelectorAll('.content-card').length === 1`);
  await evaluate(`document.querySelector('[data-quick="all"]').click()`);
  await until(`document.querySelectorAll('.content-card').length > 1`);
  if(mode === 'offline') {
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
  // An actual sidecar crash must show the recovery action without fabricating empty data.
  core.child.kill('SIGKILL');
  await core.exited;
  await until(`SF.app.state.coreStatus.state === 'stopped'`);
  await click('重启核心服务');
  await until(`SF.app.state.coreStatus.state === 'ready'`);
  assert.equal((await core.call('content.get',{item_id:firstId})).state.read,true);
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
  const mode=process.argv.includes('--live')?'live':'offline';
  const child=spawn(require('electron'),[root],{env:{...process.env,SUBSCRIBE_FLOW_RENDERER_SMOKE:mode,SUBSCRIBE_FLOW_LIVE_SKIP_SEARCH:process.argv.includes('--uid-only')?'1':'0',SUBSCRIBE_FLOW_DATA_DIR:folder},stdio:'inherit'});
  const timer=setTimeout(()=>child.kill('SIGTERM'),180000);
  child.on('close',code=>{clearTimeout(timer);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=code??1;});
}
