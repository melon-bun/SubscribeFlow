const { app, BrowserWindow, ipcMain, protocol, shell, powerMonitor, Menu, dialog, Notification } = require('electron');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { CoreClient } = require('./core-client.cjs');
const { CORE_METHODS, DESKTOP_METHODS } = require('./methods.cjs');
const { UI_METHODS, callUI } = require('./app-client.cjs');
const {openSavedLink} = require('./external-links.cjs');
const {BilibiliSession} = require('./bilibili-session.cjs');
const {XiaohongshuSession} = require('./xiaohongshu-session.cjs');
const {ZhihuSession} = require('./zhihu-session.cjs');
const {WechatSession} = require('./wechat-session.cjs');
const {ChannelSessions} = require('./channel-sessions.cjs');
const {resolveRuntime} = require('./runtime.cjs');
const {createDiagnostics} = require('./diagnostics.cjs');
const {CredentialService} = require('./credentials.cjs');
const {SettingsBridge} = require('./settings-bridge.cjs');
const {ReminderScheduler} = require('./reminders.cjs');
const {ReminderNotification} = require('./reminder-notification.cjs');
const {PriorityLabels} = require('./priority-labels.cjs');
const {TrayController} = require('./tray.cjs');
const {WindowLifecycle} = require('./lifecycle.cjs');
const {classifyStartupFailure, startupFailureRecord} = require('./startup-errors.cjs');

const root = path.resolve(__dirname, '../..');
const APP_URL = 'app://subscribe-flow/index.html';
const smoke = !app.isPackaged && process.env.SUBSCRIBE_FLOW_DESKTOP_SMOKE === '1';
// 隔离测试模式：只有在明确打开它且非打包版时，测试注入才可能生效。
const isolatedTest = !app.isPackaged && process.env.SUBSCRIBE_FLOW_ISOLATED_TEST === '1';
let loadFailureBudget = 0;
const rendererSmoke = !app.isPackaged && process.env.SUBSCRIBE_FLOW_RENDERER_SMOKE;
const diagnostics = smoke || (!app.isPackaged && process.env.SUBSCRIBE_FLOW_DIAGNOSTICS === '1');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Subscribe Flow');
if (process.env.SUBSCRIBE_FLOW_DATA_DIR) app.setPath('userData', process.env.SUBSCRIBE_FLOW_DATA_DIR);
const diagnostic = createDiagnostics(app.getPath('userData'));
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(start).catch((error) => {
  // 过去这里是空 catch：任何内部代码异常都被说成「资源无法读取，请重新解压」，
  // 真实根因完全丢失（BUG-082）。
  const failure = classifyStartupFailure(error);
  const record = startupFailureRecord(error, 'start');
  diagnostic('app.startup.failed', record);
  // smoke 与 CI 必须能看到真实原因并以非零退出，不能用静默弹窗掩盖。
  console.error(`[startup:${record.kind}] ${record.name || ''} ${record.message}`);
  if (record.stack) console.error(record.stack);
  if (smoke || rendererSmoke) {
    process.stderr.write(`startup failed (${record.kind}): ${record.message}\n`);
    app.exit(1);
    return;
  }
  dialog.showErrorBox(failure.title, failure.detail + '\n\n错误：' + failure.message);
  app.exit(1);
});

let window, core, bilibili, xiaohongshu, zhihu, wechat;
const channels = new ChannelSessions();
let lastStatus = {state: 'starting'};
let quitting = false;
/**
 * 应用级资源。顶层 activate／second-instance／window-all-closed／before-quit
 * 都要用到它们，放在 start() 局部会让这些回调抛 ReferenceError（BUG-075）。
 */
const resources = {core: null, channels: null, scheduler: null, tray: null, lifecycle: null,
                   notifier: null, ready: false, navigateIntent: null};
/**
 * M20 优先级显示名。提醒通知与托盘菜单在主进程生成，改名后这里要跟着更新，
 * 否则用户改完名字看到的仍是旧名称。只影响文案，不影响统计口径与提醒周期。
 */
const priorityLabels = new PriorityLabels();

/** 把设置里的优先级名称应用到主进程；拿不到就用默认名，不阻断提醒。 */
function applyPriorityNames(settings) {
  if (!settings || !settings.priority) return false;
  priorityLabels.apply(settings.priority.names);
  return true;
}
let suspended = false, powerUpdate = Promise.resolve();

/** 导航意图投递：页面或 Core 未就绪时挂起，就绪后补发（BUG-076）。 */
async function deliverNavigation(intent, target) {
  const win = target || (window && !window.isDestroyed() ? window : null);
  if (!win || win.isDestroyed()) return false;
  // CoreClient 只有 status 事件、没有 status 属性；就绪状态由事件维护在 resources.ready。
  if (!resources.ready || !resources.core) {
    resources.navigateIntent = intent; // 等 ready 后由 flushNavigationIntent 补发
    return false;
  }
  send('reminder.navigate', intent, win);
  return true;
}

function flushNavigationIntent() {
  if (!resources.navigateIntent || !resources.ready) return false;
  if (!window || window.isDestroyed()) return false;
  send('reminder.navigate', resources.navigateIntent);
  resources.navigateIntent = null;
  return true;
}

/** 提醒接线：Core ready 后按持久契约初始化，再决定恢复还是新建周期（BUG-074）。 */
async function wireReminders() {
  const core = resources.core, scheduler = resources.scheduler;
  if (!core || !scheduler) return;
  if (resources.reminderWiring) return resources.reminderWiring;
  // 幂等：Core ready、Core 重启与 resume 共用这一条路径，连续触发只会接线一次。
  resources.reminderWiring = (async () => {
    try {
      // 顺序很重要：先读当前设置，再读与之匹配的持久状态，最后才决定恢复还是
      // 新建周期。反过来会先建周期再把旧状态读进来覆盖它。
      const settings = await core.call('settings.get');
      applyPriorityNames(settings);
      const state = await core.call('reminder.state').catch((error) => {
        diagnostic('reminder.state.read', {phase: 'reminder-state-read',
          name: error.name || null, message: String(error.message || error).slice(0, 300)});
        return null;
      });
      scheduler.applySettings(settings, {persist: false});
      scheduler.restore(state);
    } catch (error) {
      diagnostic('reminder.wire.failed', {phase: 'reminder-wire',
        name: error.name || null, message: String(error.message || error).slice(0, 300)});
    } finally {
      resources.reminderWiring = null;
    }
  })();
  return resources.reminderWiring;
}

/** 只响应真正变化的提醒配置；无关 AI 保存不重置计时。 */
function applyReminderSettings(settings) {
  const scheduler = resources.scheduler;
  if (!scheduler || !settings) return false;
  return scheduler.applySettings(settings);
}

function send(event, data, target) {
  // 每次只向指定目标投递一次（BUG-080）。此前带 target 发送后还会无条件广播一次，
  // 导致 core.status、内容失效与导航事件全部翻倍。
  const win = target || window;
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('subscribe-flow:event', event, data);
  }
}
/**
 * 主窗口工厂。初始窗口与「销毁后重建」共用同一套安全配置、URL 加载与事件绑定
 * ——重建出来的窗口不得比初始窗口更宽松。
 *
 * 注意 API 归属：setWindowOpenHandler 在 webContents 上，权限请求／检查处理器在
 * webContents.session 上。写错对象就是 BUG-082 的直接根因。
 */
async function createWindow() {
  // 启动异常注入**只在显式的隔离测试模式**下生效。
  // 打包版必须完全忽略这些环境变量。早前这里对打包版无条件抛错，
  // 等于让所有正式包无论有没有标志都拒启动（BUG-083）。
  if (!app.isPackaged && isolatedTest && process.env.SUBSCRIBE_FLOW_TEST_CRASH === 'type') {
    throw new TypeError('test-injected: window.webContents.session.setWindowOpenHandler is not a function');
  }
  // 工厂加载失败的注入点：正常建窗，只让随后的 loadURL 失败一次，
  // 走的正是生产里「加载失败要销毁并清引用」的那条清理路径。
  const injectLoadFailure = !app.isPackaged && isolatedTest
    && process.env.SUBSCRIBE_FLOW_TEST_LOAD_FAIL === 'once'
    && (loadFailureBudget += 1) === 1;
  const created = new BrowserWindow({ width: diagnostics ? 1000 : 1440, height: diagnostics ? 760 : 1000, minWidth: diagnostics ? 680 : 800, minHeight: diagnostics ? 500 : 600, show: !smoke && !rendererSmoke,
    title: diagnostics ? 'Subscribe Flow · 开发联调' : '知流 · Subscribe Flow', webPreferences: {preload: path.join(root, 'electron', 'preload', 'index.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false,
      backgroundThrottling: !smoke && !rendererSmoke} });
  // 必须立即登记：Renderer 会在 loadURL 期间就发 IPC，来源校验比对的是这个引用。
  // 放在 loadURL 之后会让新窗口的所有请求被判为「请求来源无效」。
  window = created;
  created.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  created.webContents.session.setPermissionCheckHandler(() => false);
  created.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  created.webContents.on('will-navigate', event => event.preventDefault());
  created.webContents.on('will-attach-webview', event => event.preventDefault());
  try {
    if (injectLoadFailure) throw new Error('test-injected: loadURL 失败');
    await created.loadURL(APP_URL);
  } catch (error) {
    // 加载失败必须销毁自己并清掉引用：否则 window 仍指向一个坏窗口，
    // 下一次 restore 会先看到它就直接返回，既不重试也永不销毁（BUG-075）。
    try { if (!created.isDestroyed()) created.destroy(); } catch { /* 已失效 */ }
    if (window === created) window = null;
    throw error;
  }
  // 绑定顺序与原实现一致：loadURL 之后才挂 close/closed。
  // closed 只清理「自己仍是当前窗口」的情况，旧窗口的迟到回调不得清掉新引用（BUG-075）。
  created.on('closed', () => { if (window === created) window = null; });
  created.on('close', event => { if (resources.lifecycle) resources.lifecycle.interceptClose(event); });
  return created;
}

globalThis.__m17Send = send;

async function start() {
  const runtime = resolveRuntime({packaged: app.isPackaged, resourcesPath: process.resourcesPath, root});
  diagnostic('app.start', {version: app.getVersion(), electron: process.versions.electron, platform: process.platform, arch: process.arch, packaged: app.isPackaged});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label: '知流', submenu: [{role:'about'}, {type:'separator'}, {role:'hide'}, {role:'hideOthers'}, {role:'unhide'}, {type:'separator'}, {role:'quit'}]},
    {role:'editMenu'}, {role:'viewMenu'}, {role:'windowMenu'},
    {label:'帮助', submenu:[
      {label:'打开应用数据目录', click:()=>void shell.openPath(app.getPath('userData'))},
      {label:'打开诊断记录', click:async()=>{const folder=path.join(app.getPath('userData'),'diagnostics'); await fs.mkdir(folder,{recursive:true}); await shell.openPath(folder);}},
      {label:'使用与备份说明', click:()=>void dialog.showMessageBox(window,{type:'info',title:'知流使用说明',message:'订阅、同步与备份',detail:'在渠道管理中登录 B站、小红书或知乎，按昵称搜索并确认作者后添加订阅，再手动刷新。默认手动，可切换自动；间隔默认 24 小时，最大 72 小时。自动采集需要应用保持运行。\n\n备份：退出所有知流窗口后，复制整个应用数据目录。升级前会自动备份数据库。恢复前先退出应用并另存当前目录，再还原备份。不要把旧版数据库文件与当前 WAL 文件混用。\n\n登录会话独立于 Chrome。登录过期时在应用内重新登录。可在渠道管理设置来源默认优先级，在内容详情单独设置，并在内容总览切换优先级模式。可创建人工标签并筛选内容。标签规则与完整历史覆盖暂不支持。'})},
    ]},
  ]));
  app.setAboutPanelOptions({applicationName:'知流 · Subscribe Flow', applicationVersion:app.getVersion()});
  bilibili = new BilibiliSession({offline:smoke || (!!rendererSmoke && !['live','intake'].includes(rendererSmoke)), onChanged:async () => {
    if (quitting || !core?.ready) return;
    try { await core.call('connection.check',{connection_id:'bilibili:default'}); send('channels',null); }
    catch { /* The connection panel can retry a failed check. */ }
  }});
  xiaohongshu = new XiaohongshuSession({offline:smoke || rendererSmoke === 'offline', ...(['xhs','intake'].includes(rendererSmoke) ? {apiOptions:{delay:0,jitter:0}} : {}), onChanged:async () => {
    if (quitting || !core?.ready) return;
    try { await core.call('connection.check',{connection_id:'xiaohongshu:default'}); send('channels',null); }
    catch { /* A manual connection check remains available. */ }
  }});
  zhihu = new ZhihuSession({offline:smoke || (!!rendererSmoke && rendererSmoke !== 'zhihu'),
    ...(rendererSmoke === 'zhihu' ? {apiOptions:{delay:0}} : {}), onChanged:async () => {
      if (quitting || !core?.ready) return;
      try {await core.call('connection.check',{connection_id:'zhihu:default'});send('channels',null);}catch {}
    }});
  channels.register('zhihu',zhihu);
  channels.register('bilibili',bilibili);
  channels.register('xiaohongshu',xiaohongshu);
  // 微信只做单条文章读取：没有登录窗口，也不参与任何其他渠道的调度。
  wechat = new WechatSession({offline: smoke || (!!rendererSmoke && !['wechat','intake'].includes(rendererSmoke)),
    ...(['wechat','intake'].includes(rendererSmoke) ? {apiOptions:{minGap:0}} : {})});
  channels.register('wechat',wechat);
  const xhsFixture = rendererSmoke === 'xhs' ? require('../../scripts/xiaohongshu-fixture.cjs').install(xiaohongshu.session) : null;
  const intakeFixture = rendererSmoke === 'intake' ? await require('../../scripts/intake-fixture.cjs').install(bilibili,xiaohongshu) : null;
  const zhihuFixture = rendererSmoke === 'zhihu' ? await require('../../scripts/zhihu-fixture.cjs').install(zhihu.session) : null;
  const wechatFixture = rendererSmoke === 'wechat' ? await require('../../scripts/wechat-fixture.cjs').install(wechat.session) : null;
  core = new CoreClient({ ...runtime,
    root, dataDir: app.getPath('userData'), autoRestart:!smoke && !rendererSmoke,
    ...(rendererSmoke === 'zhihu' ? {schedulePolicy:{resource_gap:0}} : {}),
    acquisition:(params,signal) => channels.request(params,signal) });
  // M15：普通配置走 Core；Main 加密保管密钥，只经私有桥推送到 Core 内存。
  const settingsBridge = new SettingsBridge({core, credentials: new CredentialService({dir: app.getPath('userData')})});

  // M17：提醒调度器。计时在 Main，Renderer 隐藏／重载／崩溃都不影响。
  // 统计走 Core 的 reminder.summary，运行状态经 reminder.state 持久化。
  const scheduler = new ReminderScheduler({
    // 隔离测试模式下时钟可由验收脚本推进，驱动的是同一个正式定时器回调。
    now: () => (typeof resources.testClock === 'function' ? resources.testClock() : Date.now()),
    // 隔离测试模式下定时器也可控；生产恒为真实 setTimeout。
    setTimer: (fn, ms) => (typeof resources.testSetTimer === 'function' ? resources.testSetTimer(fn, ms) : setTimeout(fn, ms)),
    clearTimer: (handle) => (typeof resources.testClearTimer === 'function' ? resources.testClearTimer(handle) : clearTimeout(handle)),
    summary: () => core.call('reminder.summary'),
    notify: (summary, context) => postReminder(summary, context),
    persist: (state) => core.call('reminder.state.save', {
      signature: state.signature,
      generation: state.generation,
      next_check_at: state.nextCheckAt,
      last_handled_at: state.lastHandledAt,
      last_result: state.lastResult,
      notification_error: state.notificationError,
      backoff_index: state.backoffIndex,
    }).catch((error) => {
      // 持久化失败必须留下证据，不能静默吞掉：否则「以为存住了」和「真的存住了」
      // 无法区分。CONFLICT 表示这次写入被判定为迟到，属于预期内，记录即可。
      const expected = error.code === 'CONFLICT';
      diagnostic('reminder.persist.failed', {
        phase: 'reminder-state-save',
        kind: expected ? 'conflict' : 'error',
        name: error.name || null,
        message: String(error.message || error).slice(0, 300),
      });
      if (!expected) {
        const line = '[reminder] 运行状态未能保存：' + (error.message || error);
        if (rendererSmoke) process.stderr.write(line + '\n');
        console.error(line);
      }
    }),
  });
  let lifecycleRef = null, schedulerRef = scheduler, trayRef = null;
  // 通知构造器可注入：仅隔离测试模式替换 OS 边界，链路其余部分都是真的。
  const notifier = new ReminderNotification({
    NotificationCtor: Notification,
    // 延迟解析：隔离测试可在应用启动之后再替换 OS 通知边界。
    ctorProvider: () => (typeof resources.testNotificationCtor === 'function' ? resources.testNotificationCtor : Notification),
    priorityLabel: () => priorityLabels.high,
  });
  notifier.onClick = (view) => { void lifecycleRef.navigate({view}); };
  resources.notifier = notifier;

  /** 调度器回调：投递失败只记通知结果，不影响查询与周期（BUG-079）。 */
  function postReminder(summary, context) {
    if (context.kind === 'clear') return notifier.cancel();
    return notifier.post(summary);
  }

  const lifecycle = new WindowLifecycle({
    getWindow: () => window,
    createWindow: () => createWindow(),
    // 走共享 IPC 通道：preload 只监听 subscribe-flow:event，直接
    // webContents.send('reminder.navigate') 收不到（BUG-076）。
    deliver: async (intent, target) => deliverNavigation(intent, target),
    onQuitTasks: () => schedulerRef.halt(),
    closeResources: () => [core.stop(), channels.close()],
    destroyTray: () => { if (trayRef) { trayRef.destroy(); trayRef = null; resources.tray = null; } },
    hardQuit: () => { quitting = true; app.exit(0); },
  });
  lifecycleRef = lifecycle;
  resources.core = core; resources.channels = channels; resources.scheduler = scheduler;
  resources.lifecycle = lifecycle;

  let tray = null;
  function ensureTray() {
    if (tray) return tray;
    try {
      tray = new TrayController({
        summary: () => core.call('reminder.summary'),
        showWindow: () => { void lifecycleRef.restore(); },
        openList: (view) => { void lifecycleRef.navigate({view}); },
        // 设置菜单同样要等恢复完成再投递意图（BUG-076）。
        openSettings: () => { void lifecycleRef.navigate({view: 'settings'}); },
        quit: () => { void lifecycleRef.quit(); },
        iconPath: path.join(__dirname, '../../assets/logo.png'),
        template: process.platform === 'darwin',
        priorityLabel: () => priorityLabels.high,
        now: () => Date.now(),
      });
      trayRef = tray;
      tray.create();
      resources.tray = tray;
      void tray.refresh();
    } catch (error) {
      // 托盘建立失败：保留可访问的主窗口并说明原因，绝不隐藏成找不回来的进程。
      tray = null;
      trayRef = null;
      resources.tray = null;
      lifecycle.canHide = false;
      diagnostic('tray.create', {error: error.message});
      send('tray.status', {available: false, message: '托盘不可用，关闭主窗口会退出应用：' + error.message});
    }
    return tray;
  }
  const updatePower = () => {
    const value = suspended;
    powerUpdate = powerUpdate.catch(() => {}).then(() => core.ready && core.call('system.power',{suspended:value}));
    powerUpdate.catch(() => {});
  };
  powerMonitor.on('suspend', () => { suspended = true; updatePower(); });
  powerMonitor.on('resume', () => {
    suspended = false;
    updatePower();
    // 休眠恢复：从持久状态重新决定恢复还是合并一次过期检查，不重算周期。
    if (resources.scheduler && resources.ready) void wireReminders();
  });
  core.on('status', status => { diagnostic('core.status', status); lastStatus = status; send('core.status', status); if (status.state === 'ready' && suspended) updatePower();
    // Core 重启后内存里的密钥就没了，重新推送一次，运行时才不会以为没有密钥。
    if (status.state === 'ready') settingsBridge.sync().catch(() => {});
    const wasReady = resources.ready;
    resources.ready = status.state === 'ready';
    // Core 就绪（含重启后重新就绪）都走同一条幂等接线路径：
    // 连续 ready 事件不会重复建周期；wireReminders 内部有并发去重。
    if (resources.ready && !wasReady && resources.scheduler) void wireReminders();
    if (resources.ready) {
      flushNavigationIntent();
      if (resources.tray) void resources.tray.refresh();
    } else if (resources.tray) {
      void resources.tray.refresh(); // 失联时菜单要如实显示不可用，不伪造 0
    } });
  core.on('notification', (event, data) => {
    if (!['sync.changed', 'intake.changed', 'content.changed', 'subscription.changed', 'scheduler.changed', 'tags.changed', 'tagging.changed'].includes(event)) return;
    send(event, data);
    // 标签变动同时影响侧栏计数：内容收件箱据此重取标签目录，
    // 否则目录被标记为已加载且为空，新建标签在收件箱里会看不到。
    const aliases = {'sync.changed': ['run', 'runs'], 'content.changed': ['content'], 'subscription.changed': ['channels'], 'scheduler.changed':['channels'], 'tags.changed': ['content']};
    for (const alias of aliases[event] || []) send(alias, null); // Invalidation; consumers re-query durable state.
    // 内容状态与优先级变化会改变托盘上的两个数字，走合并刷新，不伪造 0。
    if (['content.changed', 'subscription.changed', 'scheduler.changed', 'tags.changed'].includes(event)) {
      if (resources.tray) resources.tray.scheduleRefresh();
    }
  });

  const pageRoot = path.join(root, 'electron', diagnostics ? 'diagnostics' : 'renderer');
  const assets = new Map();
  const types = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.jpg':'image/jpeg', '.png':'image/png'};
  async function registerAssets(folder, prefix = '') {
    for (const entry of await fs.readdir(folder, {withFileTypes:true})) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await registerAssets(path.join(folder, entry.name), relative + '/');
      else if (entry.isFile() && types[path.extname(entry.name)]) assets.set('/' + relative, [path.join(folder,entry.name), types[path.extname(entry.name)]]);
    }
  }
  await registerAssets(pageRoot);
  protocol.handle('app', async request => {
    const url = new URL(request.url);
    const asset = request.method === 'GET' && url.host === 'subscribe-flow' && assets.get(url.pathname);
    if (!asset) return new Response('Not found', {status:404});
    return new Response(await fs.readFile(asset[0]), {headers:{'Content-Type':asset[1], 'X-Content-Type-Options':'nosniff'}});
  });
  ipcMain.handle('subscribe-flow:call', async (event, name, params) => {
    try {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== APP_URL) throw new Error('请求来源无效');
      if (typeof name !== 'string' || ![CORE_METHODS, DESKTOP_METHODS, UI_METHODS].some(set => set.has(name))) throw new Error('不允许调用此方法');
      if (Buffer.byteLength(JSON.stringify(params) ?? '') > 60000) throw new Error('参数超过大小限制');
      if (UI_METHODS.has(name)) {
        const value = await callUI(core, name, params, {settings: settingsBridge});
        // 保存成功后才响应提醒配置变化（BUG-074）。
        if (name === 'saveSettings') {
          applyReminderSettings(value);
          // 优先级改名同样在保存成功后生效：提醒与托盘文案跟着换名。
          applyPriorityNames(value);
        }
        return {ok: true, value};
      }
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('业务参数必须是对象');
      let value;
      if (name === 'core.status') value = lastStatus;
      else if (name === 'core.restart') value = await core.restart();
      else if (name === 'connection.login') {
        if (Object.keys(params).length !== 1) throw new Error('登录连接无效');
        value = await channels.login(params.connection_id,window);
      }
      else if (name === 'content.open' || name === 'source.open') {
        value = await openSavedLink(core, name, params, url => shell.openExternal(url));
      }
      else value = await core.call(name, params);
      return {ok: true, value};
    } catch (error) {
      return {ok: false, error: {code: error.code || 'DESKTOP_ERROR', message: error.message, ...(error.data || {})}};
    }
  });
  await createWindow();
  // M17：托盘与提醒在窗口就绪后建立，失败不阻断启动。
  ensureTray();
  try { await core.start(); }
  catch (error) { lastStatus = {state: 'error', message: error.message}; diagnostic('core.status', lastStatus); send('core.status', lastStatus); if (smoke || rendererSmoke) throw error; }
  // Core ready 之后才接线提醒：之前这段在 core.start() 之前调用 settings.get，
  // CoreClient 未 ready 直接拒绝，错误还被空 catch 吞掉（BUG-074）。
  // 只读签名快照：供集成验收在 Renderer 侧等待保存真正落地。
  resources.reminderSignature = () => (scheduler ? scheduler.snapshot().signature : null);
  void wireReminders();
  // 人工验收入口：只有显式打开时才向真实桌面发一条测试通知。
  // 隔离在临时 userData，且不会改动用户的通知权限或偏好。
  if (!smoke && !rendererSmoke && !app.isPackaged && process.env.SUBSCRIBE_FLOW_NOTIFICATION_MANUAL === '1') {
    setTimeout(() => {
      const outcome = postReminder({pendingCount: 23, highUnarchivedCount: 5}, {kind: 'summary'});
      console.log('[manual-notification] 投递结果：' + JSON.stringify(outcome));
      console.log('[manual-notification] 若系统通知中心没有任何新消息，说明真实显示未通过。');
    }, 4000);
  }
  if (rendererSmoke) {
    try {
      if (rendererSmoke === 'zhihu') await require('../../scripts/zhihu-renderer.cjs').verify({window,core,root,zhihu,fixture:zhihuFixture});
      else if (rendererSmoke === 'wechat') await require('../../scripts/wechat-renderer.cjs').verify({window,core,root,wechat,fixture:wechatFixture});
      else if (rendererSmoke === 'intake') await require('../../scripts/intake-renderer.cjs').verify({window,core,root,fixture:intakeFixture});
      else if (rendererSmoke === 'xhs') await require('../../scripts/xiaohongshu-renderer.cjs').verify({window,core,root,xiaohongshu,fixture:xhsFixture});
      else if (rendererSmoke === 'flow') await require('../../scripts/m17-user-flow-renderer.cjs').verify({window,core,root});
      else if (rendererSmoke === 'reminder') await require('../../scripts/reminder-persistence-renderer.cjs').verify({window,core,root});
      else if (rendererSmoke === 'window') await require('../../scripts/window-lifecycle-renderer.cjs').verify({window,core,root});
      else if (rendererSmoke === 'm17') await require('../../scripts/m17-renderer.cjs').verify({window,core,root});
      else if (rendererSmoke === 'settings') await require('../../scripts/settings-renderer.cjs').verify({window,core,root});
      else if (rendererSmoke === 'v049') await require('../../scripts/v049-batch01-renderer.cjs').verify({window,core,root});
      else if (rendererSmoke === 'v049b2') await require('../../scripts/v049-batch02-renderer.cjs').verify({window,core,root});
      else if (rendererSmoke === 'v049b3') await require('../../scripts/v049-batch03-renderer.cjs').verify({window,core,root});
      else if (rendererSmoke === 'm26') await require('../../scripts/m26-notes-renderer.cjs').verify({window,core,root});
      else if (rendererSmoke === 'm27') await require('../../scripts/m27-note-editor-renderer.cjs').verify({window,core,root});
      else if (rendererSmoke === 'm28') await require('../../scripts/m28-notes-view-renderer.cjs').verify({window,core,root});
      else if (rendererSmoke === 'm29') await require('../../scripts/m29-summary-renderer.cjs').verify({window,core,root});
      else await require('../../scripts/renderer-smoke.cjs').verify({window, core, root, mode:rendererSmoke});
      // 验收同样走 M17 的统一退出流程，否则关窗仍会被拦截为隐藏到托盘。
      await lifecycle.quit();
      // flow 验收会替换 hardQuit 以断言清理结果，返回后仍须结束隔离进程。
      app.exit(0);
    } catch (error) { console.error(error); await core.stop(); app.exit(1); }
    return;
  }
  if (smoke) {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const bridge = window.SubscribeFlow;
        const resolved = await bridge.call('source.resolve', {locator:'946974',connection_id:'bilibili:default'});
        const subscription = await bridge.call('subscription.add', {locator:'946974',connection_id:'bilibili:default',confirmed:true});
        const job = await bridge.call('sync.start', {subscription_id:subscription.id});
        await bridge.call('sync.cancel', {job_id:job.job_id});
        let rejected = false;
        try { await bridge.call('os.system', {command:'invalid'}); } catch { rejected = true; }
        await bridge.call('core.restart');
        const subscriptions = await bridge.call('subscription.list');
        const content = await bridge.call('content.list');
        const ui = await bridge.call('listChannels', []);
        if (!rejected || subscriptions.length !== 1 || content.total !== 0 || ui.total !== 1) throw new Error('Desktop assertions failed');
        return {isolated: typeof require === 'undefined', source: resolved.external_id, rejected, persistedSubscriptions:subscriptions.length, contents:content.total, uiChannels:ui.total};
      })()`);
      if (!result.isolated) throw new Error('Node leaked into Renderer');
      await window.webContents.executeJavaScript('window.refreshDiagnostics()');
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const screenshot = await window.webContents.capturePage();
      await fs.mkdir(path.join(root, 'docs', 'verification'), {recursive: true});
      await fs.writeFile(path.join(root, 'docs', 'verification', 'm4-desktop.png'), screenshot.toPNG());
      console.log(JSON.stringify({desktopSmoke: 'passed', ...result}));
      await lifecycle.quit();
      app.exit(0);
    } catch (error) {
      console.error(error);
      await core.stop();
      app.exit(1);
    }
  }
}
// M17：托盘常驻时关闭全部窗口不退出；托盘未建立时才退出，避免应用无法找回。
app.on('second-instance', () => { if (resources.lifecycle) void resources.lifecycle.restore(); });
app.on('activate', () => { if (resources.lifecycle) void resources.lifecycle.restore(); });
// 托盘可用时关闭全部窗口不等于退出；托盘不可用时退出，避免进程无法找回。
app.on('window-all-closed', () => {
  if (!resources.lifecycle || !resources.lifecycle.canHide) app.quit();
});
// 统一退出入口：所有明确退出都走 lifecycle 的有界清理，不再有第二条无上限路径。
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  diagnostic('app.quit');
  if (resources.lifecycle) void resources.lifecycle.quit();
  else app.quit();
});

module.exports = {start, __resources: resources, createWindow, send, __wireReminders: wireReminders};
