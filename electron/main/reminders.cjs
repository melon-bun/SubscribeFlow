'use strict';
/**
 * M17 提醒调度器。
 *
 * 计时在 Main，Renderer 隐藏／重载／崩溃都不影响（计划 §4.2）。这里做四件
 * 不能含糊的事：
 *
 * 1. 从保存成功那一刻重新计时。改设置时只有提醒分区会重置周期——保存
 *    与提醒无关的 AI 配置不该把间隔也推倒重来。
 * 2. 配置版本用来作废在途结果。旧版本发起的查询与通知回来时必须丢弃，
 *    否则会出现「用户已经改短了间隔，却收到按旧间隔算的提醒」。
 * 3. 查询失败退避，不用旧计数凑一条提醒。拿不到最新数字就不发。
 * 4. 重启／休眠后最多合并一次过期提醒，不补发每个错过的周期。
 *
 * 依赖全部注入（时钟、摘要查询、通知），因此可以确定性测试，不依赖真实
 * 通知或真实等待。
 */
const DEFAULT_BACKOFF_MS = [30_000, 120_000, 600_000];
const MAX_BACKOFF_INDEX = DEFAULT_BACKOFF_MS.length - 1;

/** 提醒配置版本 + 运行状态一起校验：进程重启后从持久状态恢复。 */
function reminderSignature(settings) {
  if (!settings || !settings.reminder) return null;
  const {enabled, intervalMinutes} = settings.reminder;
  return `${enabled ? '1' : '0'}:${Number(intervalMinutes) || 0}`;
}

class ReminderScheduler {
  /**
   * @param {object} deps
   * @param {() => number} deps.now          毫秒时钟，注入以便测试
   * @param {() => Promise<object>} deps.summary  读取 Core 统计
   * @param {(summary, context) => Promise<object>} deps.notify  发送／更新通知
   * @param {(state) => void} [deps.persist]  持久化运行状态
   */
  constructor({now, summary, notify, persist}) {
    this.now = now;
    this.summary = summary;
    this.notify = notify;
    this.persist = persist || (() => {});
    this.timer = null;
    this.signature = null;
    this.state = {nextCheckAt: null, lastHandledAt: null, lastResult: null, backoffIndex: 0};
    this.inFlight = false;
    this.stopped = false;
    /** 最近一次已通知的摘要，用来维护单条汇总通知的生命周期。 */
    this.lastNotified = null;
    this.running = {callCount: 0, notified: 0, failures: 0};
  }

  /**
   * 设置变化时调用。只有提醒自身的配置变了才重新计时。
   * @returns {boolean} 是否真的重置了周期
   */
  applySettings(settings) {
    const signature = reminderSignature(settings);
    if (signature === this.signature) return false;
    this.signature = signature;
    // 只清掉待触发任务，不能连带把调度器标成已停用：设置变更是常态。
    this.clearTimer();
    if (!signature || settings.reminder.enabled === false) {
      // 停用立即清理待触发任务，不等下一个周期。
      this.state = {nextCheckAt: null, lastHandledAt: null, lastResult: 'disabled', backoffIndex: 0};
      this.lastNotified = null;
      this.persist({...this.state});
      return true;
    }
    // 从「现在」重算，而不是沿用旧的到期时间。
    this.state.backoffIndex = 0;
    this.state.nextCheckAt = this.now() + settings.reminder.intervalMinutes * 60_000;
    this.persist({...this.state});
    this.arm();
    return true;
  }

  /** 进程重启／窗口重建后用持久状态恢复，不重复建计时器。 */
  restore(persisted) {
    if (persisted && typeof persisted.nextCheckAt === 'number') this.state = {...this.state, ...persisted};
    if (!this.signature) return;
    const [, interval] = this.signature.split(':');
    if (interval === '0') return;
    // 已经过期的周期只合并成一次，不补发。
    const overdue = this.state.nextCheckAt !== null && this.state.nextCheckAt <= this.now();
    this.arm(overdue ? 0 : Math.max(0, this.state.nextCheckAt - this.now()));
    if (overdue) void this.run({reason: 'overdue'});
  }

  arm(delayMs) {
    this.clearTimer();
    if (this.stopped) return;
    const delay = Math.max(0, delayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run({reason: 'scheduled'});
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 停止待触发的任务，但调度器仍可被再次启用。 */
  stop() {
    this.clearTimer();
  }

  /** 明确退出：不再接受任何检查。 */
  halt() {
    this.stopped = true;
    this.clearTimer();
  }

  /** 同一时刻只有一个检查在执行。 */
  async run({reason = 'manual'} = {}) {
    if (this.inFlight || this.stopped || !this.signature || this.signature.startsWith('0')) return null;
    this.inFlight = true;
    this.running.callCount += 1;
    const expected = this.signature;
    const intervalMinutes = Number(expected.split(':')[1]);
    try {
      const summary = await this.summary();
      if (this.stopped || this.signature !== expected) return {skipped: 'settings_changed'};
      if (!summary || typeof summary.pendingCount !== 'number' || typeof summary.highUnarchivedCount !== 'number') {
        throw new Error('统计结果缺少必需字段');
      }
      this.state.backoffIndex = 0;
      const result = await this.dispatch(summary, intervalMinutes);
      // 成功即推进周期：即使通知发不出去，提醒也照常按间隔运行。
      this.state.lastHandledAt = this.now();
      this.state.nextCheckAt = this.now() + intervalMinutes * 60_000;
      this.state.lastResult = result;
      this.persist({...this.state});
      this.arm(intervalMinutes * 60_000);
      return result;
    } catch (error) {
      // 查询失败：有限退避，且绝不用旧计数伪造一条提醒。
      this.running.failures += 1;
      this.state.lastResult = 'query_failed';
      // 先按当前档位取延迟再递增：第一次失败就是最短的一档。
      const delay = DEFAULT_BACKOFF_MS[Math.min(this.state.backoffIndex, MAX_BACKOFF_INDEX)];
      this.state.backoffIndex = Math.min(this.state.backoffIndex + 1, MAX_BACKOFF_INDEX);
      this.state.nextCheckAt = this.now() + delay;
      this.persist({...this.state});
      this.arm(delay);
      return {error: String((error && error.message) || error)};
    } finally {
      this.inFlight = false;
    }
  }

  async dispatch(summary, intervalMinutes) {
    const pending = summary.pendingCount | 0;
    const high = summary.highUnarchivedCount | 0;
    if (pending === 0 && high === 0) {
      // 全零不通知，并关闭上一次的汇总通知。
      const outcome = await this.notify(summary, {kind: 'clear'});
      this.lastNotified = null;
      return {notified: false, reason: 'all_zero', notification: outcome};
    }
    // 数量没变也照常提醒：这是「有多少没处理」的周期提示，不是变化通知。
    const outcome = await this.notify(summary, {kind: 'summary', intervalMinutes});
    this.lastNotified = summary;
    this.running.notified += 1;
    return {notified: true, pending, high, notification: outcome};
  }

  /** 明确退出时走这里：不留下待触发的任务。 */
  shutdown() {
    this.halt();
    this.inFlight = false;
    this.state = {...this.state, nextCheckAt: null, lastResult: 'shutdown'};
    this.persist({...this.state});
  }

  snapshot() {
    return {...this.state, signature: this.signature, inFlight: this.inFlight};
  }
}

module.exports = {ReminderScheduler, reminderSignature};