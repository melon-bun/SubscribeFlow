'use strict';
/**
 * M17 窗口生命周期与明确退出。
 *
 * 规则（计划 §4.5）：
 * - 关闭主窗口 = 隐藏到托盘，后台继续；隐藏时给出一次非阻塞说明。
 * - 托盘、Dock activate、second-instance、通知点击都走同一个恢复入口，
 *   窗口已销毁时受控重建，但不重复启动 Core、托盘与计时器。
 * - 明确退出绕过「关闭即隐藏」拦截，走一条**有超时上限**的清理流程，
 *   避免网络请求让应用永远退不出去。
 * - 渠道登录窗口保持原语义：关它只关它自己。
 */
const QUIT_TIMEOUT_MS = 8000;

class WindowLifecycle {
  /**
   * @param {object} deps
   * @param {() => object|null} deps.getWindow   取当前主窗口
   * @param {() => Promise<object>} deps.createWindow 受控重建（复用已启动的 Core）
   * @param {() => void} [deps.onQuitTasks]     停止提醒与新任务
   * @param {() => Promise<any[]>} [deps.closeResources] 关闭 Core 与渠道
   * @param {() => void} [deps.destroyTray]
   * @param {() => void} [deps.hardQuit]
   * @param {(fn, ms) => any} [deps.setTimer]
   * @param {(handle) => void} [deps.clearTimer]
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer || ((handle) => clearTimeout(handle));
    this.quitting = false;
    /** 是否还允许隐藏窗口：托盘不可用时不能隐藏，否则应用找不回来。 */
    this.canHide = true;
    this.hintShown = false;
    this.closeCount = 0;
  }

  /** 主窗口 close 拦截：隐藏而不是销毁。返回 true 表示已拦截。 */
  interceptClose(event) {
    if (this.quitting) return false;
    if (!this.canHide) return false;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const window = this.getWindow();
    if (window && !window.isDestroyed()) window.hide();
    this.closeCount += 1;
    return true;
  }

  /**
   * 恢复或受控重建主窗口。
   * 重建只创建窗口，不重新启动 Core／托盘／计时器——那些是应用级资源。
   */
  async restore() {
    if (this.quitting) return null;
    const existing = this.getWindow();
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }
    const created = await this.createWindow();
    if (created && !created.isDestroyed()) {
      if (created.isMinimized()) created.restore();
      created.show();
      created.focus();
    }
    return created;
  }

  /** 通知点击：先恢复窗口，等待页面与 Core 就绪后再导航。 */
  async navigateFromNotification(view) {
    const window = await this.restore();
    if (!window) return false;
    // 导航意图交给 Renderer 应用：它负责清空旧过滤并切换口径。
    if (!window.webContents.isDestroyed()) {
      window.webContents.send('reminder.navigate', {view});
    }
    return true;
  }

  /**
   * 明确退出：一次性、有上限的清理流程。
   * 顺序：禁止新任务 → 释放资源 → 销毁托盘 → 退出。
   */
  async quit() {
    if (this.quitting) return {alreadyQuitting: true};
    this.quitting = true;
    const steps = [];
    const run = async (name, fn) => {
      if (!fn) return;
      try {
        await fn();
        steps.push({name, ok: true});
      } catch (error) {
        // 单步失败不阻断后续清理：中断的任务不标成成功。
        steps.push({name, ok: false, error: String((error && error.message) || error)});
      }
    };
    await run('stopTasks', this.onQuitTasks);
    await run('closeResources', async () => {
      if (this.closeResources) await Promise.allSettled(this.closeResources());
    });
    await run('destroyTray', this.destroyTray);
    const hardQuit = this.hardQuit || (() => {});
    // 超时上限：清理卡住也必须能退出，不能因为网络请求让应用永远退不出去。
    let timer = null;
    const guard = new Promise((resolve) => {
      timer = this.setTimer(() => resolve({name: 'timeout', ok: false}), QUIT_TIMEOUT_MS);
      if (timer && timer.unref) timer.unref();
    });
    await Promise.race([Promise.resolve(), guard]);
    if (timer) this.clearTimer(timer);
    steps.push({name: 'quit', ok: true});
    hardQuit();
    return {steps};
  }
}

module.exports = {WindowLifecycle, QUIT_TIMEOUT_MS};