/* ==========================================================================
   视图：标签管理（M9）
   --------------------------------------------------------------------------
   两个页签：
     #/tags?tab=list  标签列表 + 右侧标签详情
     #/tags?tab=ai    AI 自动识别（后端未接入，给设计化空态）

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
    activeTagId: null,
    /* 编辑副本存在模块作用域而不是闭包里：换颜色要整页重绘，
       放闭包里的话用户刚敲进去的描述会在点色块时消失。 */
    draft: null,
    draftError: null,
  };

  var searchTimer = null;
  var subscribed = false;
  var keepSearchFocus = false;
  /* 在飞的列表请求。写操作与 tags.changed 会几乎同时各触发一次刷新，
     没有这个句柄就无法区分「已经有人在读」和「我这次必须读到最新的」。 */
  var inflight = null;

  /* ---------------- 取数 ---------------- */

  function filtered() {
    return !!cache.keyword || cache.status !== "all";
  }

  function query() {
    var q = {};
    if (cache.keyword) q.keyword = cache.keyword;
    if (cache.status === "enabled") q.enabled = true;
    else if (cache.status === "disabled") q.enabled = false;
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

  /**
   * 列表只在「没读过」时拉一次。renderContent 会被搜索、启停、保存反复调用，
   * 没有 loaded 标记就会把同一份数据一遍遍重新请求。
   */
  function load(app, options) {
    var force = !!(options && options.force);
    if (inflight) {
      /* 写操作之后的强制刷新不能被「已有请求在飞」吞掉：
         tags.changed 会在服务端提交的瞬间先触发一次刷新，那次请求读到的是
         写入之前的数据；被吞掉的话，改完名列表就停在旧名字上。
         所以强制刷新排到当前请求之后再跑一次，而不是直接返回。 */
      return force ? inflight.then(function () { return load(app, { force: true }); }) : inflight;
    }
    if (cache.loaded && !force) return Promise.resolve();
    var current = cache;
    current.loading = true;
    current.error = null;
    inflight = app.client
      .listTags(query(app))
      .then(function (res) {
        if (current !== cache) return;
        cache.tags = res.items || [];
        cache.total = res.total == null ? cache.tags.length : res.total;
        /* 首次进入默认选中第一条，右侧详情不会空着；
           但被选中的标签已经不在结果里（别处删了，或被筛掉了）就清空选中，
           停在一个不存在的 id 上会让编辑区一片空白且关不掉。 */
        if (!cache.activeTagId && cache.tags.length) cache.activeTagId = cache.tags[0].id;
        if (cache.activeTagId && !hasTag(cache.activeTagId)) {
          cache.activeTagId = null;
          cache.draft = null;
        }
        if (!filtered()) cache.all = cache.tags;
        cache.loaded = true;
        cache.loading = false;
        syncCount(app);
        return loadContents(app, cache.activeTagId);
      })
      .then(function () {
        if (current !== cache) return;
        SF.app.renderContent();
        restoreSearchFocus();
      })
      .catch(function (err) {
        if (current !== cache) return;
        cache.loaded = true;
        cache.loading = false;
        cache.error = err;
        SF.app.renderContent();
      })
      /* 先清 inflight 再返回：上面的 renderContent 会同步再进来一次 load，
         那时必须已经能看到「没有请求在飞」，否则这次重绘会读不到数据。 */
      .then(function (r) {
        inflight = null;
        return r;
      });
    return inflight;
  }

  function loadContents(app, tagId) {
    cache.contentsError = null;
    if (!tagId) {
      cache.contents = [];
      cache.contentsTotal = 0;
      cache.contentsLoading = false;
      return Promise.resolve();
    }
    var current = cache;
    cache.contentsLoading = true;
    return app.client
      .listTagContents(tagId, { limit: CONTENTS_PREVIEW })
      .then(function (res) {
        if (current !== cache) return;
        cache.contents = res.items || [];
        cache.contentsTotal = res.total == null ? cache.contents.length : res.total;
        cache.contentsLoading = false;
      })
      .catch(function (err) {
        if (current !== cache) return;
        cache.contentsLoading = false;
        cache.contentsError = err;
      });
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
    var input = document.querySelector("[data-tag-search] input");
    if (!input) return;
    input.focus();
    var end = input.value.length;
    if (input.setSelectionRange) input.setSelectionRange(end, end);
  }

  /**
   * 标签变更事件。自己的写操作也会触发它，所以这里不判断来源，
   * 只做「丢掉旧结果、重新读一次」——重复读一次的代价远小于读到过期数据。
   */
  function subscribe(app) {
    if (subscribed || !app.client || typeof app.client.on !== "function") return;
    subscribed = true;
    var release = app.client.on("tags.changed", function () {
      cache.loaded = false;
      cache.loading = false;
      /* 上一次查询失败时不能把错误状态一直挂着：事件说明后端是活的，
         直接清掉让这次重绘重新拉一次，否则用户只能靠切页签绕出去。 */
      cache.error = null;
      if (app.route.name !== "tags") return;
      SF.app.renderContent();
    });
    if (release && typeof release === "function" && app.unsubscribe) app.unsubscribe.push(release);
  }

  function reset() {
    /* 数据变了就丢掉已读结果重读，但保留搜索词、筛选和选中项：
       用户正在输入时把输入框清空，比多请求一次更糟。 */
    cache.tags = [];
    cache.all = null;
    cache.contents = [];
    cache.contentsTotal = 0;
    cache.contentsLoading = false;
    cache.contentsError = null;
    cache.loaded = false;
    cache.loading = false;
    cache.error = null;
    cache.draft = null;
    cache.draftError = null;
  }

  /* ---------------- 视图入口 ---------------- */

  function render(app) {
    subscribe(app);
    if (!cache.loaded && !cache.loading && !cache.error) load(app);
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
    if (cache.error) {
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
      h("div.tags-list", null, buildToolbar(app), buildTable(app)),
      buildEditor(app)
    );
  }

  function buildToolbar(app) {
    var search = ui.searchInput(
      "搜索标签名称或别名…",
      cache.keyword,
      function (v) {
        cache.keyword = v;
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
      null,
      h("h2.toolbar__title.t-h2", { text: "全部标签（" + cache.total + "）" }),
      h(
        "div.toolbar__tools",
        null,
        search,
        /* 排序不设控件：后端 listTags 固定按名称返回（ORDER BY name COLLATE NOCASE），
           契约里也没有排序参数。放一个只能切两三种排法的下拉，
           不如让「标签按名称排列」成为一条稳定的规则。 */
        ui.select(
          [
            { value: "all", label: "全部状态" },
            { value: "enabled", label: "已启用" },
            { value: "disabled", label: "已停用" },
          ],
          cache.status,
          function (v) {
            cache.status = v;
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
      "div.panel.tags-table-wrap",
      null,
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
    cache.draft = null;
    cache.draftError = null;
    cache.contentsLoading = true;
    SF.app.renderContent();
    loadContents(app, id).then(function () {
      SF.app.renderContent();
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
        descCount.textContent = draft.description.length + "/" + MAX_DESCRIPTION;
      },
    }, draft.description);
    var descCount = h("span.tags-counter", { text: draft.description.length + "/" + MAX_DESCRIPTION });

    var aliasError = h("p.field__error", { role: "alert" });
    setFieldError(aliasError, "");

    return h(
      "aside.tags-editor",
      { "data-tag-editor": t.id },
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
        null,
        h(
          "div.tags-editor__section",
          null,
          h("div.tags-editor__section-title", { text: "基本信息" }),
          h(
            "div.field",
            null,
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
            null,
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
            null,
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
            null,
            h(
              "div.field__label.tags-label-row",
              null,
              h("span", { text: "别名 / 同义词" }),
              h("div.spacer"),
              ui.btn("复制别名", { size: "sm", onClick: function () { copySynonyms(t); } })
            ),
            h("p.field__hint", {
              text: "搜索时输入别名也能找到这个标签。最多 " + MAX_SYNONYMS + " 个，每个不超过 " + MAX_SYNONYM + " 字。",
            }),
            ui.tagInput(draft.synonyms, function (list) {
              if (list.length > MAX_SYNONYMS) {
                ui.toast("别名最多 " + MAX_SYNONYMS + " 个，多出来的没有保存", "error");
              }
              draft.synonyms = list.slice(0, MAX_SYNONYMS);
              setFieldError(aliasError, "");
            }),
            aliasError
          )
        ),
        h(
          "div.tags-editor__section",
          null,
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
          null,
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
        null,
        ui.btn("删除标签", {
          variant: "danger",
          icon: "trash",
          onClick: function () {
            removeTag(app, t);
          },
        }),
        h("div.spacer"),
        ui.btn("保存修改", {
          variant: "primary",
          onClick: function () {
            saveTag(app, t, aliasError);
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
      };
    }
    return cache.draft;
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
          SF.app.renderContent();
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
    if (cache.contentsLoading) return h("p.field__hint", { text: "正在读取内容…" });
    if (cache.contentsError) {
      return h(
        "div.col",
        { style: { gap: "8px" } },
        h("p.field__hint", { text: "内容读取失败：" + (cache.contentsError.message || "未知错误") }),
        ui.btn("重新读取", { size: "sm", onClick: function () { loadContents(app, t.id).then(function () { SF.app.renderContent(); }); } })
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
     页二：AI 自动识别（尚未接入）
     ===================================================================== */

  /**
   * 设计化空态，但只放现在真的能走通的去向。
   * 「去设置标签规则」这类按钮在本期没有落点，「填 API Key」也没有——
   * 放上去就是点了没反应，因此这里改成说明现状 + 一个真实可用的出口。
   */
  function buildAiPage(app) {
    return h(
      "div.panel.tags-fill",
      null,
      h(
        "div.tags-empty",
        null,
        h("div.tags-empty__icon", { "aria-hidden": "true" }, icon("zap", 28)),
        h("h2.tags-empty__title", { text: "AI 自动识别尚未接入" }),
        h("p.tags-empty__desc", {
          text:
            "让模型直接读懂内容并自动打标签，不用自己维护规则。这一部分还没有接入：" +
            "后端没有配置识别提供者，现在调用只会直接返回「自动识别尚未接入，人工标签不受影响」，不会给出任何猜测结果。",
        }),
        h(
          "div.tags-empty__actions",
          null,
          ui.btn("回到标签列表", {
            variant: "primary",
            icon: "tag",
            onClick: function () {
              SF.app.navigate("tags", { tab: "list" });
              app.tagTab = "list";
              SF.app.renderContent();
            },
          })
        ),
        h(
          "div.tags-empty__note",
          null,
          icon("info", 15),
          h(
            "div",
            null,
            h("p.tags-empty__note-t", { text: "现在可以做的" }),
            h("p", { text: "创建、重命名、改色和维护别名标签，并查看每个标签用在了多少条内容上。" }),
            h("p.tags-empty__note-t", { text: "后续会补上的" }),
            h("p", { text: "模型自动识别。接入时间待定，到时这一页会给出真正的操作入口；现在已可在内容详情里手动打标。" })
          )
        )
      )
    );
  }

  SF.views = SF.views || {};
  SF.views.tags = { render: render, reset: reset, TABS: TABS };
})(window);
