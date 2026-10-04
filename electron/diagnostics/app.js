'use strict';
const bridge = window.SubscribeFlow;
const byId = id => document.getElementById(id);
async function action(callback) {
  try { byId('feedback').textContent = ''; await callback(); }
  catch (error) { byId('feedback').textContent = error.message; }
}
function displayStatus(status) {
  byId('status').textContent = {ready:'核心服务已就绪', starting:'正在启动核心服务…', stopped:'核心服务已停止', error:'核心服务不可用'}[status.state] || status.state;
  if (status.message) byId('feedback').textContent = status.message;
}
async function refreshDiagnostics() {
  displayStatus(await bridge.call('core.status'));
  const [subscriptions, contents, jobs] = await Promise.all([
    bridge.call('subscription.list'), bridge.call('content.list', {limit: 1}), bridge.call('sync.list', {limit: 10}),
  ]);
  byId('summary').textContent = `${subscriptions.length} 个订阅 · ${contents.total} 条内容 · 最近 ${jobs.length} 个任务`;
  byId('subscriptions').replaceChildren();
  for (const sub of subscriptions) {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = `${sub.name} · ${sub.status}`;
    li.append(name);
    for (const [label, callback] of [
      ['刷新', () => bridge.call('sync.start', {subscription_id: sub.id})],
      ['回溯 10 页', () => bridge.call('sync.start', {subscription_id: sub.id, mode: 'backfill'})],
      [sub.status === 'active' ? '暂停' : '恢复', () => bridge.call('subscription.update', {subscription_id: sub.id, status: sub.status === 'active' ? 'paused' : 'active'})],
    ]) {
      const button = document.createElement('button'); button.textContent = label;
      button.addEventListener('click', () => action(async () => { const result = await callback(); byId('feedback').textContent = result.job_id ? '任务已创建，可查看后续状态。' : '订阅已更新'; await refreshDiagnostics(); }));
      li.append(button);
    }
    byId('subscriptions').append(li);
  }
}
function initializeDiagnostics() {
  // Check both bridge methods before registering events or issuing any requests.
  if (!bridge || typeof bridge.call !== 'function' || typeof bridge.on !== 'function') {
    byId('status').textContent = '请通过桌面应用启动';
    byId('summary').textContent = '当前页面未连接桌面服务，本地数据尚未读取。';
    byId('startup-help').hidden = false;
    return;
  }
  document.querySelectorAll('button, input').forEach(control => { control.disabled = false; });
  window.refreshDiagnostics = refreshDiagnostics;
  byId('refresh').addEventListener('click', () => action(refreshDiagnostics));
  byId('restart').addEventListener('click', () => action(async () => { await bridge.call('core.restart'); await refreshDiagnostics(); }));
  byId('subscribe').addEventListener('submit', event => {
    event.preventDefault();
    action(async () => {
      await bridge.call('subscription.add', {locator: byId('locator').value.trim(), connection_id: 'bilibili:default', confirmed: byId('confirmed').checked});
      byId('locator').value = ''; byId('confirmed').checked = false; await refreshDiagnostics();
    });
  });
  const releaseStatus = bridge.on('core.status', status => { displayStatus(status); if (status.state === 'ready') action(refreshDiagnostics); });
  const releaseSync = bridge.on('sync.changed', job => {
    byId('feedback').textContent = `任务 ${job.state} · 已保存 ${job.items} 条 · 覆盖：${job.coverage}${job.error ? ' · ' + job.error.message : ''}`;
  });
  window.addEventListener('beforeunload', () => {releaseStatus(); releaseSync();});
  action(refreshDiagnostics);
}
initializeDiagnostics();
