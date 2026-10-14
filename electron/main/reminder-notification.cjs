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

class ReminderNotification {
  /**
   * @param {object} deps
   * @param {Function} deps.NotificationCtor 注入 Notification 构造器（测试用替身）
   * @param {number} [deps.settleMs]
   */
  constructor({NotificationCtor, settleMs = DEFAULT_SETTLE_MS, setTimer, clearTimer, now}) {
    this.Notification = NotificationCtor;
    this.settleMs = settleMs;
    this.setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = clearTimer || ((handle) => clearTimeout(handle));
    this.now = now || (() => Date.now());
    /** 当前汇总通知与其目标（点击要用当前值，不是创建时的快照）。 */
    this.current = null;
    this.lastResult = {status: 'idle'};
    this.sequence = 0;
  }

  supported() {
    try {
      return !!this.Notification.isSupported();
    } catch {
      return false;
    }
  }

  cancel() {
    if (this.current) {
      const {handle} = this.current;
      this.current = null;
      this.sequence += 1;
      if (handle) this.clearTimer(handle);
      try {
        handle && handle.close();
      } catch {
        /* 已经失效的句柄不需要再关 */
      }
    }
    this.lastResult = {status: 'cleared'};
    return {status: 'cleared'};
  }

  /** 发送或更新汇总通知，返回投递结果；不抛错。 */
  post({pendingCount, highUnarchivedCount}) {
    if (!this.supported()) {
      this.lastResult = {status: 'unsupported'};
      return {status: 'unsupported'};
    }
    const body = this.format({pendingCount, highUnarchivedCount});
    // 目标随每次更新刷新：点击必须打开当前该看的口径。
    const target = pendingCount ? 'pending' : 'high_unarchived';
    if (this.current) {
      this.current.target = target;
      try {
        this.current.handle.body = body;
        this.current.handle.show();
        this.lastResult = {status: 'submitted'};
        return {status: 'submitted', reused: true};
      } catch (error) {
        // 更新失败就换一条新的，别让这条卡在旧内容上。
        this.discard();
      }
    }
    let handle;
    try {
      handle = new this.Notification({title: '知流', body});
    } catch (error) {
      this.lastResult = {status: 'failed', error: String(error.message || error)};
      return {...this.lastResult};
    }
    const entry = {handle, target, body};
    this.current = entry;
    const generation = ++this.sequence;
    const settle = () => {
      if (this.sequence !== generation || this.current !== entry) return;
      this.clearTimer(entry.timer);
      // 到期仍无系统回报：如实标未知，不写成显示成功。
      this.lastResult = {status: 'unknown', body};
    };
    entry.timer = this.setTimer(settle, this.settleMs);
    if (entry.timer && entry.timer.unref) entry.timer.unref();

    handle.on?.('show', () => {
      if (this.sequence !== generation || this.current !== entry) return;
      this.clearTimer(entry.timer);
      this.lastResult = {status: 'shown', body};
    });
    handle.on?.('failed', (_event, reason) => {
      if (this.sequence !== generation || this.current !== entry) return;
      this.clearTimer(entry.timer);
      this.lastResult = {status: 'failed', reason: String(reason || ''), body};
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
    if (highUnarchivedCount) parts.push(`${highUnarchivedCount} 条高优先级内容尚未归档`);
    if (!parts.length) return '';
    return `你有 ${parts.join('；')}。`;
  }
}

module.exports = {ReminderNotification};