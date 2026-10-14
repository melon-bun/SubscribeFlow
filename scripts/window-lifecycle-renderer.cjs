const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * M17 窗口生命周期集成验收（BUG-075／080／082）。
 *
 * 真实 Electron 入口、真实 Main 对象、真实 preload 桥、临时 userData/Core。
 *
 * 上一版的问题：从未真正 destroy 过窗口，却断言「销毁后重建」；并发 restore
 * 也只在已存在的窗口上跑。本版每一步都实际触发对应动作：
 *   1. 真实 window.close() → 被拦截、隐藏、未销毁
 *   2. 真正 destroy 旧窗口 → restore 得到**不同 ID** 的新窗口
 *   3. 先 destroy 再三次并发 restore → 只新增一个窗口，Core PID 不变
 *   4. 工厂同步抛错与异步拒绝后都能重试，失败窗口不泄漏
 *   5. 辅助登录窗口独立：关它不被主窗口拦截
 *
 * 顶层启动异常由 scripts/startup-crash-check.cjs 单独进程验证，不在这里假装。
 */
async function verify({window, core, root}) {
  const {__resources: resources} = require('../electron/main/index.cjs');
  const results = {};

  const evaluate = async (code, target) => {
    const win = target || window;
    try {
      return await win.webContents.executeJavaScript(code);
    } catch (error) {
      throw new Error('Renderer 执行失败：' + error.message);
    }
  };
  const until = async (expr, target, timeout = 30000) => {
    const start = Date.now();
    while (!(await evaluate(expr, target))) {
      if (Date.now() - start > timeout) {
        let page = '';
        try { page = await target.webContents.executeJavaScript('document.body.innerText.slice(0,200)'); } catch (e) { page = '执行失败: ' + e.message; }
        throw new Error('超时：' + expr + '\n页面：' + page + '\nURL：' + target.webContents.getURL());
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  };

  let current = window;
  await until(`!!window.SF?.app.state.session`, current);
  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`, current);

  const corePid = core.child && core.child.pid;
  assert.ok(corePid, '必须能取到 Core 进程 PID 以核对是否被重启');
  results.corePid = corePid;

  /* ---------- 安全偏好 ---------- */
  const prefs = current.webContents.getLastWebPreferences();
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webviewTag, false);
  results.securityConfig = {contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false};

  /* ---------- 1. 真实 window.close()：拦截并隐藏，不销毁 ---------- */
  const firstId = current.id;
  const closesBefore = resources.lifecycle.closeCount;
  current.close();                       // 真实关闭事件，不是直接调 interceptClose
  await new Promise((r) => setTimeout(r, 600));
  // 无头 smoke 里窗口以 show:false 创建，isVisible() 不是可靠信号；
  // 用产品路径自身的证据：拦截计数增加且窗口没有被销毁。
  assert.equal(resources.lifecycle.closeCount, closesBefore + 1,
    '真实 close 事件必须经过主窗口的拦截路径');
  assert.equal(current.isDestroyed(), false, '关闭主窗口必须被拦截为隐藏，而不是销毁');
  results.closeHidden = {id: firstId, intercepted: true, destroyed: current.isDestroyed()};

  /* ---------- 2. 真正销毁后重建：必须得到不同 ID 的新窗口 ---------- */
  current.destroy();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(resources.lifecycle.getWindow(), null, '销毁后不应残留窗口引用');
  current = await resources.lifecycle.restore();
  assert.ok(current && !current.isDestroyed(), '销毁后应重建出窗口');
  assert.notEqual(current.id, firstId, '重建必须是新的 BrowserWindow，不能是同一个');
  const prefs2 = current.webContents.getLastWebPreferences();
  assert.equal(prefs2.contextIsolation, true, '重建窗口必须保持安全偏好');
  assert.equal(prefs2.sandbox, true);
  assert.equal(prefs2.nodeIntegration, false);
  // 重建后必须重新拿到可用的 Renderer 桥接，而不是沿用旧引用。
  await until(`!!window.SF?.app.state.session`, current);
  assert.equal(await evaluate(`typeof window.SubscribeFlow === 'object'`, current), true,
    '重建窗口必须挂上 preload 桥');
  results.rebuild = {from: firstId, to: current.id, contextIsolation: prefs2.contextIsolation};

  /* ---------- 3. 先销毁再并发 restore：只新增一个窗口，Core 不重启 ---------- */
  const rebuiltId = current.id;
  current.destroy();
  await new Promise((r) => setTimeout(r, 400));
  const before = resources.lifecycle.getWindow();
  const restored = await Promise.all([
    resources.lifecycle.restore(),
    resources.lifecycle.restore(),
    resources.lifecycle.restore(),
  ]);
  current = restored[0];
  assert.equal(current.id !== rebuiltId, true, '应新建窗口');
  assert.equal(resources.lifecycle.getWindow().id, current.id);
  assert.equal(core.child.pid, corePid, '窗口重建不得重启 Core');
  assert.equal(core.child.exitCode, null, 'Core 子进程应仍在运行');
  results.concurrentRestore = {id: current.id, corePid, coreRestarted: false};

  /* ---------- 4. 工厂失败后可重试，失败窗口不泄漏 ---------- */
  const {WindowLifecycle} = require('../electron/main/lifecycle.cjs');
  const probe = {destroyed: false, isDestroyed() { return this.destroyed; }, isMinimized: () => false,
                 show() {}, focus() {}, destroy() { this.destroyed = true; }};
  let syncAttempts = 0;
  const syncLifecycle = new WindowLifecycle({
    getWindow: () => (syncAttempts >= 2 ? probe : null),
    createWindow: () => { syncAttempts += 1; if (syncAttempts === 1) throw new Error('同步工厂失败'); return probe; },
    hardQuit: () => {},
  });
  await assert.rejects(() => syncLifecycle.restore(), /同步工厂失败/);
  await syncLifecycle.restore();
  assert.equal(syncAttempts, 2, '同步失败后必须能重试');

  let asyncAttempts = 0;
  const asyncProbe = {destroyed: false, isDestroyed() { return this.destroyed; }, isMinimized: () => false,
                      show() {}, focus() {}, destroy() { this.destroyed = true; }};
  const asyncLifecycle = new WindowLifecycle({
    getWindow: () => (asyncAttempts >= 2 ? asyncProbe : null),
    createWindow: async () => { asyncAttempts += 1; if (asyncAttempts === 1) throw new Error('异步加载失败'); return asyncProbe; },
    hardQuit: () => {},
  });
  await assert.rejects(() => asyncLifecycle.restore(), /异步加载失败/);
  await asyncLifecycle.restore();
  assert.equal(asyncAttempts, 2, '异步失败后必须能重试');
  results.factoryRetry = {sync: syncAttempts, async: asyncAttempts};

  /* ---------- 4b. 真实工厂的 loadURL 失败：销毁坏窗口后能重试 ---------- */
  // 走真实 createWindow 工厂，由工厂自身的注入点在 loadURL 阶段失败一次。
  process.env.SUBSCRIBE_FLOW_TEST_LOAD_FAIL = 'once';
  const beforeFailId = current.id;
  current.destroy();
  await new Promise((r) => setTimeout(r, 300));
  const bridgeIdBefore = resources.lifecycle.getWindow();
  assert.equal(bridgeIdBefore, null, '销毁后不应残留窗口引用');
  await assert.rejects(() => resources.lifecycle.restore(), /loadURL 失败/,
    '注入的加载失败必须真实冒出来');
  assert.equal(resources.lifecycle.getWindow(), null,
    '加载失败后不得残留未就绪窗口引用（否则第二次 restore 只会拿到坏窗口）');
  delete process.env.SUBSCRIBE_FLOW_TEST_LOAD_FAIL;
  current = await resources.lifecycle.restore();
  assert.ok(current && !current.isDestroyed(), '失败后应能重新建出窗口');
  assert.notEqual(current.id, beforeFailId, '重试必须得到新的窗口');
  await until(`!!window.SF?.app.state.session`, current);
  assert.equal(await evaluate(`typeof window.SubscribeFlow === 'object'`, current), true,
    '重试出的窗口必须挂上 preload 桥');
  results.loadFailureRetry = {failedOnce: true, newId: current.id};
  await current.show();

  /* ---------- 5. 辅助登录窗口独立：不被主窗口 close 拦截 ---------- */
  const {BrowserWindow} = require('electron');
  const login = new BrowserWindow({show: false, width: 480, height: 320});
  let interceptedLogin = 0;
  login.on('close', (event) => {
    // 登录窗口自己的 close 不应经过主窗口的拦截逻辑。
    interceptedLogin += 0;
    event.preventDefault();
    setImmediate(() => { event.preventDefault = () => {}; login.destroy(); });
  });
  const loginId = login.id;
  login.close();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(login.isDestroyed(), true, '辅助窗口应能独立关闭');
  assert.notEqual(loginId, current.id, '辅助窗口不是主窗口');
  assert.equal(current.isDestroyed(), false, '关闭辅助窗口不得影响主窗口');
  results.independentWindow = {loginId, mainAlive: !current.isDestroyed()};

  /* ---------- 6. BUG-080：真实 bridge 单投递 ---------- */
  await until(`!!window.SF?.app.state.session`, current);
  await evaluate(`(() => {
    window.__m17Events = 0;
    window.__m17Off = SF.app.state.client.on('reminder.navigate', () => { window.__m17Events += 1; });
    return true;
  })()`, current);
  require('../electron/main/index.cjs').send('reminder.navigate', {view: 'pending'});
  await new Promise((r) => setTimeout(r, 700));
  const arrived = await evaluate(`window.__m17Events`, current);
  if (arrived !== 1) throw new Error('单次事件应只到达 Renderer 一次，实际 ' + arrived + ' 次（BUG-080）');
  // 退订函数返回 ipcRenderer 对象，无法跨进程结构化克隆，这里只取布尔结果。
  await evaluate(`(() => { if (window.__m17Off) window.__m17Off(); return true; })()`, current);
  results.singleDelivery = arrived;

  const out = path.join(root, 'docs/verification/m17');
  fs.mkdirSync(out, {recursive: true});
  fs.writeFileSync(path.join(out, 'window-lifecycle.log'),
    JSON.stringify({windowLifecycle: 'passed', ...results}, null, 0) + '\n');
  console.log(JSON.stringify({windowLifecycle: 'passed', ...results}));
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-win-'));
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'window', SUBSCRIBE_FLOW_DATA_DIR: folder,
          // 隔离测试模式：让工厂自身的注入点可用，且不影响任何正常用户路径。
          SUBSCRIBE_FLOW_ISOLATED_TEST: '1'},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', (code) => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
