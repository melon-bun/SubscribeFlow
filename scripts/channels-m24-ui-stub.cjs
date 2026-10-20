// 离线假桥接：只服务 channels-m24-ui-smoke.cjs，永远不启动 Core，也不发真实请求。
// 状态样本覆盖现有全部渠道与 readiness 的各条语义分支。
const {contextBridge} = require('electron');

const handlers = {};
const scenario = {
  // 六个渠道对应六种真实语义：可用、待检查、需登录、需处理访问验证、连接异常、仅自主添加。
  channels: [
    {channel: 'zhihu', name: '知乎', backend: 'electron-session', operations: {
      resolve_source: {supported: true}, search_sources: {supported: true},
      list_items: {supported: true}, get_item_detail: {supported: true}}},
    {channel: 'bilibili', name: 'B站', backend: 'electron-session', operations: {
      resolve_source: {supported: true}, search_sources: {supported: true},
      list_items: {supported: true}, get_item_detail: {supported: true}}},
    {channel: 'xiaohongshu', name: '小红书', backend: 'electron-session', operations: {
      resolve_source: {supported: true}, search_sources: {supported: true},
      list_items: {supported: true}, get_item_detail: {supported: true}}},
    {channel: 'github', name: 'GitHub', backend: 'direct-http', operations: {
      resolve_source: {supported: true}, search_sources: {supported: true},
      list_items: {supported: true}, get_item_detail: {supported: true}}},
    {channel: 'wechat', name: '微信公众号', backend: 'electron-session', operations: {
      resolve_source: {supported: false}, search_sources: {supported: false},
      list_items: {supported: false}, match_item_url: {supported: true},
      resolve_item: {supported: true}, read_item: {supported: true}}},
    {channel: 'weibo', name: '微博', backend: 'direct-http', operations: {
      resolve_source: {supported: true}, list_items: {supported: true}}},
  ],
  connections: [
    {id: 'zhihu:default', channel: 'zhihu', backend: 'electron-session', enabled: true,
      readiness: {state: 'ready', operation: 'list_items', reason: '知乎应用内会话已登录',
        scope: 'connection', scope_key: 'zhihu:default', checked_at: '2026-10-20T02:00:00+00:00',
        actions: [], dependency: 'available', authentication: 'available'}},
    {id: 'bilibili:default', channel: 'bilibili', backend: 'electron-session', enabled: true,
      readiness: {state: 'blocked', operation: 'list_items', reason: '请在应用内登录B站，关闭窗口后检查连接',
        scope: 'connection', scope_key: 'bilibili:default', checked_at: '2026-10-20T02:05:00+00:00',
        actions: ['open_browser'], dependency: 'unknown', authentication: 'required'}},
    {id: 'xiaohongshu:default', channel: 'xiaohongshu', backend: 'electron-session', enabled: true,
      readiness: {state: 'blocked', operation: 'list_items', reason: '小红书要求先完成访问验证',
        scope: 'connection', scope_key: 'xiaohongshu:default', checked_at: '2026-10-20T02:06:00+00:00',
        actions: ['open_browser'], dependency: 'unknown', authentication: 'unknown'}},
    {id: 'github:default', channel: 'github', backend: 'direct-http', enabled: true, readiness: null},
    {id: 'wechat:default', channel: 'wechat', backend: 'electron-session', enabled: true, readiness: null},
    {id: 'weibo:default', channel: 'weibo', backend: 'direct-http', enabled: true,
      readiness: {state: 'blocked', operation: 'list_items', reason: '读取公开页面失败：网络不可达',
        scope: 'connection', scope_key: 'weibo:default', checked_at: '2026-10-20T02:07:00+00:00',
        actions: ['retry'], dependency: 'unavailable', authentication: 'not_required'}},
  ],
  calls: [],
  // 让「检查连接」停一会儿，方便观察检查中状态。
  checkDelay: 0,
  checkResult: null,
};

const session = () => ({
  user: {name: '界面验收'},
  capabilities: {canManageSources: true, canManagePriorities: true, canManagePrioritiesBulk: true},
  connection: {state: 'ready', actions: []},
  channels: scenario.channels,
  connections: scenario.connections,
});

const bridge = {
  async call(name, args) {
    scenario.calls.push({name, args});
    const first = Array.isArray(args) ? args[0] : args;
    switch (name) {
      case 'core.status': return {state: 'ready'};
      case 'getSession': return session();
      case 'getCounts': return {total: 0, unread: 0};
      case 'listPlatforms': return ['zhihu', 'bilibili', 'xiaohongshu', 'github', 'wechat', 'weibo'];
      case 'listPriorities': return ['high', 'medium', 'low', 'none'];
      case 'getRuns': return [];
      case 'listContents': case 'listContentSources': return {items: [], total: 0};
      case 'listChannels': return {items: [], total: 0};
      case 'getSyncCoverage': return {label: '未采集', detail: '尚未采集过', complete: true};
      case 'checkConnection': {
        if (scenario.checkDelay) await new Promise(resolve => setTimeout(resolve, scenario.checkDelay));
        const result = scenario.checkResult || {state: 'ready', operation: 'list_items',
          reason: '检查通过', scope: 'connection', scope_key: first, checked_at: '2026-10-20T03:00:00+00:00',
          actions: [], dependency: 'available', authentication: 'available'};
        // 结果写回连接：状态文字随之更新，展开状态不受影响。
        const connection = scenario.connections.find(c => c.id === first);
        if (connection) connection.readiness = result;
        return result;
      }
      case 'loginConnection': return {state: 'ready'};
      default: throw new Error('界面验收桩未实现：' + name);
    }
  },
  on(name, handler) {
    (handlers[name] ||= new Set()).add(handler);
    return () => handlers[name].delete(handler);
  },
};

contextBridge.exposeInMainWorld('SubscribeFlow', bridge);
contextBridge.exposeInMainWorld('ChannelsM24Stub', {
  configure: patch => Object.assign(scenario, patch),
  emit: (name, data) => { for (const handler of handlers[name] || []) handler(data); },
  calls: () => scenario.calls,
  connections: () => scenario.connections,
});
