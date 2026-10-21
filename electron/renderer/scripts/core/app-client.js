/* ==========================================================================
   AppClient —— 页面与业务之间的唯一数据访问边界
   --------------------------------------------------------------------------
   页面只调用本接口，不直接读取演示数据、不拼接平台参数、不访问数据库。
   F1 阶段由开发预览注入异步演示实现；M4/M5 由受限 Preload API 提供真实实现，
   两种实现通过同一个 createClient() 工厂注入，页面代码不出现 mock / real 判断。
   --------------------------------------------------------------------------
   契约（全部返回 Promise；失败以 { ok:false, error } 语义或抛错约定为准）：

     getSession()            → { user, capabilities, connection }
     getCounts()             → Counts                      侧栏筛选计数
     listPlatforms()         → PlatformCount[]            侧栏「按平台筛选」
     listPriorities()        → PriorityMeta[]             优先级定义与计数
     getCalendar(query)     → { month, total, priorities, days } 日历汇总
     listContents(query)     → { items, total }            内容查询
     getContent(id)          → ContentItem                 详情
     updateContent(id, patch)→ ContentItem                 整理状态变更
     bulkUpdate(ids, patch)  → { updated }                 批量操作
     listChannels(query)     → { items, total }            渠道列表
     createChannel(draft)    → Channel                     新增渠道/作者
     updateChannel(id, patch)→ Channel
     removeChannel(id)       → { removed }
     setChannelEnabled(id,on)→ Channel
     startChannelRun(id, opts)→ { runId }                  发起刷新/回溯
     cancelRun(runId)        → { cancelled }
     getRuns()               → Run[]                       任务与进度
     listCreators(query)     → { items, total }            创作者管理
     getPrioritySettings()   → PrioritySetting[]
     savePrioritySettings()  → PrioritySetting[]
     listRules()             → Rule[]
     createRule(draft)       → Rule
     updateRule(id, patch)   → Rule
     removeRule(id)          → { removed }
     getSyncCoverage(id)     → Coverage                    「最近窗口 / 历史完成」范围
     listTags(query)         → { items, total }            标签管理（M9）
     getTag(id)              → Tag
     createTag(draft)        → Tag
     updateTag(id, patch)    → Tag                         改名不改稳定 ID
     setTagEnabled(id,on)    → Tag
     removeTag(id)           → { removed, detachedContents }
     listTagContents(id, q)  → { items, total }            该标签下的内容
     setContentTags(id, ids) → ContentItem                 内容打标
     bulkSetTags(ids, ids)   → { updated }                 批量打标
     getSettings()           → Settings                    脱敏设置（M15）
     saveSettings(request)      → Settings                    按页保存 {section,patch,credentials}
     getNotificationStatus() → NotificationStatus          通知支持情况（M15）
     sendTestNotification()  → NotificationStatus          测试通知（M15）
     getNote(id)             → Note | null                 内容笔记（M26）
     saveNote(id, note)      → Note | null                 全量替换，冲突时抛错
     deleteNote(id, version) → { ok }                      删除笔记（不删内容）
     listNotes(query)        → { items, total, next_offset } 笔记目录
     noteFacets(query)       → { channels, sources, tags }  笔记范围内的筛选项
     draftNote(id, requestId) → SummaryDraft               生成总结草稿（不落库）
     on(event, handler)      → unsubscribe                 进度等事件
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});

  /** 契约方法清单；开发预览用它校验实现是否完整，避免实现漂移。 */
  var CONTRACT = [
    "getSession",
    "getCounts",
    "listPlatforms",
    "listPriorities",
    "listContents",
    "getCalendar",
    "getContent",
    "updateContent",
    "bulkUpdate",
    "listChannels",
    "createChannel",
    "updateChannel",
    "removeChannel",
    "setChannelEnabled",
    "startChannelRun",
    "cancelRun",
    "getRuns",
    "listCreators",
    "getPrioritySettings",
    "savePrioritySettings",
    "listRules",
    "createRule",
    "updateRule",
    "removeRule",
    "getSyncCoverage",
    "listTags",
    "getTag",
    "createTag",
    "updateTag",
    "setTagEnabled",
    "removeTag",
    "listTagContents",
    "setContentTags",
    "bulkSetTags",
    "resolveSource", "searchSources", "listConnections", "checkConnection", "retryRun", "fetchDetail",
    "startIntake", "getIntake", "cancelIntake", "saveIntake", "listContentSources",
    "getSettings", "saveSettings", "getNotificationStatus", "sendTestNotification",
    // M25 公共 AI 层：连接列表与协议最小探针。
    "listAiProviders", "testAiProvider",
    // M26 笔记：一条内容一条笔记，写入是全量替换。
    "getNote", "saveNote", "deleteNote", "listNotes", "noteFacets",
    // M29 总结草稿：受限调用，只给内容 ID 与请求 ID。
    "draftNote",
    "on",
  ];


  /**
   * 校验一个实现是否满足契约。返回缺失方法名数组。
   * 只在开发环境使用；生产实现由 M5 验收。
   */
  function missingMethods(impl) {
    if (!impl) return CONTRACT.slice();
    return CONTRACT.filter(function (name) {
      return typeof impl[name] !== "function";
    });
  }

  /**
   * 统一选择数据访问实现。这是全应用唯一一处区分 demo / real 的位置。
   *
   * 优先级：
   *   1. 存在 Preload 业务桥（window.SubscribeFlow）→ 真实实现（M5 提供）
   *   2. 启动配置显式传入 demoFactory（仅开发预览）→ 演示实现
   *   3. 都没有 → 返回 null，页面展示「尚未接入」的真实状态，不伪造数据
   *
   * @param {object} [config]
   * @param {string} [config.mode]        'auto' | 'demo' | 'real'
   * @param {Function} [config.demoFactory] 返回 AppClient 演示实现
   * @param {object} [config.bridge]      Preload 暴露的 window.SubscribeFlow
   * @returns {{ client: object|null, source: 'real'|'demo'|'none' }}
   */
  function createClient(config) {
    config = config || {};
    var mode = config.mode || "auto";
    var bridge = config.bridge !== undefined ? config.bridge : global.SubscribeFlow;

    if (mode === "real") {
      return wrap(realClientFactory(bridge), "real");
    }
    if (mode === "demo") {
      if (!config.demoFactory) throw new Error("mode=demo 但未提供 demoFactory");
      return wrap(config.demoFactory(), "demo");
    }
    if (bridge) {
      return wrap(realClientFactory(bridge), "real");
    }
    if (config.demoFactory) {
      return wrap(config.demoFactory(), "demo");
    }
    return { client: null, source: "none" };
  }

  /**
   * 真实实现入口：M4/M5 在 Preload 暴露 window.SubscribeFlow 后由其转发。
   * 这里只做方法转发与错误规整，不含任何业务判断。
   */
  function realClientFactory(bridge) {
    if (!bridge || typeof bridge.call !== "function" || typeof bridge.on !== "function") {
      throw new Error("SubscribeFlow 桥缺少 call()，请检查 Preload 白名单实现");
    }
    function invoke(name, args) {
      if (typeof bridge.request !== 'function') return bridge.call(name, args);
      return bridge.request(name, args).then(function (result) {
        if (!result.ok) {
          var error = new Error(result.error.message);
          Object.assign(error, result.error);
          throw error;
        }
        return result.value;
      });
    }
    var client = {
      on: function (event, handler) {
        if (typeof bridge.on !== "function") return function () {};
        return bridge.on(event, handler);
      },
    };
    CONTRACT.forEach(function (name) {
      if (name === "on") return;
      client[name] = function () {
        var args = Array.prototype.slice.call(arguments);
        return invoke(name, args);
      };
    });
    client.getCoreStatus = function () { return invoke('core.status'); };
    client.restartCore = function () { return invoke('core.restart'); };
    client.openContent = function (id) { return invoke('content.open', { item_id: id }); };
    client.openChannel = function (id) { return invoke('source.open', { subscription_id: id }); };
    client.loginConnection = function (id) { return invoke('connection.login', { connection_id: id }); };
    // M16 自动打标。直接走 RPC 通道名：这些方法不接受也不返回密钥，
    // 因此不需要经过主进程的凭据编排。
    client.getTaggingStatus = function () { return invoke('tagging.status', {}); };
    // M25：连接列表与按连接的最小协议探针。探针不打标签、不生成笔记。
    client.listAiProviders = function () { return invoke('ai.provider.list', {}); };
    client.testAiProvider = function (providerId) { return invoke('ai.provider.test', { provider_id: providerId }); };
    // M26 笔记。写入是全量替换：各编辑字段都要明确提交，
    // expectedVersion 传 null 表示新建；冲突时 Core 拒绝写入并带回当前这份。
    client.getNote = function (itemId) { return invoke('getNote', [itemId]); };
    client.saveNote = function (itemId, note) { return invoke('saveNote', [itemId, note || {}]); };
    client.deleteNote = function (itemId, expectedVersion) {
      return invoke('deleteNote', [itemId, expectedVersion ?? null]);
    };
    client.listNotes = function (params) { return invoke('listNotes', [params || {}]); };
    client.noteFacets = function (params) { return invoke('noteFacets', [params || {}]); };
    // M29：生成总结草稿。requestId 由调用方给，用来认领这一次请求的返回。
    client.draftNote = function (itemId, requestId) {
      return invoke('note.draft', { item_id: itemId, request_id: requestId || null });
    };
    // M21：可以指定要测哪一类 API。只测这一类，不改打标方式、不触发打标。
    client.testTaggingConnection = function (mode) {
      return mode ? invoke('tagging.test', { mode: mode }) : invoke('tagging.test', {});
    };
    client.listTaggingTasks = function (params) { return invoke('tagging.tasks', params || {}); };
    client.retryTaggingTask = function (taskId) { return invoke('tagging.retry', { task_id: taskId }); };
    client.previewTaggingBackfill = function (limit) {
      return limit ? invoke('tagging.backfill_preview', { limit: limit }) : invoke('tagging.backfill_preview', {});
    };
    client.runTaggingBackfill = function (limit) {
      return limit ? invoke('tagging.backfill', { limit: limit }) : invoke('tagging.backfill', {});
    };
    return client;
  }

  function wrap(impl, source) {
    return { client: impl, source: source };
  }

  SF.AppClient = {
    CONTRACT: CONTRACT,
    createClient: createClient,
    missingMethods: missingMethods,
  };
})(window);
