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

  /* ---------------- 侧栏筛选定义 ---------------- */

  var QUICK_FILTERS = [
    { id: "all", name: "全部更新", icon: "all-update", countKey: "total" },
    { id: "unread", name: "未处理", icon: "circle-check", countKey: "unread" },
    { id: "high", name: "高优先级", icon: "chevron-up", countKey: "high" },
    { id: "medium", name: "中优先级", icon: "chevron-top", countKey: "medium" },
    { id: "low", name: "低优先级", icon: "chevron-bottom", countKey: "low" },
    { id: "deferred", name: "稍后处理", icon: "flag", countKey: "deferred" },
    { id: "read", name: "已读", icon: "check", countKey: "read" },
    { id: "archived", name: "已归档", icon: "archive", countKey: "archived" },
  ];

  var NAV = [
    { id: "inbox", name: "收件箱", icon: "inbox" },
    { id: "overview", name: "内容总览", icon: "calendar" },
    { id: "channels", name: "渠道管理", icon: "sliders" },
    { id: "tags", name: "标签", icon: "tag" },
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
    theme: "light",
    search: "",
    contentEl: null,
    unsubscribe: [],
  };

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
    if (!NAV.some(function (n) { return n.id === name; })) name = "inbox";
    return { name: name, params: params };
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
      h("div.brand__mark", { "aria-hidden": "true" }, icon("brand", 18)),
      h(
        "div.brand__text",
        null,
        h("div.brand__name", { text: "知流" }),
        h("div.brand__slogan", { text: "聚合你关注的创作者更新" })
      )
    );

    var nav = h(
      "nav.nav",
      { "aria-label": "主导航" },
      NAV.map(function (n) {
        var badge =
          n.id === "inbox"
            ? h("span.count-pill.count-pill--brand", { text: String(app.counts.unread || 0) })
            : n.id === "tags" && app.tagCount != null
            ? h("span.count-pill", { text: String(app.tagCount) })
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
        return h(
          "button.side-row",
          {
            type: "button",
            "data-quick": f.id,
            "aria-label": f.name, title: f.name,
            onclick: function () {
              app.filters.quick = ['high','medium','low'].includes(f.id) ? 'all' : f.id;
              app.filters.priority = ['high','medium','low'].includes(f.id) ? f.id : null;
              app.filters.channelId = null; delete app.filters.day;
              app.selectedId = null;
              navigate("inbox"); render();
            },
          },
          h("span.side-row__icon", { "aria-hidden": "true" }, icon(f.icon, 13)),
          h("span.side-row__label", { text: f.name }),
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
          h(
            "span.side-row__icon.plat.plat--" + meta.id,
            { "aria-hidden": "true" },
            meta.mark
          ),
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
        h("kbd.kbd", { text: "⌘ K" })
      ),
      h(
        "div.topbar__right",
        null,
        s.isDemo ? h("span.demo-badge", null, h("span.demo-dot"), h("span", { text: "演示数据" })) : null,
        h(
          "div.topbar__date",
          null,
          icon("calendar-sm", 16),
          h("span", { text: fmt.fullDate(app.now) }),
          h("span.topbar__weekday", { text: fmt.weekday(app.now) })
        ),
        themeBtn,
        h(
          "div.user-chip",
          { "aria-label": "本地用户" },
          ui.avatar((s.user || {}).name || "用户", (s.user || {}).avatar),
          h("span.user-chip__name", { text: (s.user || {}).name || "用户" }),
          null
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
    SF.dom.render(root, [
      h("div.app", null, [
        buildSidebar(),
        h("div.shell", null, buildTopbar(), h("div.shell__body", null, buildShellBody())),
      ]),
    ]);
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

  function buildStatusBar() {
    var conn = app.session && app.session.connection;
    var active = app.runs.find(function (r) { return ["queued", "running"].includes(r.state); });
    var title, detail, tone = "info", actions = [], key, closable = true;
    if (app.coreStatus.state !== "ready") {
      title = "核心服务" + (app.coreStatus.state === "starting" ? "正在启动" : "已断开");
      detail = app.coreStatus.message || "已显示的内容是上次读取的结果，请重启服务后重新查询。";
      tone = "danger";
      key = "core:" + app.coreStatus.state;
      closable = false; // 阻塞态且带重启入口，藏起来会丢掉唯一的恢复操作
      actions.push(ui.btn("重启核心服务", { onClick: restart }));
    } else if (app.notice) {
      title = "状态读取失败"; detail = app.notice; tone = "danger";
      key = "notice:" + app.notice;
      actions.push(ui.btn("重新查询", { onClick: function () { refreshData(true); } }));
    } else if (active) {
      title = "正在同步 " + active.channelName; detail = active.message;
      key = "active:" + active.id + ":" + active.state;
      closable = false; // 实时进度，关掉就看不到采集在推进
      actions.push(ui.btn("取消任务", { onClick: function () { act("cancel:" + active.id, async function () { await app.client.cancelRun(active.id); await refreshData(true); }); } }));
    } else if (conn && conn.state !== "ready" && (conn.state !== "unknown" || !app.runs.length)) {
      title = conn.state === "unknown" ? "采集环境尚未检查" : conn.dependency === "unavailable" ? "采集依赖不可用" : "采集连接需要处理";
      detail = conn.detail; tone = "warn";
      key = "conn:" + JSON.stringify([conn.state, conn.dependency, conn.authentication, conn.detail,
        app.runs[0] && app.runs[0].id, app.runs[0] && app.runs[0].state]);
      actions.push(ui.btn("查看连接与任务", { onClick: function () { navigate("channels"); } }));
    } else {
      var latest = app.runs[0];
      if (!latest) return null;
      title = SF.fmt.runState(latest.state) + " · " + latest.channelName;
      detail = latest.message + (latest.kind === "detail" ? "" : " · " + SF.fmt.coverage(latest.scope));
      tone = ["failed", "partial", "waiting", "interrupted"].includes(latest.state) ? "warn" : "info";
      // 带上 run id 和状态：新任务或状态推进后签名自然变化，关闭过的旧提示会重新出现
      key = "run:" + latest.id + ":" + latest.state;
      actions.push(ui.btn("查看任务", { onClick: function () { navigate("channels"); } }));
    }
    // 只压住同一条提示；签名一变就重新出现，不会把后续新结果一起藏掉
    if (app.dismissedStatus === key) return null;
    return h("div.status-bar", { role: "status", "aria-live": "polite" },
      h("div.notice.notice--" + tone, null, icon("info", 16),
        h("div.notice__body", null, h("div.notice__title", { text: title }), h("div.notice__text", { text: detail })),
        actions,
        closable ? ui.iconBtn("close", "关闭提示", function () { app.dismissedStatus = key; renderContent(); }) : null));
  }

  function invalidate() {
    Object.values(SF.views).forEach(function (view) { view.reset(); });
  }
  var refreshPromise, refreshAgain = false;
  function refreshData(force) {
    // 主动写入后的刷新已经包含已提交事件，取消其延迟刷新，避免重复替换正在操作的视图。
    if (force) clearTimeout(eventTimer);
    if (refreshPromise) { refreshAgain = refreshAgain || !!force; return refreshPromise; }
    refreshPromise = (async function () {
      try {
        var results = await Promise.all([app.client.getSession(), app.client.getCounts(), app.client.listPlatforms(), app.client.getRuns()]);
        var changed = force || JSON.stringify(app.runs) !== JSON.stringify(results[3]) || JSON.stringify(app.counts) !== JSON.stringify(results[1]) || JSON.stringify(app.session && app.session.connection) !== JSON.stringify(results[0].connection);
        app.session = results[0]; app.counts = results[1]; app.platforms = results[2]; app.runs = results[3];
        app.now = Date.now(); app.notice = null;
        if (!app.selectedDate) app.selectedDate = fmt.ymd(app.now);
        if (changed) invalidate();
        if (!document.querySelector(".shell__body")) render();
        else { refreshSidebarCounts(); if (changed) renderContent(); }
      } catch (err) {
        app.notice = err.message;
        if (app.session) renderContent(); else showStartup("无法读取本地服务", err.message);
      } finally {
        refreshPromise = null;
        if (refreshAgain) { refreshAgain = false; refreshData(true); }
      }
    })();
    return refreshPromise;
  }
  function refreshRuns() { return refreshData(true); }

  function buildMain() {
    var view;
    if (app.route.name === "overview") view = SF.views.overview;
    else if (app.route.name === "channels") view = SF.views.channels;
    else if (app.route.name === "tags") view = SF.views.tags;
    else view = SF.views.inbox;

    var result = view.render(app);
    if (result && result.main) {
      app.contentEl = result.main;
      return result;
    }
    app.contentEl = result;
    return { main: result, aside: null };
  }

  function renderContent() {
    var host = document.querySelector(".shell__body");
    if (!host) return;
    SF.tooltip.hide(); // 锚点会被整体替换，旧提示要跟着收掉
    SF.dom.render(host, buildShellBody());
  }

  function buildShellBody() {
    var result = buildMain();
    return [buildStatusBar(), h("main.workspace", { id: "main", tabindex: "-1" }, [result.main, result.aside || null])];
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
      if (app.session) renderContent();
      try { await app.client.restartCore(); await connect(); }
      catch (err) { app.coreStatus = {state: "error", message: err.message}; if (app.session) renderContent(); else showStartup("核心服务不可用", err.message); }
    });
  }
  async function connect() {
    try {
      app.coreStatus = await app.client.getCoreStatus();
      if (app.coreStatus.state === "ready") return refreshData(true);
      showStartup(app.coreStatus.state === "starting" ? "正在启动核心服务…" : "核心服务不可用", app.coreStatus.message || "请稍后重新查询，或重启核心服务。");
    } catch (err) { showStartup("核心服务不可用", err.message); }
  }
  var eventTimer, pollTimer;
  function scheduleRefresh() {
    clearTimeout(eventTimer);
    eventTimer = setTimeout(function () { refreshData(true); }, 100);
  }
  function boot() {
    try { app.theme = global.localStorage.getItem("sf.theme") || "light"; } catch (_) {}
    document.documentElement.setAttribute("data-theme", app.theme);
    var resolved;
    try { resolved = SF.AppClient.createClient(); }
    catch (err) { showStartup("桌面连接不可用", err.message); return; }
    app.client = resolved.client; app.source = resolved.source;
    if (!app.client) {
      showStartup("请通过桌面应用启动", "请在 Subscribe_Flow 项目目录运行 npm start。此页面没有连接桌面服务，本地数据尚未读取。");
      return;
    }
    refreshRoute();
    ["content", "run", "channels"].forEach(function (event) { app.unsubscribe.push(app.client.on(event, scheduleRefresh)); });
    /* 标签只在 tags.changed 时失效。跟着内容刷新一起重取没有意义，
       只会多一轮异步往返，并把用户正在点的 DOM 整块换掉。 */
    app.unsubscribe.push(app.client.on("tags.changed", function () {
      if (SF.views.inbox) SF.views.inbox.invalidateTags();
      app.tagCount = null;
      scheduleRefresh();
    }));
    app.unsubscribe.push(app.client.on("core.status", function (status) {
      app.coreStatus = status;
      if (status.state === "ready") refreshData(true);
      else if (app.session) renderContent();
      else showStartup("核心服务" + (status.state === "starting" ? "正在启动…" : "不可用"), status.message || "请重新查询或重启服务。");
    }));
    global.addEventListener("hashchange", function () { refreshRoute(); app.selectedId = null; if (app.session) render(); });
    global.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); var input = document.querySelector(".topbar__search input"); if (input) input.focus();
      }
    });
    global.addEventListener("beforeunload", function () {
      app.unsubscribe.forEach(function (release) { release(); });
      clearInterval(pollTimer); clearTimeout(eventTimer); clearTimeout(searchTimer);
    });
    // Re-query persisted state as a fallback for lost/coalesced invalidation events.
    pollTimer = setInterval(function () { if (app.coreStatus.state === "ready") refreshData(false); }, 15000);
    connect();
  }

  function refreshRoute() {
    app.route = parseHash();
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
    sidebar.parentNode.replaceChild(fresh, sidebar);
    syncNavState();
  }

  SF.app = {
    state: app,
    act: act,
    refreshData: refreshData,
    restart: restart,
    boot: boot,
    render: render,
    renderContent: renderContent,
    navigate: navigate,
    refreshCounts: refreshCounts,
    refreshRuns: refreshRuns,
    refreshSidebarCounts: refreshSidebarCounts,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
