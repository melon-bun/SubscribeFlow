/* ==========================================================================
   应用引导与外壳
   --------------------------------------------------------------------------
   负责：选择数据访问实现、渲染侧栏与顶栏、路由、维护 UI 本地状态。
   不包含任何业务判断，也不区分演示 / 真实——那是 AppClient 工厂的职责。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = global.SF;
  var h = SF.dom.h;
  var ui = SF.ui;
  var icon = SF.icon;
  var fmt = SF.fmt;
  var catalog = SF.catalog;
  var scrollPositions = new Map();

  /* ---------------- 侧栏筛选定义 ---------------- */

  /* M20：优先级三行读当前显示名，所以每次渲染时取，不在模块加载时定死。 */
  var QUICK_FILTERS = [
    { id: "all", name: "全部更新", icon: "all-update", countKey: "total" },
    { id: "unread", name: "未处理", icon: "circle-check", countKey: "unread" },
    { id: "high", name: null, icon: "priority-set", countKey: "high" },
    { id: "medium", name: null, icon: "priority-set", countKey: "medium" },
    { id: "low", name: null, icon: "priority-set", countKey: "low" },
    { id: "deferred", name: "稍后处理", icon: "flag", countKey: "deferred" },
    { id: "read", name: "已读", icon: "check", countKey: "read" },
    { id: "archived", name: "已归档", icon: "archive", countKey: "archived" },
  ];

  var NAV = [
    { id: "inbox", name: "收件箱", icon: "inbox" },
    { id: "overview", name: "内容总览", icon: "calendar" },
    { id: "channels", name: "渠道管理", icon: "sliders" },
    { id: "tags", name: "标签", icon: "tag" },
    // M28：笔记入口始终可达，与当前有没有笔记无关。
    { id: "notes", name: "笔记", icon: "edit" },
  ];

  /* ---------------- 应用状态 ---------------- */

  var app = {
    client: null,
    source: "none",
    session: null,
    platforms: [],
    priorities: [],
    coreStatus: { state: "starting" },
    notice: null,
    priorityNamesLoaded: false,
    dismissedStatus: null, // 已被手动关闭的状态栏签名；状态一变即失效
    counts: {},
    runs: [],
    now: Date.now(),
    route: { name: "inbox", params: {} },
    filters: { quick: "unread", platform: null, channelId: null },
    selectedId: null,
    selectedDate: null,
    overviewMode: "calendar",
    channelTab: "list",
    tagTab: "list",
    // 标签总数由标签视图读到后回填；null 表示还没读过，不显示 0 冒充「没有标签」
    tagCount: null,
    // M28：笔记数同理，由笔记页读到后回填。
    noteCount: null,
    theme: "light",
    // M32：轻科幻层开关。true = 开启，规则挂在 [data-fx="on"] 下；
    // 关闭即回到同一套令牌的基础风格，版式不受影响。
    fx: true,
    search: "",
    contentEl: null,
    unsubscribe: [],
  };

  /* M32：顶栏在线状态点。状态取自核心服务与采集连接，
   与状态栏里的判断保持同一口径——这里只是把它缩成一个点。 */
  function onlineState(app) {
    if (app.coreStatus && app.coreStatus.state !== "ready") return "error";
    var conn = app.session && app.session.connection;
    if (conn && conn.state && conn.state !== "ready" && conn.state !== "unknown") return "warn";
    return "ok";
  }

  function onlineTitle(app) {
    var state = onlineState(app);
    if (state === "error") return "核心服务不可用";
    if (state === "warn") return "采集连接需要处理";
    return "本地服务运行中";
  }

  /* 「静流」§顶栏：呼吸点右边跟一句等宽读数。
     口径是「通过可用性检查的采集连接 / 连接总数」——数据取自核心服务已返回的
     session.connections，不额外发请求，与渠道管理页的连接判定同源。 */
  function syncReadout(app) {
    var conns = (app.session && app.session.connections) || [];
    var total = conns.length;
    var ok = conns.filter(function (c) { return c && c.readiness && c.readiness.state === "ready"; }).length;
    return {
      ok: ok,
      total: total,
      title: total
        ? ok + " / " + total + " 个采集连接通过可用性检查"
        : "尚未登记采集连接",
    };
  }

  /* M32：把轻科幻开关写到 <html data-fx>。规则全在 fx.css 里挂 [data-fx="on"]，
     所以这里只管属性与持久化，不碰任何样式表。 */
  function applyFx() {
    document.documentElement.setAttribute("data-fx", app.fx ? "on" : "off");
  }

  function setFx(enabled) {
    app.fx = !!enabled;
    applyFx();
    try {
      global.localStorage.setItem("sf.fx", app.fx ? "on" : "off");
    } catch (e) {
      /* Electron 下可能禁用 localStorage，忽略即可 */
    }
    return app.fx;
  }

  /* ---------------- 路由 ---------------- */

  function parseHash() {
    var raw = (global.location.hash || "#/inbox").replace(/^#\/?/, "");
    var parts = raw.split("?");
    var name = parts[0] || "inbox";
    var params = {};
    if (parts[1]) {
      parts[1].split("&").forEach(function (kv) {
        var p = kv.split("=");
        params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || "");
      });
    }
    // 口径写进哈希：只有收件箱带 view 才进入提醒口径；
    // 任何其它路由（含普通侧栏导航）都会退出，不会被锁死。
    app.reminderView = name === "inbox"
      ? (params.view === "high_unarchived" ? "high_unarchived" : params.view === "pending" ? "pending" : null)
      : null;
    if (name === "settings") {
      // 分区始终带回路由参数：直接改哈希进来时左栏与正文必须对得上。
      // 分区白名单：ai／reminder／priority／summarization／appearance（M32 新增外观），
      // 未知值回落到 ai。
      var section = params.section === "reminder" ? "reminder"
        : params.section === "priority" ? "priority"
        : params.section === "summarization" ? "summarization"
        : params.section === "appearance" ? "appearance" : "ai";
      return { name: name, params: { section: section } };
    }
    if (!NAV.some(function (n) { return n.id === name; })) name = "inbox";
    return { name: name, params: params };
  }

  /**
   * 切换提醒口径。两次提醒之间不能留旧筛选：通知说 23 条、页面却只剩当前平台
   * 下的 2 条是真实发生过的问题。这里一次性清空搜索、日期、平台、来源与标签
   * 过滤，但**不改任何内容的已读／归档／标签状态**——查看不产生副作用。
   */
  function openReminderView(app, view) {
    var target = view === 'high_unarchived' ? 'high_unarchived' : 'pending';
    app.reminderView = target;
    // 一次性清空旧筛选：通知说 23 条、页面只剩当前平台下 2 条是真实发生过的问题。
    app.filters = {quick: null, platform: null, channelId: null};
    app.search = "";
    app.filters.day = null;
    if (global.location.hash !== '#/inbox?view=' + target) {
      global.location.hash = '#/inbox?view=' + target;   // 路由会触发重渲染与重查
      return;
    }
    if (app.session) { render(); refreshData(true); }
  }

  /** 记住来处，设置页关闭时回到原处，而不是一律跳回收件箱。 */
  function openSettings(section) {
    app.settingsReturn = app.route.name === "settings" ? app.settingsReturn : app.route.name;
    navigate("settings", section ? { section: section } : undefined);
  }

  function navigate(name, params) {
    var qs = "";
    if (params && Object.keys(params).length) {
      qs = "?" + Object.keys(params)
        .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); })
        .join("&");
    }
    global.location.hash = "#/" + name + qs;
  }

  /* ---------------- 渲染外壳 ---------------- */

  function buildSidebar() {
    var brand = h(
      "div.sidebar__brand",
      null,
      h("div.brand__mark", { "aria-hidden": "true" }, h("img.brand__logo", { src: "assets/brand.png", alt: "", draggable: "false" })),
      h(
        "div.brand__text",
        null,
        /* 「静流」§.brand b / .brand small：用 b 与 small 承担字重与字号，
           不用 div + CSS 硬凑（display 与语义都会和参考页对不上）。 */
        h("b.brand__name", { text: "知流" }),
        h("small.brand__slogan", { text: "聚合你关注的创作者更新" })
      )
    );

    var nav = h(
      "nav.nav",
      { "aria-label": "主导航" },
      NAV.map(function (n) {
        var badge =
          n.id === "inbox"
            /* 同时带 count-pill 与 count-pill--brand：移植过来的
               「.nav-item .count」规则管排版（贴右、等宽 12px），
               「.nav-item.on .count.pill」管颜色（品牌底、白字）。 */
            ? h("span.count-pill.count-pill--brand", { text: String(app.counts.unread || 0) })
            : n.id === "tags" && app.tagCount != null
            ? h("span.count-pill", { text: String(app.tagCount) })
            : n.id === "notes" && app.noteCount != null
            ? h("span.count-pill", { text: String(app.noteCount) })
            : null;
        return h(
          "button.nav__item",
          {
            type: "button",
            "data-nav": n.id,
            "aria-label": n.name, title: n.name,
            onclick: function () {
              if (n.id === "inbox") {
                app.filters = {quick:"unread", platform:null, channelId:null};
                app.search = ""; app.selectedId = null;
              }
              navigate(n.id);
              if (n.id === "inbox") render(); // The hash may already be #/inbox.
            },
          },
          icon(n.icon, 18),
          h("span.nav__label", { text: n.name }),
          badge
        );
      })
    );

    var quick = h(
      "div",
      null,
      h("div.side-group__title", { text: "快捷筛选" }),
      QUICK_FILTERS.filter(function (f) { return !["high", "medium", "low"].includes(f.id) || app.session.capabilities.canManagePriorities; }).map(function (f) {
        // 优先级三行用当前显示名；其余筛选项名称固定。
        var label = f.name || catalog.priority(f.id).name;
        return h(
          "button.side-row",
          {
            type: "button",
            "data-quick": f.id,
            "aria-label": label, title: label,
            onclick: function () {
              app.filters.quick = ['high','medium','low'].includes(f.id) ? 'all' : f.id;
              app.filters.priority = ['high','medium','low'].includes(f.id) ? f.id : null;
              app.filters.channelId = null; delete app.filters.day;
              app.selectedId = null;
              navigate("inbox"); render();
            },
          },
          /* 「静流」§侧栏：优先级三行用信号条表达等级，不再用同一个图标；
             其余筛选项沿用固定图标。 */
          ["high", "medium", "low"].indexOf(f.id) >= 0
            ? h("span.side-row__icon", { "aria-hidden": "true" }, ui.prioSig(f.id))
            : h("span.side-row__icon", { "aria-hidden": "true" }, icon(f.icon, 13)),
          h("span.side-row__label", { text: label }),
          h("span.side-row__count", { text: String(app.counts[f.countKey] || 0) })
        );
      })
    );

    var platformGroup = h(
      "div",
      null,
      h("div.side-group__title", { text: "按平台筛选" }),
      app.platforms.map(function (p) {
        var meta = catalog.platform(p.id);
        return h(
          "button.side-row",
          {
            type: "button",
            "data-platform": p.id,
            "aria-label": meta.name, title: meta.name,
            onclick: function () {
              app.filters.platform = app.filters.platform === p.id ? null : p.id;
              app.selectedId = null;
              render();
            },
          },
          ui.platformIcon(meta.id, { className: "side-row__icon", decorative: true }),
          h("span.side-row__label", { text: meta.name }),
          h("span.side-row__count", { text: String(p.count) })
        );
      })
    );

    return h(
      "aside.sidebar",
      null,
      brand,
      h("div.sidebar__body.scroll-y", null, nav, h("div.side-group", null, quick), h("div.side-group", null, platformGroup))
    );
  }

  function buildTopbar() {
    var s = app.session || {};
    var sync = syncReadout(app);
    var input = h("input", {
      type: "search",
      placeholder: "搜索内容标题...",
      "aria-label": "搜索内容",
      value: app.search,
      oninput: function (e) {
        app.search = e.target.value;
        scheduleSearch();
      },
    });

    var themeBtn = ui.iconBtn(sunmoon ? (app.theme === "dark" ? "sun" : "moon") : "sun", "切换主题", function () {
      app.theme = app.theme === "dark" ? "light" : "dark";
      global.document.documentElement.setAttribute("data-theme", app.theme);
      try {
        global.localStorage.setItem("sf.theme", app.theme);
      } catch (e) {
        /* Electron 下可能禁用 localStorage，忽略即可 */
      }
      render();
    });

    return h(
      "header.topbar",
      null,
      h(
        "div.topbar__search",
        null,
        icon("search", 16),
        input,
        h("kbd.kbd", { text: "⌘K" })
      ),
      h(
        "div.topbar__right",
        null,
        s.isDemo ? h("span.demo-badge", null, h("span.demo-dot"), h("span", { text: "演示数据" })) : null,
        /* 「静流」§顶栏：同步状态 = 呼吸点 + 「同步 N/M」等宽读数，装在一个内凹描边的小胶囊里。
           M32：在线状态点是信号青呼吸点，异常时是静止的琥珀色
           （座舱里的「注意」），不闪烁，避免焦虑。 */
        h("span.topbar__sync", { title: sync.title, "aria-label": sync.title },
          h("span.fx-online", {
            "data-state": onlineState(app),
            title: onlineTitle(app),
            "aria-label": onlineTitle(app),
            role: "status",
          }),
          h("span", { text: "同步" }),
          sync.total ? h("b.mono", { text: sync.ok + "/" + sync.total }) : null),
        h(
          "div.topbar__date",
          null,
          icon("calendar-sm", 16),
          h("span", { text: fmt.fullDate(app.now) }),
          h("span.topbar__weekday", { text: fmt.weekday(app.now) })
        ),
        themeBtn,
        h(
          "button.user-chip",
          {
            type: "button",
            "aria-label": "本地用户，打开设置",
            title: "设置",
            onclick: function () { openSettings(); },
          },
          ui.avatar((s.user || {}).name || "用户", (s.user || {}).avatar),
          h("span.user-chip__name", { text: (s.user || {}).name || "用户" })
        )
      )
    );
  }

  var sunmoon = true;
  var searchTimer = null;

  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      renderContent();
    }, 220);
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    var root = document.getElementById("app");
    if (!root) return;
    // 设置是整页大面板：参考图里就是独立窗口式布局，不再套侧栏与顶栏。
    if (app.route.name === "settings") {
      SF.dom.renderWithScroll(root, [SF.views.settings.render(app)], scrollPositions);
      return;
    }
    SF.dom.renderWithScroll(root, [
      h("div.app", null, [
        buildSidebar(),
        h("div.shell", null, buildTopbar(), h("div.shell__body", null, buildShellBody())),
      ]),
    ], scrollPositions);
    syncNavState();
  }

  /* ---------------- 采集状态条 ---------------- */

  /**
   * 采集后端的可用性由 session.connection 与 getRuns() 共同决定：
   * 连接不可用 / 被占用 / 任务进行中 / 任务部分成功都必须在页面上可见，
   * 而不是等用户点「刷新」才通过对话框暴露。
   */
  var pending = new Map();
  function act(key, callback) {
    if (pending.has(key)) return pending.get(key);
    var promise = Promise.resolve().then(callback).catch(function (err) {
      ui.toast(err.message || "操作失败", "error");
    }).finally(function () { pending.delete(key); });
    pending.set(key, promise);
    return promise;
  }

  /* 「静流」§顶部任务条：一条横向读数行 —— 状态灯 + 状态 + 名称 + 等宽读数 +
     操作按钮，底部一条 2px 进度轨道。
     轨道三种形态：中断/失败是停在半路的虚线，同步中是流动的青色进度线，
     完成态不画轨道（没有未完成的进度可言）。 */
  function runLamp(state) {
    if (state === "running" || state === "queued") return "live";
    if (state === "succeeded") return "ok";
    if (state === "failed") return "error";
    if (["partial", "waiting", "interrupted", "cancelled"].indexOf(state) >= 0) return "warn";
    return "idle";
  }

  /* 任务读数：一行等宽文字，说清这次采集提交了多少、存了多少、覆盖到哪里。 */
  function runReadout(run) {
    var metrics = run.kind === "detail"
      ? "更新已有内容 · " + (run.items || 0) + " 条"
      : (Object.keys(run.acquisitionMetrics || {}).length
        ? "已保存 " + (run.items || 0) + " 条 · 新增 " + (run.newItems || 0) + " 条"
        : "已提交 " + (run.pages || 0) + " 页 · " + (run.items || 0) + " 条 · 新增 " + (run.newItems || 0) + " 条");
    return [run.message, metrics, run.kind === "detail" ? "" : SF.fmt.coverage(run.scope)]
      .filter(Boolean).join(" · ");
  }

  function buildStatusBar() {
    var conn = app.session && app.session.connection;
    var active = app.runs.find(function (r) { return ["queued", "running"].includes(r.state); });
    var state = "", name = "", read = "", lamp = "idle", actions = [], key, closable = true;
    if (app.coreStatus.state !== "ready") {
      state = app.coreStatus.state === "starting" ? "正在启动" : "已断开";
      name = "核心服务";
      read = app.coreStatus.message || "已显示的内容是上次读取的结果，请重启服务后重新查询。";
      lamp = "error";
      key = "core:" + app.coreStatus.state;
      closable = false; // 阻塞态且带重启入口，藏起来会丢掉唯一的恢复操作
      actions.push(ui.btn("重启核心服务", { size: "sm", onClick: restart }));
    } else if (app.notice) {
      state = "读取失败"; name = "核心服务"; read = app.notice; lamp = "error";
      key = "notice:" + app.notice;
      actions.push(ui.btn("重新查询", { size: "sm", onClick: function () { refreshData(true); } }));
    } else if (active) {
      state = "正在同步"; name = active.channelName || "采集任务"; read = active.message; lamp = "live";
      key = "active:" + active.id + ":" + active.state;
      closable = false; // 实时进度，关掉就看不到采集在推进
      actions.push(ui.btn("取消任务", { size: "sm", onClick: function () { act("cancel:" + active.id, async function () { await app.client.cancelRun(active.id); await refreshData(true); }); } }));
    } else if (conn && conn.state !== "ready" && (conn.state !== "unknown" || !app.runs.length)) {
      state = conn.state === "unknown" ? "尚未检查"
        : conn.dependency === "unavailable" ? "依赖不可用" : "需要处理";
      name = "采集连接"; read = conn.detail; lamp = "warn";
      key = "conn:" + JSON.stringify([conn.state, conn.dependency, conn.authentication, conn.detail,
        app.runs[0] && app.runs[0].id, app.runs[0] && app.runs[0].state]);
      actions.push(ui.btn("查看连接与任务", { size: "sm", onClick: function () { navigate("channels"); } }));
    } else {
      var latest = app.runs[0];
      if (!latest) return null;
      state = SF.fmt.runState(latest.state);
      name = latest.channelName || "采集任务";
      read = runReadout(latest);
      lamp = runLamp(latest.state);
      // 带上 run id 和状态：新任务或状态推进后签名自然变化，关闭过的旧提示会重新出现
      key = "run:" + latest.id + ":" + latest.state;
      actions.push(ui.btn("查看任务", { size: "sm", onClick: function () { navigate("channels"); } }));
    }
    // 只压住同一条提示；签名一变就重新出现，不会把后续新结果一起藏掉
    if (app.dismissedStatus === key) return null;
    return h("div.status-bar", { role: "status", "aria-live": "polite" },
      h("div.task.task--" + lamp, null,
        h("span.task-lamp", { "data-state": lamp, "aria-hidden": "true" }),
        h("span.task-state", { text: state }),
        h("b.task-name", { text: name }),
        h("span.task-read.mono", { text: read }),
        h("div.task-ops", null, actions,
          closable ? ui.iconBtn("close", "关闭提示", function () { app.dismissedStatus = key; patchStatusBar(); }) : null),
        h("span.task-track", { "aria-hidden": "true" })));
  }

  function invalidateViews(reasons) {
    Object.entries(SF.views).forEach(function (entry) {
      if (entry[0] !== "settings" && entry[1].invalidate) entry[1].invalidate(reasons);
    });
  }

  function currentView() { return SF.views[app.route.name]; }

  function patchStatusBar() {
    /* 任务条现在住在纸面里，宿主是 .workspace 而不是 .shell__body。 */
    var host = document.querySelector('.workspace');
    if (!host || app.route.name === 'settings') return;
    var old = host.querySelector(':scope > .status-bar'), fresh = buildStatusBar();
    if (!fresh) { if (old) old.remove(); return; }
    if (old) SF.dom.reconcileWithScroll(old, Array.from(fresh.childNodes), scrollPositions);
    else host.insertBefore(fresh, host.firstChild);
  }

  function repaintBackground(reasons) {
    patchStatusBar();
    if (app.route.name === 'settings') return;
    var view = currentView();
    if (!view) return;
    if (view.updateBackground && view.updateBackground(app, reasons)) return;
    if (app.route.name === 'channels' && view.updateRuns && reasons.has('runs')) view.updateRuns(app);
    if (['all','content','tags','channels'].some(function (reason) { return reasons.has(reason); })) renderView(app.route.name);
  }

  var refreshPromise, queuedReasons = new Set();

  /* M20 优先级显示名：启动时读一次设置，之后由设置页保存后直接应用。
     显示名只影响文案，统计与筛选口径仍按稳定等级走。 */
  function applyPriorityNames(names) {
    if (!names) return false;
    var before = catalog.priorityNames();
    catalog.setPriorityNames(names);
    var after = catalog.priorityNames();
    return before.high !== after.high || before.medium !== after.medium || before.low !== after.low;
  }

  function loadPriorityNames() {
    if (!app.client) return Promise.resolve(false);
    return app.client.getSettings().then(function (settings) {
      app.priorityNamesLoaded = true;
      return applyPriorityNames(settings && settings.priority && settings.priority.names);
    }).catch(function () {
      // 读不到就先沿用默认名，下一轮刷新再试。
      return false;
    });
  }

  function refreshData(force, reasons) {
    var requested = reasons ? new Set(reasons) : new Set([force ? 'all' : 'poll']);
    if (force && !reasons) {
      clearTimeout(eventTimer); clearTimeout(eventDeadline);
      pendingEvents.forEach(function (reason) { requested.add(reason); });
      pendingEvents.clear(); urgentEvents = false; eventTimer = eventDeadline = null;
    }
    requested.forEach(function (reason) { queuedReasons.add(reason); });
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async function () {
      try {
        while (queuedReasons.size) {
          var batch = new Set(queuedReasons); queuedReasons.clear();
          /* M32：只在真正要拉新数据时扫一次光；轮询兜底不扫，避免每 15 秒闪一下。 */
          if (!batch.has('poll')) triggerSweep();
          var all = batch.has('all') || batch.has('poll') || !app.session;
          var readCounts = all || batch.has('content') || batch.has('tags') || batch.has('channels');
          var readSession = all || batch.has('connection') || batch.has('channels');
          var readRuns = all || batch.has('runs');
          try {
            var results = await Promise.all([
              readSession ? app.client.getSession() : app.session,
              readCounts ? app.client.getCounts() : app.counts,
              readCounts ? app.client.listPlatforms() : app.platforms,
              readRuns ? app.client.getRuns() : app.runs
            ]);
            var sidebarChanged = JSON.stringify(app.counts) !== JSON.stringify(results[1]) || JSON.stringify(app.platforms) !== JSON.stringify(results[2]);
            app.session = results[0]; app.counts = results[1]; app.platforms = results[2]; app.runs = results[3];
            app.now = Date.now(); app.notice = null;
            if (!app.selectedDate) app.selectedDate = fmt.ymd(app.now);
            // 优先级显示名：首次装载后固定，设置页改名会直接应用并触发重绘。
            if (!app.priorityNamesLoaded) await loadPriorityNames();
            // The periodic fallback also repairs missed invalidations, even when totals match.
            if (batch.has('poll')) ['content','tags','channels','runs','tagging'].forEach(function (reason) { batch.add(reason); });
            if (!app.session) continue;
            if ((batch.has('tags') || batch.has('all')) && app.tagCount !== null) {
              app.tagCount = null; sidebarChanged = true;
            }
            invalidateViews(batch);
            if (app.route.name !== 'settings' && !document.querySelector('.shell__body')) render();
            else {
              if (sidebarChanged) refreshSidebarCounts();
              repaintBackground(batch);
            }
            // Writes may await this promise; include the active view's follow-up reads.
            var view = currentView();
            if (batch.has('all') && view && view.whenIdle) await view.whenIdle();
          } catch (err) {
            app.notice = err.message;
            if (app.session) patchStatusBar();
            else showStartup("无法读取本地服务", err.message);
          }
        }
      } finally { refreshPromise = null; }
    })();
    return refreshPromise;
  }
  function refreshRuns() { return refreshData(false, ['runs']); }

  function buildMain() {
    var view;
    if (app.route.name === "overview") view = SF.views.overview;
    else if (app.route.name === "channels") view = SF.views.channels;
    else if (app.route.name === "tags") view = SF.views.tags;
    else if (app.route.name === "notes") view = SF.views.notes;
    else view = SF.views.inbox;

    var result = view.render(app);
    var main = result && result.main || result;
    if (main) main.dataset.scrollScope = JSON.stringify([app.route.name, app.filters, app.search,
      app.overviewMode, app.calendarMonth, app.channelTab, app.tagTab]);
    /* 「静流」：纸面里是「主区 + 详情」两列，主区自带内边距 26px 26px 0。
       产品原来直接把这个视图当主区，纸面里就没有 .main 这一层，
       内边距只好挂在视图自己身上——与参考页的结构对不上。
       注意：两个分支都要包。只包 {main, aside} 那一支的话，
       笔记 / 总览 / 渠道 / 标签这些直接返回元素的视图就没有 .main，
       内边距消失，页面标题会直接贴上顶部任务条。 */
    if (result && result.main) {
      app.contentEl = result.main;
      return { main: h('div.main', null, result.main), aside: result.aside || null };
    }
    app.contentEl = result;
    return { main: h('div.main', null, result), aside: null };
  }

  function renderContent(options) {
    if (app.route.name === "settings") {
      if (!options || !options.background) render();
      return;
    }
    var host = document.querySelector(".shell__body");
    if (!host) return;
    if (options && options.background) {
      SF.dom.reconcileWithScroll(host, buildShellBody(), scrollPositions);
      app.contentEl = host.querySelector('.workspace > .main');
    } else {
      SF.tooltip.hide();
      SF.dom.renderWithScroll(host, buildShellBody(), scrollPositions);
    }
  }

  // Async results can only repaint the route that requested them.
  function renderView(name) {
    if (app.route.name === name && app.session) renderContent({background:true});
  }

  function buildShellBody() {
    var result = buildMain();
    /* M32：扫描光的载体。关闭轻科幻时它没有样式也不参与布局（fx.css 里
       [data-fx="on"] 才给它 display:block）。 */
    /* 「静流」：任务条是**纸面的一部分**（方案里 .task 在 .sheet 内，
       margin:12px 14px 0），不是浮在纸面上方的灰底横条。
       所以它排在 .workspace 的第一个子位，横跨主区与详情两列。 */
    return [
      h("main.workspace" + (result.aside ? "" : ".solo"), { id: "main", tabindex: "-1" }, [
        buildStatusBar(),
        result.main,
        result.aside || null,
        h("span.fx-sweep", { "aria-hidden": "true" }),
      ]),
    ];
  }

  /* M32：后台刷新时纸面顶边扫过一道光，代替转圈的加载图标。
     只在效果开启时做，且不打断刷新链路——纯粹是个视觉提示。 */
  function triggerSweep() {
    if (!app.fx) return;
    var sheet = document.querySelector(".workspace");
    if (!sheet) return;
    sheet.classList.remove("is-scanning");
    // 强制回流，保证连续刷新时动画能重新播放
    void sheet.offsetWidth;
    sheet.classList.add("is-scanning");
    setTimeout(function () {
      sheet.classList.remove("is-scanning");
    }, 2400);
  }

  function syncNavState() {
    document.querySelectorAll("[data-nav]").forEach(function (b) {
      b.classList.toggle("is-active", b.dataset.nav === app.route.name && (b.dataset.nav !== "inbox" || app.filters.quick === "unread"));
    });
    document.querySelectorAll("[data-quick]").forEach(function (b) {
      b.classList.toggle("is-active", app.route.name === "inbox" && (b.dataset.quick === (app.filters.priority || app.filters.quick)) && !app.filters.platform);
    });
    document.querySelectorAll("[data-platform]").forEach(function (b) {
      b.classList.toggle("is-active", b.dataset.platform === app.filters.platform);
    });
  }

  /* ---------------- 引导 ---------------- */

  function showStartup(title, detail) {
    SF.dom.render(document.getElementById("app"), ui.state({ icon: "server", title: title, desc: detail,
      actions: app.client ? [
        { label: "重新查询", onClick: connect },
        { label: "重启核心服务", onClick: restart }
      ] : [] }));
  }
  function restart() {
    return act("restart", async function () {
      app.coreStatus = {state: "starting"};
      if (app.session) patchStatusBar();
      try { await app.client.restartCore(); await connect(); }
      catch (err) { app.coreStatus = {state: "error", message: err.message}; if (app.session) patchStatusBar(); else showStartup("核心服务不可用", err.message); }
    });
  }
  async function connect() {
    try {
      app.coreStatus = await app.client.getCoreStatus();
      if (app.coreStatus.state === "ready") return refreshData(true);
      showStartup(app.coreStatus.state === "starting" ? "正在启动核心服务…" : "核心服务不可用", app.coreStatus.message || "请稍后重新查询，或重启核心服务。");
    } catch (err) { showStartup("核心服务不可用", err.message); }
  }
  var eventTimer, eventDeadline, pollTimer, urgentEvents = false, pendingEvents = new Set();
  var rawAliases = new Map();
  function flushEvents() {
    clearTimeout(eventTimer); clearTimeout(eventDeadline);
    eventTimer = eventDeadline = null; urgentEvents = false;
    if (!pendingEvents.size) return;
    var reasons = new Set(pendingEvents); pendingEvents.clear();
    refreshData(false, reasons);
  }
  function scheduleRefresh(reasons, immediate) {
    reasons.forEach(function (reason) { pendingEvents.add(reason); });
    clearTimeout(eventTimer);
    urgentEvents = urgentEvents || !!immediate;
    eventTimer = setTimeout(flushEvents, urgentEvents ? 0 : 120);
    if (!eventDeadline) eventDeadline = setTimeout(flushEvents, 600);
  }
  function suppressAliases(names) {
    names.forEach(function (name) { rawAliases.set(name, Date.now()); });
  }
  function subscribeChanges() {
    function on(name, fn) { app.unsubscribe.push(app.client.on(name, fn)); }
    on('sync.changed', function (run) {
      suppressAliases(['run','runs']);
      var terminal = run && !['queued','running'].includes(run.state);
      scheduleRefresh(terminal ? ['runs','content','connection'] : ['runs'], terminal);
    });
    on('content.changed', function (data) {
      suppressAliases(['content']);
      if (data && Array.isArray(data.ids) && !data.ids.length) return;
      scheduleRefresh(['content']);
    });
    on('subscription.changed', function () { suppressAliases(['channels']); scheduleRefresh(['channels']); });
    on('scheduler.changed', function () { suppressAliases(['channels']); scheduleRefresh(['channels']); });
    on('tags.changed', function () { suppressAliases(['content']); scheduleRefresh(['tags']); });
    on('tagging.changed', function () { scheduleRefresh(['tagging']); });
    // Older bridge consumers still emit aliases. The desktop sends the typed
    // event first, so one notification never starts two queries.
    [['content','content'],['run','runs'],['channels','channels']].forEach(function (entry) {
      on(entry[0], function () {
        if (Date.now() - (rawAliases.get(entry[0]) || 0) < 50) return;
        scheduleRefresh([entry[1]]);
      });
    });
  }
  function boot() {
    try { app.theme = global.localStorage.getItem("sf.theme") || "light"; } catch (_) {}
    document.documentElement.setAttribute("data-theme", app.theme);
    /* M32：恢复轻科幻层开关。存 "off" 才关闭；没有记录时默认开启。 */
    try {
      var fxSaved = global.localStorage.getItem("sf.fx");
      app.fx = fxSaved !== "off";
    } catch (_) {
      app.fx = true;
    }
    applyFx();
    var resolved;
    try { resolved = SF.AppClient.createClient(); }
    catch (err) { showStartup("桌面连接不可用", err.message); return; }
    app.client = resolved.client; app.source = resolved.source;
    if (!app.client) {
      showStartup("请通过桌面应用启动", "请在 Subscribe_Flow 项目目录运行 npm start。此页面没有连接桌面服务，本地数据尚未读取。");
      return;
    }
    refreshRoute();
    subscribeChanges();
    /* M17：通知点击。主进程会先恢复窗口再下发意图；这里清空旧过滤并打开
       对应口径的统一列表——不还原通知里那个可能已经过时的数量。 */
    app.unsubscribe.push(app.client.on("reminder.navigate", function (intent) {
      if (!intent) return;
      if (intent.view === "settings") { openSettings("tagging"); return; }
      // 走与手动切换完全相同的路径：口径真正进入查询、旧过滤一次性清空。
      openReminderView(app, intent.view === "high_unarchived" ? "high_unarchived" : "pending");
    }));
    app.unsubscribe.push(app.client.on("core.status", function (status) {
      app.coreStatus = status;
      if (status.state === "ready") refreshData(true);
      else if (app.session) patchStatusBar();
      else showStartup("核心服务" + (status.state === "starting" ? "正在启动…" : "不可用"), status.message || "请重新查询或重启服务。");
    }));
    var leavingSettings = false;
    // 记住上一个哈希：M27 的离开确认要把用户带回原来的页面，
    // 重建哈希会丢掉筛选参数。
    var previousHash = global.location.hash;
    global.addEventListener("hashchange", function () {
      if (leavingSettings) return;
      var was = app.route.name;
      var wasHash = previousHash;
      previousHash = global.location.hash;
      // 带着未保存的草稿离开设置页（包括浏览器后退）先问保存还是放弃。
      // 确认期间仍保留 settings 路由，后台刷新不能提前把表单替换成目标页面。
      if (was === "settings" && parseHash().name !== "settings") {
        leavingSettings = true;
        SF.views.settings.confirmLeave(app).then(function (proceed) {
          leavingSettings = false;
          if (proceed) {
            SF.views.settings.reset();
            refreshRoute();
            app.selectedId = null;
            if (app.session) render();
          } else {
            // 留在设置页：把哈希拉回来，用户继续编辑刚才的草稿。
            var section = SF.views.settings.currentSection();
            history.replaceState(null, "", "#/settings?section=" + section);
            refreshRoute();
            if (app.session) render();
          }
        });
        return;
      }
      // M21：标签页的识别设置也可能有草稿，离开前同样先问一句。
      // 去设置页不算离开：草稿就在模块状态里，回来还在，用户可以先去补齐 API。
      if (was === "tags" && app.tagTab === "ai" && parseHash().name !== "tags" &&
          parseHash().name !== "settings" && SF.views.tags.hasRecognitionDraft()) {
        leavingSettings = true;
        var stayOnTags = function () {
          history.replaceState(null, "", "#/tags?tab=ai");
          refreshRoute();
          if (app.session) render();
        };
        // 确认流程无论成功、失败还是被关掉，都必须释放导航锁：
        // 锁不释放的话，之后所有 hashchange 都会被直接忽略（BUG-105）。
        Promise.resolve()
          .then(function () { return SF.views.tags.confirmLeave(app); })
          .then(function (proceed) {
            if (!proceed) { stayOnTags(); return; }
            refreshRoute();
            app.selectedId = null;
            if (app.session) render();
          }, function () {
            // 确认流程本身出错：按继续编辑处理，草稿保留，不把人困在原地。
            stayOnTags();
          })
          .finally(function () { leavingSettings = false; });
        return;
      }
      // M27：内容详情里的笔记有未保存的文字时，离开当前页先问一句。
      // 与设置页、识别设置同一套机制；确认流程无论成功、失败还是被关掉，
      // 都必须释放导航锁，否则之后所有 hashchange 都会被忽略（BUG-105）。
      var leavingView = was === "notes" ? SF.views.notes : SF.views.inbox;
      if (leavingView && leavingView.hasNoteDraft && leavingView.hasNoteDraft()) {
        var leaving = leavingView.confirmLeave(app);
        if (leaving && typeof leaving.then === "function") {
          leavingSettings = true;
          var stayHere = function () {
            history.replaceState(null, "", wasHash || "#/inbox");
            // 哈希被拉回来了：记住它，下一次离开才有正确的出发点。
            previousHash = global.location.hash;
            refreshRoute();
            if (app.session) render();
          };
          Promise.resolve(leaving).then(function (proceed) {
            leavingSettings = false;
            if (proceed) {
              refreshRoute();
              app.selectedId = null;
              if (app.session) render();
            } else {
              stayHere();
            }
          }, function () {
            leavingSettings = false;
            stayHere();
          });
          return;
        }
      }
      refreshRoute();
      app.selectedId = null;
      if (app.session) render();
    });
    global.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); var input = document.querySelector(".topbar__search input"); if (input) input.focus();
      }
    });
    global.addEventListener("beforeunload", function () {
      app.unsubscribe.forEach(function (release) { release(); });
      clearInterval(pollTimer); clearTimeout(eventTimer); clearTimeout(eventDeadline); clearTimeout(searchTimer);
    });
    // Re-query persisted state as a fallback for lost/coalesced invalidation events.
    pollTimer = setInterval(function () { if (app.coreStatus.state === "ready") refreshData(false); }, 15000);
    connect();
  }

  function refreshRoute() {
    var previous = app.route.name;
    app.route = parseHash();
    if (app.route.name === "settings") {
      if (previous !== "settings") {
        SF.views.settings.reset();
        app.settingsReturn = NAV.some(function (n) { return n.id === previous; }) ? previous : "inbox";
      }
      SF.views.settings.setSection(app.route.params.section);
    }
    if (app.route.name === "overview") {
      app.overviewMode = app.route.params.mode === "priority" ? "priority" : "calendar";
    }
    if (app.route.name === "channels" && app.route.params.tab) {
      app.channelTab = app.route.params.tab;
    }
    // 页签值只认白名单里的两个：哈希是用户可改的，未知值静默回落到列表页
    if (app.route.name === "tags") {
      app.tagTab = app.route.params.tab === "ai" ? "ai" : "list";
    }
    return Promise.resolve();
  }

  /** 侧栏计数通过 AppClient 获取，页面不感知实现来自演示还是真实服务 */
  function refreshCounts() { return refreshData(true); }

  /** 只重建侧栏，避免计数变化时把整个主区域一起重绘（会丢失输入焦点） */
  function refreshSidebarCounts() {
    var sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;
    var fresh = buildSidebar();
    SF.dom.reconcileWithScroll(sidebar, Array.from(fresh.childNodes), scrollPositions);
    syncNavState();
  }

  SF.app = {
    state: app,
    openSettings: openSettings,
    openReminderView: openReminderView,
    /* M32：轻科幻层开关（设置 → 外观） */
    setFx: setFx,
    isFxOn: function () { return !!app.fx; },
    act: act,
    isPending: function (key) { return pending.has(key); },
    refreshData: refreshData,
    restart: restart,
    boot: boot,
    render: render,
    renderContent: renderContent,
    renderView: renderView,
    navigate: navigate,
    refreshCounts: refreshCounts,
    refreshRuns: refreshRuns,
    refreshSidebarCounts: refreshSidebarCounts,
    // M20：设置页保存后立即把新名称应用到公共目录并重绘。
    applyPriorityNames: applyPriorityNames,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
