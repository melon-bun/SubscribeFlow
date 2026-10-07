// Platform transports are injected here; the router never reads their pages.
class ChannelSessions {
  constructor() { this.channels = new Map(); }
  register(channel, transport) {
    if (this.channels.has(channel)) throw new Error('重复渠道');
    this.channels.set(channel, transport); return transport;
  }
  request(params, signal) {
    const {channel, ...payload} = params || {};
    const transport = this.channels.get(channel);
    if (!transport) { const error = new Error('未注册此渠道的应用内采集实现'); error.code = 'DEPENDENCY_UNAVAILABLE'; throw error; }
    return transport.request(payload, signal);
  }
  login(connectionId, parent) {
    const transport = [...this.channels].find(([channel]) => connectionId === `${channel}:default`)?.[1];
    if (!transport) throw new Error('登录连接无效');
    return transport.openLogin(parent);
  }
  close() { return Promise.allSettled([...this.channels.values()].map(transport => Promise.resolve().then(() => transport.close()))); }
}
module.exports = {ChannelSessions};
