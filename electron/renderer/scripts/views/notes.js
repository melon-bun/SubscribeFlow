/* ==========================================================================
   M28 笔记页：原标题目录 + 阅读编辑区

   左列是**原标题目录**：每条只显示内容标题，不显示封面、简介、笔记正文、
   标签或结论徽标——目录不是卡片墙。同名标题按内容 ID 各自独立。
   右列是选中笔记的阅读区：上面是原内容卡片，下面复用 M27 的「留下点什么」
   编辑区（SF.noteUi），不另造一套笔记业务。

   取数都用 M26 的 note.list／note.facets：搜索覆盖标题与笔记文字，
   平台／来源／标签／项目结论组合筛选，total 与 next_offset 与列表同源。
   ========================================================================== */
(function (global) {
  'use strict';
  var SF = global.SF, h = SF.dom.h, ui = SF.ui, fmt = SF.fmt, icon = SF.icon;

  var PAGE = 20;

  // 列表状态。每次请求带序号：迟到的回包丢掉，不串到当前筛选上。
  // key 是当前查询的身份（条件＋排序＋分页）；needLoad 表示这个身份还没真正发出去。
  var list = {loaded:false, loading:false, error:null, items:[], total:0, next_offset:null,
              seq:0, key:null, needLoad:false};
  // 范围（facets）：只统计有笔记的内容，不是笔记的标签不当作笔记标签。
  var scope = {loaded:false, loading:false, error:null, channels:[], sources:[], tags:[],
               seq:0, needLoad:false};
  // 全局笔记数：不含任何筛选的总数，给侧栏那一枚徽标用。
  var count = {value:null, loading:false, seq:0, needLoad:true};
  var filters = {keyword:'', platform:'', sourceId:'', tags:[], tagMode:'any', verdict:''};
  var sort = 'updated';
  var offset = 0;
  var selectedId = null;
  // 筛选面板默认收起：平台常在眼前，来源／结论／标签收在「筛选」里。
  var filterOpen = false;
  // 选中条目的原内容（阅读区顶部那张卡片）。取不到就如实说取不到。
  var detail = {itemId:null, seq:0, loading:false, error:null, content:null};

  var SORTS = [
    {value:'updated', label:'最近更新'},
    {value:'created', label:'最近创建'},
    {value:'title', label:'按标题'},
  ];

  function queryKey() {
    return JSON.stringify([filters, sort, offset]);
  }

  function query() {
    var q = {limit: PAGE, offset: offset, sort: sort};
    if (filters.keyword) q.keyword = filters.keyword;
    if (filters.platform) q.platform = filters.platform;
    if (filters.sourceId) q.sourceId = filters.sourceId;
    if (filters.tags.length) { q.tags = filters.tags; if (filters.tagMode === 'all') q.tagMode = 'all'; }
    if (filters.verdict) q.verdict = filters.verdict;
    return q;
  }

  function scopeQuery() {
    var q = {};
    if (filters.keyword) q.keyword = filters.keyword;
    if (filters.platform) q.platform = filters.platform;
    if (filters.sourceId) q.sourceId = filters.sourceId;
    if (filters.tags.length) { q.tags = filters.tags; if (filters.tagMode === 'all') q.tagMode = 'all'; }
    if (filters.verdict) q.verdict = filters.verdict;
    return q;
  }

  /* ---------------------------------------------------------------- 取数 */

  function loadList(app) {
    if (list.loading) {
      // 有请求在途，而条件已经变了：记下来，等这次的回包落地后按新条件重发。
      // 直接 return 会把最新条件吞掉，目录就停在旧结果上。
      list.needLoad = true;
      return;
    }
    var key = queryKey();
    var seq = ++list.seq;
    list.loading = true;
    list.error = null;
    app.client.listNotes(query()).then(function (r) {
      list.loading = false;
      // 回包只对得上当前查询身份才算数：期间条件变了就丢掉，并按新条件重发，
      // 不能让旧结果冒充当前条件已经加载。
      if (seq !== list.seq || key !== queryKey()) {
        list.needLoad = true;
        renderView(app);
        return;
      }
      list.loaded = true;
      list.items = r.items || [];
      list.total = r.total || 0;
      list.next_offset = r.next_offset == null ? null : r.next_offset;
      // 选中的那条不在当前范围里了：选相邻的一条，没有就空态。
      if (selectedId && !list.items.some(function (i) { return i.id === selectedId; })) {
        selectNeighbour(app);
      }
      if (!selectedId && list.items.length) select(app, list.items[0].id);
      renderView(app);
    }, function (err) {
      list.loading = false;
      if (seq !== list.seq || key !== queryKey()) {
        list.needLoad = true;
        renderView(app);
        return;
      }
      list.loaded = true;
      list.error = err;
      renderView(app);
    });
  }

  function loadScope(app) {
    if (scope.loading) {
      scope.needLoad = true;
      return;
    }
    var key = queryKey();
    var seq = ++scope.seq;
    scope.loading = true;
    scope.error = null;
    app.client.noteFacets(scopeQuery()).then(function (r) {
      scope.loading = false;
      // 范围也跟当前查询身份走：旧条件的 facets 不能冒充最新范围。
      if (seq !== scope.seq || key !== queryKey()) {
        scope.needLoad = true;
        renderView(app);
        return;
      }
      scope.loaded = true;
      scope.channels = r.channels || [];
      scope.sources = r.sources || [];
      scope.tags = r.tags || [];
      renderView(app);
    }, function (err) {
      scope.loading = false;
      if (seq !== scope.seq || key !== queryKey()) {
        scope.needLoad = true;
        renderView(app);
        return;
      }
      scope.loaded = true;
      scope.error = err;
      renderView(app);
    });
  }

  /**
   * 全局笔记数：不含任何筛选。侧栏那枚徽标用它，不能用筛选后的总数——
   * 筛出 1 条不代表库里只剩 1 条笔记。
   */
  function loadCount(client) {
    if (!client) return;
    if (count.loading) {
      count.needLoad = true;
      return;
    }
    var seq = ++count.seq;
    count.loading = true;
    client.listNotes({limit: 1}).then(function (r) {
      count.loading = false;
      if (seq !== count.seq) return;
      count.value = r.total || 0;
      var state = SF.app && SF.app.state;
      if (state && state.noteCount !== count.value) {
        state.noteCount = count.value;
        if (SF.app.refreshSidebarCounts) SF.app.refreshSidebarCounts();
      }
      if (count.needLoad) {
        count.needLoad = false;
        loadCount(client);
      }
    }, function () {
      count.loading = false;
    });
  }

  function loadDetail(app, itemId) {
    if (detail.itemId === itemId && (detail.content || detail.error)) return;
    var seq = ++detail.seq;
    detail.itemId = itemId;
    detail.loading = true;
    detail.error = null;
    detail.content = null;
    app.client.getContent(itemId).then(function (content) {
      if (seq !== detail.seq) return;    // 换了一条：慢回包丢掉
      detail.loading = false;
      detail.content = content;
      renderView(app);
    }, function (err) {
      if (seq !== detail.seq) return;
      detail.loading = false;
      detail.error = err;
      renderView(app);
    });
  }

  function renderView(app) {
    if (SF.app && SF.app.state.route.name === 'notes') SF.app.renderView('notes');
  }

  /* ---------------------------------------------------------------- 选择 */

  function select(app, itemId) {
    selectedId = itemId;
    loadDetail(app, itemId);
    renderView(app);
  }

  /** 当前选中的那条没了（被删或被筛掉）：选相邻的一条。 */
  function selectNeighbour(app) {
    var index = list.items.findIndex(function (i) { return i.id === selectedId; });
    var next = list.items[index + 1] || list.items[index - 1] || list.items[0];
    if (!next) {
      selectedId = null;
      detail = {itemId:null, seq:detail.seq + 1, loading:false, error:null, content:null};
      return;
    }
    selectedId = next.id;
    loadDetail(app, next.id);
  }

  /* ---------------------------------------------------------------- 渲染 */

  function render(app) {
    var key = queryKey();
    if (key !== list.key) {
      // 查询身份变了：旧结果作废，新条件一定要真的发出去。
      list.key = key;
      list.loaded = false;
      list.items = [];
      list.needLoad = true;
      scope.needLoad = true;
    }
    // needLoad 表示这个身份还没发过请求：在途的请求回来之前也记着，
    // 回来之后按新条件重发（BUG-111）。
    if (list.needLoad && !list.loading) { list.needLoad = false; loadList(app); }
    if (scope.needLoad && !scope.loading) { scope.needLoad = false; loadScope(app); }
    if (count.needLoad && !count.loading) { count.needLoad = false; loadCount(app.client); }
    if (selectedId) loadDetail(app, selectedId);
    return h('div.view', {'data-view':'notes', 'data-refresh-key':'notes:' + queryKey()},
      head(app),
      h('div.notes-layout', null, directory(app), reader(app)));
  }

  function head(app) {
    return h('div.view__head', {'data-refresh-key':'notes-head'},
      h('div.view__head-text', null,
        h('div.view__title', null,
          h('h1.t-h1', {text:'笔记'}),
          h('span.notes-head__count', {text: list.loaded ? (list.total + ' 篇') : ''})),
        h('p.view__desc', {text:'把看过的内容，变成自己的判断。'})));
  }

  /* ---------------- 左列：原标题目录 ---------------- */

  /* 「静流」§笔记：条目下加平台、日期和模板／结论徽标。
     徽标只给一个：项目笔记看结论，通用笔记看类型，两个都没有就不占位。 */
  var VERDICT_LABELS = {using:'在用', watching:'观望', dropped:'放弃'};
  var TEMPLATE_LABELS = {general:'通用', project:'项目'};

  function noteBadge(item) {
    if (item.verdict) {
      return h('span.badge.badge--info', {text: VERDICT_LABELS[item.verdict] || item.verdict});
    }
    if (item.template && item.template !== 'none') {
      return h('span.badge', {text: TEMPLATE_LABELS[item.template] || item.template});
    }
    return null;
  }

  /**
   * 目录条目下的那一行摘要。
   * Core 给的是截断后的总结（没有总结时退回收获）；这里再压平空白、收一次长度，
   * 免得多行文本把目录条目撑高。什么都没写的时候直说「还没写收获」，
   * 而不是留一段空白让人以为坏了。
   */
  function excerptText(raw) {
    var flat = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!flat) return '还没写收获';
    return flat.length > 90 ? flat.slice(0, 90) + '…' : flat;
  }

  function directory(app) {
    var body;
    if (list.error) {
      body = h('div.notes-toc__empty', null,
        h('p.field__error', {role:'status', text:'笔记读取失败：' + (list.error.message || '')}),
        ui.btn('重试', {onClick:function () { list.loaded = false; list.needLoad = true; renderView(app); }}));
    } else if (!list.loaded) {
      body = h('p.field__hint', {text:'正在读取笔记…'});
    } else if (!list.total) {
      body = h('div.notes-toc__empty', null,
        h('p.field__hint', {text: filters.keyword || filters.platform || filters.sourceId ||
          filters.tags.length || filters.verdict
          ? '没有符合条件的笔记。换个关键词或清除筛选看看。'
          : '还没有笔记。打开任意内容，在“留下点什么”里记一句。'}));
    } else {
      body = h('ul.panel__body.notes-toc__list', {'data-refresh-key':'notes-toc'},
        list.items.map(function (item) {
          var active = item.id === selectedId;
          return h('li', null, h('button.notes-toc__item' + (active ? '.is-active' : ''), {
            type:'button', 'aria-current': active ? 'true' : null,
            title: item.title,
            onclick: function () { select(app, item.id); },
          },
            h('span.notes-toc__title', {text: item.title}),
            h('span.notes-toc__meta', null,
              h('span.notes-toc__src', null,
                item.platform ? ui.platformIcon(item.platform, {className:'plat--sm', decorative:true}) : null,
                h('span.notes-toc__src-name', {text: item.source_name || ''})),
              item.note_updated_at ? h('span.notes-toc__date.mono', {text: fmt.ymd(item.note_updated_at).slice(5)}) : null,
              noteBadge(item)),
            h('span.notes-toc__excerpt', {text: excerptText(item.excerpt)})));
        }));
    }
    /* 「静流」§笔记页：左列是一张面板——面板头（标题+排序）、工具区、面板体（列表）、面板脚。
       这里直接套上参考页的组件类名，让移植过来的 .panel/.panel-head/.panel-body 规则生效。 */
    return h('aside.panel.notes-toc', {'aria-label':'笔记目录','data-refresh-key':'notes-toc-wrap'},
      h('div.panel__head.notes-toc__head', null,
        h('span.notes-toc__label', {text:'全部笔记'}),
        h('div.spacer'),
        ui.select(SORTS, sort, function (value) {
          sort = value || 'updated';
          offset = 0;
          list.loaded = false; list.needLoad = true;
          renderView(app);
        }, {ariaLabel:'笔记排序', small:true})),
      h('div.nl-tools.notes-toc__tools', null,
        ui.searchInput('搜索标题或笔记…', filters.keyword, function (value) {
          filters.keyword = value;
          offset = 0;
          list.loaded = false; list.needLoad = true;
          renderView(app);
        }, {ariaLabel:'搜索笔记'}),
        h('div.notes-toc__filters', null,
          ui.select([{value:'',label:'全部平台'}].concat(scope.channels.map(function (row) {
            return {value: row.id, label: (SF.catalog.platform(row.id) || {}).name || row.id};
          })), filters.platform, function (value) {
            filters.platform = value || '';
            offset = 0;
            list.loaded = false; list.needLoad = true;
            renderView(app);
          }, {ariaLabel:'按平台筛选', small:true}),
          ui.btn('筛选', {
            size:'sm',
            variant: filterOpen ? 'accent' : 'ghost',
            onClick: function () { filterOpen = !filterOpen; renderView(app); },
          }),
          activeChips(app)),
        filterOpen ? filterPanel(app) : null),
      body,
      h('div.panel__foot.notes-toc__foot', null,
        h('span', {text: list.loaded ? ('共 ' + list.total + ' 篇') : ''}),
        h('div.spacer'),
        offset > 0 ? ui.iconBtn('chevron-left', '上一页', function () {
          offset = Math.max(0, offset - PAGE);
          list.loaded = false; list.needLoad = true;
          renderView(app);
        }) : null,
        list.next_offset != null ? ui.iconBtn('chevron-right', '下一页', function () {
          offset = list.next_offset;
          list.loaded = false; list.needLoad = true;
          renderView(app);
        }) : null));
  }

  /** 展开的筛选面板：来源、结论与标签。能力都在，只是收起来。 */
  function filterPanel(app) {
    return h('div.notes-toc__panel', null,
      ui.select([{value:'',label:'全部来源'}].concat(scope.sources.map(function (row) {
        return {value: row.id, label: row.name || row.id};
      })), filters.sourceId, function (value) {
        filters.sourceId = value || '';
        offset = 0;
        list.loaded = false; list.needLoad = true;
        renderView(app);
      }, {ariaLabel:'按来源筛选', small:true}),
      ui.select([{value:'',label:'不限结论'},
                 {value:'using', label:'在用'},
                 {value:'watching', label:'观望'},
                 {value:'dropped', label:'放弃'}],
        filters.verdict, function (value) {
          filters.verdict = value || '';
          offset = 0;
          list.loaded = false; list.needLoad = true;
          renderView(app);
        }, {ariaLabel:'按项目结论筛选', small:true}),
      tagFilter(app));
  }

  /** 已经生效的筛选：做成可去掉的标签，一眼能看出在筛什么。 */
  function activeChips(app) {
    var chips = [];
    function chip(label, onRemove) {
      return h('span.notes-toc__chip', null,
        h('span', {text: label}),
        ui.iconBtn('close', '去掉这个筛选', onRemove, {size:14}));
    }
    if (filters.keyword) {
      chips.push(chip('检索 ' + filters.keyword, function () {
        filters.keyword = ''; offset = 0;
        list.loaded = false; list.needLoad = true; renderView(app);
      }));
    }
    if (filters.platform) {
      var platform = (SF.catalog.platform(filters.platform) || {}).name || filters.platform;
      chips.push(chip(platform, function () {
        filters.platform = ''; offset = 0;
        list.loaded = false; list.needLoad = true; renderView(app);
      }));
    }
    if (filters.sourceId) {
      var source = scope.sources.filter(function (row) { return row.id === filters.sourceId; })[0];
      chips.push(chip((source && source.name) || filters.sourceId, function () {
        filters.sourceId = ''; offset = 0;
        list.loaded = false; list.needLoad = true; renderView(app);
      }));
    }
    filters.tags.forEach(function (tagId) {
      var tag = scope.tags.filter(function (row) { return row.id === tagId; })[0];
      chips.push(chip((tag && tag.name) || tagId, function () {
        filters.tags = filters.tags.filter(function (id) { return id !== tagId; });
        offset = 0; list.loaded = false; list.needLoad = true; renderView(app);
      }));
    });
    if (filters.verdict) {
      var labels = {using:'在用', watching:'观望', dropped:'放弃'};
      chips.push(chip(labels[filters.verdict] || filters.verdict, function () {
        filters.verdict = ''; offset = 0;
        list.loaded = false; list.needLoad = true; renderView(app);
      }));
    }
    if (!chips.length) return null;
    return h('div.notes-toc__chips', null, chips);
  }

  /** 标签筛选：选项只来自笔记范围内的标签，不是全库标签。 */
  function tagFilter(app) {
    if (!scope.tags.length) return null;
    return h('div.notes-toc__tags', null,
      scope.tags.map(function (tag) {
        var active = filters.tags.indexOf(tag.id) >= 0;
        return h('button.notes-toc__tag' + (active ? '.is-active' : ''), {
          type:'button', 'aria-pressed': String(active),
          title: tag.name + ' · ' + tag.count + ' 篇',
          onclick: function () {
            var index = filters.tags.indexOf(tag.id);
            if (index >= 0) filters.tags.splice(index, 1);
            else filters.tags.push(tag.id);
            offset = 0;
            list.loaded = false; list.needLoad = true;
            renderView(app);
          },
        }, h('span', {text: tag.name}), h('span.notes-toc__tag-count', {text: String(tag.count)}));
      }),
      filters.tags.length > 1 ? ui.select([{value:'any',label:'任一符合'},{value:'all',label:'全部符合'}],
        filters.tagMode, function (value) {
          filters.tagMode = value === 'all' ? 'all' : 'any';
          offset = 0;
          list.loaded = false; list.needLoad = true;
          renderView(app);
        }, {ariaLabel:'标签筛选方式'}) : null);
  }

  /* ---------------- 右列：阅读区 ---------------- */

  function reader(app) {
    if (!selectedId) {
      return h('section.panel.notes-reader', {'aria-label':'笔记阅读区'},
        ui.state({icon:'edit', title:'还没有选中笔记', desc:'左边挑一条标题，这里显示原内容和你的笔记。'}));
    }
    var item = list.items.find(function (i) { return i.id === selectedId; });
    var title = item ? item.title : '（这条笔记已不在当前范围里）';
    var updated = item ? item.note_updated_at : null;
    return h('section.panel.notes-reader', {'aria-label':'笔记阅读区','data-refresh-key':'notes-reader:' + selectedId},
      h('div.notes-reader__head', null,
        h('h2.notes-reader__title', {text: title}),
        h('p.notes-reader__meta', {text: updated ? ('笔记更新于 ' + fmt.absolute(updated)) : '笔记更新时间未知'})),
      contentCard(app),
      SF.noteUi ? SF.noteUi.noteEditor({
        itemId: selectedId,
        item: detail.content || {},
        client: app.client,
        repaint: function () { renderView(app); },
        // 阅读区里的保存/删除贴在底部，滚动时也能直接点到（确认图）。
        stickyActions: true,
        onChanged: function (info) {
          // 存好或删掉：目录位置、数量与范围都要跟上。
          info = info || {};
          list.loaded = false; list.needLoad = true;
          scope.loaded = false; scope.needLoad = true;
          // 侧栏那枚全局笔记数也跟着变：写完／删掉一条，总数就少一条。
          count.needLoad = true;
          if (info.deleted) {
            // 被删掉的那条不在了：选相邻的一条。
            selectNeighbour(app);
          }
          renderView(app);
        },
      }) : null);
  }

  /**
   * 原内容卡片：尽可能简洁。
   *
   * 只放平台/来源、原标题、短简介和「查看原内容」入口——小红书那种长正文、
   * 多段换行、话题和长链接都不能把卡片撑高，也不铺大图；完整原文只到本地
   * modal 里读。显示只做压缩，数据库里的原文一个字都不改。
   */
  function contentCard(app) {
    var content = detail.content;
    if (detail.loading && !content) {
      return h('div.notes-card', null, h('p.field__hint', {text:'正在读取原内容…'}));
    }
    if (detail.error) {
      return h('div.notes-card', null,
        h('p.field__error', {role:'status', text:'原内容读取失败：' + (detail.error.message || '')}),
        ui.btn('重试', {onClick:function () {
          detail.itemId = null;
          loadDetail(app, selectedId);
          renderView(app);
        }}));
    }
    if (!content) return null;
    var source = content.channelName || content.platform || '';
    var platform = (SF.catalog.platform(content.platform) || {}).name || content.platform || '';
    var sourceLine = platform && source && platform !== source ? (platform + ' · ' + source) : (source || platform);
    var tags = (content.tags || []).slice(0, 2);
    var snippet = content.summary ? plainSnippet(content.summary, 240) : '';
    return h('div.notes-card', {'data-refresh-key':'notes-card:' + content.id},
      h('div.notes-card__top', null,
        h('span.notes-card__source', {title: sourceLine},
          content.platform ? ui.platformIcon(content.platform, {className:'plat--sm', decorative:true}) : null,
          h('span', {text: source || platform})),
        content.publishedAt ? h('span.notes-card__date.mono', {text: fmt.ymd(content.publishedAt).slice(5)}) : null,
        h('div.spacer'),
        viewContentButton(app, content)),
      h('h3.notes-card__title', {title: content.title, text: content.title}),
      snippet ? h('p.notes-card__summary', {title: snippet, text: snippet}) : null,
      tags.length ? h('div.notes-card__tags', null,
        tags.map(function (tag) { return ui.tag(tag.name); })) : null);
  }

  /**
   * 纯文本片段：换行、多余空白、长话题与长链接都压成一行。
   * 只影响显示——数据库里的原文一字不改，完整原文在本地 modal 里读。
   */
  function plainSnippet(text, limit) {
    var flat = String(text || '')
      .replace(/[\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
  }

  /** 「查看原内容」按钮：触发元素留着，关闭 modal 后焦点回到它。 */
  function viewContentButton(app, content) {
    /* 「静流」§组件样张：「打开原文」这类次一级重要操作用墨色。 */
    var button = ui.btn('查看原内容', {variant:'ink', size:'sm', icon:'external', onClick:function () {
      openContentModal(app, content, button);
    }});
    return button;
  }

  /* ---------------- 原内容 modal ---------------- */

  /**
   * 只读的本地原内容弹窗：按稳定内容 ID 读取已保存的数据，
   * 不改路由、不跳收件箱、不自动打开网页。
   */
  function openContentModal(app, content, trigger) {
    var body = h('div.notes-modal', null, h('p.field__hint', {text:'正在读取原内容…'}));
    var layer = ui.dialog({
      title: '原内容详情',
      wide: true,
      body: body,
      footer: [
        h('p.notes-modal__foot', {text:'关闭后继续查看当前笔记。'}),
        h('div.spacer'),
        ui.btn('返回笔记', {variant:'primary', onClick:function () { layer.close(); }}),
      ],
      onClose: function () {
        // 关闭后焦点回到触发它的那个卡片／按钮。
        if (trigger && trigger.isConnected) trigger.focus();
      },
    });
    // 焦点由对话框自己放进弹层里（ui.dialog 的 pushLayer），
    // 键盘用户不该能 Tab 到背后的页面上。
    app.client.getContent(content.id).then(function (full) {
      SF.dom.render(body, [modalBody(app, full)]);
    }, function (err) {
      SF.dom.render(body, [
        h('p.field__error', {role:'status', text:'原内容读取失败：' + (err.message || '')}),
        ui.btn('重试', {onClick:function () {
          SF.dom.render(body, [h('p.field__hint', {text:'正在读取原内容…'})]);
          app.client.getContent(content.id).then(function (full) {
            SF.dom.render(body, [modalBody(app, full)]);
          }, function (err2) {
            SF.dom.render(body, [h('p.field__error', {role:'status', text:'原内容读取失败：' + (err2.message || '')})]);
          });
        }}),
      ]);
    });
    return layer;
  }

  function modalBody(app, content) {
    var children = [];
    children.push(h('div.notes-modal__meta', null,
      ui.platformTag(content.platform),
      h('span.notes-card__source', {text: content.channelName || content.platform}),
      h('span.tag', {text: content.intakeMethod === 'manual' ? '手动收录' : '自动采集'})));
    children.push(h('h3.notes-modal__title', {text: content.title}));
    var time = content.publishedAt || content.manualAddedAt || content.firstSeenAt;
    if (time) {
      children.push(h('p.notes-modal__time', {text: (content.intakeMethod === 'manual' ? '收录时间：' : '发布时间：') + fmt.absolute(time)}));
    }
    if ((content.tags || []).length) {
      children.push(h('div.notes-modal__tags', null, content.tags.map(function (tag) { return ui.tag(tag.name); })));
    }
    if (content.summary) {
      children.push(h('h4.notes-modal__section', {text:'已保存的简介'}));
      children.push(h('p.notes-modal__text', {text: content.summary}));
    }
    if (content.state && (content.state.read || content.state.deferred || content.state.archived)) {
      var marks = [];
      if (content.state.read) marks.push('已读');
      if (content.state.deferred) marks.push('稍后处理');
      if (content.state.archived) marks.push('归档');
      children.push(h('p.notes-modal__state', {text:'处理状态：' + marks.join('、')}));
    }
    if (content.url) {
      children.push(h('p.notes-modal__link', null,
        h('span', {text:'原网页地址：' + content.url}),
        ui.btn('打开原网页', {size:'sm', icon:'external', onClick:function () {
          // 明确的外部打开动作：只有点了这里才交给系统浏览器。
          SF.app.act('open:' + content.id, function () { return app.client.openContent(content.id); });
        }})));
    }
    children.push(h('p.notes-modal__note', {text:'这里只展示已经采集到的内容；没有采集到的部分如实不显示。'}));
    return h('div.notes-modal__inner', null, children);
  }

  /* ---------------------------------------------------------------- 失效 */

  function invalidate(reasons) {
    if (!reasons || reasons.has('all') || reasons.has('content') || reasons.has('poll')) {
      list.needLoad = true;
      scope.needLoad = true;
    }
    if (!reasons || reasons.has('all') || reasons.has('content')) {
      // 侧栏那枚全局笔记数也要跟上：写完／删掉笔记后不必等用户回到笔记页才更新。
      count.needLoad = true;
      var client = SF.app && SF.app.state && SF.app.state.client;
      // 徽标还没出现过时不急着查：等用户打开笔记页时一起算，省一次无用往返。
      if (client && count.value !== null) { count.needLoad = false; loadCount(client); }
    }
  }

  function reset() {
    list = {loaded:false, loading:false, error:null, items:[], total:0, next_offset:null,
            seq:list.seq, key:null, needLoad:false};
    scope = {loaded:false, loading:false, error:null, channels:[], sources:[], tags:[],
             seq:scope.seq, needLoad:false};
    count = {value:null, loading:false, seq:count.seq, needLoad:true};
    filters = {keyword:'', platform:'', sourceId:'', tags:[], tagMode:'any', verdict:''};
    sort = 'updated';
    offset = 0;
    selectedId = null;
    detail = {itemId:null, seq:detail.seq, loading:false, error:null, content:null};
  }

  /* ---------------------------------------------------------------- 离开 */

  /** 当前选中笔记有没有未保存的文字。 */
  function hasNoteDraft() {
    return !!(SF.noteUi && selectedId && SF.noteUi.hasDirty(selectedId));
  }

  /** 离开页面前问一句：保存、放弃还是继续编辑。 */
  function confirmLeave(app) {
    if (!hasNoteDraft()) return Promise.resolve(true);
    return SF.noteUi.confirmLeave(app, selectedId);
  }

  SF.views = SF.views || {};
  SF.views.notes = {
    render: render, reset: reset, invalidate: invalidate,
    confirmLeave: confirmLeave, hasNoteDraft: hasNoteDraft,
    openContentModal: openContentModal,
  };
})(window);
