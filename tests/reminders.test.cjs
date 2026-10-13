'use strict';
/**
 * M17 提醒调度器测试（T01–T04、BUG-071~073）。
 *
 * 关键点：**必须真的跑定时器**。上一版全部靠手动调用 run()，结果 NaN 延迟
 * 这类只会在真定时器上暴露的问题整个测试套件都看不见（BUG-071）。
 * 这里用可注入的假定时器：到期逻辑与 setTimeout 完全一致，但断言立即可判定。
 */
const test = require('node:test');
const assert = require('node:assert');
const {ReminderScheduler, reminderSignature} = require('../electron/main/reminders.cjs');

/** 手动推进的假定时器：保存 fn 与到期时刻，由 tick() 精确触发。 */
function fakeTimers() {
  const queue = new Map();
  let nextId = 1;
  return {
    setTimer: (fn, ms) => {
      const id = nextId++;
      queue.set(id, {fn, due: ms});
      return {id, unref() {}};
    },
    clearTimer: (handle) => {
      if (handle) queue.delete(handle.id);
    },
    /** 到期的回调按到期时刻顺序执行，返回条数。 */
    tick() {
      const due = [...queue.entries()].sort((a, b) => a[1].due - b[1].due);
      for (const [id, entry] of due) {
        queue.delete(id);
        entry.fn();
      }
      return due.length;
    },
    pending: () => queue.size,
    delays: () => [...queue.values()].map((entry) => entry.due),
  };
}

function harness({summary, notify, start = 1_000_000} = {}) {
  let clock = start;
  const timers = fakeTimers();
  const calls = {notify: [], summary: 0, persist: []};
  // 统计调用次数在这里统一计数：之前自定义 summary 没经过计数器，
  // 断言「查询了几次」时读到的是恒为 0 的值。
  const query = summary || (async () => ({pendingCount: 0, highUnarchivedCount: 0}));
  const scheduler = new ReminderScheduler({
    now: () => clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    summary: async () => {
      calls.summary += 1;
      return query();
    },
    notify: notify || (async (value, context) => {
      calls.notify.push({summary: value, context});
      return {status: 'shown'};
    }),
    persist: (state) => calls.persist.push(state),
  });
  const h = {
    scheduler,
    calls,
    timers,
    at: () => clock,
    /** 推进时钟但不触发回调：用来验证「到期前一次都不该触发」。 */
    idle: (ms) => {
      clock += ms;
    },
    /** 推进时钟并触发已到期的定时器。 */
    async tick(ms) {
      clock += ms;
      timers.tick();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return h;
}

const enabled = (minutes) => ({reminder: {enabled: true, intervalMinutes: minutes}});
const disabled = () => ({reminder: {enabled: false, intervalMinutes: 60}});

test('BUG-071：启用 60 分钟后，到期前一次定时器都不能触发', async () => {
  const h = harness({summary: async () => ({pendingCount: 7, highUnarchivedCount: 0})});
  h.scheduler.applySettings(enabled(60));
  assert.equal(h.timers.delays()[0], 60 * 60_000, '定时器延迟必须是真实间隔，不能是 NaN');
  assert.ok(h.timers.delays().every((d) => Number.isFinite(d)), 'NaN 延迟会被 setTimeout 当成 1ms');
  // 只推进时钟、不触发回调：通知次数必须保持 0。
  h.idle(30);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.notify.length, 0, '30ms 内不得触发任何提醒');
  h.idle(59 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.notify.length, 0, '到期前仍不得触发');
});

test('BUG-071：真正到期才触发一次，并排出下一个周期', async () => {
  const h = harness({summary: async () => ({pendingCount: 7, highUnarchivedCount: 0})});
  h.scheduler.applySettings(enabled(60));
  await h.tick(60 * 60_000);
  assert.equal(h.calls.notify.length, 1);
  assert.deepEqual(h.timers.delays(), [60 * 60_000], '成功后重新排出一个完整周期');
});

test('BUG-072：开→关→开（相同间隔）作废在途的旧查询', async () => {
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
  const generation = h.scheduler.currentGeneration();
  const running = h.scheduler.run({reason: 'test'});
  h.scheduler.applySettings(disabled());
  h.scheduler.applySettings(enabled(60));
  assert.ok(h.scheduler.currentGeneration() > generation, '停用与再启用都要推进代际');
  release();
  assert.deepEqual(await running, {skipped: 'settings_changed'});
  assert.equal(h.calls.notify.length, 0, '旧代际的查询结果不得发通知');
});

test('BUG-072：通知在途时改间隔，迟到回执不得改写新周期', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let notifyCount = 0;
  const h = harness({
    summary: async () => ({pendingCount: 3, highUnarchivedCount: 0}),
    notify: async (value, context) => {
      notifyCount += 1;
      if (notifyCount === 1) await gate;
      h.calls.notify.push({summary: value, context});
      return {status: 'shown'};
    },
  });
  h.scheduler.applySettings(enabled(60));
  const running = h.scheduler.run({reason: 'test'});
  await new Promise((resolve) => setImmediate(resolve));
  // 通知已提交、回调在途时用户改了间隔。
  h.scheduler.applySettings(enabled(15));
  const due = h.scheduler.state.nextCheckAt;
  release();
  const result = await running;
  assert.equal(result.stale, 'settings_changed');
  assert.equal(h.scheduler.state.nextCheckAt, due, '旧回执不得改写新配置的到期时间');
  assert.equal(h.scheduler.state.lastResult, null, '旧回执不得把停用状态改回 checked');
  assert.deepEqual(h.timers.delays(), [15 * 60_000], '新周期继续执行');
});

test('BUG-072：停用后在途通知回执不得重建定时器', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    summary: async () => ({pendingCount: 3, highUnarchivedCount: 0}),
    notify: async () => {
      await gate;
      return {status: 'shown'};
    },
  });
  h.scheduler.applySettings(enabled(60));
  const running = h.scheduler.run({reason: 'test'});
  await new Promise((resolve) => setImmediate(resolve));
  h.scheduler.applySettings(disabled());
  release();
  await running;
  assert.equal(h.scheduler.state.lastResult, 'disabled', '停用状态不能被迟到回执覆盖');
  assert.equal(h.timers.pending(), 0, '停用后不得重建定时器');
});

test('BUG-072：迟到的查询失败不得污染新配置状态', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    summary: async () => {
      await gate;
      throw new Error('Core 不可用');
    },
  });
  h.scheduler.applySettings(enabled(60));
  const running = h.scheduler.run({reason: 'test'});
  h.scheduler.applySettings(enabled(30));
  const due = h.scheduler.state.nextCheckAt;
  release();
  assert.deepEqual(await running, {skipped: 'stale_failure'});
  assert.equal(h.scheduler.state.lastResult, null);
  assert.equal(h.scheduler.state.nextCheckAt, due);
  assert.deepEqual(h.timers.delays(), [30 * 60_000], '不应被旧失败带进退避');
});

test('BUG-073：退出只释放进程内资源，持久到期时间保留', async () => {
  const h = harness({summary: async () => ({pendingCount: 1, highUnarchivedCount: 0})});
  h.scheduler.applySettings(enabled(60));
  const due = h.scheduler.state.nextCheckAt;
  h.scheduler.halt();
  assert.equal(h.timers.pending(), 0, '进程内定时器必须清掉');
  assert.equal(h.scheduler.state.nextCheckAt, due, '到期时间不得被退出清空');
  // 退出后不得再触发。
  h.idle(120 * 60_000);
  await h.tick(0);
  assert.equal(h.calls.notify.length, 0);
});

test('BUG-073：重启后按原到期时间恢复，过期只合并一次', async () => {
  const first = harness({summary: async () => ({pendingCount: 2, highUnarchivedCount: 0})});
  first.scheduler.applySettings(enabled(30));
  const persisted = {...first.scheduler.state, signature: first.scheduler.signature};
  assert.ok(persisted.nextCheckAt !== null, '持久记录必须带到期时间');

  // 重建一个调度器，注入同一份持久状态。
  const revived = harness({summary: async () => ({pendingCount: 2, highUnarchivedCount: 0})});
  revived.scheduler.applySettings(enabled(30));
  revived.scheduler.restore(persisted);
  assert.deepEqual(revived.timers.delays(), [30 * 60_000], '未到期就按剩余时间等待，不立刻触发');
  revived.scheduler.restore(persisted);
  revived.scheduler.restore(persisted);
  assert.equal(revived.timers.pending(), 1, '连续恢复只保留一个定时器');
  assert.equal(revived.calls.summary, 0, '连续恢复不得重复触发查询');
});

test('BUG-073：过期状态恢复后只检查一次，不补发风暴', async () => {
  const h = harness({summary: async () => ({pendingCount: 4, highUnarchivedCount: 0})});
  h.scheduler.applySettings(enabled(10));
  const overdue = {...h.scheduler.state, signature: h.scheduler.signature, nextCheckAt: h.at() - 5 * 60_000};
  h.scheduler.halt();
  const revived = harness({summary: async () => ({pendingCount: 4, highUnarchivedCount: 0})});
  revived.scheduler.applySettings(enabled(10));
  revived.scheduler.restore(overdue);
  revived.scheduler.restore(overdue);
  revived.scheduler.restore(overdue);
  await revived.tick(0);
  assert.equal(revived.calls.summary, 1, '过期周期无论恢复几次都只检查一次');
});

test('BUG-073：配置身份不符的旧状态不得激活提醒', () => {
  const h = harness();
  h.scheduler.applySettings(enabled(30));
  const stale = {signature: '1:15', nextCheckAt: h.at() - 1000, lastResult: 'checked', backoffIndex: 2};
  assert.equal(h.scheduler.restore(stale), false);
  assert.equal(h.timers.pending(), 1, '应仍按当前配置排自己的周期');
});

test('BUG-073：重启不丢退避状态', async () => {
  const h = harness({summary: async () => { throw new Error('Core 不可用'); }});
  h.scheduler.applySettings(enabled(60));
  await h.tick(60 * 60_000);
  await h.tick(30_000);
  const saved = h.calls.persist.at(-1);
  assert.equal(saved.backoffIndex, 2);
  assert.equal(saved.lastResult, 'query_failed');
  assert.ok(typeof saved.nextCheckAt === 'number');
});

test('数量不变仍按期提醒，全零不通知并关闭汇总', async () => {
  let pending = 2;
  const h = harness({summary: async () => ({pendingCount: pending, highUnarchivedCount: 0})});
  h.scheduler.applySettings(enabled(15));
  await h.tick(15 * 60_000);
  await h.tick(15 * 60_000);
  assert.equal(h.calls.notify.length, 2, '数量没变也按期提醒');
  pending = 0;
  await h.tick(15 * 60_000);
  assert.equal(h.calls.notify.at(-1).context.kind, 'clear');
  assert.equal(h.scheduler.running.notified, 2);
});

test('查询失败有限退避并封顶，不用旧计数发提醒', async () => {
  let fail = true;
  const h = harness({
    summary: async () => {
      if (fail) throw new Error('Core 暂不可用');
      return {pendingCount: 4, highUnarchivedCount: 0};
    },
  });
  h.scheduler.applySettings(enabled(60));
  // 先让正常周期到期一次，才会转入退避档位。
  await h.tick(60 * 60_000);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const delay = h.timers.delays().at(-1);
    seen.push(delay);
    h.idle(delay);
    h.timers.tick();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(seen, [30_000, 120_000, 600_000, 600_000], '退避递增并封顶');
  assert.equal(h.calls.notify.length, 0, '查询失败期间不得用旧计数发提醒');
  fail = false;
  h.idle(600_000);
  h.timers.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.notify.length, 1, '恢复后合并检查一次');
});

test('停用立即取消待触发任务', async () => {
  const h = harness();
  h.scheduler.applySettings(enabled(60));
  assert.equal(h.timers.pending(), 1);
  h.scheduler.applySettings(disabled());
  assert.equal(h.timers.pending(), 0);
  h.idle(120 * 60_000);
  h.timers.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.notify.length, 0);
});

test('保存无关的 AI 设置不重置提醒间隔', async () => {
  const h = harness({summary: async () => ({pendingCount: 1, highUnarchivedCount: 0})});
  h.scheduler.applySettings(enabled(30));
  await h.tick(30 * 60_000);
  const due = h.scheduler.state.nextCheckAt;
  const generation = h.scheduler.currentGeneration();
  assert.equal(h.scheduler.applySettings({
    reminder: {enabled: true, intervalMinutes: 30},
    tagging: {enabled: true, mode: 'jev'},
  }), false);
  assert.equal(h.scheduler.currentGeneration(), generation, '无关保存不得推进代际');
  assert.equal(h.scheduler.state.nextCheckAt, due);
  assert.equal(h.scheduler.applySettings(enabled(45)), true);
  assert.equal(h.scheduler.state.nextCheckAt, h.at() + 45 * 60_000);
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
  assert.equal(started, 1);
});

test('统计缺字段按查询失败处理，不当成全零', async () => {
  const h = harness({summary: async () => ({pendingCount: 5})});
  h.scheduler.applySettings(enabled(30));
  await h.tick(30 * 60_000);
  assert.equal(h.calls.notify.length, 0);
  assert.equal(h.scheduler.state.lastResult, 'query_failed');
});

test('签名只反映提醒自身配置', () => {
  assert.equal(reminderSignature({reminder: {enabled: true, intervalMinutes: 45}}), '1:45');
  assert.equal(reminderSignature({reminder: {enabled: false, intervalMinutes: 45}}), '0:45');
  assert.equal(reminderSignature({}), null);
});