'use strict';
/**
 * M17 提醒调度器。
 *
 * 计时在 Main，Renderer 隐藏／重载／崩溃都不影响（计划 §4.2）。
 *
 * 三条不变量，BUG-071~073 就是它们被破坏后的样子：
 *
 * 1. **到期时间必须显式算出再交给定时器。** setTimeout 收到 NaN 会按 1ms 处理，
 *    结果是「打开 60 分钟提醒，30ms 后就发通知」。所有 arm 调用都必须带真实延迟。
 * 2. **每次提醒配置变更与停止都递增单调代际（generation）。** 只用
 *    `enabled:interval` 当版本区分不了「停用后再以相同间隔启用」，而且异步
 *    边界（查询、通知、持久化）返回时若不复核代际，迟到的结果就会用旧配置
 *    改写新状态、甚至发出一条过期通知。
 * 3. **退出只释放进程内资源，不清空持久到期时间。** 下次启动仍要按原周期恢复，
 *    否则「过期最多合并一次」无从谈起。
 *
 * 时钟、定时器、统计查询、通知回调与持久层全部注入，因此可以确定性测试，
 * 不依赖真实等待，也不弹真实通知。
 */
const DEFAULT_BACKOFF_MS = [30_000, 120_000, 600_000];
const MAX_BACKOFF_INDEX = DEFAULT_BACKOFF_MS.length - 1;

/** 提醒自身的配置身份。与 AI 设置无关，保存别的分区不得改变它。 */
function reminderSignature(settings) {
  if (!settings || !settings.reminder) return null;
  const {enabled, intervalMinutes} = settings.reminder;
  return `${enabled ? '1' : '0'}:${Number(intervalMinutes) || 0}`;
}

const EMPTY_STATE = () => ({
  nextCheckAt: null,
  lastHandledAt: null,
  lastResult: null,
  notificationError: null,
  backoffIndex: 0,
});

class ReminderScheduler {
  /**
   * @param {object} deps
   * @param {() => number} deps.now          毫秒时钟
   * @param {Function} [deps.setTimer]        (fn, ms) => handle；默认 setTimeout
   * @param {Function} [deps.clearTimer]      (handle) => void；默认 clearTimeout
   * @param {() => Promise<object>} deps.summary  读取 Core 统计
   * @param {(summary, context) => Promise<object>} deps.notify  发送／更新／关闭通知
   * @param {(state) => Promise|void} [deps.persist] 持久化运行状态
   */
  constructor({now, setTimer, clearTimer, summary, notify, persist}) {
    this.now = now;
    // 挂到 _ 前缀的私有字段：否则会遮蔽同名原型方法 clearTimer()，
    // 变成「用空参数调用注入函数」，旧计时器永远清不掉、不断累积。
    this._setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = clearTimer || ((handle) => clearTimeout(handle));
    this.summary = summary;
    this.notify = notify;
    this.persist = persist || (() => {});
    this.timer = null;
    this.signature = null;
    this.state = EMPTY_STATE();
    /** 单调代际：任何提醒配置变更、停止与退出都会 +1。 */
    this.generation = 0;
    this.inFlight = false;
    this.halted = false;
    this.lastNotified = null;
    this.running = {callCount: 0, notified: 0, failures: 0, stale: 0};
  }

  currentGeneration() {
    return this.generation;
  }

  /**
   * 设置变化时调用。只有提醒自身配置变了才推进代际与重置周期。
   * @returns {boolean} 是否真的重置了周期
   */
  applySettings(settings, {persist = true} = {}) {
    const signature = reminderSignature(settings);
    if (signature === this.signature) return false;
    this.signature = signature;
    this.generation += 1;
    this.clear();
    if (!signature || settings.reminder.enabled === false) {
      this.state = {...EMPTY_STATE(), lastResult: 'disabled'};
      this.lastNotified = null;
      // 启动接线时不落盘：先读配置再读持久记录，反过来会覆盖原记录（BUG-074）。
      if (persist) void this.persist({...this.state, signature});
      return true;
    }
    // 从「现在」重算，而不是沿用旧的到期时间。
    this.state.backoffIndex = 0;
    this.state.notificationError = null;
    this.armIn(this.state.nextCheckAt = this.now() + settings.reminder.intervalMinutes * 60_000);
    if (persist) void this.persist({...this.state, signature});
    return true;
  }

  /**
   * 进程重启／窗口重建后按持久状态恢复。
   * 先看持久记录，再决定是等下一个周期还是合并一次过期检查——不并发触发。
   */
  restore(persisted) {
    if (persisted && persisted.signature !== undefined && persisted.signature !== this.signature) {
      // 配置身份对不上的旧记录不得激活提醒：那是上一个配置的残留。
      return false;
    }
    if (persisted && typeof persisted.nextCheckAt === 'number') {
      this.state = {...this.state, ...persisted, signature: this.signature};
      // 代际必须从持久记录续接：每进程从 0 起算会让重启后的正常写入被
      // Core 判为「比已存代际更旧」而拒绝，提醒就再也存不进新周期。
      if (Number.isInteger(persisted.generation) && persisted.generation > this.generation) {
        this.generation = persisted.generation;
      }
    }
    if (!this.signature || this.signature.startsWith('0')) return false;
    const due = this.state.nextCheckAt;
    if (due === null || due === undefined) {
      // 没有可用记录：从现在起排一个完整周期。
      const [, minutes] = this.signature.split(':');
      this.armIn(this.state.nextCheckAt = this.now() + Number(minutes) * 60_000);
      return true;
    }
    // armIn 收的是绝对到期时刻，不是相对延迟：传错会让未到期的检查立刻触发。
    if (due <= this.now()) {
      // 过期只合并一次，不补发每个错过的周期。
      this.armIn(due);
      return true;
    }
    this.armIn(due);
    return true;
  }

  /** 到点触发。只有剩余时间确实是有限非负数时才建定时器。 */
  armIn(dueAt) {
    const now = this.now();
    const delay = Number(dueAt) - now;
    if (!Number.isFinite(delay)) {
      // 宁可没有定时器，也不能让 NaN 进入 setTimeout（会被当成 1ms）。
      this.clear();
      return false;
    }
    const wait = Math.max(0, delay);
    this.clear();
    this.timer = this._setTimer(() => {
      this.timer = null;
      void this.run({reason: 'scheduled'});
    }, wait);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    return true;
  }

  /** 清掉待触发任务。调度器仍可再次启用。 */
  clear() {
    if (this.timer !== null) {
      this._clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** 明确退出：释放进程内资源，但保留持久到期时间供下次恢复。 */
  halt() {
    this.halted = true;
    this.generation += 1;
    this.clear();
    this.inFlight = false;
    // nextCheckAt 原样保留：清空它就丢掉了「过期最多合并一次」的依据。
  }

  /** 同一时刻只有一个检查在执行。 */
  async run({reason = 'manual'} = {}) {
    if (this.inFlight || this.halted || !this.signature || this.signature.startsWith('0')) return null;
    const generation = this.generation;
    const alive = () => !this.halted && generation === this.generation && this.signature && !this.signature.startsWith('0');
    this.inFlight = true;
    this.running.callCount += 1;
    const [, intervalMinutes] = this.signature.split(':');
    try {
      const summary = await this.summary();
      if (!alive()) {
        this.running.stale += 1;
        return {skipped: 'settings_changed'};
      }
      if (!summary || typeof summary.pendingCount !== 'number' || typeof summary.highUnarchivedCount !== 'number') {
        throw new Error('统计结果缺少必需字段');
      }
      this.state.backoffIndex = 0;
      this.state.notificationError = null;
      // 查询成功与投递成功是两回事：投递失败不得把已成功的检查降级成查询失败，
      // 更不能触发查询退避（BUG-079）。
      let result, deliveryError = null;
      try {
        result = await this.dispatch(summary, Number(intervalMinutes));
      } catch (error) {
        deliveryError = String((error && error.message) || error);
        result = {notified: false, reason: 'delivery_failed'};
      }
      if (!alive()) {
        // 通知可能已经提交给系统，但新周期的状态不能再被这次旧回调改写。
        this.running.stale += 1;
        return {...result, stale: 'settings_changed'};
      }
      this.state.lastHandledAt = this.now();
      this.state.nextCheckAt = this.now() + Number(intervalMinutes) * 60_000;
      // 投递结果如实记录：failed / unsupported / unknown 都不是「已检查完且提醒成功」。
      const delivery = result && result.notification ? result.notification.status : null;
      this.state.notificationError = deliveryError
        || (delivery && ['failed', 'unknown'].includes(delivery.status) ? delivery.status : null);
      this.state.lastResult = deliveryError || delivery === 'failed' ? 'notification_failed'
        : delivery === 'unsupported' ? 'notification_unsupported'
        : delivery === 'unknown' ? 'notification_unknown'
        : result.notified ? 'checked' : 'checked_empty';
      this.armIn(this.state.nextCheckAt);
      await this.persist({...this.state, signature: this.signature, generation});
      return {...result, lastResult: this.state.lastResult};
    } catch (error) {
      if (!alive()) {
        // 迟到失败同样不能覆盖新配置状态，也不能改动新周期的计时。
        this.running.stale += 1;
        return {skipped: 'stale_failure'};
      }
      // 查询失败：有限退避，且绝不用旧计数伪造一条提醒。
      this.running.failures += 1;
      this.state.lastResult = 'query_failed';
      const delay = DEFAULT_BACKOFF_MS[Math.min(this.state.backoffIndex, MAX_BACKOFF_INDEX)];
      this.state.backoffIndex = Math.min(this.state.backoffIndex + 1, MAX_BACKOFF_INDEX);
      this.armIn(this.state.nextCheckAt = this.now() + delay);
      await this.persist({...this.state, signature: this.signature, generation});
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

  snapshot() {
    return {...this.state, signature: this.signature, generation: this.generation, inFlight: this.inFlight};
  }
}

module.exports = {ReminderScheduler, reminderSignature, DEFAULT_BACKOFF_MS};