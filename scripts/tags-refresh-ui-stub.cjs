// Offline-only bridge for tags-refresh-ui-smoke.cjs; never starts the Core.
const {contextBridge} = require('electron');
const handlers = {};
const scenario = {
  tags: [{id: 'tag-a', name: '阅读', description: '原说明', synonyms: ['读书'], color: 'cyan', enabled: true, contentCount: 8}],
  status: {summary: {}, recent: []},
  calls: [], delays: {}, errors: {},
};
const content = index => ({id: 'item-' + index, title: '关联内容 ' + index + '：' + '长标题'.repeat(15), channelName: '离线作者', platform: 'zhihu', publishedAt: '2026-10-20', publishedPrecision: 'date'});
const bridge = {
  async call(name, args) {
    scenario.calls.push({name, args});
    const tags = structuredClone(scenario.tags), status = structuredClone(scenario.status);
    const error = scenario.errors[name];
    if (scenario.delays[name]) await new Promise(resolve => setTimeout(resolve, scenario.delays[name]));
    if (error) throw new Error(error);
    const first = Array.isArray(args) ? args[0] : args;
    switch (name) {
      case 'core.status': return {state: 'ready'};
      case 'getSession': return {user: {name: '界面验收'}, capabilities: {canManageTags: true}, connection: {state: 'ready', actions: []}};
      case 'getCounts': return {total: 0, unread: 0};
      case 'listPlatforms': case 'listPriorities': case 'getRuns': return [];
      case 'listContents': case 'listContentSources': return {items: [], total: 0};
      case 'listTags': return {items: tags.filter(t => !first?.keyword || t.name.includes(first.keyword)), total: tags.length};
      case 'listTagContents': return {items: Array.from({length: 5}, (_, i) => content(i)), total: 8};
      case 'updateTag': {
        Object.assign(scenario.tags.find(t => t.id === first), args[1]);
        return scenario.tags.find(t => t.id === first);
      }
      case 'tagging.status': return status;
      case 'tagging.backfill_preview': return {pending: 7, total: 12, limit: 7};
      case 'tagging.backfill': return {queued: first.limit};
      case 'tagging.retry': return {queued: true};
      default: throw new Error('界面验收桩未实现：' + name);
    }
  },
  on(name, handler) {
    (handlers[name] ||= new Set()).add(handler);
    return () => handlers[name].delete(handler);
  },
};
contextBridge.exposeInMainWorld('SubscribeFlow', bridge);
contextBridge.exposeInMainWorld('TagsRefreshStub', {
  configure: patch => Object.assign(scenario, patch),
  emit: (name, data) => { for (const handler of handlers[name] || []) handler(data); },
  calls: () => scenario.calls,
});
