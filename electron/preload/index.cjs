const { contextBridge, ipcRenderer } = require('electron');
// Sandboxed preload uses only Electron's restricted builtin modules.
const allowed = new Set([
  'channel.list', 'connection.list', 'connection.check', 'source.resolve', 'source.search',
  'subscription.list', 'subscription.add', 'subscription.update', 'sync.start', 'sync.cancel',
  'sync.retry', 'sync.get', 'sync.list', 'sync.coverage', 'content.list', 'content.get',
  'content.update', 'content.bulk_update', 'core.status', 'core.restart', 'content.open',
  'getSession', 'getCounts', 'listPlatforms', 'listPriorities', 'listContents', 'getContent',
  'updateContent', 'bulkUpdate', 'listChannels', 'createChannel', 'updateChannel',
  'removeChannel', 'setChannelEnabled', 'startChannelRun', 'cancelRun', 'getRuns',
  'listCreators', 'getPrioritySettings', 'savePrioritySettings', 'listRules', 'createRule',
  'updateRule', 'removeRule', 'getSyncCoverage',
]);
const events = new Set(['core.status', 'sync.changed', 'content.changed', 'subscription.changed', 'run', 'runs', 'content', 'channels']);
contextBridge.exposeInMainWorld('SubscribeFlow', Object.freeze({
  async call(name, params = {}) {
    if (!allowed.has(name)) throw new Error('不允许调用此方法');
    const result = await ipcRenderer.invoke('subscribe-flow:call', name, params);
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
