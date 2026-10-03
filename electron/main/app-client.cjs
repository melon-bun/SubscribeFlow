// F1's call(name, args[]) boundary maps here. Display-only projections do not
// implement a second store. M5 owns page-level integration and missing controls.
const UI_METHODS = new Set([
  'getSession', 'getCounts', 'listPlatforms', 'listPriorities', 'listContents', 'getContent',
  'updateContent', 'bulkUpdate', 'listChannels', 'createChannel', 'updateChannel',
  'removeChannel', 'setChannelEnabled', 'startChannelRun', 'cancelRun', 'getRuns',
  'listCreators', 'getPrioritySettings', 'savePrioritySettings', 'listRules', 'createRule',
  'updateRule', 'removeRule', 'getSyncCoverage',
]);
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
    channelId: sub?.id ?? null, channelName: item.source.name, author: item.source.name,
    publishedAt: item.published.value, publishedPrecision: item.published.precision,
    publishedTimezone: item.published.timezone, url: item.url, thumb: item.thumbnail,
    state: item.state, priority: null, tags: [], contentHash: null,
  };
}
function channelDTO(sub) {
  return { id: sub.id, name: sub.name, platform: sub.channel, link: sub.url,
    enabled: sub.status === 'active', status: sub.status, connectionId: sub.connection_id,
    intervalSeconds: sub.interval_seconds, frequency: null, lastSync: null };
}
function runDTO(job, subscriptions) {
  return { id: job.id, channelId: job.subscription_id,
    channelName: subscriptions.find(sub => sub.id === job.subscription_id)?.name ?? '',
    kind: job.mode === 'backfill' ? 'backfill' : 'recent', scope: job.coverage,
    state: job.state, progress: null, pages: job.pages, items: job.items,
    message: job.error?.message ?? `已提交 ${job.pages} 页、${job.items} 条记录`,
    startedAt: Date.parse(job.created_at), error: job.error };
}

async function callUI(core, name, args) {
  if (!Array.isArray(args) || args.length > 2) throw new Error('AppClient 参数必须是最多两个元素的数组');
  const [first, second] = args;
  const call = (method, params = {}) => core.call(method, params);
  const subscriptions = () => call('subscription.list', { include_cancelled: true });
  switch (name) {
    case 'getSession': {
      const [channels, connections] = await Promise.all([call('channel.list'), call('connection.list')]);
      const latest = connections.find(c => c.readiness?.state === 'blocked')?.readiness ?? connections.find(c => c.readiness)?.readiness;
      return { user: { name: '本地用户' }, now: Date.now(), isDemo: false,
        capabilities: { canRefresh: channels.some(c => c.operations.list_items?.supported),
          canBackfill: channels.some(c => c.operations.list_items?.pagination !== 'none'),
          canCancel: true, canManageChannels: true, canManagePriorities: false, canManageRules: false },
        connection: { state: latest?.state ?? 'unknown', detail: latest?.reason ?? '尚未检查采集环境' } };
    }
    case 'getCounts': {
      const queries = [{}, {read: false, archived: false}, {read: true}, {deferred: true}, {archived: true}];
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
      if (query.state === 'unread') Object.assign(params, {read: false, archived: false});
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
      let items = (await call('subscription.list')).map(channelDTO);
      if (query.platform) items = items.filter(item => item.platform === query.platform);
      if (query.keyword) items = items.filter(item => item.name.includes(query.keyword) || item.link.includes(query.keyword));
      return {items, total: items.length};
    }
    case 'createChannel': {
      const draft = object(first); keys(draft, ['platform', 'link', 'connectionId', 'confirmed', 'intervalSeconds']);
      const connections = await call('connection.list');
      const connection = connections.find(c => draft.connectionId ? c.id === draft.connectionId : c.channel === draft.platform);
      if (!connection) unsupported('所选平台尚未接入');
      const params = {locator: draft.link, connection_id: connection.id, confirmed: draft.confirmed === true};
      if (draft.intervalSeconds !== undefined) params.interval_seconds = draft.intervalSeconds;
      return channelDTO(await call('subscription.add', params));
    }
    case 'updateChannel': {
      const patch = object(second); keys(patch, ['enabled', 'connectionId', 'intervalSeconds']);
      const params = {subscription_id: first};
      if ('enabled' in patch) { if (typeof patch.enabled !== 'boolean') throw new Error('enabled 必须为布尔值'); params.status = patch.enabled ? 'active' : 'paused'; }
      if ('connectionId' in patch) params.connection_id = patch.connectionId;
      if ('intervalSeconds' in patch) params.interval_seconds = patch.intervalSeconds;
      return channelDTO(await call('subscription.update', params));
    }
    case 'setChannelEnabled':
      if (typeof second !== 'boolean') throw new Error('enabled 必须为布尔值');
      return channelDTO(await call('subscription.update', {subscription_id: first, status: second ? 'active' : 'paused'}));
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
    case 'getSyncCoverage': {
      const result = await call('sync.coverage', {subscription_id: first});
      const complete = result.progress.some(p => p.compatible && p.payload.complete && p.payload.coverage === 'history_end');
      return {scope: complete ? 'full' : 'recent', complete, label: complete ? '历史遍历已完成' : '尚未证明历史完整',
        detail: complete ? '已记录可靠末页证据' : '请查看任务的实际覆盖范围与错误信息', canBackfill: !complete, progress: result.progress};
    }
    default: unsupported();
  }
}
module.exports = { UI_METHODS, callUI, contentDTO, channelDTO, runDTO };
