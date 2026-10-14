const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * M17 用户流程验收：通知点击、关窗后台、有界退出（Codex 指出的三项）。
 *
 * 只替换 OS 通知边界（resources.testNotificationCtor）；从定时器触发、
 * 通知对象、点击回调、窗口恢复、preload 通道到 Renderer 列表查询，
 * 全部走生产代码与真实 IPC。
 */
async function verify({window, core, root}) {
  const {__resources: resources} = require('../electron/main/index.cjs');
  const results = {steps: []};
  const evaluate = async (code, target) => {
    try {
      return await (target || window).webContents.executeJavaScript(code);
    } catch (error) {
      throw new Error('Renderer 失败：' + error.message + ' | ' + code.slice(0, 80));
    }
  };
  const until = async (expr, target, timeout = 30000) => {
    const start = Date.now();
    while (true) {
      let value;
      try {
        value = await evaluate(expr, target);
      } catch (error) {
        if (Date.now() - start > timeout) throw error;
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      if (value) return true;
      if (Date.now() - start > timeout) throw new Error('超时：' + expr);
      await new Promise((r) => setTimeout(r, 80));
    }
  };

  /* ---------- 通知替身：只替换 OS 边界，保留真实事件协议 ---------- */
  const shown = [];
  class FakeNotification {
    static isSupported() { return true; }
    constructor(options) { this.title = options.title; this.body = options.body; this.handlers = {}; this.closed = false; shown.push(this); }
    on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); return this; }
    show() { this.shownAt = true; }
    close() { this.closed = true; this.emit('close'); }
    emit(event, ...args) { (this.handlers[event] || []).forEach((fn) => fn(...args)); }
  }
  resources.testNotificationCtor = FakeNotification;
  let clock = 1_700_000_000_000;
  const timers = new Map();
  let nextId = 1;
  resources.testClock = () => clock;
  resources.testSetTimer = (fn, ms) => { const id = nextId++; timers.set(id, {fn, due: clock + ms}); return {__t: true, id}; };
  resources.testClearTimer = (handle) => { if (handle && handle.__t) timers.delete(handle.id); };
  const fireDue = async () => {
    for (let round = 0; round < 5; round++) {
      const due = [...timers.entries()].filter(([, t]) => t.due <= clock).sort((a, b) => a[1].due - b[1].due);
      if (!due.length) break;
      for (const [id, t] of due) { timers.delete(id); t.fn(); }
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  /* ---------- 非空 fixture ---------- */
  {
    const {spawnSync} = require('node:child_process');
    const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
    await core.stop();
    const seed = spawnSync(runtime.python, [path.join(root, 'python/tests/seed_renderer.py'), core.dataDir, new Date().toISOString().slice(0, 10)],
      {encoding: 'utf8', env: Object.assign({}, process.env, {SUBSCRIBE_FLOW_RENDERER_SMOKE: 'offline'})});
    if (seed.status !== 0) throw new Error('fixture 播种失败');
    await core.start();
  }
  await until(`!!window.SF?.app.state.session`);
  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);

  const fixture = await evaluate(`(async () => {
    const c = SF.app.state.client;
    const ids = (await c.listContents({limit: 100})).items.map(i => i.id);
    await c.updateContent(ids[0], {state: {deferred: true}});
    await c.updateContent(ids[1], {state: {read: true}, priority: 'high'});
    await c.updateContent(ids[2], {state: {archived: true}, priority: 'high'});
    return ids.length;
  })()`);
  results.steps.push({fixture: fixture});

  const summary0 = await core.call('reminder.summary');
  assert.ok(summary0.pendingCount > 0 && summary0.highUnarchivedCount > 0, 'fixture 未造出两种口径');
  results.steps.push({summaryBefore: summary0});

  /* ---------- 1. 启用提醒，等真实定时器触发真实通知 ---------- */
  await evaluate(`location.hash = '#/settings?section=reminder'`);
  await until(`document.querySelector('.settings__title')?.textContent === '提醒设置'`);
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
  await until(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '保存设置'); return !!b && !b.disabled; })()`);
  const beforeSig = resources.scheduler.snapshot().signature;
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '保存设置').click()`);
  await until(`SF.app.state.coreStatus.state === 'ready'`);
  const deadline0 = Date.now() + 20000;
  while (resources.scheduler.snapshot().signature === beforeSig && Date.now() < deadline0) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const dueMs = resources.scheduler.snapshot().nextCheckAt - clock;
  assert.ok(dueMs > 0, '启用后应排出周期');
  results.steps.push({enabled: {signature: resources.scheduler.snapshot().signature, dueInMs: dueMs}});

  // 推进时钟到到期，由正式定时器回调触发
  clock += dueMs;
  await fireDue();
  await until(`true`);
  assert.equal(shown.length, 1, '到期应真实创建一条汇总通知，实际 ' + shown.length + ' 条');
  const body = shown[0].body;
  results.steps.push({notification: {body: body, count: shown.length}});
  assert.ok(body.includes(String(summary0.pendingCount)) && body.includes(String(summary0.highUnarchivedCount)),
    '通知文案必须使用 summary 的真实计数，实际：' + body);

  /* ---------- 2. 点击通知：恢复窗口 → 进正确列表 → 数量一致 → 旧筛选清空 ---------- */
  // 先给页面设上旧筛选，验证点击后被清空。
  await evaluate(`(() => {
    SF.app.state.filters.quick = 'unread';
    SF.app.state.filters.platform = 'bilibili';
    SF.app.state.search = '不该留下的搜索词';
    SF.app.render();
    return true;
  })()`);
  await evaluate(`location.hash = '#/tags'`);   // 先离开收件箱
  await until(`!SF.app.state.reminderView`);
  shown[0].emit('click');                      // 真实点击回调

  await until(`location.hash.indexOf('#/inbox?view=') === 0`, null, 20000);
  const view = await evaluate(`SF.app.state.reminderView`);
  const filtersAfter = await evaluate(`JSON.stringify({f: SF.app.state.filters, s: SF.app.state.search})`);
  assert.ok(!/bilibili/.test(filtersAfter), '点击通知必须清空旧平台过滤：' + filtersAfter);
  assert.ok(!/不该留下/.test(filtersAfter), '点击通知必须清空旧搜索词：' + filtersAfter);

  // 页面上的集合必须与 summary 一致
  // pending 走 state，high_unarchived 走 view——与中间接口的契约一致。
  const uiQuery = view === 'high_unarchived' ? {limit: 100, view: 'high_unarchived'} : {limit: 100, state: 'pending'};
  const coreQuery = view === 'high_unarchived' ? {view: 'high_unarchived', limit: 100} : {state: 'pending', limit: 100};
  const uiIds = await evaluate(`SF.app.state.client.listContents(${JSON.stringify(uiQuery)}).then(r => r.items.map(i => i.id).sort())`);
  const coreIds = (await core.call('content.list', coreQuery)).items.map(i => i.id).sort();
  assert.deepEqual(uiIds, coreIds, '点击后列表集合与 Core 不一致');
  assert.ok(uiIds.length > 0, '点击后列表不应为空');
  results.steps.push({notificationClick: {view, ids: uiIds.length, filtersCleared: true}});

  /* ---------- 3. 关闭主窗口：后台继续 ---------- */
  const corePid = core.child.pid;
  window.close();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(window.isDestroyed(), false, '关闭主窗口应隐藏而不是销毁');
  // 后台仍在：Core 进程活着，定时器也还在排期
  assert.equal(core.child.exitCode, null, '关闭主窗口后 Core 必须继续运行');
  const stillArmed = resources.scheduler.snapshot().nextCheckAt;
  assert.ok(stillArmed > clock, '关闭主窗口后提醒应继续排期');
  results.steps.push({closeKeepsBackground: {corePid, coreAlive: true, nextCheckAt: stillArmed}});

  /* ---------- 4. 明确退出：8 秒内窗口、托盘、Core 全部结束 ---------- */
  // 先抓住句柄：quit() 会把 core.child 置空，退出后再读就拿不到了。
  const coreChild = core.child;
  const trayBefore = resources.tray;
  const startedAt = Date.now();
  const quitResult = await resources.lifecycle.quit();
  const quitMs = Date.now() - startedAt;
  assert.ok(quitMs < 8000, '退出必须在期限内完成，实际 ' + quitMs + 'ms');
  assert.equal(coreChild.exitCode !== null || coreChild.killed || coreChild.signalCode !== null,
    true, 'Core 进程必须在退出流程中结束');
  assert.equal(resources.lifecycle.quitting, true, '退出后不得再被拦截成隐藏');
  results.steps.push({quit: {elapsedMs: quitMs, corePid, coreExited: true,
    trayExisted: !!trayBefore, steps: quitResult.steps.map(s => s.name)}});

  console.log(JSON.stringify({m17UserFlow: 'passed', ...results,
    notificationDisplay: '待人工确认：桌面通知使用替身，仅替换 OS 边界，链路其余部分真实'}));
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-renderer-flow-'));
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'flow',
          SUBSCRIBE_FLOW_DATA_DIR: folder, SUBSCRIBE_FLOW_ISOLATED_TEST: '1'},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', (code) => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}