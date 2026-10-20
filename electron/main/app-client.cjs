// F1's call(name, args[]) boundary maps here. Display-only projections do not
// implement a second store. M5 owns page-level integration and missing controls.
const UI_METHODS = new Set([
  'getSession', 'getCounts', 'listPlatforms', 'listPriorities', 'getCalendar', 'listContents', 'getContent',
  'updateContent', 'bulkUpdate', 'listChannels', 'createChannel', 'updateChannel',
  'listTags', 'getTag', 'createTag', 'updateTag', 'setTagEnabled', 'removeTag', 'listTagContents',
  'setContentTags', 'bulkSetTags',
  'removeChannel', 'setChannelEnabled', 'startChannelRun', 'cancelRun', 'getRuns',
  'listCreators', 'getPrioritySettings', 'savePrioritySettings', 'listRules', 'createRule',
  'updateRule', 'removeRule', 'getSyncCoverage', 'resolveSource', 'searchSources', 'listConnections', 'checkConnection', 'retryRun', 'fetchDetail',
  'startIntake', 'getIntake', 'cancelIntake', 'saveIntake', 'listContentSources',
  'getSettings', 'saveSettings', 'getNotificationStatus', 'sendTestNotification',
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
function contentPatch(value) {
  const patch = object(value); keys(patch, ['state','priority']);
  const state = object(patch.state); keys(state, ['read','archived','deferred']);
  const result = {...state};
  if ('priority' in patch) result.priority = patch.priority;
  return result;
}
function tagIds(value) {
  const list = Array.isArray(value) ? value : (value && Array.isArray(value.tagIds) ? value.tagIds : value);
  if (!Array.isArray(list)) throw new Error('缺少标签列表');
  if (list.length > 100 || list.some(id => typeof id !== 'string' || !id)) throw new Error('标签列表无效');
  return list;
}
function displayTimezone(value) {
  return value ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}
function contentDTO(item, subscriptions) {
  const sourceKey = `${item.source.channel}:${item.source.kind}:${item.source.external_id}`;
  const sub = subscriptions.find(row => row.source_id === sourceKey);
  return {
    id: item.id, title: item.title, summary: item.summary, platform: item.channel, kind: item.kind,
    canFetchDetail: subscriptions.some(row => row.source_id === sourceKey && row.status === 'active'),
    channelId: sub?.id ?? null, channelName: sub?.name ?? item.source.name, author: sub?.name ?? item.source.name,
    publishedAt: item.published.value, publishedPrecision: item.published.precision,
    publishedTimezone: item.published.timezone, publishedLabel:item.published.raw_label || null, url: item.url, thumb: item.thumbnail, cover: item.thumbnail, publishedProvenance: item.published.provenance,
    state: item.state, priority: item.priority ?? null, priorityOverride: item.priority_override ?? null, sourcePriority: item.source_priority ?? null,
    tags: (item.tags || []).map(tag => ({id: tag.id, name: tag.name, color: tag.color, origin: tag.origin})),
    updatedAt: item.updated_at ?? null, contentHash: null,
    sourceId: sourceKey, intakeMethod: item.intake_method ?? null,
    firstSeenAt: item.first_seen_at ?? null, manualAddedAt: item.manual_added_at ?? null,
    calendarAt: item.calendar_at ?? null, calendarDate: item.calendar_date ?? null,
    calendarTimezone: item.calendar_timezone ?? null, calendarBasis: item.calendar_basis ?? null,
  };
}
function channelDTO(sub, descriptors = [], schedule = null) {
  const descriptor = descriptors.find(c => c.channel === sub.channel && (!sub.backend || c.backend === sub.backend)) || {};
  const operations = descriptor.operations || {};
  return { id: sub.id, name: sub.name, platform: sub.channel, link: sub.url,
    enabled: sub.status === 'active', status: sub.status, connectionId: sub.connection_id,
    defaultPriority: sub.default_priority ?? null, externalId: sub.external_id, intervalSeconds: sub.interval_seconds, syncMode:sub.sync_mode, collectItems: sub.collect_items || 0,
    frequency: sub.sync_mode === 'automatic' ? (sub.interval_seconds % 3600 ? `每 ${sub.interval_seconds/60} 分钟` : `每 ${sub.interval_seconds/3600} 小时`) : '手动刷新', schedule,
    pageSize:descriptor.page_size || 20, defaultRefreshBudget:descriptor.default_refresh_budget || 1,
    defaultBackfillBudget:descriptor.default_backfill_budget || 10, incrementalDetails:['details','items'].includes(descriptor.budget_unit),
    checkedItems:descriptor.budget_unit === 'items',
    contentNoun: descriptor.content_types?.includes('pin') ? '想法' : descriptor.content_types?.includes('note') ? '笔记' : '内容',
    capabilities: { canRefresh: !!operations.list_items?.supported,
      canBackfill: !!operations.list_items?.supported && operations.list_items.pagination !== 'none',
      fullHistory: !!operations.list_items?.full_history, canFetchDetail: !!operations.get_item_detail?.supported } };
}
function runDTO(job, subscriptions) {
  const metrics = job.acquisition_metrics || {};
  const scanMessage = Object.keys(metrics).length ? `主页读取 ${metrics.profile_reads || 0} 次，检查 ${metrics.discovered || 0} 条内容，跳过已收录 ${metrics.skipped || 0} 条，详情读取 ${metrics.detail_requests || 0} 次；新增 ${job.new_items} 条` : null;
  return { id: job.id, channelId: job.subscription_id,
    channelName: subscriptions.find(sub => sub.id === job.subscription_id)?.name ?? '',
    kind: job.mode, scope: job.coverage, trigger:job.trigger,
    state: job.state, progress: null, pages: job.pages, items: job.items, newItems: job.new_items,
    acquisitionMetrics:metrics,
    message: job.error?.message ?? scanMessage ?? (job.mode === 'detail' ? (job.state === 'succeeded' ? '详情补充完成' : '正在处理详情任务') : job.state === 'succeeded' && job.mode !== 'detail' && job.new_items === 0 ? `检查完成，没有新内容；本次读取 ${job.items} 条记录` : `已提交 ${job.pages} 页、${job.items} 条记录，新增 ${job.new_items} 条`),
    startedAt: Date.parse(job.created_at), updatedAt: job.updated_at, error: job.error };
}

// context 由主入口注入（M15：受保护密钥与桌面通知）。单测可以省略，
// 省略时设置类方法如实报未接入，不返回任何伪造结果。
async function callUI(core, name, args, context) {
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
          canCancel: true, canManageChannels: true, canManagePriorities: true, canManageRules: false, canBookmark: false, canManageTags: true, canSchedule: true,
          canIntake: channels.some(c => connections.some(conn => conn.enabled && conn.channel===c.channel && conn.backend===c.backend) && ['match_item_url','resolve_item','read_item'].every(op => c.operations[op]?.supported)) },
        channels, connections, scheduler,
        connection: { state: latest?.state ?? 'unknown', detail: latest?.reason ?? '尚未检查采集环境',
          dependency: latest?.dependency, authentication: latest?.authentication, actions: latest?.actions || [] } };
    }
    case 'getCounts': {
      const queries = [{}, INBOX_FILTER, {read: true}, {deferred: true}, {archived: true}, ...['high','medium','low','none'].map(priority => ({priority}))];
      const results = await Promise.all(queries.map(query => call('content.list', { ...query, limit: 1 })));
      return Object.fromEntries(['total', 'unread', 'read', 'deferred', 'archived', 'high', 'medium', 'low', 'none'].map((key, i) => [key, results[i].total]));
    }
    case 'listPlatforms': {
      const channels = [...new Map((await call('channel.list')).map(c => [c.channel,c])).values()];
      return Promise.all(channels.map(async c => ({ id: c.channel, count: (await call('content.list', {channel: c.channel, limit: 1})).total })));
    }
    case 'listPriorities': {
      const levels = ['high','medium','low','none'];
      return Promise.all(levels.map(async id => ({id, count: (await callUI(core, 'listContents', [{...object(first), priority:id, limit:1, offset:0}])).total})));
    }
    case 'getPrioritySettings':
      return (await subscriptions()).map(sub => ({id:sub.id, name:sub.name, platform:sub.channel, status:sub.status, priority:sub.default_priority ?? null}));
    case 'savePrioritySettings': {
      // One source per save: a failed request never partially applies a list.
      const setting = object(first); keys(setting, ['id','priority']);
      if (!('priority' in setting)) throw new Error('缺少优先级');
      return channelDTO(await call('priority.set_source', {subscription_id:setting.id, priority:setting.priority}), await call('channel.list'));
    }
    case 'getCalendar':
    case 'listContents': {
      const query = object(first);
      keys(query, ['platform', 'channelId', 'sourceId', 'intakeMethod', 'timezone', 'state', 'view', 'keyword', 'priority', 'tags', 'tagMode',
                   ...(name === 'getCalendar' ? ['month'] : ['limit','offset','from','to'])]);
      const params = {timezone: displayTimezone(query.timezone)};
      for (const [front, back] of [['platform', 'channel'], ['sourceId', 'source_id'], ['intakeMethod', 'intake_method'], ['keyword', 'query'], ['limit', 'limit'], ['offset', 'offset'], ['from', 'start'], ['to', 'end'], ['priority', 'priority']]) {
        if (query[front] != null && query[front] !== '') params[back] = query[front];
      }
      // 非法取值必须在这里报错：静默降级成「任一符合」会让用户看到错的筛选结果。
      if (query.tags != null && query.tags.length) params.tags = tagIds(query.tags);
      if (query.tagMode != null && query.tagMode !== '' && query.tagMode !== 'any' && query.tagMode !== 'all') {
        throw new Error('标签筛选方式需为任一符合或全部符合');
      }
      if (query.tagMode === 'all') params.tag_mode = 'all';
      // M17 提醒口径：pending 与 high_unarchived 直接下发给 Core 的共享谓词，
      // 与 reminder.summary 同源。此前这两个取值会被当成不支持而拒绝。
      if (query.view != null && query.view !== '') {
        if (query.view !== 'high_unarchived') unsupported('不支持此列表口径');
        params.view = query.view;
      }
      if (query.state === 'unread') Object.assign(params, INBOX_FILTER);
      else if (query.state === 'pending') params.state = 'pending';
      else if (query.state) {
        if (!['read', 'archived', 'deferred'].includes(query.state)) unsupported('不支持此内容状态');
        params[query.state] = true;
      }
      const subs = await subscriptions();
      if (query.channelId) {
        const sub = subs.find(s => s.id === query.channelId);
        if (!sub) throw new Error('订阅不存在');
        if (query.sourceId && query.sourceId !== sub.source_id) throw new Error('来源与订阅筛选不一致');
        params.source_id = sub.source_id;
      }
      if (name === 'getCalendar') return call('content.calendar', {...params, month:query.month});
      const result = await call('content.list', params);
      return {...result, items: result.items.map(item => contentDTO(item, subs))};
    }
    case 'getContent':
      return contentDTO(await call('content.get', {item_id: first, timezone: displayTimezone()}), await subscriptions());
    case 'updateContent': {
      const patch = contentPatch(second);
      return contentDTO(await call('content.update', {item_id: first, patch}), await subscriptions());
    }
    case 'bulkUpdate': {
      return call('content.bulk_update', {item_ids: first, patch: contentPatch(second)});
    }
    case 'listTags': {
      // M23：sort 是可选的显示层参数，不传就是按名称排（旧调用照常工作）。
      const query = object(first); keys(query, ['keyword', 'enabled', 'sort']);
      const params = {};
      if (query.keyword) params.query = query.keyword;
      if (typeof query.enabled === 'boolean') params.enabled = query.enabled;
      if (typeof query.sort === 'string' && query.sort) params.sort = query.sort;
      return call('tag.list', params);
    }
    case 'getTag':
      return call('tag.get', {tag_id: first});
    case 'createTag': {
      const draft = object(first); keys(draft, ['name', 'description', 'color', 'synonyms']);
      const params = {name: draft.name};
      for (const field of ['description', 'color']) if (draft[field] != null && draft[field] !== '') params[field] = draft[field];
      if (Array.isArray(draft.synonyms)) params.synonyms = draft.synonyms;
      return call('tag.create', params);
    }
    case 'updateTag': {
      const patch = object(second); keys(patch, ['name', 'description', 'color', 'synonyms']);
      return call('tag.update', {tag_id: first, ...patch});
    }
    case 'setTagEnabled':
      if (typeof second !== 'boolean') throw new Error('enabled 必须为布尔值');
      return call('tag.set_enabled', {tag_id: first, enabled: second});
    case 'removeTag':
      return call('tag.remove', {tag_id: first});
    case 'listTagContents': {
      const query = object(second); keys(query, ['limit', 'offset', 'state', 'priority', 'platform', 'sourceId', 'intakeMethod', 'timezone', 'from', 'to', 'keyword', 'tags', 'tagMode']);
      const params = {tag_id: first, timezone: displayTimezone(query.timezone)};
      for (const [front, back] of [['platform','channel'], ['sourceId','source_id'], ['intakeMethod','intake_method'], ['from','start'], ['to','end'], ['keyword','query']]) {
        if (query[front] != null && query[front] !== '') params[back] = query[front];
      }
      if (query.tags != null && query.tags.length) params.tags = tagIds(query.tags);
      if (query.tagMode != null && query.tagMode !== '' && !['any','all'].includes(query.tagMode)) throw new Error('标签筛选方式需为任一符合或全部符合');
      if (query.tagMode === 'all') params.tag_mode = 'all';
      if (query.limit != null) params.limit = query.limit;
      if (query.offset != null) params.offset = query.offset;
      if (query.priority) params.priority = query.priority;
      if (query.state === 'unread') Object.assign(params, INBOX_FILTER);
      else if (query.state && ['read', 'archived', 'deferred'].includes(query.state)) params[query.state] = true;
      else if (query.state) unsupported('不支持此内容状态');
      const result = await call('tag.contents', params);
      const subs = await subscriptions();
      return {...result, items: result.items.map(item => contentDTO(item, subs))};
    }
    case 'setContentTags':
      return contentDTO(await call('content.set_tags', {item_id: first, tag_ids: tagIds(second)}), await subscriptions());
    case 'bulkSetTags': {
      if (!Array.isArray(first)) throw new Error('缺少内容列表');
      return call('content.bulk_set_tags', {item_ids: first, tag_ids: tagIds(second)});
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
      const patch = object(second); keys(patch, ['enabled', 'connectionId', 'intervalSeconds', 'syncMode', 'collectItems']);
      const params = {subscription_id: first};
      if ('enabled' in patch) { if (typeof patch.enabled !== 'boolean') throw new Error('enabled 必须为布尔值'); params.status = patch.enabled ? 'active' : 'paused'; }
      if ('connectionId' in patch) params.connection_id = patch.connectionId;
      if ('intervalSeconds' in patch) params.interval_seconds = patch.intervalSeconds;
      if ('syncMode' in patch) params.sync_mode = patch.syncMode;
      if ('collectItems' in patch) {
        const items = patch.collectItems;
        if (typeof items === 'number' ? (!Number.isInteger(items) || items < 0 || items > 50) : items !== null) throw new Error('collectItems 必须是 0 到 50 的整数，0 表示使用默认');
        params.collect_items = items === null ? 0 : items;
      }
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
      if (opts.pageBudget !== undefined && (!Number.isInteger(opts.pageBudget) || opts.pageBudget < 1 || opts.pageBudget > 100)) throw new Error('分页预算必须在 1 到 100 之间');
      const params = {subscription_id: first, mode: opts.kind === 'backfill' ? 'backfill' : 'refresh'};
      // Omitting pageBudget lets the core derive it from the channel's item ceiling.
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
    case 'listContentSources': {
      const query = object(first); keys(query, ['platform','keyword']);
      const params = {};
      if (query.platform) params.channel = query.platform;
      if (query.keyword) params.query = query.keyword;
      const result = await call('source.list', params);
      const items = result.items.map(source => ({id:source.id, platform:source.channel, kind:source.kind,
        externalId:source.external_id, name:source.name, link:source.url,
        confirmed:!!source.confirmed, contentCount:source.content_count}));
      return {items, total:items.length};
    }
    case 'startIntake': {
      const input = object(first); keys(input, ['url','connectionId']);
      const params = {url:input.url};
      if (input.connectionId !== undefined) params.connection_id = input.connectionId;
      return call('intake.start', params);
    }
    case 'getIntake': return call('intake.get', {task_id:first});
    case 'cancelIntake': return call('intake.cancel', {task_id:first});
    case 'saveIntake': {
      const options = object(second); keys(options, ['priority','tagIds']);
      const params = {preview_id:first};
      if ('priority' in options) params.priority = options.priority;
      if ('tagIds' in options) params.tag_ids = tagIds(options.tagIds);
      return call('intake.save', params);
    }
    case 'getSettings':
      if (!context?.settings) unsupported('设置尚未接入');
      return context.settings.read();
    case 'saveSettings': {
      if (!context?.settings) unsupported('设置尚未接入');
      const request = object(first);
      keys(request, ['section', 'patch', 'credentials']);
      return context.settings.write(request);
    }
    case 'getNotificationStatus':
      return require('./notifications.cjs').notificationStatus();
    case 'sendTestNotification':
      return require('./notifications.cjs').sendTestNotification();
    case 'checkConnection': {
      // 检查必须挑该连接真正支持的操作：只支持单条读取的渠道（例如微信）
      // 不支持 list_items，用默认操作会把可用的渠道误报成不可用。
      const [rows, descriptors] = await Promise.all([call('connection.list'), call('channel.list')]);
      const connection = rows.find(c => c.id === first);
      if (!connection) throw new Error('连接不存在');
      const operations = (descriptors.find(d => d.channel === connection.channel && d.backend === connection.backend) || {}).operations || {};
      const operation = ['list_items', 'read_item', 'resolve_item'].find(op => operations[op] && operations[op].supported);
      return operation ? call('connection.check', {connection_id: first, operation}) : call('connection.check', {connection_id: first});
    }
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
