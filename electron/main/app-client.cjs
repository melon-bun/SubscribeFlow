// F1's call(name, args[]) boundary maps here. Display-only projections do not
// implement a second store. M5 owns page-level integration and missing controls.
const UI_METHODS = new Set([
  'getSession', 'getCounts', 'listPlatforms', 'listPriorities', 'listContents', 'getContent',
  'updateContent', 'bulkUpdate', 'listChannels', 'createChannel', 'updateChannel',
  'removeChannel', 'setChannelEnabled', 'startChannelRun', 'cancelRun', 'getRuns',
  'listCreators', 'getPrioritySettings', 'savePrioritySettings', 'listRules', 'createRule',
  'updateRule', 'removeRule', 'getSyncCoverage', 'resolveSource', 'searchSources', 'listConnections', 'checkConnection', 'retryRun', 'fetchDetail',
]);
// F1's “未处理” / inbox means no processing state has been set.
const INBOX_FILTER = Object.freeze({read: false, archived: false, deferred: false});
function unsupported(message = '此功能属于后续模块，当前业务核心尚未支持') {
  const error = new Error(message); error.code = 'UNSUPPORTED_OPERATION'; throw error;
}
function object(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须为对象');
  return value;
}
function keys(value, allowed) {
  if (Object.keys(value).some(key => !allowed.includes(key))) unsupported('请求包含尚未接入的字段');
}
function contentDTO(item, subscriptions) {
  const sourceKey = `${item.source.channel}:${item.source.kind}:${item.source.external_id}`;
  const sub = subscriptions.find(row => row.source_id === sourceKey);
  return {
    id: item.id, title: item.title, summary: item.summary, platform: item.channel,
    channelId: sub?.id ?? null, channelName: sub?.name ?? item.source.name, author: sub?.name ?? item.source.name,
    publishedAt: item.published.value, publishedPrecision: item.published.precision,
    publishedTimezone: item.published.timezone, url: item.url, thumb: item.thumbnail, cover: item.thumbnail, publishedProvenance: item.published.provenance,
    state: item.state, priority: null, tags: [], contentHash: null,
  };
}
function channelDTO(sub, descriptors = [], schedule = null) {
  const operations = descriptors.find(c => c.channel === sub.channel)?.operations || {};
  return { id: sub.id, name: sub.name, platform: sub.channel, link: sub.url,
    enabled: sub.status === 'active', status: sub.status, connectionId: sub.connection_id,
    externalId: sub.external_id, intervalSeconds: sub.interval_seconds, syncMode:sub.sync_mode,
    frequency: sub.sync_mode === 'automatic' ? (sub.interval_seconds % 3600 ? `每 ${sub.interval_seconds/60} 分钟` : `每 ${sub.interval_seconds/3600} 小时`) : '手动刷新', schedule,
    capabilities: { canRefresh: !!operations.list_items?.supported,
      canBackfill: !!operations.list_items?.supported && operations.list_items.pagination !== 'none',
      fullHistory: !!operations.list_items?.full_history, canFetchDetail: !!operations.get_item_detail?.supported } };
}
function runDTO(job, subscriptions) {
  return { id: job.id, channelId: job.subscription_id,
    channelName: subscriptions.find(sub => sub.id === job.subscription_id)?.name ?? '',
    kind: job.mode, scope: job.coverage, trigger:job.trigger,
    state: job.state, progress: null, pages: job.pages, items: job.items, newItems: job.new_items,
    message: job.error?.message ?? (job.mode === 'detail' ? (job.state === 'succeeded' ? '详情补充完成' : '正在处理详情任务') : job.state === 'succeeded' && job.mode !== 'detail' && job.new_items === 0 ? `检查完成，没有新内容；本次读取 ${job.items} 条记录` : `已提交 ${job.pages} 页、${job.items} 条记录，新增 ${job.new_items} 条`),
    startedAt: Date.parse(job.created_at), updatedAt: job.updated_at, error: job.error };
}

async function callUI(core, name, args) {
  if (!Array.isArray(args) || args.length > 2) throw new Error('AppClient 参数必须是最多两个元素的数组');
  const [first, second] = args;
  const call = (method, params = {}) => core.call(method, params);
  const subscriptions = () => call('subscription.list', { include_cancelled: true });
  switch (name) {
    case 'getSession': {
      const [channels, connections, scheduler] = await Promise.all([call('channel.list'), call('connection.list'), call('schedule.status')]);
      const latest = connections.find(c => c.readiness?.state === 'blocked')?.readiness ?? connections.find(c => c.readiness)?.readiness;
      return { user: { name: '本地用户' }, now: Date.now(), isDemo: false,
        capabilities: { canRefresh: channels.some(c => c.operations.list_items?.supported),
          canBackfill: channels.some(c => c.operations.list_items?.supported && c.operations.list_items.pagination !== 'none'),
          canCancel: true, canManageChannels: true, canManagePriorities: false, canManageRules: false, canBookmark: false, canManageTags: false, canSchedule: true },
        channels, connections, scheduler,
        connection: { state: latest?.state ?? 'unknown', detail: latest?.reason ?? '尚未检查采集环境',
          dependency: latest?.dependency, authentication: latest?.authentication, actions: latest?.actions || [] } };
    }
    case 'getCounts': {
      const queries = [{}, INBOX_FILTER, {read: true}, {deferred: true}, {archived: true}];
      const results = await Promise.all(queries.map(query => call('content.list', { ...query, limit: 1 })));
      return Object.fromEntries(['total', 'unread', 'read', 'deferred', 'archived'].map((key, i) => [key, results[i].total]));
    }
    case 'listPlatforms': {
      const channels = await call('channel.list');
      return Promise.all(channels.map(async c => ({ id: c.channel, count: (await call('content.list', {channel: c.channel, limit: 1})).total })));
    }
    case 'listContents': {
      const query = object(first);
      keys(query, ['platform', 'channelId', 'state', 'keyword', 'limit', 'offset', 'from', 'to']);
      const params = {};
      for (const [front, back] of [['platform', 'channel'], ['keyword', 'query'], ['limit', 'limit'], ['offset', 'offset'], ['from', 'start'], ['to', 'end']]) {
        if (query[front] != null && query[front] !== '') params[back] = query[front];
      }
      if (query.state === 'unread') Object.assign(params, INBOX_FILTER);
      else if (query.state) {
        if (!['read', 'archived', 'deferred'].includes(query.state)) unsupported('不支持此内容状态');
        params[query.state] = true;
      }
      const subs = await subscriptions();
      if (query.channelId) {
        const sub = subs.find(s => s.id === query.channelId);
        if (!sub) throw new Error('订阅不存在');
        params.source_id = sub.source_id;
      }
      const result = await call('content.list', params);
      return {...result, items: result.items.map(item => contentDTO(item, subs))};
    }
    case 'getContent':
      return contentDTO(await call('content.get', {item_id: first}), await subscriptions());
    case 'updateContent': {
      const patch = object(second); keys(patch, ['state']);
      return contentDTO(await call('content.update', {item_id: first, patch: object(patch.state)}), await subscriptions());
    }
    case 'bulkUpdate': {
      const patch = object(second); keys(patch, ['state']);
      return call('content.bulk_update', {item_ids: first, patch: object(patch.state)});
    }
    case 'listChannels':
    case 'listCreators': {
      const query = object(first); keys(query, ['platform', 'keyword']);
      const [subs, descriptors, schedules] = await Promise.all([call('subscription.list'), call('channel.list'), call('schedule.list')]);
      let items = subs.map(sub => channelDTO(sub, descriptors, schedules.find(s=>s.subscription_id===sub.id)));
      if (query.platform) items = items.filter(item => item.platform === query.platform);
      if (query.keyword) items = items.filter(item => item.name.includes(query.keyword) || item.link.includes(query.keyword));
      return {items, total: items.length};
    }
    case 'createChannel': {
      const draft = object(first); keys(draft, ['platform', 'link', 'connectionId', 'confirmed', 'intervalSeconds', 'syncMode']);
      const connections = await call('connection.list');
      const connection = connections.find(c => draft.connectionId ? c.id === draft.connectionId : c.channel === draft.platform);
      if (!connection) unsupported('所选平台尚未接入');
      const params = {locator: draft.link, connection_id: connection.id, confirmed: draft.confirmed === true};
      if (draft.intervalSeconds !== undefined) params.interval_seconds = draft.intervalSeconds;
      if (draft.syncMode !== undefined) params.sync_mode = draft.syncMode;
      return channelDTO(await call('subscription.add', params), await call('channel.list'));
    }
    case 'updateChannel': {
      const patch = object(second); keys(patch, ['enabled', 'connectionId', 'intervalSeconds', 'syncMode']);
      const params = {subscription_id: first};
      if ('enabled' in patch) { if (typeof patch.enabled !== 'boolean') throw new Error('enabled 必须为布尔值'); params.status = patch.enabled ? 'active' : 'paused'; }
      if ('connectionId' in patch) params.connection_id = patch.connectionId;
      if ('intervalSeconds' in patch) params.interval_seconds = patch.intervalSeconds;
      if ('syncMode' in patch) params.sync_mode = patch.syncMode;
      return channelDTO(await call('subscription.update', params), await call('channel.list'));
    }
    case 'setChannelEnabled':
      if (typeof second !== 'boolean') throw new Error('enabled 必须为布尔值');
      return channelDTO(await call('subscription.update', {subscription_id: first, status: second ? 'active' : 'paused'}), await call('channel.list'));
    case 'removeChannel':
      await call('subscription.update', {subscription_id: first, status: 'cancelled'});
      return {removed: first};
    case 'startChannelRun': {
      const opts = object(second); keys(opts, ['kind', 'pageBudget']);
      if (opts.kind && !['recent', 'backfill'].includes(opts.kind)) unsupported('不支持此任务类型');
      const params = {subscription_id: first, mode: opts.kind === 'backfill' ? 'backfill' : 'refresh'};
      if (opts.pageBudget !== undefined) params.page_budget = opts.pageBudget;
      const result = await call('sync.start', params);
      return {runId: result.job_id};
    }
    case 'cancelRun': return call('sync.cancel', {job_id: first});
    case 'getRuns': {
      const [jobs, subs] = await Promise.all([call('sync.list'), subscriptions()]);
      return jobs.map(job => runDTO(job, subs));
    }
    case 'resolveSource':
    case 'searchSources': {
      const query = object(first); keys(query, ['connectionId', 'text']);
      return call(name === 'resolveSource' ? 'source.resolve' : 'source.search', {
        connection_id: query.connectionId, [name === 'resolveSource' ? 'locator' : 'query']: query.text,
      });
    }
    case 'listConnections': return call('connection.list');
    case 'checkConnection': return call('connection.check', {connection_id: first});
    case 'retryRun': return call('sync.retry', {job_id: first});
    case 'fetchDetail': {
      const item = await call('content.get', {item_id: first});
      const sub = (await subscriptions()).find(row => row.source_id === `${item.source.channel}:${item.source.kind}:${item.source.external_id}` && row.status === 'active');
      if (!sub) unsupported('请先恢复该来源的订阅再补充详情');
      return call('sync.start', {subscription_id: sub.id, mode: 'detail', item_key: first});
    }
    case 'getSyncCoverage': {
      const result = await call('sync.coverage', {subscription_id: first});
      const complete = result.progress.some(p => p.compatible && p.payload.complete && p.payload.coverage === 'history_end');
      const compatible = result.progress.filter(p => p.compatible);
      const [subs, connections, jobs] = await Promise.all([subscriptions(), call('connection.list'), call('sync.list')]);
      const sub = subs.find(s => s.id === first);
      const connection = connections.find(c => c.id === sub.connection_id);
      const hasWindow = jobs.some(j => j.subscription_id === first && j.mode !== 'detail' && j.pages > 0 &&
        j.snapshot.subscription_version === sub.version && j.snapshot.connection_version === connection.version && j.snapshot.connection_id === connection.id);
      return {scope: complete ? 'full' : 'recent', complete,
        label: complete ? '历史遍历已完成' : compatible.length || hasWindow ? '仅已采集窗口' : '尚无有效覆盖记录',
        detail: complete ? '已记录可靠末页证据' : '已保存的内容可正常阅读；未取得可靠末页证据，不代表全部历史。分页回溯也可能存在缺口。',
        canBackfill: !complete, progress: result.progress};
    }
    default: unsupported();
  }
}
module.exports = { UI_METHODS, callUI, contentDTO, channelDTO, runDTO };
