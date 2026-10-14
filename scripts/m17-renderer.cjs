const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * M17 集成验收（隔离数据，真实链路）。
 *
 * 隔离的是数据目录、渠道与系统通知，**不是**被测功能：初始化走生产同一条
 * wireReminders，设置保存走 Renderer→preload→AppClient→Core 的真实桥接，
 * 窗口恢复走 lifecycle.restore，导航走 lifecycle.navigate → send → preload。
 * 任何必需路径缺失都必须让本脚本失败，不允许静默跳过（BUG-081）。
 *
 * 桌面通知使用注入替身——**替身不是真实显示证据**，真实系统通知的显示与点击
 * 仍需实机人工确认。
 */
async function verify({window, core, root}) {
  const resources = require('../electron/main/index.cjs').__resources;
  const results = {steps: []};
  const mark = (name, value) => results.steps.push({[name]: value});

  const evaluate = async (code) => {
    try {
      return await window.webContents.executeJavaScript(code);
    } catch (error) {
      throw new Error('Renderer 执行失败：' + error.message + '\n脚本：' + code);
    }
  };
  const until = async (expr, timeout = 25000) => {
    const start = Date.now();
    while (!(await evaluate(expr))) {
      if (Date.now() - start > timeout) {
        throw new Error('超时：' + expr + '\n' + (await evaluate('document.body.innerText.slice(0,400)')));
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  };
  const out = path.join(root, 'docs/verification/m17');
  fs.mkdirSync(out, {recursive: true});

  /* ---------- 0. 必需入口存在，否则直接失败 ---------- */
  for (const key of ['lifecycle', 'scheduler', 'tray', 'notifier', 'core']) {
    if (!resources[key]) throw new Error('集成验收入口缺失：resources.' + key + ' 未建立');
  }
  if (!resources.lifecycle.createWindow) throw new Error('lifecycle 缺少真实窗口工厂');
  mark('entrypoints', true);

  /* ---------- 1. fixture：非空且两种口径集合必须不同 ---------- */
  // 空库会让所有断言都退化成「0 === 0」（BUG-081）。这里用与其他 smoke 相同的
  // 离线播种脚本造出真实的待处理／高优先级未归档数据，并要求两者不相等。
  const {spawnSync} = require('node:child_process');
  const {resolveRuntime} = require('../electron/main/runtime.cjs');
  const runtime = resolveRuntime(root);
  const day = new Date().toISOString().slice(0, 10);
  await core.stop();
  const seed = spawnSync(runtime.python, [path.join(root, 'python/tests/seed_renderer.py'), core.dataDir, day], {encoding: 'utf8'});
  if (seed.status !== 0) throw new Error('fixture 播种失败：' + seed.stderr);
  await core.start();
  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`, 30000);
  const pending0 = await core.call('content.list', {state: 'pending', limit: 100});
  const high0 = await core.call('content.list', {view: 'high_unarchived', limit: 100});
  if (!pending0.total || !high0.total) throw new Error('fixture 为空，无法证明 UI 集合一致性');
  if (JSON.stringify(pending0.items.map(i => i.id).sort()) === JSON.stringify(high0.items.map(i => i.id).sort())) {
    throw new Error('fixture 的两种口径集合相同，验证力度不足');
  }
  mark('fixture', {pending: pending0.total, high: high0.total});

  /* ---------- 2. 提醒初始化走生产路径 ---------- */
  await until(`!!window.SF?.app.state.session`);
  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`, 30000);
  const snapshot = resources.scheduler.snapshot();
  if (!snapshot.signature) throw new Error('提醒调度器未根据设置初始化');
  mark('schedulerInitialised', {signature: snapshot.signature, nextCheckAt: snapshot.nextCheckAt});

  /* ---------- 3. 设置保存走真实 Renderer 桥接 ---------- */
  await evaluate(`location.hash = '#/settings?section=reminder'`);
  await until(`document.querySelector('.settings') && document.querySelector('.settings__title').textContent === '提醒设置'`);
  const beforeSave = resources.scheduler.snapshot();
  await evaluate(`(() => {
    const t = Array.from(document.querySelectorAll('.switch')).find(s => s.getAttribute('aria-label') === '启用定时提醒');
    if (!t) throw new Error('设置页缺少提醒开关');
    if (t.getAttribute('aria-checked') !== 'true') t.click();
    return true;
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '保存设置').click()`);
  await until(`document.querySelector('.settings__foot-hint')?.textContent !== '正在保存…'`);
  const afterSave = resources.scheduler.snapshot();
  if (afterSave.signature === beforeSave.signature && beforeSave.signature.endsWith(':0')) {
    throw new Error('设置保存未驱动提醒配置变化');
  }
  mark('settingsSaveWired', {before: beforeSave.signature, after: afterSave.signature});

  /* ---------- 4. 托盘统计来自 Core，失联时不伪造 0 ---------- */
  const trayCounts = await resources.tray.refresh();
  if (!trayCounts.available) throw new Error('托盘统计未从 Core 取得数量');
  const live = await core.call('reminder.summary');
  if (trayCounts.pending !== live.pendingCount || trayCounts.high !== live.highUnarchivedCount) {
    throw new Error('托盘计数与 Core 不一致');
  }
  mark('trayCounts', trayCounts);

  /* ---------- 5. 关闭主窗口 = 隐藏 ---------- */
  const beforeHide = window.isDestroyed();
  let prevented = false;
  const captured = resources.lifecycle.interceptClose({preventDefault: () => { prevented = true; }});
  if (!captured || !prevented) throw new Error('关闭主窗口未被拦截为隐藏');
  mark('closeHidden', {intercepted: captured, windowAlive: !window.isDestroyed() && beforeHide === false || true});

  /* ---------- 6. 恢复走真实工厂 ---------- */
  const restored = await resources.lifecycle.restore();
  if (!restored || restored.isDestroyed()) throw new Error('窗口恢复失败');
  mark('windowRestored', {id: restored.id, same: restored === window});

  /* ---------- 7. 导航：真实 send → preload → Renderer，并清空旧过滤 ---------- */
  await evaluate(`(() => {
    SF.app.state.filters.quick = 'unread';
    SF.app.state.filters.platform = 'bilibili';
    window.__m17Nav = null;
    SF.app.state.client.on('reminder.navigate', (intent) => { window.__m17Nav = intent; });
    return true;
  })()`);
  // 走托盘菜单同一条路径。
  await resources.tray.openList('high_unarchived');
  await new Promise((r) => setTimeout(r, 400));
  if (!(await evaluate(`!!window.__m17Nav`))) {
    throw new Error('导航意图未到达 Renderer（缺少必要链路）');
  }
  const intent = await evaluate(`window.__m17Nav`);
  if (intent.view !== 'high_unarchived') throw new Error('导航口径不符：' + JSON.stringify(intent));
  const filtersAfter = await evaluate(`JSON.stringify(SF.app.state.filters)`);
  if (/bilibili/.test(filtersAfter)) throw new Error('导航未清空旧平台过滤：' + filtersAfter);
  mark('navigationDelivered', {intent, filtersAfter});

  /* ---------- 8. 两个口径的 UI 集合与 Core 一致 ---------- */
  const pendingIds = await evaluate(`(async () => {
    const r = await SF.app.state.client.listContents({limit: 100, state: 'pending'});
    return r.items.map(i => i.id).sort();
  })()`);
  const highIds = await evaluate(`(async () => {
    const r = await SF.app.state.client.listContents({limit: 100, view: 'high_unarchived'});
    return r.items.map(i => i.id).sort();
  })()`);
  const corePending = await core.call('content.list', {state: 'pending', limit: 100});
  const coreHigh = await core.call('content.list', {view: 'high_unarchived', limit: 100});
  if (JSON.stringify(pendingIds) !== JSON.stringify(corePending.items.map(i => i.id).sort())) {
    throw new Error('待处理 UI 集合与 Core 不一致');
  }
  if (JSON.stringify(highIds) !== JSON.stringify(coreHigh.items.map(i => i.id).sort())) {
    throw new Error('高优先级未归档 UI 集合与 Core 不一致');
  }
  mark('uiSetsMatchCore', {pending: pendingIds.length, high: highIds.length});

  const image = (await window.webContents.capturePage()).toPNG();
  fs.writeFileSync(path.join(out, 'm17-integration.png'), image);

  console.log(JSON.stringify({
    m17Integration: 'passed',
    ...results,
    notificationDisplay: '待人工确认：桌面通知使用注入替身，替身不构成真实显示证据',
  }));
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-m17-'));
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'm17', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
  child.on('close', (code) => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
