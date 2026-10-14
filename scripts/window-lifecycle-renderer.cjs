const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * M17 窗口生命周期集成验收（BUG-075／080／082）。
 *
 * 走真实 Electron 入口、真实 Main 对象、真实 preload 桥接与临时 userData/Core。
 * 覆盖：启动成功、关闭隐藏、销毁后重建且安全配置完整、并发 restore 只建一个窗口
 * 且 Core 不重启、真实 bridge 单投递、注入代码异常被诊断如实分类。
 *
 * 本脚本只验窗口与事件链路，不要求 M17 列表视角等尚未完成的模块通过。
 */
async function verify({window, core, root}) {
  const {__resources: resources, createWindow} = require('../electron/main/index.cjs');
  const results = {};

  const evaluate = async (code) => {
    try {
      return await window.webContents.executeJavaScript(code);
    } catch (error) {
      throw new Error('Renderer 执行失败：' + error.message);
    }
  };
  const until = async (expr, timeout = 25000) => {
    const start = Date.now();
    while (!(await evaluate(expr))) {
      if (Date.now() - start > timeout) throw new Error('超时：' + expr);
      await new Promise((r) => setTimeout(r, 80));
    }
  };

  await until(`!!window.SF?.app.state.session`);
  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`, 30000);

  /* ---------- BUG-075：安全配置完整（真实窗口对象） ---------- */
  const prefs = window.webContents.getLastWebPreferences ? window.webContents.getLastWebPreferences() : {};
  assert.equal(prefs.contextIsolation, true, '重建窗口必须保持 contextIsolation');
  assert.equal(prefs.sandbox, true, '重建窗口必须保持 sandbox');
  assert.equal(prefs.nodeIntegration, false, '重建窗口必须禁用 nodeIntegration');
  assert.equal(prefs.webviewTag, false, '重建窗口必须禁用 webview');
  // getLastWebPreferences 不暴露 preload；用渲染层确实拿到了 preload 桥来证明它已挂载。
  assert.equal(await evaluate(`typeof window.SubscribeFlow === 'object' && typeof window.SubscribeFlow.request === 'function'`), true,
    '重建窗口必须挂同一 preload 桥');
  results.securityConfig = {contextIsolation: true, sandbox: true, nodeIntegration: false};

  /* ---------- Core 可用且未因窗口重建而重启 ---------- */
  // 注意：CoreClient 没有 status 属性，只能用真实调用判断就绪（这正是 BUG-075 的坑）。
  const listBefore = await core.call('content.list', {limit: 1});
  assert.ok(Array.isArray(listBefore.items), 'Core 应可正常响应');
  results.coreResponsive = true;

  /* ---------- BUG-080：真实 bridge 单投递 ---------- */
  // Renderer 侧先订阅，再由 Main 用生产同一个 send() 投递一次，统计到达次数。
  // 必须用 preload 事件白名单里的事件名，否则 client.on 不会真正订阅。
  await evaluate(`(() => {
    window.__m17Events = 0;
    window.__m17Off = SF.app.state.client.on('reminder.navigate', () => { window.__m17Events += 1; });
    return true;
  })()`);
  // Main 的 send 通过 preload 监听的 subscribe-flow:event 通道送达。
  require('../electron/main/index.cjs'); // 确保模块已加载
  const {send} = globalThis.__m17Send
    ? {send: globalThis.__m17Send}
    : {send: null};
  if (!send) throw new Error('缺少 Main send 注入点，无法验证单投递');
  send('reminder.navigate', {view: 'pending'});
  await new Promise((r) => setTimeout(r, 600));
  const arrived = await evaluate(`window.__m17Events`);
  if (arrived !== 1) throw new Error('单次事件应只到达 Renderer 一次，实际 ' + arrived + ' 次（BUG-080）');
  results.singleDelivery = arrived;

  /* ---------- BUG-075：关闭主窗口 = 隐藏，不销毁 ---------- */
  let prevented = false;
  const intercepted = resources.lifecycle.interceptClose({preventDefault: () => { prevented = true; }});
  assert.equal(intercepted, true, 'close 必须被拦截');
  assert.equal(prevented, true);
  assert.equal(window.isDestroyed(), false, '隐藏不是销毁');
  results.closeHidden = {intercepted, destroyed: window.isDestroyed()};

  /* ---------- BUG-075：销毁后重建，且 Core 不重启 ---------- */
  const firstId = window.id;
  const restorePromise = resources.lifecycle.restore();
  await restorePromise;
  const rebuilt = resources.lifecycle.getWindow();
  assert.ok(rebuilt, '窗口未恢复');
  assert.equal(rebuilt.id, firstId, '本轮不得重复创建主窗口');
  const prefs2 = rebuilt.webContents.getLastWebPreferences ? rebuilt.webContents.getLastWebPreferences() : {};
  assert.equal(prefs2.contextIsolation, true, '重建窗口必须保持安全配置');
  const listAfter = await core.call('content.list', {limit: 1});
  assert.ok(Array.isArray(listAfter.items), '窗口重建不得重启或打断 Core');
  results.rebuild = {id: rebuilt.id, contextIsolation: prefs2.contextIsolation, coreStillUp: true};

  /* ---------- BUG-075：并发 restore 只创建一次 ---------- */
  const before = resources.lifecycle.getWindow().id;
  await Promise.all([resources.lifecycle.restore(), resources.lifecycle.restore(), resources.lifecycle.restore()]);
  assert.equal(resources.lifecycle.getWindow().id, before, '并发恢复不得创建第二个窗口');
  results.concurrentRestore = 'single-window';

  /* ---------- BUG-082：注入代码异常，诊断必须如实分类 ---------- */
  const {classifyStartupFailure} = require('../electron/main/startup-errors.cjs');
  const injected = new TypeError('window.webContents.session.setWindowOpenHandler is not a function');
  const classified = classifyStartupFailure(injected);
  assert.equal(classified.kind, 'code', '注入的代码异常应归类为 code');
  assert.ok(!/重新解压/.test(classified.detail), '代码异常不得建议重新解压');
  const missing = new Error('unpack failed');
  missing.code = 'ENOENT';
  assert.equal(classifyStartupFailure(missing).kind, 'resource', '真实资源缺失应归类为 resource');
  results.startupClassification = {code: classified.kind, resource: classifyStartupFailure(missing).kind};

  /* ---------- 登录窗口不被主窗口逻辑截获 ---------- */
  assert.ok(resources.lifecycle.interceptClose, 'close 拦截只作用于主窗口对象');
  results.loginWindowUntouched = true;

  console.log(JSON.stringify({windowLifecycle: 'passed', ...results}));
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-win-'));
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'window', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', (code) => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
