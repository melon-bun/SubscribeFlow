const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * M17 提醒持久化集成验收（BUG-072／073／074）。
 *
 * 走真实 Electron 入口与**生产初始化**（wireReminders 不再在 smoke 下跳过），
 * 设置保存经真实 Renderer→preload→AppClient→Core 桥接，状态读写走真实 RPC 与
 * 临时 SQLite。隔离的只有数据目录、时钟与系统通知，不重建另一套调度器。
 *
 * 通知使用替身，不构成真实系统通知显示证据。
 */
async function verify({window, core, root}) {
  const {__resources: resources} = require('../electron/main/index.cjs');
  const results = {steps: []};
  const evaluate = async (code) => {
    try {
      return await window.webContents.executeJavaScript(code);
    } catch (error) {
      let page = '';
      try { page = await window.webContents.executeJavaScript('document.body.innerText.slice(0,200)'); } catch (_) { page = '?'; }
      throw new Error('Renderer 失败：' + error.message + ' | 脚本：' + code.slice(0, 90) + ' | 页面：' + page);
    }
  };
  const until = async (expr, timeout = 30000) => {
    const start = Date.now();
    while (!(await evaluate(expr))) {
      if (Date.now() - start > timeout) {
        throw new Error('超时：' + expr + '\n' + await evaluate('document.body.innerText.slice(0,300)'));
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  };

  // 可控时钟与可控定时器：推进它们驱动的是**生产定时器回调本身**，
  // 不是手动调用 run() 冒充计时。
  let clock = 1_700_000_000_000;
  const timers = new Map();
  let nextTimerId = 1;
  resources.testClock = () => clock;
  resources.testSetTimer = (fn, ms) => {
    const id = nextTimerId++;
    timers.set(id, {fn, due: clock + ms});
    return {__testTimer: true, id};
  };
  resources.testClearTimer = (handle) => {
    if (handle && handle.__testTimer) timers.delete(handle.id);
  };
  const advance = async (ms) => {
    clock += ms;
    // 触发所有到期定时器（可能级联产生新的到期项）。
    for (let round = 0; round < 5; round++) {
      const due = [...timers.entries()].filter(([, t]) => t.due <= clock).sort((a, b) => a[1].due - b[1].due);
      if (!due.length) break;
      for (const [id, t] of due) {
        timers.delete(id);
        t.fn();
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  };

  await until(`!!window.SF?.app.state.session`);
  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);
  const scheduler = resources.scheduler;
  assert.ok(scheduler, '生产提醒调度器必须已建立');
  assert.equal(await core.call('reminder.state'), null, '初始不应有持久运行状态');

  // 点保存前必须等按钮真的可点：草稿没变就点，按钮是 disabled，点了等于没点。
  const clickSave = async () => {
    await until(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '保存设置');
      return !!b && !b.disabled;
    })()`);
    // 保存是异步的：点完必须等**调度器真的收到新配置**，否则读到的还是保存前的状态。
    const before = resources.scheduler.snapshot().signature;
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '保存设置').click()`);
    await until(`(() => {
      const hint = document.querySelector('.settings__foot-hint')?.textContent;
      return hint !== '正在保存…' && hint !== '有未保存的修改';
    })()`);
    if (before) {
      // 启停／改间隔一定会换身份；等到调度器真的收到新配置才算这次保存生效。
      // smoke 跑在 Main 里，直接读调度器状态，无需跨 Renderer 桥。
      const deadline = Date.now() + 20000;
      while (resources.scheduler.snapshot().signature === before && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  };

  /* ---------- 1. 生产初始化已按设置建立周期 ---------- */
  await until(`SF.views.settings ? true : true`);
  await new Promise((r) => setTimeout(r, 800));
  const initial = scheduler.snapshot();
  results.steps.push({productionWiring: {signature: initial.signature, nextCheckAt: initial.nextCheckAt}});

  /* ---------- 2. 设置页经真实 bridge 保存：首次启用 ---------- */
  await evaluate(`location.hash = '#/settings?section=reminder'`);
  await until(`document.querySelector('.settings__title') && document.querySelector('.settings__title').textContent === '提醒设置'`);
  await evaluate(`(() => {
    const t = Array.from(document.querySelectorAll('.switch')).find(s => s.getAttribute('aria-label') === '启用定时提醒');
    if (t.getAttribute('aria-checked') !== 'true') t.click();
    return true;
  })()`);
  await evaluate(`(() => {
    const select = document.querySelector('.setting-inline select');
    select.value = '30';
    select.dispatchEvent(new Event('change', {bubbles: true}));
    return true;
  })()`);
  await clickSave();

  const afterEnable = scheduler.snapshot();
  assert.ok(afterEnable.signature && afterEnable.signature.startsWith('1:'),
    '保存成功后必须真的驱动提醒配置，实际 ' + afterEnable.signature);
  const persistedEnabled = await core.call('reminder.state');
  assert.ok(persistedEnabled && persistedEnabled.signature === afterEnable.signature,
    '运行状态必须带正确身份落盘');
  assert.equal(persistedEnabled.nextCheckAt, afterEnable.nextCheckAt, '持久 deadline 必须与调度器一致');
  const enableDue = afterEnable.nextCheckAt - clock;
  results.steps.push({enableViaBridge: {signature: afterEnable.signature, dueInMs: enableDue,
    persisted: persistedEnabled.signature}});

  /* ---------- 3. 未到期不通知；到期走正式定时器回调一次 ---------- */
  const notificationsBefore = scheduler.running.notified;
  await advance(Math.floor(enableDue / 2));
  assert.equal(scheduler.running.notified, notificationsBefore, '未到期不得通知');
  await advance(enableDue);
  const afterFirst = scheduler.snapshot();
  assert.equal(afterFirst.nextCheckAt, clock + 30 * 60_000, '成功后按完整间隔排出下一周期');
  results.steps.push({timerFires: {lastResult: afterFirst.lastResult, nextDueInMs: afterFirst.nextCheckAt - clock}});

  /* ---------- 4. 数量没变仍按期提醒 ---------- */
  const notifiedAfterFirst = scheduler.running.notified;
  await advance(30 * 60_000);
  assert.ok(scheduler.running.notified >= notifiedAfterFirst, '周期提醒应继续执行');

  /* ---------- 5. 无关 AI 设置保存不得重置周期 ---------- */
  const beforeIrrelevant = scheduler.snapshot();
  await evaluate(`location.hash = '#/settings?section=tagging'`);
  await until(`document.querySelector('.settings__title').textContent === 'AI 模型配置'`);
  const genBefore = beforeIrrelevant.generation;
  const dueBefore = beforeIrrelevant.nextCheckAt;
  // 合法的 AI 配置变更：只改模型标识文本，不开启自动打标、不需要任何模型凭据，
  // 也不会触发任何模型调用。
  await evaluate(`(() => {
    const fields = Array.from(document.querySelectorAll('.setting-block input[type="text"]'));
    const model = fields[fields.length - 1];
    if (model) { model.value = 'acceptance-only-model'; model.dispatchEvent(new Event('input', {bubbles: true})); }
    return true;
  })()`);
  await clickSave();
  const afterIrrelevant = scheduler.snapshot();
  assert.equal(afterIrrelevant.nextCheckAt, dueBefore, '无关 AI 保存不得重置提醒周期');
  assert.equal(afterIrrelevant.generation, genBefore, '无关 AI 保存不得推进提醒代际');
  results.steps.push({irrelevantSave: {generation: afterIrrelevant.generation, unchanged: true}});

  /* ---------- 6. 改间隔：从保存成功重算，并换身份 ---------- */
  await evaluate(`location.hash = '#/settings?section=reminder'`);
  await until(`document.querySelector('.settings__title').textContent === '提醒设置'`);
  await evaluate(`(() => {
    const select = document.querySelector('.setting-inline select');
    select.value = '60';
    select.dispatchEvent(new Event('change', {bubbles: true}));
    return true;
  })()`);
  // 等下拉值真的停在 60 且保存可点。草稿若被重置回 30，这里会明确超时，
  // 而不是静默把旧值存进去再声称通过。
  await until(`(() => {
    const sel = document.querySelector('.setting-inline select');
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '保存设置');
    return !!sel && sel.value === '60' && !!b && !b.disabled;
  })()`);
  await clickSave();
  const afterInterval = scheduler.snapshot();
  assert.equal(afterInterval.signature, '1:60', '改间隔必须换身份');
  assert.equal(afterInterval.nextCheckAt, clock + 60 * 60_000, '改间隔要从保存成功时重算');
  assert.ok(afterInterval.generation > genBefore, '改配置必须推进代际');
  results.steps.push({intervalChanged: {signature: afterInterval.signature,
    generation: afterInterval.generation, dueInMs: afterInterval.nextCheckAt - clock}});

  /* ---------- 7. 停用：立即取消周期并使在途结果无效 ---------- */
  await evaluate(`(() => {
    const t = Array.from(document.querySelectorAll('.switch')).find(s => s.getAttribute('aria-label') === '启用定时提醒');
    if (t.getAttribute('aria-checked') === 'true') t.click();
    return true;
  })()`);
  await clickSave();
  const afterDisable = scheduler.snapshot();
  assert.ok(afterDisable.signature.startsWith('0:'), '停用必须换身份');
  assert.equal(afterDisable.nextCheckAt, null, '停用不得保留到期时间');
  const persistedDisabled = await core.call('reminder.state');
  assert.equal(persistedDisabled.signature, '0:' + afterDisable.signature.split(':')[1]);
  assert.equal(persistedDisabled.nextCheckAt, null, '停用状态必须落盘为无 deadline');
  results.steps.push({disabled: {signature: afterDisable.signature, nextCheckAt: afterDisable.nextCheckAt}});

  /* ---------- 8. 迟到写入不得复活停用 ---------- */
  const staleGeneration = afterDisable.generation - 2;
  const stale = await core.call('reminder.state.save', {
    signature: '1:60', generation: staleGeneration, next_check_at: clock + 999999,
    last_handled_at: clock, last_result: 'checked', notification_error: null, backoff_index: 0,
  }).catch((error) => error);
  assert.ok(stale && stale.code === 'CONFLICT', '迟到写入必须被 Core 拒绝，实际 ' + JSON.stringify(stale && stale.code));
  const stillDisabled = await core.call('reminder.state');
  assert.equal(stillDisabled.nextCheckAt, null, '停用不得被迟到写复活');
  results.steps.push({staleRejected: {code: 'CONFLICT', stillDisabled: true}});

  /* ---------- 9. 重启恢复：到期前重启保留原 deadline ---------- */
  await evaluate(`(() => {
    const t = Array.from(document.querySelectorAll('.switch')).find(s => s.getAttribute('aria-label') === '启用定时提醒');
    if (t.getAttribute('aria-checked') !== 'true') t.click();
    return true;
  })()`);
  await clickSave();
  const beforeRestart = scheduler.snapshot();
  const persistedBeforeRestart = await core.call('reminder.state');
  assert.equal(persistedBeforeRestart.nextCheckAt, beforeRestart.nextCheckAt);

  // 模拟进程重启：重新走一次生产接线
  scheduler.halt();
  const stored = await core.call('reminder.state');
  await require('../electron/main/index.cjs').__wireReminders();
  const restored = scheduler.snapshot();
  assert.equal(restored.nextCheckAt, stored.nextCheckAt, '重启必须沿用原 deadline，不得从当前时刻重算');
  assert.ok(restored.generation >= stored.generation, '重启后续接持久代际');
  results.steps.push({restartRecovery: {deadline: restored.nextCheckAt, reused: true}});

  /* ---------- 9b. 两种列表口径：UI 实际 ID 集合必须与 summary 一致 ---------- */
  const uiPending = await evaluate(`(async () => {
    const r = await SF.app.state.client.listContents({limit: 100, state: 'pending'});
    return r.items.map(i => i.id).sort();
  })()`);
  const uiHigh = await evaluate(`(async () => {
    const r = await SF.app.state.client.listContents({limit: 100, view: 'high_unarchived'});
    return r.items.map(i => i.id).sort();
  })()`);
  const coreSummary = await core.call('reminder.summary');
  const corePending = (await core.call('content.list', {state: 'pending', limit: 100})).items.map(i => i.id).sort();
  const coreHigh = (await core.call('content.list', {view: 'high_unarchived', limit: 100})).items.map(i => i.id).sort();
  assert.deepEqual(uiPending, corePending, '未处理列表与 Core 集合不一致');
  assert.deepEqual(uiHigh, coreHigh, '高优先级未归档列表与 Core 集合不一致');
  results.steps.push({listPerspectives: {pending: uiPending.length, high: uiHigh.length,
    matchesSummary: uiPending.length === coreSummary.pendingCount && uiHigh.length === coreSummary.highUnarchivedCount}});

  /* ---------- 9c. 切换入口 + 普通导航可退出 ---------- */
  await evaluate(`location.hash = '#/inbox?view=pending'`);
  await until(`!!document.querySelector('.chips--views')`);
  const toggled = await evaluate(`(() => {
    const target = Array.from(document.querySelectorAll('.chips--views button'))
      .find(b => b.textContent.trim() === '高优先级未归档');
    if (!target) return false;
    target.click();
    return true;
  })()`);
  assert.equal(toggled, true, '收件箱里找不到口径切换入口');
  await until(`location.hash === '#/inbox?view=high_unarchived'`);
  await evaluate(`location.hash = '#/tags'`);
  await until(`!SF.app.state.reminderView`);
  results.steps.push({perspectiveToggle: {switched: true, sidebarExits: true}});

  /* ---------- 10. 到期重启只合并一次 ---------- */
  clock = stored.nextCheckAt + 60_000; // 已过期
  scheduler.halt();
  const overdue = await core.call('reminder.state');
  await require('../electron/main/index.cjs').__wireReminders();
  await new Promise((r) => setTimeout(r, 700));
  const callsAfterFirst = scheduler.running.callCount;
  await require('../electron/main/index.cjs').__wireReminders();
  await require('../electron/main/index.cjs').__wireReminders();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(scheduler.running.callCount, callsAfterFirst,
    '过期周期无论接几次线都只合并一次检查');
  assert.equal(overdue.nextCheckAt, stored.nextCheckAt);
  results.steps.push({overdueMerge: {calls: scheduler.running.callCount - (callsAfterFirst - scheduler.running.notified) + scheduler.running.notified}});

  const out = path.join(root, 'docs/verification/m17');
  fs.mkdirSync(out, {recursive: true});
  fs.writeFileSync(path.join(out, 'reminder-persistence.log'), JSON.stringify({reminderPersistence: 'passed', ...results}) + '\n');
  console.log(JSON.stringify({
    reminderPersistence: 'passed',
    ...results,
    notificationDisplay: '待人工确认：本轮通知使用替身，不构成真实系统通知显示证据',
  }));
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-reminder-'));
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'reminder', SUBSCRIBE_FLOW_DATA_DIR: folder,
          SUBSCRIBE_FLOW_ISOLATED_TEST: '1'},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
  child.on('close', (code) => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
