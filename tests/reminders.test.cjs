'use strict';
/**
 * M17 提醒调度器测试（T01–T04）。
 *
 * 全部使用假时钟、假统计与假通知：不等待真实时间，不弹真实通知。
 * 真实桌面显示属于人工验收，mock 不作为真实显示证据。
 */
const test = require('node:test');
const assert = require('node:assert');
const {ReminderScheduler, reminderSignature} = require('../electron/main/reminders.cjs');

function harness({summary, notify, start = 1_000_000} = {}) {
  let clock = start;
  const calls = {notify: [], summary: 0, persist: []};
  const scheduler = new ReminderScheduler({
    now: () => clock,
    summary: summary || (async () => ({pendingCount: 0, highUnarchivedCount: 0})),
    notify: notify || (async (summary, context) => {
      calls.notify.push({summary, context});
      return {status: 'shown'};
    }),
    persist: (state) => calls.persist.push(state),
  });
  return {
    scheduler,
    calls,
    advance: (ms) => {
      clock += ms;
    },
    at: () => clock,
    /** 直接触发到期：推进时钟后等一个微任务，模拟定时器到点。 */
    async tick(ms) {
      clock += ms;
      await scheduler.run({reason: 'test'});
    },
  };
}

const enabled = (minutes) => ({reminder: {enabled: true, intervalMinutes: minutes}});
const disabled = () => ({reminder: {enabled: false, intervalMinutes: 60}});

test('启用后按间隔推进周期，数量不变也照常提醒', async () => {
  const h = harness({summary: async () => ({pendingCount: 3, highUnarchivedCount: 1})});
  h.scheduler.applySettings(enabled(15));
  assert.equal(h.scheduler.state.nextCheckAt, h.at() + 15 * 60_000);
  await h.tick(15 * 60_000);
  assert.equal(h.calls.notify.length, 1);
  assert.equal(h.scheduler.state.lastResult, 'checked');
  // 推进到下一个周期，不是因为数量变化。
  await h.tick(15 * 60_000);
  assert.equal(h.calls.notify.length, 2, '数量没变也应按期提醒');
});

test('两个数都为零时不通知，并清理上一次汇总通知', async () => {
  let pending = 2;
  const h = harness({summary: async () => ({pendingCount: pending, highUnarchivedCount: 0})});
  h.scheduler.applySettings(enabled(15));
  await h.tick(15 * 60_000);
  assert.equal(h.calls.notify.length, 1);
  pending = 0;
  await h.tick(15 * 60_000);
  assert.equal(h.calls.notify.at(-1).context.kind, 'clear', '全零要收回汇总通知');
  assert.equal(h.scheduler.running.notified, 1, '全零那轮不算已通知');
});

test('查询失败走有限退避，且不用旧计数伪造提醒', async () => {
  let fail = true;
  const h = harness({
    summary: async () => {
      if (fail) throw new Error('Core 暂不可用');
      return {pendingCount: 4, highUnarchivedCount: 0};
    },
  });
  h.scheduler.applySettings(enabled(60));
  const delays = [];
  for (let i = 0; i < 4; i++) {
    const before = h.at();
    await h.tick(1);
    delays.push(h.scheduler.state.nextCheckAt - before);
  }
  // 每次 tick 前先推进 1ms，所以比标称延迟多 1ms。
  assert.deepEqual(delays, [30_001, 120_001, 600_001, 600_001], '退避递增并封顶');
  assert.equal(h.calls.notify.length, 0, '查询失败期间不得用旧计数发提醒');
  fail = false;
  await h.tick(600_000);
  assert.equal(h.scheduler.state.backoffIndex, 0, '成功后回到正常周期');
  assert.equal(h.calls.notify.length, 1);
});

test('统计缺字段按查询失败处理，不当成全零', async () => {
  const h = harness({summary: async () => ({pendingCount: 5})});
  h.scheduler.applySettings(enabled(30));
  await h.tick(30 * 60_000);
  assert.equal(h.calls.notify.length, 0);
  assert.equal(h.scheduler.state.lastResult, 'query_failed');
});

test('停用立即取消待触发任务', async () => {
  const h = harness();
  h.scheduler.applySettings(enabled(60));
  assert.ok(h.scheduler.timer);
  h.scheduler.applySettings(disabled());
  assert.equal(h.scheduler.timer, null, '停用要立刻清掉计时器');
  assert.equal(h.scheduler.state.nextCheckAt, null);
  const before = h.calls.notify.length;
  await h.tick(120 * 60_000);
  assert.equal(h.calls.notify.length, before, '停用后不再触发');
});

test('保存无关的 AI 设置不重置提醒间隔', async () => {
  const h = harness({summary: async () => ({pendingCount: 1, highUnarchivedCount: 0})});
  h.scheduler.applySettings(enabled(30));
  await h.tick(30 * 60_000);
  const due = h.scheduler.state.nextCheckAt;
  const reset = h.scheduler.applySettings({
    reminder: {enabled: true, intervalMinutes: 30},
    tagging: {enabled: true, mode: 'jev'},
  });
  assert.equal(reset, false, '提醒配置未变就不该重置');
  assert.equal(h.scheduler.state.nextCheckAt, due, '到期时间保持不变');
  // 提醒自身改变时必须重置。
  assert.equal(h.scheduler.applySettings(enabled(45)), true);
  assert.equal(h.scheduler.state.nextCheckAt, h.at() + 45 * 60_000);
});

test('设置改变后丢弃在途的旧结果', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    summary: async () => {
      await gate;
      return {pendingCount: 9, highUnarchivedCount: 9};
    },
  });
  h.scheduler.applySettings(enabled(60));
  const running = h.scheduler.run({reason: 'test'});
  // 查询在途时用户改了间隔。
  h.scheduler.applySettings(enabled(15));
  release();
  const result = await running;
  assert.deepEqual(result, {skipped: 'settings_changed'});
  assert.equal(h.calls.notify.length, 0, '旧版本的查询结果不得触发通知');
});

test('同一时刻只执行一个检查', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;
  const h = harness({
    summary: async () => {
      started += 1;
      await gate;
      return {pendingCount: 1, highUnarchivedCount: 0};
    },
  });
  h.scheduler.applySettings(enabled(60));
  const first = h.scheduler.run({reason: 'test'});
  const second = h.scheduler.run({reason: 'test'});
  release();
  await Promise.all([first, second]);
  assert.equal(started, 1, '并发的第二次检查必须被挡掉');
});

test('重启后过期周期只合并一次，不补发风暴', async () => {
  const h = harness({summary: async () => ({pendingCount: 2, highUnarchivedCount: 0})});
  h.scheduler.applySettings(enabled(10));
  const persisted = {...h.scheduler.state, nextCheckAt: h.at() - 5 * 60_000};
  const revived = new ReminderScheduler({
    now: h.scheduler.now,
    summary: h.scheduler.summary,
    notify: h.scheduler.notify,
    persist: () => {},
  });
  revived.applySettings(enabled(10));
  revived.restore(persisted);
  await revived.run({reason: 'overdue'});
  await revived.run({reason: 'overdue'});
  assert.equal(revived.running.callCount, 1, '过期周期只合并成一次检查');
  assert.equal(revived.running.notified, 1, '不补发每个错过的周期');
});

test('通知失败单独记录，且不把已成功的检查降级成退避', async () => {
  const h = harness({
    summary: async () => ({pendingCount: 1, highUnarchivedCount: 0}),
    notify: async () => {
      throw new Error('系统通知提交失败');
    },
  });
  h.scheduler.applySettings(enabled(15));
  await h.tick(15 * 60_000);
  // tick 本身已把时钟推过一个周期，检查成功后从当下再排一个周期。
  const expected = h.at() + 15 * 60_000;
  assert.equal(h.scheduler.state.lastResult, 'notification_failed');
  assert.match(h.scheduler.state.notificationError, /提交失败/);
  assert.equal(h.scheduler.state.nextCheckAt, expected,
    '查询成功就按间隔推进，不因通知失败进入退避');
  assert.equal(h.scheduler.state.backoffIndex, 0);
  // 下一轮仍然正常触发。
  await h.tick(15 * 60_000);
  assert.equal(h.scheduler.running.callCount, 2);
});

test('退避与周期都由持久状态恢复，不依赖进程内计时器', () => {
  const signature = reminderSignature({reminder: {enabled: true, intervalMinutes: 45}});
  assert.equal(signature, '1:45');
  assert.equal(reminderSignature({reminder: {enabled: false, intervalMinutes: 45}}), '0:45');
  assert.equal(reminderSignature({}), null);
});

test('明确退出会清空待触发任务', async () => {
  const h = harness();
  h.scheduler.applySettings(enabled(60));
  h.scheduler.shutdown();
  assert.equal(h.scheduler.timer, null);
  assert.equal(h.scheduler.state.nextCheckAt, null);
  assert.equal(h.scheduler.state.lastResult, 'shutdown');
  assert.ok(h.calls.persist.at(-1).lastResult === 'shutdown', '退出状态要落盘');
});