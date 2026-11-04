'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {ReadingStateLabels, DEFAULT_READING_STATE_NAMES, DEFERRED_READING_STATE_NAME} = require('../electron/main/reading-state-labels.cjs');
const {ReminderNotification} = require('../electron/main/reminder-notification.cjs');
const {formatHigh} = require('../electron/main/tray.cjs');

test('Renderer 与 Main 的默认名称一致，改名后托盘和通知实时使用保存值', () => {
  const context = {window: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/renderer/scripts/core/catalog.js'), 'utf8'), context);
  const catalog = context.window.SF.catalog;
  const labels = new ReadingStateLabels();
  for (const id of ['read', 'archived']) {
    assert.equal(catalog.readingState(id), DEFAULT_READING_STATE_NAMES[id]);
    assert.equal(labels.label(id), catalog.readingState(id));
  }
  assert.equal(catalog.readingState('deferred'), DEFERRED_READING_STATE_NAME);
  labels.apply({read: '值得重温', archived: '已结束'});
  catalog.setReadingStateNames({read: '值得重温', archived: '已结束'});
  assert.equal(labels.label('deferred'), '稍后阅读');
  assert.equal(catalog.readingState('archived'), labels.label('archived'));
  assert.equal(formatHigh(3, true, '今天看', labels.label('archived')), '不在「已结束」中的今天看 3 条');
  const notification = new ReminderNotification({
    NotificationCtor: class {}, priorityLabel: () => '今天看', archivedLabel: () => labels.label('archived'),
  });
  assert.equal(notification.format({pendingCount: 2, highUnarchivedCount: 3}),
    '你有 2 条内容未处理；3 条「今天看」内容不在「已结束」中。');
  labels.apply(DEFAULT_READING_STATE_NAMES);
  assert.match(notification.format({pendingCount: 0, highUnarchivedCount: 3}), /不在「看完了」中/);
});
