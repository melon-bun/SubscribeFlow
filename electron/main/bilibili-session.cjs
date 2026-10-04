const {session, BaseWindow, WebContentsView} = require('electron');
const {BilibiliAPI, AcquisitionError, validateRequest} = require('./bilibili-api.cjs');
const {setTimeout: delay} = require('node:timers/promises');

const PARTITION = 'persist:bilibili';
function allowedPage(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && (u.hostname === 'bilibili.com' || u.hostname.endsWith('.bilibili.com'));
  } catch { return false; }
}
class BilibiliSession {
  constructor({offline = false, onChanged = () => {}} = {}) {
    this.offline = offline; this.onChanged = onChanged; this.tail = Promise.resolve(); this.controllers = new Set();
    this.session = session.fromPartition(PARTITION);
    this.session.setPermissionRequestHandler((_w,_p,cb) => cb(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.on('will-download', event => event.preventDefault());
    this.api = new BilibiliAPI((...args) => this.session.fetch(...args));
  }
  async request(params, outerSignal) {
    validateRequest(params);
    if (this.offline) throw new AcquisitionError('DEPENDENCY_UNAVAILABLE', '离线验收环境未连接 B站');
    const controller = new AbortController(); this.controllers.add(controller);
    const cancel = () => controller.abort(new AcquisitionError('CANCELLED','采集已取消'));
    outerSignal?.addEventListener('abort',cancel,{once:true});
    if (outerSignal?.aborted) cancel();
    const previous = this.tail;
    let release; this.tail = new Promise(resolve => { release = resolve; });
    const timer = setTimeout(() => controller.abort(new AcquisitionError('TIMEOUT','B站请求超时，请重试',true)), 45000);
    try {
      // Serial even if login checks and multiple Core requests arrive together.
      await previous;
      for (let attempt=0; attempt<2; attempt++) {
        controller.signal.throwIfAborted();
        try { return await this.api.request(params,controller.signal); }
        catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          // A single bounded retry only for transient transport/server errors.
          if (!error.retryable || error.code !== 'ACCESS_FAILED' || attempt) throw error;
          await delay(500,undefined,{signal:controller.signal});
        }
      }
    } finally {
      clearTimeout(timer); this.controllers.delete(controller); outerSignal?.removeEventListener('abort',cancel);
      release();
    }
  }
  openLogin(parent) {
    if (this.login && !this.login.isDestroyed()) { this.login.show(); this.login.focus(); return {opened:true}; }
    const win = this.login = new BaseWindow({parent, width:1060,height:820,minWidth:800,minHeight:600,title:'B站应用内登录 · 登录后关闭此窗口并检查连接'});
    const view = new WebContentsView({webPreferences:{session:this.session, sandbox:true, contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false}});
    this.loginView = view;
    win.contentView.addChildView(view);
    const resize = () => { const [width,height] = win.getContentSize(); view.setBounds({x:0,y:0,width,height}); };
    resize(); win.on('resize',resize);
    const wc = view.webContents;
    wc.setWindowOpenHandler(({url}) => {
      if (allowedPage(url)) void wc.loadURL(url).catch(() => {});
      return {action:'deny'};
    });
    for (const name of ['will-navigate','will-redirect']) wc.on(name,(event,url) => { if (!allowedPage(url)) event.preventDefault(); });
    wc.on('will-attach-webview',event => event.preventDefault());
    win.on('closed',() => {
      if (!wc.isDestroyed()) wc.close();
      this.login = null; this.loginView = null;
      void this.session.cookies.flushStore().then(() => this.onChanged()).catch(() => {});
    });
    void wc.loadURL('https://passport.bilibili.com/login').catch(() => {
      if (!win.isDestroyed()) win.setTitle('B站页面加载失败，请关闭后重试');
    });
    return {opened:true};
  }
  async close() {
    for (const controller of this.controllers) controller.abort(new AcquisitionError('CANCELLED','应用正在关闭'));
    if (this.login && !this.login.isDestroyed()) this.login.close();
    await this.session.cookies.flushStore();
  }
}
module.exports = {BilibiliSession, PARTITION, allowedPage};
