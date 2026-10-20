'use strict';
/**
 * M17 提醒通知的投递状态机（BUG-079）。
 *
 * `show()` 返回只代表「已提交给系统」，不代表真的显示。这里区分五态：
 *   submitted  已提交，等待系统回报
 *   shown      系统确认显示
 *   failed     系统明确拒绝或提交失败
 *   unsupported 系统不支持通知
 *   unknown    期限内既没有显示也没有失败——如实标未知，不冒充成功
 *
 * 复用一条汇总通知：更新同一条而不是不断新建，避免通知中心堆积。
 * 点击时使用**当前**提醒目标，不使用首次创建时的快照；旧通知的 close/failed
 * 事件不得清除或污染新通知。
 */
const DEFAULT_SETTLE_MS = 5000;
const {DEFAULT_PRIORITY_NAMES} = require('./priority-labels.cjs');

class ReminderNotification {
  /**
   * @param {object} deps
   * @param {Function} deps.NotificationCtor 注入 Notification 构造器（测试用替身）
   * @param {number} [deps.settleMs]
   * @param {Function} [deps.priorityLabel] 返回高优先级显示名（用户改名后文案跟着改）
   */
  constructor({NotificationCtor, ctorProvider, settleMs = DEFAULT_SETTLE_MS, setTimer, clearTimer, now, priorityLabel}) {
    this.Notification = NotificationCtor;
    // ctorProvider 让构造器延迟解析：隔离测试可在应用启动之后再替换 OS 边界，
    // 在启动时捕获的话，后注入的替身根本不会被用到。
    this.ctorProvider = ctorProvider || (() => NotificationCtor);
    this.settleMs = settleMs;
    this.setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = clearTimer || ((handle) => clearTimeout(handle));
    this.now = now || (() => Date.now());
    // 显示名可注入；统计口径不变，改名只影响文案。
    this.priorityLabel = typeof priorityLabel === 'function' ? priorityLabel : () => DEFAULT_PRIORITY_NAMES.high;
    /** 当前汇总通知与其目标（点击要用当前值，不是创建时的快照）。 */
    this.current = null;
    this.lastResult = {status: 'idle'};
    this.sequence = 0;
  }

  supported() {
    try {
      return !!this.ctorProvider().isSupported();
    } catch {
      return false;
    }
  }

  cancel() {
    this.discard();
    this.lastResult = {status: 'cleared'};
    return {status: 'cleared'};
  }

  /** 发送或更新汇总通知，返回投递结果；不抛错。 */
  post({pendingCount, highUnarchivedCount}) {
    const Ctor = this.ctorProvider();
    if (!Ctor.isSupported()) {
      this.lastResult = {status: 'unsupported'};
      return {status: 'unsupported'};
    }
    const body = this.format({pendingCount, highUnarchivedCount});
    // 目标随每次更新刷新：点击必须打开当前该看的口径。
    const target = pendingCount ? 'pending' : 'high_unarchived';
    if (this.current) {
      // 复用同一条：更新目标与正文，并**重置回执期限与身份**，
      // 否则上一轮的 shown/failed 可能落在新一轮正文上。
      const entry = this.current;
      entry.target = target;
      entry.body = body;
      entry.generation = ++this.sequence;
      if (entry.timer) this.clearTimer(entry.timer);
      this.armReceipt(entry);
      try {
        entry.handle.body = body;
        entry.handle.show();
        this.lastResult = {status: 'submitted'};
        return {status: 'submitted', reused: true};
      } catch (error) {
        this.discard();
        this.lastResult = {status: 'failed', error: String(error.message || error)};
        return {...this.lastResult};
      }
    }
    let handle;
    try {
      handle = new Ctor({title: '知流', body});
    } catch (error) {
      this.lastResult = {status: 'failed', error: String(error.message || error)};
      return {...this.lastResult};
    }
    const entry = {handle, target, body};
    this.current = entry;
    entry.generation = ++this.sequence;
    this.armReceipt(entry);

    handle.on?.('show', () => {
      if (this.sequence !== entry.generation || this.current !== entry) return;
      this.clearTimer(entry.timer);
      this.lastResult = {status: 'shown', body: entry.body};
    });
    handle.on?.('failed', (_event, reason) => {
      if (this.sequence !== entry.generation || this.current !== entry) return;
      this.clearTimer(entry.timer);
      this.lastResult = {status: 'failed', reason: String(reason || ''), body: entry.body};
    });
    handle.on?.('close', () => {
      // 旧通知的 close 不得清掉已经换上的新通知。
      if (this.current === entry) this.current = null;
    });
    handle.on?.('click', () => {
      // 读当前 entry 的 target：事件处理器闭包里不要捕获首次快照。
      const active = this.current === entry ? entry.target : target;
      if (typeof this.onClick === 'function') this.onClick(active);
    });
    try {
      handle.show();
    } catch (error) {
      this.lastResult = {status: 'failed', error: String(error.message || error), body};
      return {...this.lastResult};
    }
    this.lastResult = {status: 'submitted', body};
    return {status: 'submitted'};
  }

  /** 为一轮投递建立回执期限；到期仍无系统回报即如实标未知。 */
  armReceipt(entry) {
    if (entry.timer) this.clearTimer(entry.timer);
    const generation = entry.generation;
    entry.timer = this.setTimer(() => {
      if (this.sequence !== generation || this.current !== entry) return;
      this.lastResult = {status: 'unknown', body: entry.body};
    }, this.settleMs);
    if (entry.timer && entry.timer.unref) entry.timer.unref();
  }

  discard() {
    if (this.current) {
      const entry = this.current;
      this.current = null;
      this.sequence += 1;
      if (entry.timer) this.clearTimer(entry.timer);
      try {
        entry.handle.close();
      } catch {
        /* ignore */
      }
    }
  }

  format({pendingCount, highUnarchivedCount}) {
    const parts = [];
    if (pendingCount) parts.push(`${pendingCount} 条内容未处理`);
    if (highUnarchivedCount) parts.push(`${highUnarchivedCount} 条${this.priorityLabel()}内容尚未归档`);
    if (!parts.length) return '';
    return `你有 ${parts.join('；')}。`;
  }
}

module.exports = {ReminderNotification};