const { app, BrowserWindow, ipcMain, protocol, shell } = require('electron');
const { readFileSync, promises: fs } = require('node:fs');
const path = require('node:path');
const { CoreClient } = require('./core-client.cjs');
const { CORE_METHODS, DESKTOP_METHODS } = require('./methods.cjs');
const { UI_METHODS, callUI } = require('./app-client.cjs');

const root = path.resolve(__dirname, '../..');
const APP_URL = 'app://subscribe-flow/index.html';
const smoke = process.env.SUBSCRIBE_FLOW_DESKTOP_SMOKE === '1';
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Subscribe Flow');
if (process.env.SUBSCRIBE_FLOW_DATA_DIR) app.setPath('userData', process.env.SUBSCRIBE_FLOW_DATA_DIR);
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(start).catch(error => { console.error(error.message); app.exit(1); });

let window, core;
let lastStatus = {state: 'starting'};
let quitting = false;

function send(event, data) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('subscribe-flow:event', event, data);
}
async function start() {
  let runtime = {};
  try { runtime = JSON.parse(readFileSync(path.join(root, '.runtime-paths.json'), 'utf8')); }
  catch { /* The window reports missing runtime configuration. */ }
  core = new CoreClient({ ...runtime, python: process.env.SUBSCRIBE_FLOW_PYTHON || runtime.python,
    root, dataDir: app.getPath('userData'), opencli: smoke ? '/missing/opencli' : runtime.opencli });
  core.on('status', status => { lastStatus = status; send('core.status', status); });
  core.on('notification', (event, data) => {
    if (!['sync.changed', 'content.changed', 'subscription.changed'].includes(event)) return;
    send(event, data);
    const aliases = {'sync.changed': ['run', 'runs'], 'content.changed': ['content'], 'subscription.changed': ['channels']};
    for (const alias of aliases[event]) send(alias, null); // Invalidation; consumers re-query durable state.
  });

  const assets = {'/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css']};
  protocol.handle('app', async request => {
    const url = new URL(request.url);
    const asset = url.hostname === 'subscribe-flow' && assets[url.pathname];
    if (!asset) return new Response('Not found', {status: 404});
    return new Response(await fs.readFile(path.join(root, 'electron', 'diagnostics', asset[0])), {headers: {'Content-Type': `${asset[1]}; charset=utf-8`}});
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
      else if (name === 'content.open') {
        if (Object.keys(params).length !== 1 || typeof params.item_id !== 'string') throw new Error('需要已保存的内容 ID');
        const item = await core.call('content.get', {item_id: params.item_id});
        const url = new URL(item.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || item.url.length > 2000) throw new Error('原文链接无效');
        await shell.openExternal(url.href);
        value = {opened: true};
      } else value = await core.call(name, params);
      return {ok: true, value};
    } catch (error) {
      return {ok: false, error: {code: error.code || 'DESKTOP_ERROR', message: error.message, ...(error.data || {})}};
    }
  });
  window = new BrowserWindow({ width: 1000, height: 760, minWidth: 680, minHeight: 500, show: !smoke,
    title: 'Subscribe Flow · 开发联调', webPreferences: {preload: path.join(root, 'electron', 'preload', 'index.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false,
      backgroundThrottling: !smoke} });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  await window.loadURL(APP_URL);
  try { await core.start(); }
  catch (error) { lastStatus = {state: 'error', message: error.message}; send('core.status', lastStatus); if (smoke) throw error; }
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
  core.stop().finally(() => app.quit());
});
