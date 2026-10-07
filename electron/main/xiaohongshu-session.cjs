const {session, BaseWindow, WebContentsView} = require('electron');
const PARTITION = 'persist:xiaohongshu';
function allowedPage(raw) {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && !u.port && (u.hostname === 'xiaohongshu.com' || u.hostname.endsWith('.xiaohongshu.com')); }
  catch { return false; }
}
class XiaohongshuSession {
  constructor({offline = false, onChanged = () => {}, apiOptions = {}} = {}) {
    Object.assign(this,{offline,onChanged,apiOptions});
    this.session=session.fromPartition(PARTITION);
    this.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    this.session.setPermissionCheckHandler(()=>false);
    this.session.on('will-download',e=>e.preventDefault());
    this.tail=Promise.resolve(); this.controllers=new Set(); this.closing=false; this.loginVisible=false;
  }
  async init() {
    if (this.api) return;
    if (this.initializing) return this.initializing;
    this.initializing=this.createPage();
    try {await this.initializing;}finally{this.initializing=null;}
  }
  async createPage() {
    const {XiaohongshuAPI}=await import('./xiaohongshu-api.mjs');
    if(this.closing)throw new Error('应用正在关闭');
    this.host=new BaseWindow({width:1060,height:820,minWidth:800,minHeight:600,show:false,title:'小红书应用内登录 · 登录后关闭此窗口并检查连接'});
    this.view=new WebContentsView({webPreferences:{session:this.session,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false,backgroundThrottling:false}});
    this.host.contentView.addChildView(this.view);
    const resize=()=>{const [width,height]=this.host.getContentSize();this.view.setBounds({x:0,y:0,width,height});};
    resize(); this.host.on('resize',resize);
    const wc=this.view.webContents;
    wc.setWindowOpenHandler(({url})=>{if(this.loginVisible && allowedPage(url)) void wc.loadURL(url).catch(()=>{});return {action:'deny'};});
    for(const event of ['will-navigate','will-redirect']) wc.on(event,(e,url)=>{if(!allowedPage(url))e.preventDefault();});
    wc.on('will-attach-webview',e=>e.preventDefault());
    this.host.on('close',e=>{
      if(this.closing) return;
      e.preventDefault();this.host.hide();this.loginVisible=false;
      void this.session.cookies.flushStore().then(()=>this.onChanged()).catch(()=>{});
    });
    this.host.on('closed',()=>{if(!wc.isDestroyed())wc.close();});
    this.api=new XiaohongshuAPI({url:()=>wc.getURL(),evaluate:script=>wc.executeJavaScript(script),goto:url=>wc.loadURL(url)},this.apiOptions);
  }
  async request(params,outerSignal) {
    params={...params,channel:'xiaohongshu'};
    const {validateRequest,XHSError}=await import('./xiaohongshu-api.mjs');
    validateRequest(params);
    if(this.offline) throw new XHSError('DEPENDENCY_UNAVAILABLE','离线验收环境未连接小红书');
    const controller=new AbortController();this.controllers.add(controller);
    const cancel=()=>{controller.abort(new XHSError('CANCELLED','采集已取消'));this.api?.abortScan(params.job_id);};
    outerSignal?.addEventListener('abort',cancel,{once:true});if(outerSignal?.aborted)cancel();
    const run=this.tail.then(async()=>{
      controller.signal.throwIfAborted();
      if(this.closing)throw new XHSError('CANCELLED','应用正在关闭');
      if(this.loginVisible)throw new XHSError('INTERACTION_REQUIRED','请先完成小红书登录并关闭登录窗口，再检查连接或重试');
      await this.init();
      const timeout=setTimeout(()=>controller.abort(new XHSError('TIMEOUT','小红书读取超时，已保存结果保留，请稍后重试')),45000);
      try{return await this.api.request(params,controller.signal);}
      catch(error){
        if(['AUTH_REQUIRED','INTERACTION_REQUIRED','CANCELLED','TIMEOUT'].includes(error.code))this.api?.abortScan(params.job_id);
        if(error.code==='TIMEOUT') {
          this.api.reset();this.api=null;
          this.host.destroy();this.host=null;this.view=null;
        }
        throw error;
      }
      finally{clearTimeout(timeout);if(controller.signal.aborted && this.view && !this.view.webContents.isDestroyed())this.view.webContents.stop();}
    });
    this.tail=run.catch(()=>{});
    try{return await run;}finally{this.controllers.delete(controller);outerSignal?.removeEventListener('abort',cancel);}
  }
  async openLogin(parent) {
    const {XHSError}=await import('./xiaohongshu-api.mjs');
    this.loginVisible=true;
    for(const controller of this.controllers)controller.abort(new XHSError('CANCELLED','已暂停采集，请完成登录后重试'));
    await this.tail;
    await this.init(); this.api.reset();
    if(parent && !parent.isDestroyed())this.host.setParentWindow(parent);
    this.host.show();this.host.focus();
    if(!this.view.webContents.getURL() || this.view.webContents.getURL()==='about:blank')
      void this.view.webContents.loadURL('https://www.xiaohongshu.com/explore').catch(()=>{if(!this.host.isDestroyed())this.host.setTitle('小红书页面加载失败，请关闭后重试');});
    return {opened:true};
  }
  async close() {
    this.closing=true;
    this.api?.reset();
    for(const c of this.controllers)c.abort();
    if(this.view && !this.view.webContents.isDestroyed())this.view.webContents.stop();
    if(this.host && !this.host.isDestroyed())this.host.close();
    await this.session.cookies.flushStore();
  }
}
module.exports={XiaohongshuSession,PARTITION,allowedPage};
