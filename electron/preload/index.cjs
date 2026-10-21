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
  // M15 设置：密钥明文只在提交这一刻经过 Preload，任何读取都拿不到密钥。
  'getSettings', 'saveSettings', 'getNotificationStatus', 'sendTestNotification',
  // M16 自动打标：状态、连接测试、重试与补打。渲染层拿不到密钥，只能看到结果。
  'tagging.status', 'tagging.test', 'tagging.tasks', 'tagging.retry',
  'tagging.backfill_preview', 'tagging.backfill',
  // M26 笔记：读写与查询都在 Core 侧完成，渲染层只提交内容 ID 与笔记内容。
  'note.get', 'note.save', 'note.delete', 'note.list', 'note.facets',
  'getNote', 'saveNote', 'deleteNote', 'listNotes', 'noteFacets',
  'getSession', 'getCounts', 'listPlatforms', 'listPriorities', 'getCalendar', 'listContents', 'getContent',
  'updateContent', 'bulkUpdate', 'listChannels', 'createChannel', 'updateChannel',
  'removeChannel', 'setChannelEnabled', 'startChannelRun', 'cancelRun', 'getRuns',
  'listCreators', 'getPrioritySettings', 'savePrioritySettings', 'listRules', 'createRule',
  'updateRule', 'removeRule', 'getSyncCoverage', 'resolveSource', 'searchSources', 'listConnections', 'checkConnection', 'retryRun', 'fetchDetail', 'source.open',
  // 渲染层按 AppClient 方法名调用，主进程再转成上面对应的 tag.* RPC 通道；两层名字都要在白名单里。
  'listTags', 'getTag', 'createTag', 'updateTag', 'setTagEnabled', 'removeTag', 'listTagContents',
  'setContentTags', 'bulkSetTags',
]);
const events = new Set(['core.status', 'sync.changed', 'intake.changed', 'content.changed', 'subscription.changed', 'scheduler.changed', 'tags.changed', 'tagging.changed', 'run', 'runs', 'content', 'channels', 'reminder.navigate']);
// All renderer subscriptions share one IPC listener, including typed events
// and compatibility aliases. Route changes only mutate the per-event sets.
const eventHandlers = new Map();
ipcRenderer.on('subscribe-flow:event', (_event, eventName, data) => {
  for (const handler of eventHandlers.get(eventName) || []) handler(data);
});
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
    if (!eventHandlers.has(name)) eventHandlers.set(name, new Set());
    const handlers = eventHandlers.get(name);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (!handlers.size && eventHandlers.get(name) === handlers) eventHandlers.delete(name);
    };
  },
}));
