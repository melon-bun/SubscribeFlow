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
const {TrayController} = require('./tray.cjs');
const {WindowLifecycle} = require('./lifecycle.cjs');

const root = path.resolve(__dirname, '../..');
const APP_URL = 'app://subscribe-flow/index.html';
const smoke = !app.isPackaged && process.env.SUBSCRIBE_FLOW_DESKTOP_SMOKE === '1';
const rendererSmoke = !app.isPackaged && process.env.SUBSCRIBE_FLOW_RENDERER_SMOKE;
const diagnostics = smoke || (!app.isPackaged && process.env.SUBSCRIBE_FLOW_DIAGNOSTICS === '1');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Subscribe Flow');
if (process.env.SUBSCRIBE_FLOW_DATA_DIR) app.setPath('userData', process.env.SUBSCRIBE_FLOW_DATA_DIR);
const diagnostic = createDiagnostics(app.getPath('userData'));
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(start).catch(() => {
  diagnostic('app.error');
  dialog.showErrorBox('知流无法启动', '应用资源无法读取，请重新解压完整应用。应用数据目录中的订阅与内容会保留。');
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
let suspended = false, powerUpdate = Promise.resolve();

/** 导航意图投递：页面或 Core 未就绪时挂起，就绪后补发（BUG-076）。 */
async function deliverNavigation(intent, target) {
  const win = target || (window && !window.isDestroyed() ? window : null);
  if (!win || win.isDestroyed()) return false;
  // CoreClient 只发 status 事件，没有 status 属性；用 resources.ready 判定。
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
async function wireReminders({persisted = true} = {}) {
  const core = resources.core, scheduler = resources.scheduler;
  if (!core || !scheduler) return;
  try {
    // 先读配置，再读持久记录：applySettings 会写运行状态，顺序反了会覆盖原记录。
    const settings = await core.call('settings.get');
    scheduler.applySettings(settings, {persist: false});
    const state = persisted ? await core.call('reminder.state') : null;
    scheduler.restore(state);
  } catch (error) {
    diagnostic('reminder.wire', {error: error.message});
  }
}

/** 只响应真正变化的提醒配置；无关 AI 保存不重置计时。 */
function applyReminderSettings(settings) {
  const scheduler = resources.scheduler;
  if (!scheduler || !settings) return false;
  return scheduler.applySettings(settings);
}

function send(event, data, target) {
  // 每次只投递一次：早期版本在带 target 的同时又无条件广播一次，导致
  // core.status、内容失效与导航事件全部翻倍（BUG-080）。
  const win = target || window;
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('subscribe-flow:event', event, data);
  }
}
/**
 * 主窗口工厂。初始窗口与「销毁后重建」共用同一套安全配置、URL 加载与
 * close/closed 绑定——重建出来的窗口不得比初始窗口更宽松。
 */
async function createWindow() {
  window = new BrowserWindow({ width: diagnostics ? 1000 : 1440, height: diagnostics ? 760 : 1000, minWidth: diagnostics ? 680 : 800, minHeight: diagnostics ? 500 : 600, show: !smoke && !rendererSmoke,
    title: diagnostics ? 'Subscribe Flow · 开发联调' : '知流 · Subscribe Flow', webPreferences: {preload: path.join(root, 'electron', 'preload', 'index.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false,
      backgroundThrottling: !smoke && !rendererSmoke} });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('closed', () => { if (window && window.isDestroyed()) window = null; });
  window.on('close', event => { if (resources.lifecycle) resources.lifecycle.interceptClose(event); });
  await window.loadURL(APP_URL);
  return window;
}

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
    now: () => Date.now(),
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
    }).catch(() => {}),
  });
  let lifecycleRef = null, schedulerRef = scheduler, trayRef = null;
  const notifier = new ReminderNotification({NotificationCtor: Notification});
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
  powerMonitor.on('resume', () => { suspended = false; updatePower(); });
  core.on('status', status => { diagnostic('core.status', status); lastStatus = status; send('core.status', status); if (status.state === 'ready' && suspended) updatePower();
    // Core 重启后内存里的密钥就没了，重新推送一次，运行时才不会以为没有密钥。
    if (status.state === 'ready') settingsBridge.sync().catch(() => {});
    resources.ready = status.state === 'ready';
    if (resources.ready) {
      flushNavigationIntent();
      if (resources.tray) void resources.tray.refresh();
    } else if (resources.tray) {
      void resources.tray.refresh(); // 失联时菜单要如实显示不可用
    } });
  core.on('notification', (event, data) => {
    if (!['sync.changed', 'intake.changed', 'content.changed', 'subscription.changed', 'scheduler.changed', 'tags.changed'].includes(event)) return;
    send(event, data);
    // 标签变动同时影响侧栏计数：内容收件箱据此重取标签目录，
    // 否则目录被标记为已加载且为空，新建标签在收件箱里会看不到。
    const aliases = {'sync.changed': ['run', 'runs'], 'content.changed': ['content'], 'subscription.changed': ['channels'], 'scheduler.changed':['channels'], 'tags.changed': ['content']};
    for (const alias of aliases[event] || []) send(alias, null); // Invalidation; consumers re-query durable state.
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
        // 保存成功后才响应提醒配置变化；无关 AI 保存不重置间隔（BUG-074）。
        if (name === 'saveSettings') applyReminderSettings(value);
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
  // M17：托盘在窗口就绪后建立，失败不阻断启动。
  ensureTray();
  try { await core.start(); }
  catch (error) { lastStatus = {state: 'error', message: error.message}; diagnostic('core.status', lastStatus); send('core.status', lastStatus); if (smoke || rendererSmoke) throw error; }
  // Core ready 之后才接线提醒：之前这段在 core.start() 之前调用 settings.get，
  // CoreClient 未 ready 直接拒绝，错误还被空 catch 吞掉（BUG-074）。
  // 只在纯桌面 smoke 下跳过；renderer smoke（含 M17）走与产品相同的初始化。
  if (rendererSmoke !== 'offline' || !rendererSmoke) void wireReminders();
  if (rendererSmoke) {
    try {
      if (rendererSmoke === 'zhihu') await require('../../scripts/zhihu-renderer.cjs').verify({window,core,root,zhihu,fixture:zhihuFixture});
      else if (rendererSmoke === 'wechat') await require('../../scripts/wechat-renderer.cjs').verify({window,core,root,wechat,fixture:wechatFixture});
      else if (rendererSmoke === 'intake') await require('../../scripts/intake-renderer.cjs').verify({window,core,root,fixture:intakeFixture});
      else if (rendererSmoke === 'xhs') await require('../../scripts/xiaohongshu-renderer.cjs').verify({window,core,root,xiaohongshu,fixture:xhsFixture});
      else if (rendererSmoke === 'm17') await require('../../scripts/m17-renderer.cjs').verify({window,core,root});
      else if (rendererSmoke === 'settings') await require('../../scripts/settings-renderer.cjs').verify({window,core,root});
      else await require('../../scripts/renderer-smoke.cjs').verify({window, core, root, mode:rendererSmoke});
      await core.stop(); await channels.close(); quitting = true; app.quit();
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
      await core.stop();
      quitting = true;
      app.quit();
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

module.exports = {start, __resources: resources};
