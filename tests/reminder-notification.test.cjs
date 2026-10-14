'use strict';
/**
 * M17 提醒通知的投递结果测试（BUG-079）。
 *
 * 替身通知对象用于验证状态机本身；**替身不能作为真实显示证据**，
 * 真实系统通知的显示与点击仍需实机人工确认。
 */
const test = require('node:test');
const assert = require('node:assert');
const {ReminderNotification} = require('../electron/main/reminder-notification.cjs');

test('通知投递状态机区分五种结果', () => {
  const {ReminderNotification} = require('../electron/main/reminder-notification.cjs');

  function fakeCtor({supported = true} = {}) {
    const created = [];
    class Fake {
      static isSupported() { return supported; }
      constructor(options) {
        this.options = options;
        this.body = options.body;
        this.handlers = {};
        this.shown = 0;
        created.push(this);
      }
      on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); return this; }
      emit(event, ...args) { (this.handlers[event] || []).forEach((fn) => fn(...args)); }
      show() { this.shown += 1; }
      close() { this.emit('close'); }
    }
    return {Fake, created};
  }

  const timers = [];
  const mk = (ctor, settleMs = 5000) => new ReminderNotification({
    NotificationCtor: ctor, settleMs,
    setTimer: (fn) => { const h = {unref() {}}; timers.push({fn, h}); return h; },
    clearTimer: () => {},
  });

  // submitted：show() 返回不等于显示成功
  {
    const {Fake} = fakeCtor();
    const n = mk(Fake);
    const result = n.post({pendingCount: 3, highUnarchivedCount: 1});
    assert.equal(result.status, 'submitted', 'show() 返回只代表已提交');
    assert.equal(n.format({pendingCount: 3, highUnarchivedCount: 1}), '你有 3 条内容未处理；1 条高优先级内容尚未归档。');
  }

  // shown：系统回报显示
  {
    const {Fake, created} = fakeCtor();
    const n = mk(Fake);
    n.post({pendingCount: 2, highUnarchivedCount: 0});
    created[0].emit('show');
    assert.equal(n.lastResult.status, 'shown');
  }

  // failed：系统明确失败
  {
    const {Fake, created} = fakeCtor();
    const n = mk(Fake);
    n.post({pendingCount: 2, highUnarchivedCount: 0});
    created[0].emit('failed', {}, '通知中心被关闭');
    assert.equal(n.lastResult.status, 'failed');
    assert.match(n.lastResult.reason, /通知中心被关闭/);
  }

  // unsupported
  {
    const {Fake} = fakeCtor({supported: false});
    const n = mk(Fake);
    assert.equal(n.post({pendingCount: 1, highUnarchivedCount: 0}).status, 'unsupported');
  }

  // unknown：期限内没有系统回报
  {
    const {Fake} = fakeCtor();
    const n = mk(Fake);
    n.post({pendingCount: 2, highUnarchivedCount: 0});
    const before = timers.length;
    timers[before - 1].fn();
    assert.equal(n.lastResult.status, 'unknown', '无回报不得冒充显示成功');
  }

  // 复用同一条通知
  {
    const {Fake, created} = fakeCtor();
    const n = mk(Fake);
    n.post({pendingCount: 2, highUnarchivedCount: 0});
    n.post({pendingCount: 5, highUnarchivedCount: 0});
    assert.equal(created.length, 1, '应当复用同一条汇总通知');
    assert.match(created[0].body, /5 条/);
  }

  // 迟到事件不得污染新通知
  {
    const {Fake, created} = fakeCtor();
    const n = mk(Fake);
    n.post({pendingCount: 2, highUnarchivedCount: 0});
    n.cancel();                       // 旧通知作废
    n.post({pendingCount: 9, highUnarchivedCount: 0});
    assert.equal(created.length, 2, '作废后重发才另起一条');
    const stale = created[0];
    stale.emit('failed', {}, '旧通知失败');
    stale.emit('close');
    assert.notEqual(n.lastResult.status, 'failed', '旧通知的失败事件不得覆盖新通知状态');
    assert.ok(n.current, '旧通知的 close 不得清掉当前通知');
    created[1].emit('show');
    assert.equal(n.lastResult.status, 'shown', '当前通知的显示事件照常生效');
  }

  // 点击使用当前目标，而不是首次创建时的快照
  {
    const {Fake, created} = fakeCtor();
    const n = mk(Fake);
    const clicks = [];
    n.onClick = (view) => clicks.push(view);
    n.post({pendingCount: 5, highUnarchivedCount: 0});   // 目标：pending
    n.post({pendingCount: 0, highUnarchivedCount: 2});   // 目标：high_unarchived
    created[0].emit('click');
    assert.deepEqual(clicks, ['high_unarchived'], '点击必须用当前目标');
  }

  // 全零关闭
  {
    const {Fake, created} = fakeCtor();
    const n = mk(Fake);
    n.post({pendingCount: 2, highUnarchivedCount: 0});
    n.cancel();
    assert.equal(n.current, null);
    assert.equal(n.lastResult.status, 'cleared');
    created[0].closed = true;
  }
});
