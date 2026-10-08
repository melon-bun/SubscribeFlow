const { contextBridge, ipcRenderer } = require('electron');
// Sandboxed preload uses only Electron's restricted builtin modules.
const allowed = new Set([
  'channel.list', 'connection.list', 'connection.check', 'connection.login', 'source.resolve', 'source.search',
  'subscription.list', 'subscription.add', 'subscription.update', 'sync.start', 'sync.cancel',
  'sync.retry', 'sync.get', 'sync.list', 'sync.coverage', 'content.list', 'content.calendar', 'content.get',
  'content.update', 'content.bulk_update', 'priority.set_source',
  'tag.list', 'tag.get', 'tag.create', 'tag.update', 'tag.set_enabled', 'tag.remove', 'tag.contents',
  'content.set_tags', 'content.bulk_set_tags',
  'intake.start', 'intake.get', 'intake.cancel', 'intake.save', 'source.list',
  'startIntake', 'getIntake', 'cancelIntake', 'saveIntake', 'listContentSources',
  'core.status', 'core.restart', 'content.open',
  'schedule.list', 'schedule.status',
  'getSession', 'getCounts', 'listPlatforms', 'listPriorities', 'getCalendar', 'listContents', 'getContent',
  'updateContent', 'bulkUpdate', 'listChannels', 'createChannel', 'updateChannel',
  'removeChannel', 'setChannelEnabled', 'startChannelRun', 'cancelRun', 'getRuns',
  'listCreators', 'getPrioritySettings', 'savePrioritySettings', 'listRules', 'createRule',
  'updateRule', 'removeRule', 'getSyncCoverage', 'resolveSource', 'searchSources', 'listConnections', 'checkConnection', 'retryRun', 'fetchDetail', 'source.open',
  // 渲染层按 AppClient 方法名调用，主进程再转成上面对应的 tag.* RPC 通道；两层名字都要在白名单里。
  'listTags', 'getTag', 'createTag', 'updateTag', 'setTagEnabled', 'removeTag', 'listTagContents',
  'setContentTags', 'bulkSetTags',
]);
const events = new Set(['core.status', 'sync.changed', 'intake.changed', 'content.changed', 'subscription.changed', 'tags.changed', 'run', 'runs', 'content', 'channels']);
// Plain result envelopes cross contextBridge intact. Renderer creates its own
// Error so code/scope/retry fields are not discarded while crossing contexts.
async function request(name, params = {}) {
  if (!allowed.has(name)) return {ok:false,error:{code:'FORBIDDEN_METHOD',message:'不允许调用此方法'}};
  return ipcRenderer.invoke('subscribe-flow:call', name, params);
}
contextBridge.exposeInMainWorld('SubscribeFlow', Object.freeze({
  request,
  async call(name, params = {}) {
    const result = await request(name, params);
    if (!result.ok) {
      const error = new Error(result.error.message);
      Object.assign(error, result.error);
      throw error;
    }
    return result.value;
  },
  on(name, handler) {
    if (!events.has(name) || typeof handler !== 'function') throw new Error('事件订阅无效');
    const listener = (_event, eventName, data) => { if (eventName === name) handler(data); };
    ipcRenderer.on('subscribe-flow:event', listener);
    return () => ipcRenderer.removeListener('subscribe-flow:event', listener);
  },
}));
