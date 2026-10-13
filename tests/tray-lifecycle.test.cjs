'use strict';
/**
 * M17 托盘与窗口生命周期测试。
 *
 * Electron 的 Tray/Menu/BrowserWindow 全部注入替身：不创建真实窗口，
 * 不弹真实通知，也不碰用户会话。
 */
const test = require('node:test');
const assert = require('node:assert');
const {TrayController, formatPending, formatHigh} = require('../electron/main/tray.cjs');
const {WindowLifecycle} = require('../electron/main/lifecycle.cjs');

/** 假托盘：记录 setContextMenu 的调用，不触碰系统菜单栏。 */
function fakeTrayCtor() {
  const created = [];
  class FakeTray {
    constructor(image) {
      this.destroyed = false;
      this.menus = [];
      created.push(this);
    }
    setToolTip(value) {
      this.tooltip = value;
    }
    setContextMenu(menu) {
      this.menus.push(menu);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return {FakeTray, created};
}

function trayHarness(summary) {
  const {FakeTray, created} = fakeTrayCtor();
  const clicks = [];
  const controller = new TrayController({
    summary,
    showWindow: () => clicks.push('window'),
    openList: (view) => clicks.push(`list:${view}`),
    openSettings: () => clicks.push('settings'),
    quit: () => clicks.push('quit'),
    iconPath: '/dev/null',
    now: () => 1000,
    // TrayController 内部直接 require electron，这里通过替换构造器不可行，
    // 因此只测依赖注入后的行为：Menu/Tray 在真实 Electron 进程中才有意义。
  });
  return {controller, clicks, created, FakeTray};
}

const templateOf = (menu) => menu.template;

// 下面的用例直接针对 TrayController 的纯逻辑与菜单文案，不创建真实 Tray。

test('Core 不可用时菜单显示「数据暂不可用」，不伪造 0', () => {
  assert.equal(formatPending(0, false), '待处理：数据暂不可用');
  assert.equal(formatHigh(0, false), '高优先级未归档：数据暂不可用');
  assert.equal(formatPending(3, true), '待处理 3 条');
  assert.equal(formatHigh(1, true), '高优先级未归档 1 条');
});

test('统计读取失败后进入不可用状态，而不是显示 0', async () => {
  const controller = new TrayController({
    summary: async () => {
      throw new Error('Core 未就绪');
    },
    showWindow() {}, openList() {}, openSettings() {}, quit() {},
    iconPath: '/dev/null', now: () => 1000,
  });
  const counts = await controller.refresh();
  assert.equal(counts.available, false);
  assert.equal(counts.pending, null);
  assert.equal(counts.high, null);
  assert.equal(formatPending(counts.pending, counts.available), '待处理：数据暂不可用');
});

test('统计返回缺字段时同样标记不可用', async () => {
  const controller = new TrayController({
    summary: async () => ({pendingCount: 3}),
    showWindow() {}, openList() {}, openSettings() {}, quit() {},
    iconPath: '/dev/null', now: () => 1000,
  });
  const counts = await controller.refresh();
  assert.equal(counts.available, false);
});

test('合并刷新：短时间内的多次变化只跑一次查询', async () => {
  let queries = 0;
  const controller = new TrayController({
    summary: async () => {
      queries += 1;
      return {pendingCount: queries, highUnarchivedCount: 0};
    },
    showWindow() {}, openList() {}, openSettings() {}, quit() {},
    iconPath: '/dev/null', now: () => 1000,
  });
  // 没有 Tray 时不做任何查询：托盘不可用就不该打扰 Core。
  controller.scheduleRefresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queries, 0);
  // 托盘存在时才会真正去查。
  controller.available = () => true;
  const counts = await controller.refresh();
  assert.equal(counts.available, true);
  assert.equal(queries, 1);
  // 合并刷新：连续排期只跑一次查询。
  controller.scheduleRefresh(50);
  controller.scheduleRefresh(50);
  controller.scheduleRefresh(50);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(queries, 2, '合并窗口内的多次刷新只应再查一次');
});

// ---------------- 窗口生命周期 ----------------

function lifecycleHarness(overrides = {}) {
  const events = {shown: 0, focused: 0, minimized: 0, closed: 0};
  let window = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    isMinimized() { events.minimized += 1; return false; },
    restore() {},
    show() { events.shown += 1; },
    focus() { events.focused += 1; },
    hide() { events.hidden = (events.hidden || 0) + 1; },
    webContents: {isDestroyed: () => false, send: (channel, payload) => events.sent = {channel, payload}},
  };
  const lifecycle = new WindowLifecycle({
    getWindow: () => window,
    createWindow: async () => {
      window = {...window, destroyed: false, show() { events.shown += 1; }, focus() { events.focused += 1; }};
      events.created = (events.created || 0) + 1;
      return window;
    },
    ...overrides,
  });
  return {lifecycle, events, dropWindow: () => { window = null; }};
}

test('关闭主窗口被拦截并隐藏，不销毁', () => {
  const {lifecycle, events} = lifecycleHarness();
  let prevented = false;
  const intercepted = lifecycle.interceptClose({preventDefault: () => { prevented = true; }});
  assert.equal(intercepted, true);
  assert.equal(prevented, true);
  assert.equal(events.hidden, 1, '窗口应被隐藏');
  assert.equal(lifecycle.closeCount, 1);
});

test('托盘不可用时不隐藏窗口，避免应用无法找回', () => {
  const {lifecycle, events} = lifecycleHarness();
  lifecycle.canHide = false;
  assert.equal(lifecycle.interceptClose({preventDfault: () => {}}), false);
  assert.equal(events.hidden, undefined);
});

test('明确退出时不拦截关闭', async () => {
  const {lifecycle} = lifecycleHarness();
  await lifecycle.quit();
  assert.equal(lifecycle.quitting, true);
  assert.equal(lifecycle.interceptClose({preventDefault: () => {}}), false);
});

test('窗口仍在时恢复只聚焦不重建', async () => {
  const {lifecycle, events} = lifecycleHarness();
  await lifecycle.restore();
  assert.equal(events.shown, 1);
  assert.equal(events.focused, 1);
  assert.equal(events.created, undefined, '已有窗口时不得重建');
});

test('窗口已销毁时受控重建同一个窗口', async () => {
  const {lifecycle, events} = lifecycleHarness();
  lifecycle.getWindow = () => null;
  await lifecycle.restore();
  assert.equal(events.created, 1, '窗口不存在才重建');
  assert.equal(events.shown, 1);
});

test('通知点击先恢复窗口再下发导航意图', async () => {
  const {lifecycle, events} = lifecycleHarness();
  const ok = await lifecycle.navigateFromNotification('high_unarchived');
  assert.equal(ok, true);
  assert.equal(events.shown, 1, '必须先恢复窗口');
  assert.deepEqual(events.sent, {channel: 'reminder.navigate', payload: {view: 'high_unarchived'}});
});

test('退出清理有顺序且失败不阻断后续步骤', async () => {
  const order = [];
  const {lifecycle} = lifecycleHarness({
    onQuitTasks: async () => {
      order.push('stopTasks');
      throw new Error('任务取消失败');
    },
    closeResources: () => {
      order.push('closeResources');
      return [Promise.reject(new Error('渠道关闭失败'))];
    },
    destroyTray: () => order.push('destroyTray'),
    hardQuit: () => order.push('quit'),
  });
  const result = await lifecycle.quit();
  assert.deepEqual(order, ['stopTasks', 'closeResources', 'destroyTray', 'quit']);
  const failed = result.steps.filter((step) => step.ok === false);
  assert.ok(failed.length >= 1, '失败步骤必须被记录');
  assert.equal(failed[0].name, 'stopTasks');
});

test('重复退出不会重复执行清理', async () => {
  let quits = 0;
  const {lifecycle} = lifecycleHarness({hardQuit: () => { quits += 1; }});
  await lifecycle.quit();
  const second = await lifecycle.quit();
  assert.equal(second.alreadyQuitting, true);
  assert.equal(quits, 1);
});

test('退出后不再恢复窗口', async () => {
  const {lifecycle} = lifecycleHarness();
  await lifecycle.quit();
  assert.equal(await lifecycle.restore(), null);
});