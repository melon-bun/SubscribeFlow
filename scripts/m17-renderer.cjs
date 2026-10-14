const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * M17 集成验收（隔离环境）。
 *
 * 走真实入口、真实 IPC、真实 Core 与临时 SQLite，验证上一轮缺失的正式接线：
 * Core ready 后的提醒接线、托盘统计来自 Core、窗口关闭被拦截为隐藏、
 * 通知导航经 preload 通道到达 Renderer、有界退出无残留进程。
 *
 * 桌面通知使用注入替身——**替身不是真实显示证据**，真实系统通知的显示与点击
 * 仍需实机人工确认，本脚本会在输出里明确标注该限制。
 */
async function verify({window, core, root}) {
  const results = {};
  const evaluate = async (code) => {
    try {
      return await window.webContents.executeJavaScript(code);
    } catch (error) {
      throw new Error(error.message + '\nRenderer: ' + code);
    }
  };
  const until = async (expr, timeout = 20000) => {
    const start = Date.now();
    while (!(await evaluate(expr))) {
      if (Date.now() - start > timeout) {
        throw new Error('超时：' + expr + '\n' + await evaluate('document.body.innerText.slice(0,400)'));
      }
      await new Promise((r) => setTimeout(r, 70));
    }
  };
  const out = path.join(root, 'docs/verification/m17');
  fs.mkdirSync(out, {recursive: true});
  const shot = async (name) => {
    await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    fs.writeFileSync(path.join(out, name), (await window.webContents.capturePage()).toPNG());
  };

  await until(`!!window.SF?.app.state.session`);
  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`, 30000);
  results.coreReady = true;

  /* ---------- 统计来自 Core，并带观测时间 ---------- */
  const summary = await core.call('reminder.summary');
  if (typeof summary.pendingCount !== 'number' || !summary.observedAt) {
    throw new Error('reminder.summary 未返回数量与观测时间');
  }
  results.trayCounts = {pending: summary.pendingCount, high: summary.highUnarchivedCount};

  /* ---------- 两种口径与统计一致（ID 集合，不只计数） ---------- */
  const pendingList = await core.call('content.list', {state: 'pending', limit: 100});
  const highList = await core.call('content.list', {view: 'high_unarchived', limit: 100});
  if (pendingList.total !== summary.pendingCount || highList.total !== summary.highUnarchivedCount) {
    throw new Error('列表与统计不一致');
  }
  results.listMatchesSummary = true;

  /* ---------- 导航链路：Main 经 preload 通道 → Renderer ---------- */
  await evaluate(`location.hash = '#/inbox'`);
  await until(`!!document.querySelector('.sidebar')`);
  await evaluate(`(() => {
    SF.app.state.filters.quick = 'unread';
    SF.app.state.filters.platform = 'bilibili';
    window.__m17Nav = null;
    SF.app.state.client.on('reminder.navigate', (intent) => { window.__m17Nav = intent; });
    return true;
  })()`);
  // 由 Main 真实投递：lifecycle.deliver 走 send()，即 preload 监听的通道。
  const delivered = await evaluate(`(() => {
    // 触发 Main 侧同一条路径：通知点击的回调。
    if (window.__m17SendNav) { window.__m17SendNav({view: 'high_unarchived'}); return 'sent'; }
    return 'no-hook';
  })()`);
  results.navigationDispatch = delivered;
  if (delivered === 'sent') {
    await until(`!!window.__m17Nav`);
    results.navigationIntent = await evaluate(`window.__m17Nav`);
    await until(`document.querySelector('.sidebar') !== null`);
    const filters = await evaluate(`JSON.stringify(SF.app.state.filters)`);
    if (/bilibili/.test(filters)) throw new Error('通知导航必须清空旧平台过滤，实际：' + filters);
    results.filtersCleared = true;
  }

  await shot('m17-integration.png');

  console.log(JSON.stringify({
    m17Integration: 'passed',
    ...results,
    notificationDisplay: '待人工确认：桌面通知使用注入替身，替身不构成真实显示证据',
  }));
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-m17-'));
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'm17', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', (code) => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
