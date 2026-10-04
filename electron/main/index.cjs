const { app, BrowserWindow, ipcMain, protocol, shell, powerMonitor } = require('electron');
const { readFileSync, promises: fs } = require('node:fs');
const path = require('node:path');
const { CoreClient } = require('./core-client.cjs');
const { CORE_METHODS, DESKTOP_METHODS } = require('./methods.cjs');
const { UI_METHODS, callUI } = require('./app-client.cjs');
const {openSavedLink} = require('./external-links.cjs');
const {BilibiliSession} = require('./bilibili-session.cjs');

const root = path.resolve(__dirname, '../..');
const APP_URL = 'app://subscribe-flow/index.html';
const smoke = process.env.SUBSCRIBE_FLOW_DESKTOP_SMOKE === '1';
const rendererSmoke = process.env.SUBSCRIBE_FLOW_RENDERER_SMOKE;
const diagnostics = smoke || process.env.SUBSCRIBE_FLOW_DIAGNOSTICS === '1';
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Subscribe Flow');
if (process.env.SUBSCRIBE_FLOW_DATA_DIR) app.setPath('userData', process.env.SUBSCRIBE_FLOW_DATA_DIR);
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(start).catch(error => { console.error(error.message); app.exit(1); });

let window, core, bilibili;
let lastStatus = {state: 'starting'};
let quitting = false;
let suspended = false, powerUpdate = Promise.resolve();

function send(event, data) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('subscribe-flow:event', event, data);
}
async function start() {
  let runtime = {};
  try { runtime = JSON.parse(readFileSync(path.join(root, '.runtime-paths.json'), 'utf8')); }
  catch { /* The window reports missing runtime configuration. */ }
  bilibili = new BilibiliSession({offline:smoke || rendererSmoke === 'offline', onChanged:async () => {
    if (quitting || !core?.ready) return;
    try { await core.call('connection.check',{connection_id:'bilibili:default'}); send('channels',null); }
    catch { /* The connection panel can retry a failed check. */ }
  }});
  core = new CoreClient({ ...runtime, python: process.env.SUBSCRIBE_FLOW_PYTHON || runtime.python,
    root, dataDir: app.getPath('userData'), autoRestart:!smoke && !rendererSmoke,
    acquisition:(params,signal) => bilibili.request(params,signal) });
  const updatePower = () => {
    const value = suspended;
    powerUpdate = powerUpdate.catch(() => {}).then(() => core.ready && core.call('system.power',{suspended:value}));
    powerUpdate.catch(() => {});
  };
  powerMonitor.on('suspend', () => { suspended = true; updatePower(); });
  powerMonitor.on('resume', () => { suspended = false; updatePower(); });
  core.on('status', status => { lastStatus = status; send('core.status', status); if (status.state === 'ready' && suspended) updatePower(); });
  core.on('notification', (event, data) => {
    if (!['sync.changed', 'content.changed', 'subscription.changed', 'scheduler.changed'].includes(event)) return;
    send(event, data);
    const aliases = {'sync.changed': ['run', 'runs'], 'content.changed': ['content'], 'subscription.changed': ['channels'], 'scheduler.changed':['channels']};
    for (const alias of aliases[event]) send(alias, null); // Invalidation; consumers re-query durable state.
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
      if (UI_METHODS.has(name)) return {ok: true, value: await callUI(core, name, params)};
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('业务参数必须是对象');
      let value;
      if (name === 'core.status') value = lastStatus;
      else if (name === 'core.restart') value = await core.restart();
      else if (name === 'connection.login') {
        if (Object.keys(params).length !== 1 || params.connection_id !== 'bilibili:default') throw new Error('登录连接无效');
        value = bilibili.openLogin(window);
      }
      else if (name === 'content.open' || name === 'source.open') {
        value = await openSavedLink(core, name, params, url => shell.openExternal(url));
      } else value = await core.call(name, params);
      return {ok: true, value};
    } catch (error) {
      return {ok: false, error: {code: error.code || 'DESKTOP_ERROR', message: error.message, ...(error.data || {})}};
    }
  });
  window = new BrowserWindow({ width: diagnostics ? 1000 : 1440, height: diagnostics ? 760 : 1000, minWidth: diagnostics ? 680 : 800, minHeight: diagnostics ? 500 : 600, show: !smoke && !rendererSmoke,
    title: diagnostics ? 'Subscribe Flow · 开发联调' : '知流 · Subscribe Flow', webPreferences: {preload: path.join(root, 'electron', 'preload', 'index.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false,
      backgroundThrottling: !smoke && !rendererSmoke} });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  await window.loadURL(APP_URL);
  try { await core.start(); }
  catch (error) { lastStatus = {state: 'error', message: error.message}; send('core.status', lastStatus); if (smoke || rendererSmoke) throw error; }
  if (rendererSmoke) {
    try {
      await require('../../scripts/renderer-smoke.cjs').verify({window, core, root, mode:rendererSmoke});
      await core.stop(); quitting = true; app.quit();
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
app.on('second-instance', () => { if (window && !window.isDestroyed()) { window.show(); window.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting || !core) return;
  event.preventDefault();
  quitting = true;
  Promise.allSettled([core.stop(), bilibili?.close()]).finally(() => app.quit());
});
