'use strict';
/**
 * M17 窗口生命周期与明确退出。
 *
 * 规则（计划 §4.5）：
 * - 关闭主窗口 = 隐藏到托盘；隐藏第一次给一次非阻塞说明，不反复确认。
 * - 托盘、Dock activate、second-instance、通知点击共用同一恢复入口；
 *   窗口已销毁才受控重建，并发恢复只创建一个窗口，退出期间不再新建。
 * - 明确退出走**有总期限**的清理流程：期限从退出开始计时，包含永远不会
 *   完成的清理；到期强制收尾并如实记录。单步失败不阻断其余清理。
 *
 * 这里是应用级对象，由 index.cjs 在模块作用域持有，不放在 start() 局部。
 */
const QUIT_TIMEOUT_MS = 8000;

class WindowLifecycle {
  /**
   * @param {object} deps
   * @param {() => object|null} deps.getWindow
   * @param {() => Promise<object>} deps.createWindow 真实窗口工厂
   * @param {(intent) => Promise<boolean>} [deps.deliver] 下发导航意图（已 ready 时）
   * @param {() => void} [deps.onQuitTasks] 停止提醒与新任务
   * @param {() => Promise<any[]>} [deps.closeResources]
   * @param {() => void} [deps.destroyTray]
   * @param {() => void} [deps.hardQuit]
   * @param {(fn, ms) => any} [deps.setTimer]
   * @param {(handle) => void} [deps.clearTimer]
   * @param {() => number} [deps.now]
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer || ((handle) => clearTimeout(handle));
    this.now = deps.now || (() => Date.now());
    this.quitting = false;
    /** 托盘不可用时不能隐藏窗口：否则应用变成用户找不回来的后台进程。 */
    this.canHide = true;
    this.hintShown = false;
    this.closeCount = 0;
    /** 窗口创建的串行化：并发 restore 只会有一个真正建窗。 */
    this.pendingWindow = null;
  }

  /** 关闭主窗口：拦截并隐藏。返回 true 表示已拦截。 */
  interceptClose(event) {
    if (this.quitting || !this.canHide) return false;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const window = this.getWindow();
    if (window && !window.isDestroyed()) window.hide();
    this.closeCount += 1;
    return true;
  }

  /**
   * 恢复或受控重建主窗口；并发调用合并成一次建窗。
   *
   * 工厂同步抛错时 async 函数返回的是**已拒绝的 Promise**，外层赋值会把它存进
   * pendingWindow；此时 finally 已经清过空值，赋值发生在之后，于是这个已拒绝的
   * Promise 被留在槽里，之后的 restore 只会重复抛出同一个错误、再也不调用工厂。
   * 这里在赋值前就把 rejected 情况清掉，保证失败后可以重试。
   */
  restore() {
    if (this.quitting) return Promise.resolve(null);
    const existing = this.getWindow();
    if (existing && !existing.isDestroyed()) return Promise.resolve(this.focus(existing));
    if (this.pendingWindow) return this.pendingWindow;
    let created = null;
    const task = (async () => {
      created = await this.createWindow();
      if (this.quitting) {
        // 退出期间不再创建窗口：关掉刚建的那个。
        if (created && !created.isDestroyed()) created.destroy();
        return null;
      }
      return created && !created.isDestroyed() ? this.focus(created) : created;
    })();
    this.pendingWindow = task;
    // 无论同步抛错还是异步拒绝，都不能把已拒绝的 Promise 留在槽里。
    const clear = () => {
      if (this.pendingWindow === task) this.pendingWindow = null;
    };
    task.then(clear, clear);
    return task;
  }

  focus(window) {
    if (!window || window.isDestroyed()) return window;
    if (typeof window.isMinimized === 'function' && window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }

  /**
   * 通知／托盘点击：先恢复窗口，再下发导航意图。
   * 意图由 deliver 负责等待 Renderer 与 Core 就绪，本方法不吞失败。
   */
  async navigate(intent) {
    const window = await this.restore();
    if (!window) return {delivered: false, reason: 'window_unavailable'};
    if (!this.deliver) return {delivered: false, reason: 'no_bridge'};
    const delivered = await this.deliver(intent, window);
    return {delivered: !!delivered, window};
  }

  /**
   * 明确退出：唯一入口，幂等，总期限从此刻开始计时。
   */
  async quit() {
    if (this.quitting) return {alreadyQuitting: true};
    this.quitting = true;
    const startedAt = this.now();
    const steps = [];

    // 期限先建立：即使清理永远不返回，也到点强制收尾（BUG-078）。
    let deadlineTimer = null;
    const expired = new Promise((resolve) => {
      deadlineTimer = this.setTimer(() => resolve('timeout'), QUIT_TIMEOUT_MS);
      if (deadlineTimer && deadlineTimer.unref) deadlineTimer.unref();
    });
    const budget = {limitMs: QUIT_TIMEOUT_MS};

    const runStep = async (name, fn) => {
      if (!fn) return;
      try {
        await Promise.race([
          Promise.resolve().then(() => fn()),
          expired.then(() => {
            const error = new Error(`清理步骤「${name}」超过总期限，未完成`);
            error.timedOut = true;
            throw error;
          }),
        ]);
        steps.push({name, ok: true});
      } catch (error) {
        // 中断的步骤不标成成功；失败也不阻断其余清理。
        steps.push({name, ok: false, timedOut: !!error.timedOut, error: String(error.message || error)});
      }
    };

    await runStep('stopTasks', this.onQuitTasks);
    await runStep('closeResources', async () => {
      if (!this.closeResources) return;
      // 单项失败也要落到 steps，不能被 allSettled 悄悄吞掉。
      const results = await Promise.allSettled(this.closeResources());
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          steps.push({name: `closeResource[${index}]`, ok: false, error: String(result.reason)});
        }
      });
    });
    await runStep('destroyTray', this.destroyTray);
    if (deadlineTimer) this.clearTimer(deadlineTimer);
    const elapsed = this.now() - startedAt;
    const timedOut = steps.some((step) => step.timedOut);
    steps.push({name: 'quit', ok: true, elapsedMs: elapsed, timedOut});
    (this.hardQuit || (() => {}))();
    return {steps, budget, elapsedMs: elapsed, timedOut};
  }
}

module.exports = {WindowLifecycle, QUIT_TIMEOUT_MS};