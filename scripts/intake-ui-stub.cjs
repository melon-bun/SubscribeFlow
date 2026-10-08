// M13 自主添加界面的专用桩桥：只供 scripts/intake-ui-smoke.cjs 使用。
//
// 它替代真实 Preload，让正式 Renderer 在没有 Core 的情况下启动，用来验证
// 对话框自身的界面路径（两步流转、预览、优先级、标签、已收录、保存）。
// 平台读取与查重的真实性由 M11 的 Python 契约测试负责，这里一律不冒充。
const {contextBridge} = require('electron');

const stub = (() => {
  const DTO = {
    id: 'bilibili:video:BV1demo0001',
    title: '把普通的一天，拍成值得留下的片段',
    summary: '从日常光线与构图出发，记录身边的小事。',
    platform: 'bilibili',
    channelId: null,
    channelName: '影像笔记',
    author: '影像笔记',
    publishedAt: '2025-09-16',
    publishedPrecision: 'date',
    publishedTimezone: 'UTC',
    publishedLabel: null,
    url: 'https://www.bilibili.com/video/BV1demo0001',
    thumb: null, cover: null,
    state: { read: false, archived: false, deferred: false },
    priority: null, priorityOverride: null, sourcePriority: null,
    tags: [], updatedAt: null, contentHash: null,
    sourceId: 'bilibili:author:影像笔记',
    intakeMethod: 'subscription', firstSeenAt: null, manualAddedAt: null,
    calendarAt: null, calendarDate: null, calendarTimezone: null, calendarBasis: null,
  };

  const PREVIEW = {
    id: 'bilibili:video:BV1demo0001',
    channel: 'bilibili', namespace: 'video', external_id: 'BV1demo0001',
    kind: 'video',
    source: {
      channel: 'bilibili', kind: 'author', external_id: '影像笔记',
      name: '影像笔记', url: 'https://space.bilibili.com/946974',
      confirmed: true, avatar: null, description: null,
    },
    title: DTO.title,
    url: DTO.url,
    summary: DTO.summary,
    thumbnail: null,
    duration_seconds: null,
    acquisition_complete: true,
    published: {
      value: '2025-09-16', precision: 'date',
      provenance: 'offline-stub', timezone: 'UTC', raw_label: null,
    },
  };

  const TAGS = [
    { id: 'tag-photo', name: '摄影', color: 'violet', enabled: true, contentCount: 3 },
    { id: 'tag-idea', name: '灵感', color: 'cyan', enabled: true, contentCount: 1 },
  ];

  // 由测试脚本在每次 startIntake 前写入，决定这次识别走哪条分支。
  const scenario = { mode: 'preview', taskId: null, polls: 0, saved: [], cancelled: [], logins: [] };

  const session = {
    user: { name: '本地用户' },
    now: Date.now(),
    isDemo: false,
    capabilities: {
      canRefresh: true, canBackfill: true, canCancel: true,
      canManageChannels: true, canManagePriorities: true, canManageRules: false,
      canBookmark: false, canManageTags: true, canSchedule: true,
      // 桩里显式打开：真实渠道尚未声明链接收录能力，界面据此禁用入口。
      canIntake: true,
    },
    channels: [
      {
        channel: 'bilibili', name: 'B站', backend: 'opencli',
        operations: { match_item_url: { supported: true }, resolve_item: { supported: true }, read_item: { supported: true } },
      },
    ],
    connections: [
      { id: 'conn-bili', channel: 'bilibili', backend: 'opencli', enabled: true, readiness: { state: 'ready' } },
    ],
    scheduler: null,
    connection: { state: 'ready', detail: '界面验收桩', dependency: 'available', authentication: 'not_required', actions: [] },
  };

  const handlers = {};
  const bridge = {
    // 必须与真实 Preload 一致地返回 Promise：渲染层全部按 then/await 使用。
    async call(name, args) {
      const first = Array.isArray(args) ? args[0] : args;
      const second = Array.isArray(args) ? args[1] : undefined;
      switch (name) {
        case 'core.status': return { state: 'ready' };
        case 'getSession': return session;
        case 'getCounts': return { total: 2, unread: 2, read: 0, deferred: 0, archived: 0, high: 0, medium: 0, low: 0, none: 2 };
        case 'listPlatforms': return [{ id: 'bilibili', count: 2 }, { id: 'xiaohongshu', count: 0 }];
        case 'getRuns': return [];
        case 'listPriorities': return ['high', 'medium', 'low', 'none'].map(id => ({ id, count: 0 }));
        case 'listContents': return { items: [DTO], total: 1, next_offset: null };
        case 'getContent': return { ...DTO, id: first };
        case 'getCalendar': return { month: '2026-10', total: 0, priorities: {}, days: [] };
        case 'listChannels': {
          if (stub.subs.fail) throw new Error('订阅目录读取失败');
          if (stub.subs.subscribed) {
            return {
              items: [{
                id: 'sub-1', name: '影像笔记', platform: 'bilibili', link: 'https://space.bilibili.com/946974',
                externalId: PREVIEW.source.external_id, enabled: true, status: 'active',
              }],
              total: 1,
            };
          }
          return { items: [], total: 0 };
        }
        case 'listCreators': return { items: [], total: 0 };
        case 'listTags': return { items: TAGS, total: TAGS.length };
        case 'updateContent': return { ...DTO, id: first };
        case 'bulkUpdate': return { updated: (first || []).length };
        case 'setContentTags': return { ...DTO, id: first };
        case 'bulkSetTags': return { updated: (first || []).length };
        case 'listConnections': return session.connections;
        case 'listPrioritySettings': return [];
        case 'getSyncCoverage': return { label: '—', detail: '', complete: false };
        case 'content.open': return true;
        case 'source.open': return true;
        case 'connection.login': scenario.logins.push(first.connection_id); return true;
        case 'checkConnection': return { state: 'ready', reason: 'ok' };
        case 'getCoreStatus': return { state: 'ready' };

        /* ---- M13 收录桩：状态机形状与 Core 一致 ---- */
        case 'startIntake': {
          scenario.polls = 0;
          scenario.taskId = `task-${scenario.mode}-${Date.now()}`;
          scenario.url = first && first.url;
          if (scenario.mode === 'start-error') {
            const err = new Error('请在应用内登录该平台，完成后重新识别。');
            err.code = 'AUTH_REQUIRED'; err.scope_key = 'conn-bili';
            throw err;
          }
          const taskId = scenario.taskId;
          if (scenario.mode === 'late-start') await new Promise(r => setTimeout(r, 500));
          return { task_id: taskId, state: 'running', connection_id:'conn-bili', channel: 'bilibili', preview_id: null, item_id: null, error: null };
        }
        case 'getIntake': {
          scenario.polls++;
          if (scenario.polls < 2) return { task_id: first, state: 'running' };
          if (scenario.mode === 'preview') {
            return { task_id: first, state: 'preview', channel: 'bilibili', preview_id: 'preview-1', preview: PREVIEW, error: null };
          }
          if (scenario.mode === 'exists') {
            return { task_id: first, state: 'exists', channel: 'bilibili', item_id: PREVIEW.id, content: { ...DTO, intakeMethod: 'subscription' }, error: null };
          }
          if (scenario.mode === 'failed') {
            return { task_id: first, state: 'failed', channel: 'bilibili', error: { code: 'RATE_LIMITED', message: '平台访问过于频繁，请稍后重试', retryable: true } };
          }
          return { task_id: first, state: 'failed', error: { code: 'INTERNAL_ERROR', message: '未知桩分支' } };
        }
        case 'cancelIntake': scenario.cancelled.push(first); return { cancelled: true, task_id: first };
        case 'saveIntake': {
          const previewId = first;
          if (previewId !== 'preview-1') throw new Error('必须提交权威预览标识');
          const options = second || {};
          scenario.saved.push({ previewId, options });
          if (scenario.mode === 'save-exists') {
            return { status: 'exists', item_id: PREVIEW.id, content: { ...DTO, intakeMethod: 'subscription' } };
          }
          return { status: 'created', item_id: PREVIEW.id, content: { ...DTO, intakeMethod: 'manual' } };
        }
        default:
          throw new Error(`桩桥未实现：${name}`);
      }
    },
    async request(name, args) {
      try { return {ok:true, value:await bridge.call(name,args)}; }
      catch (error) { return {ok:false,error:{message:error.message,code:error.code,scope_key:error.scope_key}}; }
    },
    on(name, handler) {
      (handlers[name] = handlers[name] || []).push(handler);
      return () => {};
    },
  };

  return { bridge, scenario, PREVIEW, session, subs: { subscribed: false, fail: false } };
})();

contextBridge.exposeInMainWorld('SubscribeFlow', Object.freeze(stub.bridge));
// 供测试脚本切换分支：必须在页面脚本执行前挂上。
contextBridge.exposeInMainWorld('IntakeStub', Object.freeze({
  scenario: stub.scenario,
  setMode: (mode) => { stub.scenario.mode = mode; },
  setSubscribed: (on) => { stub.subs.subscribed = on; },
  // 让订阅目录读取失败：界面必须照常渲染，且不能谎称「未订阅」。
  failChannels: (on) => { stub.subs.fail = on; },
  saved: () => stub.scenario.saved,
  metrics: () => ({polls:stub.scenario.polls, cancelled:stub.scenario.cancelled, logins:stub.scenario.logins}),
  // 关掉能力声明，用来验证「尚未接入的能力按不支持处理」，而不是照样放行。
  setIntakeCapability: (on) => {    if (on) {
      stub.session.capabilities.canIntake = true;
      stub.session.channels[0].operations = {
        match_item_url: { supported: true }, resolve_item: { supported: true }, read_item: { supported: true },
      };
      return;
    }
    stub.session.capabilities.canIntake = false;
    stub.session.channels[0].operations = {
      match_item_url: { supported: false }, resolve_item: { supported: false }, read_item: { supported: false },
    };
  },
}));
