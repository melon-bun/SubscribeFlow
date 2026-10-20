// Only used by tags-ai-ui-smoke.cjs: no Core, platform, model or user database.
const {contextBridge} = require('electron');

const scenario = {status: {summary: {}, recent: []}, preview: {pending: 7, total: 12, limit: 7}, calls: []};
const session = {
  user: {name: '界面验收'}, capabilities: {canManageTags: true},
  connection: {state: 'ready', dependency: 'available', authentication: 'not_required', actions: []},
};
const bridge = {
  async call(name, args) {
    switch (name) {
      case 'core.status': return {state: 'ready'};
      case 'getSession': return session;
      case 'getCounts': return {total: 0, unread: 0};
      case 'listPlatforms': case 'listPriorities': case 'getRuns': return [];
      case 'listContents': case 'listTags': case 'listTagContents': return {items: [], total: 0};
      case 'tagging.status':
        if (scenario.error) throw new Error(scenario.error);
        return scenario.status;
      case 'tagging.backfill_preview':
        scenario.calls.push({name, args});
        return scenario.preview;
      case 'tagging.backfill':
        scenario.calls.push({name, args});
        return {queued: args.limit};
      case 'tagging.retry':
        scenario.calls.push({name, args});
        return {queued: true};
      default: throw new Error('界面验收桩未实现：' + name);
    }
  },
  on() { return () => {}; },
};
contextBridge.exposeInMainWorld('SubscribeFlow', bridge);
contextBridge.exposeInMainWorld('TaggingStub', {
  setStatus: status => { scenario.status = status; scenario.error = null; },
  setError: error => { scenario.error = error; },
  calls: () => scenario.calls,
});
