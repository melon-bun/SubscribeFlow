'use strict';
/**
 * M17 托盘常驻。
 *
 * 托盘对象是应用级的，不挂在主窗口上：主窗口销毁重建不会带走它。菜单里的
 * 两个数字来自 Core 的同一份 reminder.summary，Core 暂不可用时显示「数据暂不可用」
 * 而不是伪造的 0（计划 §4.4）。
 *
 * 构造失败时不隐藏主窗口：那会把应用变成一个用户找不回来的后台进程。
 */
const {Tray, Menu, nativeImage} = require('electron');

function unavailableCounts() {
  return {pending: null, high: null, available: false};
}

function formatPending(count, available) {
  if (!available || count === null || count === undefined) return '待处理：数据暂不可用';
  return `待处理 ${count} 条`;
}

function formatHigh(count, available) {
  if (!available || count === null || count === undefined) return '高优先级未归档：数据暂不可用';
  return `高优先级未归档 ${count} 条`;
}

class TrayController {
  /**
   * @param {object} deps
   * @param {() => Promise<object>} deps.summary 读取 Core 统计
   * @param {() => void} deps.showWindow        恢复主窗口
   * @param {(view) => void} deps.openList      打开统一列表
   * @param {() => void} deps.openSettings      打开设置
   * @param {() => void} deps.quit              明确退出
   * @param {string} deps.iconPath              按平台适配的图标
   * @param {() => object} [deps.now]           注入时钟，便于测试
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.tray = null;
    this.counts = unavailableCounts();
    this.refreshTimer = null;
    this.refreshInFlight = false;
    this.lastRefreshedAt = null;
  }

  /** 创建失败时抛出，由调用方决定是否降级为「不隐藏窗口」。 */
  create() {
    const image = nativeImage.createFromPath(this.iconPath);
    this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    // 应用级引用：主窗口销毁不影响它。
    this.tray.setToolTip('知流');
    this.refreshMenu();
    return this.tray;
  }

  destroy() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }

  available() {
    return !!this.tray && !this.tray.isDestroyed();
  }

  /** 统计刷新即使没有托盘也要能跑：状态本身与是否显示无关。 */
  safeRefreshMenu() {
    try {
      return this.refreshMenu();
    } catch {
      return null;
    }
  }

  /** 内容／优先级变化后合并刷新：短时间内的多次变化只跑一次统计查询。 */
  scheduleRefresh(delayMs = 250) {
    if (!this.available()) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delayMs);
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  async refresh() {
    if (!this.available() || this.refreshInFlight) return this.counts;
    this.refreshInFlight = true;
    try {
      const summary = await this.summary();
      const valid = summary && typeof summary.pendingCount === 'number'
        && typeof summary.highUnarchivedCount === 'number';
      this.counts = valid
        ? {pending: summary.pendingCount, high: summary.highUnarchivedCount, available: true}
        : unavailableCounts();
    } catch {
      // Core 暂不可用：如实标记不可用，绝不用 0 冒充。
      this.counts = unavailableCounts();
    } finally {
      this.refreshInFlight = false;
      this.lastRefreshedAt = this.now();
    }
    this.safeRefreshMenu();
    return this.counts;
  }

  refreshMenu() {
    if (!this.available()) return null;
    const {pending, high, available} = this.counts;
    const menu = Menu.buildFromTemplate([
      {label: '打开知流', click: () => this.showWindow()},
      {type: 'separator'},
      // Core 不可用时仍可点击：点了会带着真实不可用状态打开列表，而不是显示空白。
      {label: formatPending(pending, available), click: () => this.openList('pending')},
      {label: formatHigh(high, available), click: () => this.openList('high_unarchived')},
      {type: 'separator'},
      {label: '设置…', click: () => this.openSettings()},
      {label: '退出应用', click: () => this.quit()},
    ]);
    this.tray.setContextMenu(menu);
    return menu;
  }
}

module.exports = {TrayController, formatPending, formatHigh, unavailableCounts};