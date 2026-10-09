const {session} = require('electron');
const PARTITION = 'persist:wechat';
// Public articles need no account, so this session never opens a window: it
// exists only to keep WeChat requests on their own cookie jar and user agent,
// away from the Bilibili / Xiaohongshu / Zhihu sessions.
class WechatSession {
  constructor({offline = false, apiOptions = {}} = {}) {
    Object.assign(this, {offline, apiOptions});
    this.session = session.fromPartition(PARTITION);
    this.session.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.on('will-download', e => e.preventDefault());
    this.controllers = new Set();
    this.closing = false;
  }
  async init() {
    if (this.api) return;
    const {WechatAPI} = await import('./wechat-api.mjs');
    this.api = new WechatAPI({fetch: (url, options) => this.session.fetch(url, options)}, this.apiOptions);
  }
  async request(params, outerSignal) {
    params = {...params, channel: 'wechat'};
    const {validateRequest, WechatError} = await import('./wechat-api.mjs');
    validateRequest(params);
    if (this.offline) throw new WechatError('DEPENDENCY_UNAVAILABLE', '离线验收环境未连接微信');
    const controller = new AbortController();
    this.controllers.add(controller);
    const cancel = () => controller.abort(new WechatError('CANCELLED', '采集已取消'));
    outerSignal?.addEventListener('abort', cancel, {once: true});
    if (outerSignal?.aborted) cancel();
    const timeout = setTimeout(() => controller.abort(new WechatError('TIMEOUT', '微信文章读取超时，本次已停止且未保存内容')), 55000);
    try {
      await this.init();
      return await this.api.request(params, controller.signal);
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof WechatError) error = controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      outerSignal?.removeEventListener('abort', cancel);
    }
  }
  async openLogin() {
    const {WechatError} = await import('./wechat-api.mjs');
    throw new WechatError('UNSUPPORTED_OPERATION', '微信公众号文章无需登录，请直接粘贴文章链接');
  }
  async close() {
    this.closing = true;
    this.api?.reset();
    for (const controller of this.controllers) controller.abort();
    await this.session.cookies.flushStore().catch(() => {});
  }
}
module.exports = {WechatSession, PARTITION};