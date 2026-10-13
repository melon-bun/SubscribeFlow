'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { sendTestNotification } = require('../electron/main/notifications.cjs');

function fakeNotification(behavior, supported = true) {
  return class extends EventEmitter {
    static isSupported() { return supported; }
    show() { behavior(this); }
  };
}

test('测试通知区分异步显示与异步失败，不把 show 调用当显示成功', async () => {
  const shown = await sendTestNotification({NotificationClass: fakeNotification(n => setImmediate(() => n.emit('show')))});
  assert.equal(shown.delivery, 'shown');
  const failed = await sendTestNotification({NotificationClass: fakeNotification(n => setImmediate(() => n.emit('failed', {}, 'permission denied')))});
  assert.equal(failed.sent, false);
  assert.equal(failed.delivery, 'failed');
  assert.match(failed.message, /permission denied/);
});

test('系统不支持或同步发送失败应报告失败', async () => {
  const unsupported = await sendTestNotification({NotificationClass: fakeNotification(() => {throw new Error('不应调用');}, false)});
  assert.equal(unsupported.sent, false);
  const failed = await sendTestNotification({NotificationClass: fakeNotification(() => {throw new Error('native failure');})});
  assert.equal(failed.sent, false);
  assert.match(failed.message, /native failure/);
});

test('没有系统事件时只报告已提交、未确认，调用不会无限等待', async () => {
  const result = await sendTestNotification({NotificationClass: fakeNotification(() => {}), timeoutMs: 5});
  assert.equal(result.delivery, 'unknown');
  assert.match(result.message, /未获得显示确认/);
});
