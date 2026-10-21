/* ==========================================================================
   视图：标签管理（M9）
   --------------------------------------------------------------------------
   两个页签：
     #/tags?tab=list  标签列表 + 右侧标签详情
     #/tags?tab=ai    AI 自动识别：后台任务、失败重试与历史补打

   「标签规则」整页属于后续模块，本期不做。因此本页不会出现任何指向规则的入口：
   放一个点了没反应的按钮，比诚实地说明「还没有这个功能」更糟。

   两条硬约束贯穿全文件：
     1. 数据只走 app.client.*，页面不判断演示 / 真实，不自己拼查询参数。
     2. 颜色只走 SF.tagCatalog，页面代码里不出现任何十六进制色值。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});
  var h = SF.dom.h;
  var ui = SF.ui;
  var icon = SF.icon;
  var fmt = SF.fmt;
  var tagUi = SF.tagUi;
  var tagCatalog = SF.tagCatalog;

  var TABS = [
    { id: "list", label: "标签列表" },
    { id: "ai", label: "AI 自动识别" },
  ];

  /* 上限照抄后端 contracts/tags.py。在输入时就拦住，比提交一次、失败一次、
     再让用户猜哪里写错了要好。 */
  var MAX_NAME = 40;
  var MAX_DESCRIPTION = 200;
  var MAX_SYNONYMS = 8;
  var MAX_SYNONYM = 40;

  /* 详情里只列最近几条。这个区块回答的是「这个标签最近落在什么内容上」，
     完整列表不在本期范围，铺满几百行只会把编辑区挤到看不见。 */
  var CONTENTS_PREVIEW = 5;

  /* ---------------- 本地状态 ----------------
     只放「界面上一次编辑到哪里」和「读回来的结果」，不放业务数据。 */
  var cache = {
    tags: [],
    total: 0,
    /* 未筛选时的全量快照。只用于新建标签时算默认色：筛选状态下
       nextColor 拿可见的几条算，会让取色跟着筛选条件乱跳。 */
    all: null,
    contents: [],
    contentsTotal: 0,
    contentsLoading: false,
    contentsError: null,
    loading: false,
    loaded: false,
    error: null,
    keyword: "",
    status: "all",
    /* M23：排序只在本会话里保留，不进用户设置。
       默认按名称，与旧行为一致；"usage_desc"/"usage_asc" 按使用次数排。 */
    sort: "name",
    activeTagId: null,
    /* 首次进入才默认选中第一条。标签被删掉或被筛掉之后不该又跳回首行。 */
    autoSelect: true,
    /* 用户主动换了搜索／筛选／排序：这一次允许回到结果顶部，
       与「点行选中」「后台刷新」区分开。 */
    resetScroll: false,
    /* 编辑副本存在模块作用域而不是闭包里：换颜色要整页重绘，
       放闭包里的话用户刚敲进去的描述会在点色块时消失。 */
    draft: null,
    draftError: null,
  };

  var searchTimer = null;
  var keepSearchFocus = false;
  /* 在飞的列表请求。写操作与 tags.changed 会几乎同时各触发一次刷新，
     没有这个句柄就无法区分「已经有人在读」和「我这次必须读到最新的」。 */
  var inflight = null;
  var contentsPromise = null;
  var generation = 0, contentsGeneration = 0;
  var tagsStale = true, contentsStale = true;
  var tagsRevision = 0, contentsRevision = 0;
  var draftVersion = 0;

  function paint() {
    var anchor = captureAnchor();
    SF.app.renderView("tags");
    restoreAnchor(anchor);
  }

  /**
   * 可见行锚点（M22）：记住视口最上面那条标签，重排之后按它回到同一行。
   * 光靠 scrollTop 不够——按使用次数排序时行会换位置，同一个 scrollTop
   * 指向的已经不是同一条标签了。
   */
  function captureAnchor() {
    if (cache.resetScroll) return null;
    var wrap = document.querySelector(".tags-table-wrap");
    if (!wrap) return null;
    var top = wrap.getBoundingClientRect().top;
    var rows = wrap.querySelectorAll("tbody tr[data-tag-id]");
    for (var i = 0; i < rows.length; i++) {
      var rect = rows[i].getBoundingClientRect();
      if (rect.bottom > top) {
        return { id: rows[i].getAttribute("data-tag-id"), offset: rect.top - top };
      }
    }
    return null;
  }

  function restoreAnchor(anchor) {
    var wrap = document.querySelector(".tags-table-wrap");
    if (!wrap) return;
    if (cache.resetScroll) {
      // 用户主动换了搜索／筛选／排序：这一次允许回到结果顶部。
      cache.resetScroll = false;
      wrap.scrollTop = 0;
      return;
    }
    if (!anchor) return;
    var rows = wrap.querySelectorAll("tbody tr[data-tag-id]");
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute("data-tag-id") !== anchor.id) continue;
      var delta = rows[i].getBoundingClientRect().top - wrap.getBoundingClientRect().top - anchor.offset;
      if (delta) wrap.scrollTop += delta;
      return;
    }
  }

  function tabActive(app, tab) {
    return app.route.name === "tags" && app.tagTab === tab;
  }

  function invalidate(reasons) {
    if (reasons.has("all") || reasons.has("tags")) { tagsStale = true; tagsRevision++; }
    if (reasons.has("all") || reasons.has("tags") || reasons.has("content") || reasons.has("channels")) {
      contentsStale = true; contentsRevision++;
    }
    if (reasons.has("all") || reasons.has("tagging")) { aiState.stale = true; aiState.revision++; }
  }

  /* ---------------- 取数 ---------------- */

  function filtered() {
    return !!cache.keyword || cache.status !== "all";
  }

  function query() {
    var q = {};
    if (cache.keyword) q.keyword = cache.keyword;
    if (cache.status === "enabled") q.enabled = true;
    else if (cache.status === "disabled") q.enabled = false;
    // M23：排序随查询一起走，Core 侧用白名单解释。
    if (cache.sort && cache.sort !== "name") q.sort = cache.sort;
    return q;
  }

  function hasTag(id) {
    return cache.tags.some(function (t) {
      return t.id === id;
    });
  }

  function activeTag() {
    if (!cache.activeTagId) return null;
    for (var i = 0; i < cache.tags.length; i++) {
      if (cache.tags[i].id === cache.activeTagId) return cache.tags[i];
    }
    return null;
  }

  /** 已显示的目录保留到后台读取成功。读取期间的新失效合并为最后一轮补查。 */
  function load(app, options) {
    var force = !!(options && options.force);
    if (force) { tagsStale = true; tagsRevision++; }
    if (inflight) return inflight;
    if (cache.loaded && !tagsStale) return Promise.resolve();
    var epoch = generation;
    inflight = (async function () {
      do {
        // Keep queued invalidations for the next visit; never start a hidden
        // follow-up batch after the outstanding request has settled.
        if (!tabActive(app, "list")) { tagsStale = true; return; }
        var revision = tagsRevision, q = query(), key = JSON.stringify(q);
        tagsStale = false;
        cache.loading = true;
        cache.error = null;
        try {
          var res = await app.client.listTags(q);
          if (epoch !== generation) return;
          if (key !== JSON.stringify(query()) || revision !== tagsRevision) { tagsStale = true; continue; }
          cache.tags = res.items || [];
          cache.total = res.total == null ? cache.tags.length : res.total;
          /* 首次进入默认选中第一条，右侧详情不会空着；
             但被选中的标签已经不在结果里（别处删了，或被筛掉了）就清空选中，
             停在一个不存在的 id 上会让编辑区一片空白且关不掉。
             清掉之后不再自动跳回首行——用户筛掉它就是不想看它。 */
          if (!cache.activeTagId && cache.tags.length && cache.autoSelect) {
            cache.activeTagId = cache.tags[0].id;
          }
          // 只在首次进入时自动选第一条；之后选中由用户自己决定。
          cache.autoSelect = false;
          if (cache.activeTagId && !hasTag(cache.activeTagId)) {
            cache.activeTagId = null;
            cache.draft = null;
            cache.autoSelect = false;
          }
          if (!filtered()) cache.all = cache.tags;
          if (activeTag()) mergeDraft(activeTag());
          cache.loaded = true;
          cache.loading = false;
          syncCount(app);
          await loadContents(app, cache.activeTagId);
        } catch (err) {
          if (epoch !== generation) return;
          if (revision !== tagsRevision || key !== JSON.stringify(query())) { tagsStale = true; continue; }
          cache.loading = false;
          cache.error = err;
        }
      } while (tagsStale && epoch === generation);
    })().finally(function () {
      if (epoch === generation) {
        cache.loading = false;
        inflight = null;
        paint();
        restoreSearchFocus();
      }
    });
    return inflight;
  }

  function loadContents(app, tagId) {
    if (!tabActive(app, "list")) { contentsStale = true; return Promise.resolve(); }
    cache.contentsError = null;
    if (!tagId) {
      cache.contents = [];
      cache.contentsTotal = 0;
      cache.contentsLoading = false;
      return Promise.resolve();
    }
    if (contentsPromise && cache.contentsTagId === tagId) return contentsPromise;
    var epoch = generation, ticket = ++contentsGeneration;
    cache.contentsTagId = tagId;
    contentsPromise = (async function () {
      do {
        if (!tabActive(app, "list")) { contentsStale = true; return; }
        var revision = contentsRevision;
        contentsStale = false;
        cache.contentsLoading = true;
        try {
          var res = await app.client.listTagContents(tagId, { limit: CONTENTS_PREVIEW });
          if (epoch !== generation || ticket !== contentsGeneration || cache.activeTagId !== tagId) return;
          if (revision !== contentsRevision) { contentsStale = true; continue; }
          cache.contents = res.items || [];
          cache.contentsTotal = res.total == null ? cache.contents.length : res.total;
          cache.contentsLoaded = true;
          cache.contentsError = null;
        } catch (err) {
          if (epoch !== generation || ticket !== contentsGeneration || cache.activeTagId !== tagId) return;
          cache.contentsError = err;
        }
      } while (contentsStale);
    })().finally(function () {
      if (epoch !== generation || ticket !== contentsGeneration) return;
      cache.contentsLoading = false;
      contentsPromise = null;
    });
    return contentsPromise;
  }

  /** 侧栏计数据此更新。筛选状态下的 total 只是筛选结果，不能拿来当总数。 */
  function syncCount(app) {
    if (filtered() || app.tagCount === cache.total) return;
    app.tagCount = cache.total;
    SF.app.refreshSidebarCounts();
  }

  /* 搜索框在视图内部，每次取数回来都会整块重绘，光标就没了。
     只有「重绘前它正被输入」时才把焦点还回去，其他重绘不该抢焦点。 */
  function restoreSearchFocus() {
    if (!keepSearchFocus) return;
    keepSearchFocus = false;
    if (!tabActive(SF.app.state, "list")) return;
    var input = document.querySelector("[data-tag-search] input");
    if (!input) return;
    input.focus();
    var end = input.value.length;
    if (input.setSelectionRange) input.setSelectionRange(end, end);
  }

  function reset() {
    generation++; contentsGeneration++;
    inflight = null; contentsPromise = null;
    tagsStale = true; contentsStale = true;
    aiState = { busy: false, stale: true, revision: 0 };
    /* 硬重置用于清理会话；普通内容和任务事件只走 invalidate。 */
    cache.tags = [];
    cache.all = null;
    cache.contents = [];
    cache.contentsTotal = 0;
    cache.contentsLoading = false;
    cache.contentsError = null;
    cache.contentsLoaded = false;
    cache.loaded = false;
    cache.loading = false;
    cache.error = null;
    cache.draft = null;
    cache.draftError = null;
  }

  /* ---------------- 视图入口 ---------------- */

  function render(app) {
    if (app.tagTab !== "ai") {
      if ((!cache.loaded || tagsStale) && !cache.loading && (!cache.error || tagsStale)) load(app);
      else if (contentsStale && cache.activeTagId && !cache.contentsLoading) loadContents(app, cache.activeTagId).then(paint);
    }
    return h(
      "div.view.view--tags",
      { "data-view": "tags" },
      buildHead(app),
      buildTabs(app),
      h("div.view__body", null, buildBody(app))
    );
  }

  function buildHead(app) {
    var descs = {
      list: "创建、重命名、改色和维护标签别名，并查看每个标签用在了多少条内容上。",
      ai: "由模型自动读懂内容并打标签，不需要手动维护。",
    };
    return h(
      "div.view__head",
      null,
      h(
        "div.view__head-text",
        null,
        h("h1.t-h1", { text: "标签管理" }),
        h("p.view__desc", { text: descs[app.tagTab] || descs.list })
      )
    );
  }

  function buildTabs(app) {
    return h(
      "div.tags-tabbar",
      { role: "tablist", "aria-label": "标签管理分区" },
      TABS.map(function (t) {
        return h(
          "button.tags-tab" + (app.tagTab === t.id ? ".is-active" : ""),
          {
            type: "button",
            role: "tab",
            "aria-selected": app.tagTab === t.id ? "true" : "false",
            onclick: function () {
              if (app.tagTab === t.id) return;
              // 点同一个页签不会改 hash，因此这里必须自己重绘一次
              SF.app.navigate("tags", { tab: t.id });
              app.tagTab = t.id;
              SF.app.renderContent();
            },
          },
          h("span", { text: t.label })
        );
      })
    );
  }

  function buildBody(app) {
    /* AI 页不依赖标签列表：标签查询失败时它也应该照常显示 */
    if (app.tagTab === "ai") return buildAiPage(app);
    if (cache.error && !cache.loaded) {
      return h(
        "div.panel.tags-fill",
        null,
        ui.state({
          icon: "alert",
          tone: "danger",
          title: "标签读取失败",
          desc: (cache.error && cache.error.message) || "查询未能完成。",
          actions: [
            {
              label: "重试",
              variant: "primary",
              onClick: function () {
                cache.error = null;
                load(app, { force: true });
              },
            },
          ],
        })
      );
    }
    if (!cache.loaded) {
      return h("div.panel.tags-fill", null, ui.state({ icon: "clock", title: "正在载入标签…" }));
    }
    return buildListPage(app);
  }

  /* =====================================================================
     页一：标签列表
     ===================================================================== */

  function buildListPage(app) {
    return h(
      "div.tags-layout",
      null,
      h("div.tags-list", null, buildToolbar(app),
        cache.error ? h("p.field__error", {role: "alert", text: "标签刷新失败：" + cache.error.message}) : null,
        buildTable(app)),
      buildEditor(app)
    );
  }

  function buildToolbar(app) {
    var search = ui.searchInput(
      "搜索标签名称或别名…",
      cache.keyword,
      function (v) {
        cache.keyword = v;
        // 主动换搜索：这一次允许回到结果顶部。
        cache.resetScroll = true;
        keepSearchFocus = true;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          load(app, { force: true });
        }, 240);
      }
    );
    search.setAttribute("data-tag-search", "");
    return h(
      "div.panel.tags-toolbar",
      {"data-refresh-key": "tags-toolbar"},
      h("h2.toolbar__title.t-h2", { text: "全部标签（" + cache.total + "）" }),
      h(
        "div.toolbar__tools",
        null,
        search,
        /* M23：排序只是显示层的选择，随查询一起交给 Core 的白名单。
           默认按名称；使用次数沿用 contentCount（挂载该标签的内容条数）。 */
        ui.select(
          [
            { value: "name", label: "名称" },
            { value: "usage_desc", label: "使用次数：从多到少" },
            { value: "usage_asc", label: "使用次数：从少到多" },
          ],
          cache.sort,
          function (v) {
            cache.sort = v;
            // 主动换排序：回到结果顶部，选中标签按 ID 保留。
            cache.resetScroll = true;
            load(app, { force: true });
          },
          { ariaLabel: "标签排序" }
        ),
        ui.select(
          [
            { value: "all", label: "全部状态" },
            { value: "enabled", label: "已启用" },
            { value: "disabled", label: "已停用" },
          ],
          cache.status,
          function (v) {
            cache.status = v;
            cache.resetScroll = true;
            load(app, { force: true });
          },
          { ariaLabel: "状态筛选" }
        ),
        ui.btn("新建标签", { variant: "primary", icon: "plus", onClick: function () { openCreateTag(app); } })
      )
    );
  }

  function buildTable(app) {
    if (!cache.tags.length) {
      var active = filtered();
      return h(
        "div.panel.tags-fill",
        null,
        ui.state({
          icon: "tag",
          tone: "brand",
          title: active ? "没有符合条件的标签" : "还没有任何标签",
          desc: active
            ? "换个关键词，或把状态筛选切回「全部状态」。"
            : "标签是内容整理的基本单位。先建几个标签，之后给内容打标时就能直接选用。",
          actions: active
            ? [
                {
                  label: "清除筛选",
                  onClick: function () {
                    cache.keyword = "";
                    cache.status = "all";
                    load(app, { force: true });
                  },
                },
              ]
            : [{ label: "新建标签", variant: "primary", onClick: function () { openCreateTag(app); } }],
        })
      );
    }

    /* 使用量条共用一把标尺：max 取当前列表里真实的最大值，
       所以最长的一条就是用得最多的那个标签，而不是每行各自撑满。 */
    var max = cache.tags.reduce(function (m, t) {
      return Math.max(m, t.contentCount || 0);
    }, 0);

    return h(
      "div.panel.tags-table-wrap.scroll-y",
      /* M22：给滚动容器一个稳定身份。全局重绘会换掉整棵子树，
         靠这个键才能把滚动位置还回来——否则点一行标签就跳回列表顶部。 */
      { "data-scroll-key": "tags-table" },
      h(
        "table.table.table--tags",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th.tags-col-name", { text: "标签名称" }),
            h("th.tags-col-desc", { text: "描述" }),
            h("th.tags-col-usage", { text: "使用次数" }),
            h("th.tags-col-updated", { text: "最近更新" }),
            h("th.tags-col-status", { text: "状态" })
          )
        ),
        h(
          "tbody",
          null,
          cache.tags.map(function (t) {
            return tagRow(app, t, max);
          })
        )
      )
    );
  }

  function tagRow(app, t, max) {
    var c = tagCatalog.color(t.color);
    return h(
      "tr",
      {
        "data-refresh-key": "tag-row:" + t.id,
        /* 稳定标签 ID：可见行锚点靠它认出「同一条标签」。 */
        "data-tag-id": t.id,
        "data-refresh-boundary": "true",
        class: t.id === cache.activeTagId ? "is-selected" : "",
        tabindex: "0",
        onclick: function (e) {
          if (e.target.closest(".switch")) return;
          selectTag(app, t.id);
        },
        onkeydown: function (e) {
          if (e.key !== "Enter" && e.key !== " ") return;
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          selectTag(app, t.id);
        },
      },
      /* 行首色条：让一整列标签在扫视时靠颜色区分，而不是逐行读文字 */
      h(
        "td.tags-col-name",
        null,
        h("span.tag-row", { style: { "--row-color": c.solid } }, tagUi.tagChip(t))
      ),
      h("td.tags-col-desc", null, h("span.t-ellipsis", { title: t.description || "", text: t.description || "—" })),
      h(
        "td.tags-col-usage",
        null,
        h(
          "div.usage-cell",
          null,
          h("span.usage-cell__num.t-num", { text: String(t.contentCount || 0) }),
          tagUi.usageBar(t.contentCount || 0, max, t.color)
        )
      ),
      h(
        "td.tags-col-updated",
        null,
        h("span", { text: t.updatedAt ? fmt.relative(t.updatedAt, app.now) : "—" })
      ),
      h(
        "td.tags-col-status",
        null,
        ui.toggle(
          t.enabled,
          function (on) {
            setEnabled(app, t, on);
          },
          { label: (t.enabled ? "停用 " : "启用 ") + t.name }
        )
      )
    );
  }

  function selectTag(app, id) {
    if (cache.activeTagId === id) return;
    cache.activeTagId = id;
    cache.contents = [];
    cache.contentsTotal = 0;
    cache.contentsLoaded = false;
    contentsGeneration++;
    contentsPromise = null;
    cache.draft = null;
    cache.draftError = null;
    cache.contentsLoading = true;
    // M22：换选中只换右侧详情，左侧列表的滚动位置不能跟着跳。
    var anchor = captureAnchor();
    SF.app.renderContent();
    restoreAnchor(anchor);
    loadContents(app, id).then(function () {
      paint();
    });
  }

  function setEnabled(app, t, on) {
    return SF.app.act("tag:" + t.id, async function () {
      await app.client.setTagEnabled(t.id, on);
      ui.toast((on ? "已启用" : "已停用") + "「" + t.name + "」");
      await load(app, { force: true });
    });
  }

  /* ---------------- 写操作 ---------------- */

  /**
   * 删除确认必须说出「会从多少条内容上摘掉这个标签」。
   * 删除前能拿到的只有 contentCount（后端 delete_tag 用的就是同一个值），
   * 删除后返回的 detachedContents 才是权威数字，所以两处都如实报出来：
   * 确认框用删除前的值给用户预判，toast 用返回值复述实际结果。
   */
  function removeTag(app, t) {
    var count = t.contentCount || 0;
    return ui
      .confirm({
        title: "删除标签「" + t.name + "」？",
        message: count
          ? "这个标签正用在 " + count + " 条内容上。删除后这 " + count + " 条内容会失去该标签，内容本身不会被删除，标签也不会自动恢复。"
          : "这个标签目前没有用在任何内容上，删除后不影响已整理的内容。",
        confirmText: "删除标签",
        danger: true,
      })
      .then(function (confirmed) {
        if (!confirmed) return;
        return SF.app.act("tag:" + t.id, async function () {
          var res = await app.client.removeTag(t.id);
          var detached = res && typeof res.detachedContents === "number" ? res.detachedContents : count;
          ui.toast(
            "已删除「" + t.name + "」" + (detached ? "，" + detached + " 条内容已移除该标签" : "")
          );
          cache.activeTagId = null;
          cache.draft = null;
          cache.draftError = null;
          await load(app, { force: true });
        });
      });
  }

  function buildEditor(app) {
    var t = activeTag();
    if (!t) {
      return h(
        "aside.tags-editor",
        null,
        h("div.tags-editor__head", null, h("div.tags-editor__title", { text: "标签详情" })),
        ui.state({
          icon: "tag",
          title: "选择一个标签",
          desc: "在左侧点任意一行，即可在这里重命名、改色、维护别名。",
        })
      );
    }

    var draft = draftFor(t);
    var c = tagCatalog.color(draft.color);

    var nameError = h("p.field__error", { role: "alert" });
    setFieldError(nameError, cache.draftError);

    var nameInput = h("input.input", {
      id: "tag-name",
      value: draft.name,
      maxlength: MAX_NAME,
      "aria-label": "标签名称",
      oninput: function (e) {
        draft.name = e.target.value;
        markField("name");
        nameCount.textContent = draft.name.length + "/" + MAX_NAME;
        /* 开始改名字就把上一次的冲突提示收掉：它描述的是上一个名字的结果 */
        cache.draftError = null;
        setFieldError(nameError, "");
      },
    });
    var nameCount = h("span.tags-counter", { text: draft.name.length + "/" + MAX_NAME });

    var descInput = h("textarea.input", {
      id: "tag-desc",
      maxlength: MAX_DESCRIPTION,
      "aria-label": "标签描述",
      placeholder: "这个标签用来收什么样的内容？",
      oninput: function (e) {
        draft.description = e.target.value;
        markField("description");
        descCount.textContent = draft.description.length + "/" + MAX_DESCRIPTION;
      },
    }, draft.description);
    var descCount = h("span.tags-counter", { text: draft.description.length + "/" + MAX_DESCRIPTION });

    var aliasError = h("p.field__error", { role: "alert" });
    setFieldError(aliasError, "");

    return h(
      "aside.tags-editor",
      { "data-tag-editor": t.id, "data-refresh-key": "tag-editor:" + t.id },
      h(
        "div.tags-editor__head",
        null,
        h("div.tags-editor__title", { text: "标签详情" }),
        h("div.spacer"),
        ui.iconBtn("close", "关闭详情", function () {
          cache.activeTagId = null;
          cache.draft = null;
          cache.draftError = null;
          SF.app.renderContent();
        }, { ariaLabel: "关闭标签详情" })
      ),
      /* 横幅用中性底色 + 标签色竖条：色块本身是 soft 底，
         放在同样 soft 的横幅上会糊成一片，深色模式下更明显。 */
      h(
        "div.tags-editor__banner",
        { style: { "--banner-color": c.solid } },
        h(
          "div.tags-editor__banner-row",
          null,
          tagUi.tagChip({ id: t.id, name: draft.name || t.name, color: draft.color }),
          h("span.tags-editor__banner-text", { text: t.enabled ? "已启用" : "已停用" }),
          h("div.spacer"),
          ui.toggle(
            t.enabled,
            function (on) {
              setEnabled(app, t, on);
            },
            { label: "启用标签 " + t.name }
          )
        ),
        h("p.tags-editor__banner-hint", {
          text: t.enabled ? "启用后可在给内容打标时选用这个标签" : "停用后不再参与打标，已有的归类仍会保留",
        })
      ),
      h(
        "div.tags-editor__body.scroll-y",
        {"data-scroll-key": "tag-editor:" + t.id},
        h(
          "div.tags-editor__section",
          null,
          h("div.tags-editor__section-title", { text: "基本信息" }),
          h(
            "div.field",
            fieldProps(t, draft, "name"),
            h(
              "label.field__label.tags-label-row",
              { htmlFor: "tag-name" },
              h("span", { text: "标签名称" }),
              h("span.req", { text: "*" }),
              h("div.spacer"),
              nameCount
            ),
            nameInput,
            nameError
          ),
          h(
            "div.field",
            fieldProps(t, draft, "description"),
            h(
              "label.field__label.tags-label-row",
              { htmlFor: "tag-desc" },
              h("span", { text: "标签描述" }),
              h("div.spacer"),
              descCount
            ),
            descInput
          ),
          h(
            "div.field",
            fieldProps(t, draft, "color"),
            h("span.field__label", { text: "标签颜色" }),
            h(
              "div.tags-field-preview",
              null,
              h("span.field__label", { text: "效果预览" }),
              previewBox(draft)
            ),
            /* 换色会整页重绘，所以编辑副本必须放在模块作用域里，
               否则这里一点，刚敲的描述就没了 */
            tagUi.colorPicker(draft.color, function (v) {
              draft.color = v;
              cache.draftError = null;
              SF.app.renderContent();
            })
          ),
          h(
            "div.field",
            fieldProps(t, draft, "synonyms"),
            h(
              "div.field__label.tags-label-row",
              null,
              h("span", { text: "别名 / 同义词" }),
              h("div.spacer"),
              ui.btn("复制别名", { size: "sm", onClick: function () { copySynonyms(activeTag() || t); } })
            ),
            h("p.field__hint", {
              text: "搜索时输入别名也能找到这个标签。最多 " + MAX_SYNONYMS + " 个，每个不超过 " + MAX_SYNONYM + " 字。",
            }),
            ui.tagInput(draft.synonyms, function (list) {
              if (list.length > MAX_SYNONYMS) {
                ui.toast("别名最多 " + MAX_SYNONYMS + " 个，多出来的没有保存", "error");
              }
              draft.synonyms = list.slice(0, MAX_SYNONYMS);
              markField("synonyms");
              setFieldError(aliasError, "");
            }),
            aliasError
          )
        ),
        h(
          "div.tags-editor__section",
          {"data-refresh-key": "tag-associations:" + t.id},
          h("div.tags-editor__section-title", { text: "关联" }),
          h(
            "div.tags-mini-stats",
            null,
            h(
              "div.tags-mini-stat",
              null,
              h("span.tags-mini-stat__num.t-num", { text: String(t.contentCount || 0) }),
              h("span.tags-mini-stat__label", { text: "相关内容" })
            ),
            h(
              "div.tags-mini-stat",
              null,
              h("span.tags-mini-stat__num.t-num", { text: String((t.synonyms || []).length) }),
              h("span.tags-mini-stat__label", { text: "个别名" })
            )
          )
        ),
        h(
          "div.tags-editor__section",
          {"data-refresh-key": "tag-contents:" + t.id, "data-refresh-boundary": "true"},
          h(
            "div.tags-editor__section-title",
            null,
            h("span", { text: "最近使用该标签的内容" }),
            h("div.spacer"),
            cache.contentsTotal ? h("span.tags-counter", { text: "共 " + cache.contentsTotal + " 条" }) : null
          ),
          buildContents(app, t)
        )
      ),
      h(
        "div.tags-editor__foot",
        {"data-refresh-key": "tag-footer:" + t.id, "data-refresh-boundary": "true"},
        ui.btn("删除标签", {
          variant: "danger",
          icon: "trash",
          onClick: function () {
            removeTag(app, activeTag() || t);
          },
        }),
        h("div.spacer"),
        ui.btn("保存修改", {
          variant: "primary",
          onClick: function () {
            saveTag(app, activeTag() || t, aliasError);
          },
        })
      )
    );
  }

  /** 编辑副本：切换标签时从最新数据重建，保存后作废。 */
  function draftFor(t) {
    if (!cache.draft || cache.draft.id !== t.id) {
      cache.draft = {
        id: t.id,
        name: t.name,
        description: t.description || "",
        color: t.color,
        synonyms: (t.synonyms || []).slice(),
        version: ++draftVersion,
      };
      cache.draft.base = draftValues(t);
    }
    return cache.draft;
  }

  function draftValues(t) {
    return {name: t.name, description: t.description || "", color: t.color, synonyms: (t.synonyms || []).slice()};
  }

  function fieldDirty(draft, field) {
    return JSON.stringify(draft[field]) !== JSON.stringify(draft.base[field]);
  }

  function mergeDraft(t) {
    var draft = cache.draft;
    if (!draft || draft.id !== t.id) return;
    var fresh = draftValues(t);
    Object.keys(fresh).forEach(function (field) {
      if (!fieldDirty(draft, field) && !fieldFocused(field)) draft[field] = fresh[field];
    });
    draft.base = fresh;
  }

  function fieldProps(t, draft, field) {
    return {
      "data-tag-field": field,
      "data-refresh-key": "tag-field:" + t.id + ":" + draft.version + ":" + field,
      "data-refresh-boundary": "true",
      "data-refresh-preserve": fieldDirty(draft, field) || fieldFocused(field) ? "editing:" + draft.version : null,
      onfocusin: function (e) { e.currentTarget.setAttribute("data-refresh-preserve", "editing:" + draft.version); },
      onfocusout: function (e) {
        if (!fieldDirty(draft, field) && !e.currentTarget.contains(e.relatedTarget)) e.currentTarget.removeAttribute("data-refresh-preserve");
      },
    };
  }

  function fieldFocused(field) {
    return document.activeElement && document.activeElement.closest('[data-tag-field="' + field + '"]');
  }

  function markField(field) {
    var el = document.querySelector('[data-tag-field="' + field + '"]');
    if (el && cache.draft) el.setAttribute("data-refresh-preserve", "editing:" + cache.draft.version);
  }

  function previewBox(draft) {
    var box = h("div");
    SF.dom.render(box, [tagUi.tagChip({ id: draft.id, name: draft.name || "新标签", color: draft.color })]);
    return box;
  }

  function setFieldError(el, msg) {
    SF.dom.render(el, msg ? [icon("alert", 13), h("span", { text: msg })] : []);
    el.style.display = msg ? "flex" : "none";
  }

  function saveTag(app, t, aliasError) {
    aliasError = document.querySelector('[data-tag-field="synonyms"] .field__error') || aliasError;
    var draft = cache.draft;
    if (!draft) return Promise.resolve();
    var name = draft.name.trim();
    if (!name) {
      cache.draftError = "请填写标签名称";
      SF.app.renderContent();
      return Promise.resolve();
    }
    var tooLong = (draft.synonyms || []).filter(function (s) {
      return String(s).length > MAX_SYNONYM;
    })[0];
    if (tooLong) {
      setFieldError(aliasError, "别名「" + tooLong + "」超过 " + MAX_SYNONYM + " 字");
      return Promise.resolve();
    }
    var description = String(draft.description || "").trim();
    var payload = { name: name, color: draft.color, synonyms: draft.synonyms, description: description };
    return SF.app.act("tag:" + t.id, async function () {
      try {
        await app.client.updateTag(t.id, payload);
      } catch (err) {
        /* 重名冲突必须落在名称字段下方：只弹 toast 的话，
           用户的注意力还在输入框上，提示一闪而过根本来不及看。 */
        if (isNameError(err)) {
          cache.draftError = (err && err.message) || "标签名称已存在";
          var liveError = document.querySelector('[data-tag-field="name"] .field__error');
          if (liveError) setFieldError(liveError, cache.draftError);
          paint();
          return;
        }
        ui.toast((err && err.message) || "保存失败", "error");
        return;
      }
      cache.draft = null;
      cache.draftError = null;
      ui.toast("已保存「" + name + "」");
      await load(app, { force: true });
    });
  }

  /** 后端 contracts/tags.py：重名是 CONFLICT，名称非法是 INVALID_INPUT + operation=name。 */
  function isNameError(err) {
    if (!err) return false;
    if (err.code === "CONFLICT") return true;
    return err.code === "INVALID_INPUT" && err.operation === "name";
  }

  function openCreateTag(app) {
    var draft = {
      name: "",
      description: "",
      /* 默认色按现有标签轮转，避免新建出来总是同一个颜色。
         筛选状态下用未筛选时的全量快照算，基准才是真实的全部标签。 */
      color: tagCatalog.nextColor(cache.all || cache.tags),
    };

    var error = h("p.field__error", { role: "alert" });
    var preview = previewBox(draft);

    var input = h("input.input", {
      id: "new-tag-name",
      placeholder: "例如：旅行",
      maxlength: MAX_NAME,
      "aria-label": "标签名称",
      oninput: function (e) {
        draft.name = e.target.value;
        setFieldError(error, "");
        SF.dom.render(preview, [
          tagUi.tagChip({ name: draft.name.trim() || "新标签", color: draft.color }),
        ]);
      },
    });

    var layer = ui.dialog({
      title: "新建标签",
      body: h(
        "div.col",
        { style: { gap: "16px" } },
        h("p.field__hint", {
          text: "标签名称最多 " + MAX_NAME + " 个字。别名可以在创建后于右侧详情里补充。",
        }),
        h(
          "div.field",
          null,
          h(
            "label.field__label",
            { htmlFor: "new-tag-name" },
            h("span", { text: "标签名称" }),
            h("span.req", { text: "*" })
          ),
          input,
          error
        ),
        h(
          "div.field",
          null,
          h("span.field__label", { text: "标签描述" }),
          h("textarea.input", {
            id: "new-tag-desc",
            placeholder: "这个标签用来收什么样的内容？",
            maxlength: MAX_DESCRIPTION,
            "aria-label": "标签描述",
            oninput: function (e) {
              draft.description = e.target.value;
            },
          })
        ),
        h(
          "div.field",
          null,
          h("span.field__label", { text: "标签颜色" }),
          h("div.tags-field-preview", null, h("span.field__label", { text: "效果预览" }), preview),
          tagUi.colorPicker(draft.color, function (v) {
            draft.color = v;
            SF.dom.render(preview, [
              tagUi.tagChip({ name: draft.name.trim() || "新标签", color: v }),
            ]);
          })
        )
      ),
      footer: [
        h("div.spacer"),
        ui.btn("取消", { onClick: function () { layer.close(); } }),
        ui.btn("创建标签", {
          variant: "primary",
          onClick: function () {
            var name = draft.name.trim();
            if (!name) {
              setFieldError(error, "请填写标签名称");
              return;
            }
            SF.app.act("tag:new", async function () {
              try {
                var tag = await app.client.createTag({
                  name: name,
                  description: draft.description,
                  color: draft.color,
                });
              } catch (err) {
                if (isNameError(err)) {
                  setFieldError(error, (err && err.message) || "标签名称已存在");
                  return;
                }
                setFieldError(error, (err && err.message) || "创建失败");
                return;
              }
              layer.close();
              cache.activeTagId = tag.id;
              cache.draft = null;
              cache.draftError = null;
              ui.toast(
                filtered() ? "已创建「" + tag.name + "」，当前筛选下可能看不到它" : "已创建「" + tag.name + "」"
              );
              await load(app, { force: true });
            });
          },
        }),
      ],
    });
  }

  /* 剪贴板可能被权限或非安全上下文拒绝，也可能永远不 settle。
     两种情况都只挂 then/catch 的话，点击就是零反馈，所以加一个超时兜底：
     无论如何都要让用户看见结果。 */
  function copySynonyms(t) {
    var list = t.synonyms || [];
    var text = list.join("、");
    if (!text) {
      ui.toast("「" + t.name + "」还没有设置别名");
      return;
    }
    function fallback(reason) {
      ui.toast("别名：" + text + (reason ? "（复制失败，可手动选中）" : ""));
    }
    if (!global.navigator || !global.navigator.clipboard) {
      fallback(false);
      return;
    }
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) fallback(true);
    }, 800);
    global.navigator.clipboard
      .writeText(text)
      .then(function () {
        settled = true;
        clearTimeout(timer);
        ui.toast("已复制 " + list.length + " 个别名");
      })
      .catch(function () {
        settled = true;
        clearTimeout(timer);
        fallback(true);
      });
  }

  /* ---------------- 标签下的内容 ---------------- */

  function buildContents(app, t) {
    if (cache.contentsLoading && !cache.contentsLoaded) return h("p.field__hint", { text: "正在读取内容…" });
    if (cache.contentsError && !cache.contentsLoaded) {
      return h(
        "div.col",
        { style: { gap: "8px" } },
        h("p.field__hint", { text: "内容读取失败：" + (cache.contentsError.message || "未知错误") }),
        ui.btn("重新读取", { size: "sm", onClick: function () { loadContents(app, t.id).then(paint); } })
      );
    }
    if (!cache.contents.length) {
      return h("p.field__hint", { text: "还没有内容使用这个标签。" });
    }
    return h(
      "div.tags-mini-list",
      null,
      cache.contents.map(function (item) {
        return h(
          "button.tags-mini-row",
          {
            type: "button",
            title: "在浏览器中打开：" + item.title,
            onclick: function () {
              SF.app.act("content:" + item.id, function () {
                return app.client.openContent(item.id);
              });
            },
          },
          h("span.tags-mini-row__thumb", null, item.cover ? h("img", { src: item.cover, alt: "", loading: "lazy" }) : null),
          h(
            "span.grow",
            null,
            h("span.tags-mini-row__title.t-clamp-2", { text: item.title }),
            h(
              "span.tags-mini-row__meta",
              null,
              h("span.t-ellipsis", { text: item.channelName }),
              h("span", { text: "·" }),
              h("span", { text: fmt.publication(item, true) })
            )
          )
        );
      })
    );
  }

  /* =====================================================================
     页二：AI 自动识别
     ===================================================================== */

  /**
   * AI 自动识别：真实的后台任务面板。
   *
   * 这里不再是「尚未接入」的空态：任务状态、失败重试与历史补打都走
   * app.client 的正式 RPC 方法，页面不判断演示 / 真实，也不自己拼模型参数。
   * 补打是用户主动动作，先显示范围与数量再执行，不在打开页面时自动扫全库。
   */
  var aiState = { busy: false, stale: true, revision: 0 };

  /* M21：识别设置。连接参数在设置页的「AI API 配置」，这里只管策略：
     开关、用哪种识别方式，以及当前方式所用的 API 能不能跑。
     草稿与已保存值分开存：后台状态刷新不能把用户正在改的东西冲掉。 */
  var recognition = {
    loaded: false,
    promise: null,
    error: null,
    saved: null,   // 已保存的策略 {enabled, mode, providerIds}
    draft: null,   // 草稿 {enabled, mode, providerIds}
    providers: {}, // 连接摘要（只读，来自设置快照）
    missing: {},   // 每一类缺什么
    saving: false,
    notice: null,
    stale: false,
  };

  var RECOGNITION_MODES = [
    { id: "jev", label: "Jev 已有标签分类", desc: "从你已经启用的标签里挑选合适的，不新建标签。",
      capability: "candidate_classification" },
    { id: "llm", label: "LLM 自由生成标签", desc: "由模型判断该用哪些标签，必要时可以新建标签并挂载。",
      capability: "text_generation" },
  ];

  /**
   * 这一种识别方式能用哪些连接：按能力筛，不按名字，也不限数量。
   * 连接在「AI API 配置」里管理，这里只挑用哪一条。
   */
  function compatibleProviders(mode) {
    var meta = RECOGNITION_MODES.filter(function (m) { return m.id === mode; })[0] || {};
    return Object.keys(recognition.providers).filter(function (providerId) {
      var provider = recognition.providers[providerId];
      return provider && (provider.capabilities || []).indexOf(meta.capability) >= 0;
    });
  }

  /** 当前这一种识别方式选中的那条连接。 */
  function recognitionProvider(mode) {
    var draftIds = recognition.draft && recognition.draft.providerIds;
    var savedIds = recognition.saved && recognition.saved.providerIds;
    var providerId = null;
    // 草稿里显式选了「不选」就是没有连接，不再回退到已保存的那一条。
    if (draftIds && mode in draftIds) providerId = draftIds[mode] || null;
    else if (savedIds) providerId = savedIds[mode] || null;
    return providerId ? (recognition.providers[providerId] || {}) : {};
  }

  /** 当前草稿选中的方式缺什么：缺项就说不清，别让用户以为能直接开。 */
  function recognitionMissing(mode) {
    var provider = recognitionProvider(mode);
    return provider.missing || [];
  }

  /**
   * providerIds 的独立副本。
   * 草稿与已保存值不能共用同一个映射：共用的话，改了连接就看不出草稿，
   * 「保存识别设置」会一直灰着。
   */
  function copyProviderIds(map) {
    var copy = {};
    Object.keys(map || {}).forEach(function (mode) {
      copy[mode] = map[mode] || null;
    });
    return copy;
  }

  function loadRecognition(app) {
    if (recognition.promise) return recognition.promise;
    var owner = recognition;
    owner.promise = app.client.getSettings().then(function (settings) {
      if (owner !== recognition) return;
      owner.error = null;
      owner.loaded = true;
      owner.stale = false;
      var tagging = settings.tagging || {};
      var providerIds = tagging.providerIds || {};
      owner.saved = { enabled: !!tagging.enabled, mode: tagging.mode || "llm", providerIds: copyProviderIds(providerIds) };
      // 已经有草稿时不覆盖：用户正在改的东西不能被后台刷新冲掉。
      if (!owner.draft) {
        owner.draft = { enabled: owner.saved.enabled, mode: owner.saved.mode, providerIds: copyProviderIds(providerIds) };
      }
      var providers = (settings.ai && settings.ai.providers) || {};
      owner.providers = providers;
      owner.missing = {};
      Object.keys(providers).forEach(function (providerId) {
        owner.missing[providerId] = providers[providerId].missing || [];
      });
      paintRecognition(app);
    }, function (err) {
      if (owner !== recognition) return;
      owner.error = err.message || "读取识别设置失败。";
      paintRecognition(app);
    }).finally(function () {
      if (owner === recognition) owner.promise = null;
    });
    return owner.promise;
  }

  function recognitionDirty() {
    if (!recognition.saved || !recognition.draft) return false;
    if (recognition.draft.enabled !== recognition.saved.enabled) return true;
    if (recognition.draft.mode !== recognition.saved.mode) return true;
    // 只换连接也是修改：换了就得能保存，不能让保存按钮一直灰着。
    var savedIds = recognition.saved.providerIds || {};
    var draftIds = recognition.draft.providerIds || {};
    var modes = Object.keys(savedIds).concat(Object.keys(draftIds));
    for (var i = 0; i < modes.length; i++) {
      var mode = modes[i];
      if ((draftIds[mode] || null) !== (savedIds[mode] || null)) return true;
    }
    return false;
  }

  /**
   * 保存识别策略。这里只提交 enabled、mode 与每种方式用哪条连接：
   * 不携带任何 API 字段，因此不会覆盖用户刚在设置页改好的连接参数。
   */
  function saveRecognition(app, done) {
    if (recognition.saving || !recognition.draft) { if (done) done(false); return; }
    var draft = recognition.draft;
    var modeLabel = (RECOGNITION_MODES.filter(function (m) { return m.id === draft.mode; })[0] || {}).label;
    var picked = (draft.providerIds || {})[draft.mode] || "";
    if (draft.enabled && !picked) {
      // 开着识别却没有连接：这是跑不起来的配置，不能存。
      recognition.notice = {
        tone: "danger",
        text: "「" + modeLabel + "」还没有选连接，先在下面选一条，或到「AI API 配置」新增一条。",
      };
      paintRecognition(app);
      if (done) done(false);
      return;
    }
    var missing = recognitionMissing(draft.mode);
    if (draft.enabled && missing.length) {
      recognition.notice = {
        tone: "danger",
        text: "「" + modeLabel +
          "」还缺" + missing.join("、") + "，先去「AI API 配置」补齐再启用。",
      };
      paintRecognition(app);
      if (done) done(false);
      return;
    }
    recognition.saving = true;
    recognition.notice = null;
    paintRecognition(app);
    app.client.saveSettings({
      section: "tagging",
      patch: { enabled: !!draft.enabled, mode: draft.mode, providerIds: draft.providerIds },
    })
      .then(function (settings) {
        recognition.saving = false;
        var providerIds = (settings.tagging && settings.tagging.providerIds) || draft.providerIds;
        // 草稿与已保存值各存一份：共用同一个映射会让「有没有未保存修改」永远算不出来。
        recognition.saved = { enabled: !!settings.tagging.enabled, mode: settings.tagging.mode,
                              providerIds: copyProviderIds(providerIds) };
        // 保存成功后以服务端返回的值为准，方式可能与草稿不同。
        recognition.draft = { enabled: recognition.saved.enabled, mode: recognition.saved.mode,
                              providerIds: copyProviderIds(providerIds) };
        recognition.notice = { tone: "success", text: "识别设置已保存。" };
        // 策略变了，后台任务状态要跟着重新读一次。
        aiState.stale = true; aiState.revision++; loadAiPanel(app);
        paintRecognition(app);
        if (done) done(true);
      }, function (err) {
        recognition.saving = false;
        // 保存失败保留草稿：用户改的东西不能因为一次失败就没了。
        recognition.notice = { tone: "danger", text: err.message || "识别设置未能保存。" };
        paintRecognition(app);
        if (done) done(false);
      });
  }

  /**
   * 离开标签页时若识别设置还有草稿，先问保存还是放弃。
   * 与设置页同一套原则：不让用户以为改了就已经生效。
   */
  function confirmRecognitionLeave(app) {
    if (!recognitionDirty()) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var settled = false;
      var layer;
      function done(value) { if (settled) return; settled = true; resolve(value); }
      layer = ui.dialog({
        title: "识别设置还有未保存的修改",
        beforeClose: function () { return !recognition.saving; },
        body: h("div.settings-leave", null,
          h("p.settings-leave__lead", { text: "识别设置还有未保存的修改。可以先保存，也可以放弃这些修改直接离开。" }),
          h("p.settings-leave__note", { text: "识别方式与自动打标开关在保存前不会生效。连接参数在「AI API 配置」里，不受这里影响。" })),
        footer: [
          h("div.spacer"),
          ui.btn("继续编辑", { onClick: function () { if (recognition.saving) return; done(false); layer.close(); } }),
          ui.btn("放弃修改", {
            variant: "danger",
            onClick: function () {
              if (recognition.saving) return;
              if (recognition.saved) {
                // 连连接引用一起还原：漏掉这一项会让页面凭空多出一个「未保存修改」。
                recognition.draft = { enabled: recognition.saved.enabled, mode: recognition.saved.mode,
                                      providerIds: copyProviderIds(recognition.saved.providerIds) };
              }
              done(true); layer.close();
            },
          }),
          ui.btn("保存并离开", {
            variant: "primary",
            disabled: recognition.saving,
            onClick: function () {
              if (recognition.saving) return;
              // 保存失败就留在本页：草稿还在，用户能改了再试。
              saveRecognition(app, function (ok) { done(ok); layer.close(); });
            },
          }),
        ],
        // 通用关闭路径（Escape、右上角关闭、点遮罩）必须结算，
        // 否则这个 Promise 永远悬着，app.js 的导航锁也永远解不开（BUG-105）。
        // 结算成「继续编辑」：草稿保留、路由恢复、用户可以接着改或再走。
        onClose: function () {
          done(false);
        },
      });
    });
  }

  function buildRecognition(app) {
    var children = [];
    if (recognition.error) {
      children.push(h("p.field__error", { role: "alert", text: recognition.error }));
    }
    if (!recognition.loaded) {
      children.push(h("p.field__hint", { text: recognition.error ? "" : "正在读取识别设置…" }));
      return h("section.ai-status", { "aria-label": "识别设置" }, children);
    }
    var draft = recognition.draft;
    var provider = recognitionProvider(draft.mode);
    var missing = recognitionMissing(draft.mode);
    var modeLabel = (RECOGNITION_MODES.filter(function (m) { return m.id === draft.mode; })[0] || {}).label || draft.mode;

    children.push(
      h(
        "div.ai-status__row",
        null,
        h("span.ai-status__name", { text: "自动打标" }),
        h("span.ai-status__note", {
          text: draft.enabled
            ? "开启中：此后收录的内容会进入后台队列并由模型打标。"
            : "已关闭：新收录的内容不会自动打标，需要时可手动补打。",
        }),
        h("div.switch", {
          role: "switch",
          tabindex: "0",
          "aria-checked": draft.enabled ? "true" : "false",
          "aria-label": "启用自动打标",
          onclick: function () {
            draft.enabled = !draft.enabled;
            recognition.notice = null;
            paintRecognition(app);
          },
        }, h("span.switch__knob"))
      )
    );
    children.push(
      h(
        "div.ai-status__row",
        null,
        h("span.ai-status__name", { text: "识别方式" }),
        h("span.ai-status__note", { text: "两种方式互斥选择，切换后另一种的 API 配置仍然保留。" })
      )
    );
    children.push(
      h(
        "div.mode-picker",
        null,
        RECOGNITION_MODES.map(function (item) {
          var picked = draft.mode === item.id;
          return h(
            "button.mode-card" + (picked ? ".is-active" : ""),
            {
              type: "button",
              role: "radio",
              "aria-checked": picked ? "true" : "false",
              onclick: function () {
                draft.mode = item.id;
                recognition.notice = null;
                paintRecognition(app);
              },
            },
            h("span.mode-card__mark", { "aria-hidden": "true" }, picked ? icon("check", 13) : null),
            h(
              "span.mode-card__text",
              null,
              h("span.mode-card__title", { text: item.label }),
              h("span.mode-card__desc", { text: item.desc }),
              // 缺项提前标出来：用户点之前就知道这一类还跑不起来。
              recognitionMissing(item.id).length
                ? h("span.mode-card__desc", { text: "API 未配置完整，缺：" + recognitionMissing(item.id).join("、") })
                : null
            )
          );
        })
      )
    );
    // 用哪条连接：按能力筛出可用的连接，用户自己挑一条。
    var usable = compatibleProviders(draft.mode);
    var currentProviderId = (draft.providerIds || {})[draft.mode] || "";
    children.push(
      h(
        "div.ai-status__row",
        null,
        h("span.ai-status__name", { text: "使用哪条连接" }),
        h("span.ai-status__note", {
          text: usable.length
            ? "这一类识别可以用下面这些连接；连接在「AI API 配置」里管理。"
            : "还没有支持这一类识别的连接，先去「AI API 配置」新增一条。",
        })
      )
    );
    children.push(
      h(
        "div.ai-status__row",
        null,
        ui.select(
          usable.map(function (providerId) {
            var provider = recognition.providers[providerId] || {};
            return {
              value: providerId,
              label: (provider.name || providerId) +
                (provider.enabled === false ? "（已停用）" : "") +
                (provider.configured ? "" : "（未配置完整）"),
            };
          }),
          currentProviderId,
          function (value) {
            draft.providerIds = draft.providerIds || {};
            draft.providerIds[draft.mode] = value;
            recognition.notice = null;
            paintRecognition(app);
          },
          { ariaLabel: "选择连接" }
        ),
        // 明确的「不选择」：解除这一类识别与连接的引用。解除后才能删除那条连接。
        ui.btn("不选择这条连接", {
          variant: "ghost",
          disabled: !currentProviderId,
          title: currentProviderId ? "解除这一类识别与连接的引用" : "当前没有选中的连接",
          onClick: function () {
            draft.providerIds = draft.providerIds || {};
            draft.providerIds[draft.mode] = null;
            recognition.notice = null;
            paintRecognition(app);
          },
        })
      )
    );
    // 当前方式用的 API 摘要与可用状态：缺什么直接写出来。
    children.push(
      h(
        "div.ai-status__row",
        null,
        h("span.ai-status__name", { text: "当前方式的 API" }),
        h("span.ai-status__note", {
          text: !currentProviderId
            ? modeLabel + " 还没有选连接：选一条，或点「不选择这条连接」解除引用。"
            : missing.length
              ? modeLabel + " 尚未配置完整，缺：" + missing.join("、") + "。"
              : modeLabel + " 使用 " + (provider.endpoint || "") + " · " + (provider.model || "") + "，配置完整。",
        }),
        h("span.badge.badge--" + (!currentProviderId ? "neutral" : missing.length ? "danger" : "success"), {
          text: !currentProviderId ? "未选择连接" : missing.length ? "未配置完整" : "可用",
        })
      )
    );
    if (recognition.notice) {
      children.push(h("p.field__hint.field__hint--danger", { role: "alert", text: recognition.notice.text }));
    }
    children.push(
      h(
        "div.tags-ai__actions",
        null,
        ui.btn("前往 AI API 配置", { icon: "sliders", onClick: function () { SF.app.openSettings("ai"); } }),
        ui.btn(recognition.saving ? "正在保存…" : "保存识别设置", {
          variant: "primary",
          disabled: recognition.saving || !recognitionDirty(),
          onClick: function () { saveRecognition(app); },
        })
      )
    );
    return h("section.ai-status", { "aria-label": "识别设置" }, children);
  }

  function paintRecognition(app) {
    var panel = mountedAi(app);
    if (!panel) return;
    var slot = panel.querySelector('[data-ai-slot="recognition"]');
    if (!slot) return;
    SF.dom.render(slot, buildRecognition(app));
  }

  function buildAiPage(app) {
    if ((!aiState.loaded || aiState.stale) && !aiState.promise && (!aiState.error || aiState.stale)) loadAiPanel(app);
    // M21：识别设置在上方，独立于任务与补打面板。草稿与后台刷新互不干扰。
    // 此刻这块面板还没挂在页面上，说明是刚进入本页：重读一次设置，
    // 让「当前方式的 API」摘要反映用户刚在设置页改的内容。页内重绘不重读。
    if (!mountedAi(app)) recognition.stale = true;
    if ((!recognition.loaded || recognition.stale) && !recognition.promise && !recognition.error) loadRecognition(app);
    return h("div.panel.tags-ai.scroll-y", {
      "data-refresh-key": "tags-ai:" + generation,
      "data-refresh-preserve": "always",
      "data-scroll-key": "tags-ai",
    },
      h("section.ai-status", {"data-ai-slot": "recognition", "data-refresh-key": "tags-recognition", "data-refresh-preserve": "always"}, buildRecognition(app)),
      h("div.tags-ai__status", {"data-ai-slot": "status"}, aiStatus(app)),
      h("div.tags-ai__actions", null,
        ui.btn("刷新状态", {icon: "refresh", onClick: function () { aiState.stale = true; aiState.revision++; loadAiPanel(app); }})),
      h("section.ai-status", {"data-ai-slot": "backfill", "data-refresh-key": "tags-backfill", "data-refresh-preserve": "always"}, backfillBody(app)),
      h("div.tags-ai__section", {"data-ai-slot": "tasks"}, aiTasks(app))
    );
  }

  function mountedAi(app) {
    if (app.route.name !== "tags" || app.tagTab !== "ai") return null;
    return document.querySelector('[data-view="tags"] .tags-ai');
  }

  function paintAi(app) {
    var panel = mountedAi(app);
    if (!panel) return;
    var top = panel.scrollTop;
    SF.dom.render(panel.querySelector('[data-ai-slot="status"]'), aiStatus(app));
    SF.dom.render(panel.querySelector('[data-ai-slot="tasks"]'), aiTasks(app));
    panel.scrollTop = top;
  }

  function paintBackfill(app) {
    var panel = mountedAi(app);
    if (panel) SF.dom.render(panel.querySelector('[data-ai-slot="backfill"]'), backfillBody(app));
  }

  function trackAi(owner, promise) {
    var actions = owner.actions || (owner.actions = new Set());
    actions.add(promise);
    function settled() { actions.delete(promise); }
    promise.then(settled, settled);
    return promise;
  }

  function loadAiPanel(app) {
    if (!tabActive(app, "ai")) { aiState.stale = true; return Promise.resolve(); }
    if (aiState.promise) return aiState.promise;
    var owner = aiState, epoch = generation;
    owner.promise = (async function () {
      do {
        if (!tabActive(app, "ai")) { owner.stale = true; return; }
        var revision = owner.revision;
        owner.stale = false;
        try {
          var status = await app.client.getTaggingStatus();
          if (owner !== aiState || epoch !== generation) return;
          if (revision !== owner.revision) { owner.stale = true; continue; }
          owner.status = status;
          owner.loaded = true;
          owner.error = null;
        } catch (err) {
          if (owner !== aiState || epoch !== generation) return;
          if (revision !== owner.revision) { owner.stale = true; continue; }
          owner.error = err.message || "读取自动打标状态失败。";
        }
      } while (owner.stale);
    })().finally(function () {
      if (owner !== aiState || epoch !== generation) return;
      owner.promise = null;
      paintAi(app);
    });
    return owner.promise;
  }

  function aiStatus(app) {
    var children = [];
    if (aiState.error) children.push(h("p.tags-empty__desc", {role: "alert", text: aiState.error}));
    if (!aiState.loaded) {
      if (!aiState.error) children.push(h("p.field__hint", {text: "正在读取自动打标状态…"}));
      else children.push(ui.btn("重新读取", {onClick: function () { aiState.stale = true; loadAiPanel(app); }}));
      return children;
    }
    var summary = (aiState.status && aiState.status.summary) || {};
    children.push(h("div.ai-status", null,
      aiStatusRow("后台任务", summary.total ? summary.total + " 条已登记" : "暂无任务", "neutral",
        summary.active ? summary.active + " 条正在排队或执行。" : "当前没有排队或执行中的任务。"),
      aiStatusRow("需要处理", summary.needsAttention ? summary.needsAttention + " 条失败或被阻塞" : "没有需要处理的任务",
        summary.needsAttention ? "danger" : "neutral",
        summary.needsAttention ? "认证失败或配置缺失会阻塞，改好配置后自动恢复。" : "所有任务都已正常结束。")));
    return children;
  }

  function backfillBody(app) {
    var owner = aiState;
    var preview = owner.preview;
    var text = preview ? preview.pending + " 条可补打" : owner.backfillResult || "未执行";
    var note = preview ? "范围内共 " + preview.total + " 条内容，最多补打 " + preview.limit + " 条。" : "只处理尚未打标过的内容，不会重复请求已完成的标签。";
    return [aiStatusRow("历史内容补打", text, preview ? "brand" : "neutral", note),
      owner.backfillError ? h("p.field__error", {role: "alert", text: owner.backfillError}) : null,
      h("div.tags-ai__actions", null,
        preview ? ui.btn(owner.busy ? "正在排队…" : "立即补打 " + preview.limit + " 条", {
          icon: "zap", variant: "primary", disabled: owner.busy,
          onClick: function () {
            if (owner.busy) return;
            owner.busy = true; owner.backfillError = null; paintBackfill(app);
            trackAi(owner, app.client.runTaggingBackfill(preview.limit).then(function (result) {
              if (owner !== aiState) return;
              owner.preview = null; owner.backfillResult = "已排队 " + result.queued + " 条";
              owner.stale = true; owner.revision++; loadAiPanel(app);
            }, function (err) { if (owner === aiState) owner.backfillError = err.message || "补打未能排队，请检查设置。"; })
              .finally(function () { if (owner === aiState) { owner.busy = false; paintBackfill(app); } }));
          },
        }) : ui.btn(owner.busy ? "正在读取范围…" : "查看可补打范围", {
          icon: "search", disabled: owner.busy,
          onClick: function () {
            if (owner.busy) return;
            owner.busy = true; owner.backfillError = null; paintBackfill(app);
            trackAi(owner, app.client.previewTaggingBackfill(200).then(function (result) {
              if (owner === aiState) owner.preview = result;
            }, function (err) { if (owner === aiState) owner.backfillError = err.message || "读取范围失败。"; })
              .finally(function () { if (owner === aiState) { owner.busy = false; paintBackfill(app); } }));
          },
        }),
        preview ? ui.btn("取消", {icon: "close", disabled: owner.busy, onClick: function () { owner.preview = null; owner.backfillError = null; paintBackfill(app); }}) : null)
    ];
  }

  var STATE_LABEL = {queued: "排队中", running: "识别中", retry_wait: "等待重试", blocked: "需要处理", succeeded: "已完成", skipped: "已跳过", failed: "失败", cancelled: "已取消"};
  var STATE_TONE = {queued: "neutral", running: "brand", retry_wait: "warn", blocked: "danger", succeeded: "success", skipped: "neutral", failed: "danger", cancelled: "neutral"};

  function aiTasks(app) {
    if (!aiState.loaded) return null;
    var recent = (aiState.status && aiState.status.recent) || [];
    if (!recent.length) return h("div.tags-empty__note", null, icon("info", 15),
      h("div", null, h("p.tags-empty__note-t", {text: "还没有自动打标任务"}),
        h("p", {text: "开启自动打标后，新收录的内容会进入后台队列。人工标签不受影响，随时可用。"})));
    var owner = aiState;
    return h("section.tags-ai__section", {"aria-label": "最近任务"},
      h("h2.t-h2", {text: "最近任务"}),
      owner.retryError ? h("p.field__error", {role: "alert", text: owner.retryError}) : null,
      h("ol.ai-tasklist", null, recent.map(function (task) {
        return h("li.ai-task", {"data-task-id": task.id},
          h("span.ai-task__name", {text: task.content_id}),
          h("span.ai-task__state.badge.badge--" + (STATE_TONE[task.state] || "neutral"), {text: STATE_LABEL[task.state] || task.state}),
          h("span.ai-task__note", {text:
            (task.provider ? task.provider + " " + (task.model || "") + " · " : "") +
            (task.skipped_reason || task.error_message || (task.applied_count ? "已挂载 " + task.applied_count + " 个标签" : "无匹配标签"))}),
          task.state !== "succeeded" ? ui.btn("重试", {icon: "refresh", size: "sm", onClick: function () {
            trackAi(owner, app.client.retryTaggingTask(task.id).then(function () {
              if (owner !== aiState) return;
              owner.retryError = null; owner.stale = true; owner.revision++; loadAiPanel(app);
            }, function (err) { if (owner === aiState) { owner.retryError = err.message || "重试未能排队。"; paintAi(app); } }));
          }}) : null);
      })));
  }

  function updateTagging(app) {
    if (!aiState.loaded || aiState.stale) return loadAiPanel(app);
    return aiState.promise || Promise.resolve();
  }

  function updateBackground(app) {
    if (app.tagTab !== "ai" || !mountedAi(app)) return false;
    updateTagging(app);
    return true;
  }

  async function whenIdle() {
    var pending;
    do {
      pending = [inflight, contentsPromise, aiState.promise].concat(Array.from(aiState.actions || [])).filter(Boolean);
      if (pending.length) await Promise.all(pending);
    } while (inflight || contentsPromise || aiState.promise || (aiState.actions && aiState.actions.size));
  }

  /** 状态徽章顺带说清「为什么是这个状态」，避免只丢一个词让用户猜。 */
  function aiStatusRow(name, text, tone, note) {
    return h(
      "div.ai-status__row",
      null,
      h("span.ai-status__name", { text: name }),
      h("span.badge.badge--" + tone, { text: text }),
      h("span.ai-status__note", { text: note })
    );
  }

  SF.views = SF.views || {};
  SF.views.tags = { render: render, reset: reset, invalidate: invalidate, updateBackground: updateBackground, updateTagging: updateTagging, whenIdle: whenIdle, TABS: TABS,
    // M21：识别设置的草稿保护。
    hasRecognitionDraft: function () { return recognitionDirty(); },
    confirmLeave: confirmRecognitionLeave };
})(window);
