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
  var list = {loaded:false, loading:false, error:null, items:[], total:0, next_offset:null, seq:0};
  // 范围（facets）：只统计有笔记的内容，不是笔记的标签不当作笔记标签。
  var scope = {loaded:false, loading:false, error:null, channels:[], sources:[], tags:[]};
  var filters = {keyword:'', platform:'', sourceId:'', tags:[], tagMode:'any', verdict:''};
  var sort = 'updated';
  var offset = 0;
  var selectedId = null;
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
    if (list.loading) return;
    var seq = ++list.seq;
    list.loading = true;
    list.error = null;
    app.client.listNotes(query()).then(function (r) {
      if (seq !== list.seq) return;      // 迟到的回包：丢掉
      list.loading = false;
      list.loaded = true;
      list.items = r.items || [];
      list.total = r.total || 0;
      list.next_offset = r.next_offset == null ? null : r.next_offset;
      // 侧栏上的笔记数：有笔记才算数。变了就更新侧栏那一枚。
      if (app.noteCount !== list.total) {
        app.noteCount = list.total;
        if (SF.app && SF.app.refreshSidebarCounts) SF.app.refreshSidebarCounts();
      }
      // 选中的那条不在当前范围里了：选相邻的一条，没有就空态。
      if (selectedId && !list.items.some(function (i) { return i.id === selectedId; })) {
        selectNeighbour(app);
      }
      if (!selectedId && list.items.length) select(app, list.items[0].id);
      renderView(app);
    }, function (err) {
      if (seq !== list.seq) return;
      list.loading = false;
      list.loaded = true;
      list.error = err;
      renderView(app);
    });
  }

  function loadScope(app) {
    if (scope.loading) return;
    scope.loading = true;
    scope.error = null;
    app.client.noteFacets(scopeQuery()).then(function (r) {
      scope.loading = false;
      scope.loaded = true;
      scope.channels = r.channels || [];
      scope.sources = r.sources || [];
      scope.tags = r.tags || [];
      renderView(app);
    }, function (err) {
      scope.loading = false;
      scope.loaded = true;
      scope.error = err;
      renderView(app);
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
    if (key !== list.key) { list.key = key; list.loaded = false; list.items = []; }
    if (!list.loaded || list.stale) { list.stale = false; loadList(app); loadScope(app); }
    if (selectedId) loadDetail(app, selectedId);
    return h('div.view', {'data-view':'notes', 'data-refresh-key':'notes:' + queryKey()},
      head(app),
      h('div.notes-layout', null, directory(app), reader(app)));
  }

  function head(app) {
    return h('div.view__head', {'data-refresh-key':'notes-head'},
      h('div.view__head-text', null,
        h('div.view__title', null, h('h1.t-h1', {text:'笔记'})),
        h('p.view__desc', {text:'从标题找回内容，从笔记找回自己的判断。'})),
      h('div.view__actions', null,
        h('span.muted', {text: list.loaded ? ('共 ' + list.total + ' 篇') : '正在读取…'})));
  }

  /* ---------------- 左列：原标题目录 ---------------- */

  function directory(app) {
    var body;
    if (list.error) {
      body = h('div.notes-toc__empty', null,
        h('p.field__error', {role:'status', text:'笔记读取失败：' + (list.error.message || '')}),
        ui.btn('重试', {onClick:function () { list.loaded = false; list.stale = true; renderView(app); }}));
    } else if (!list.loaded) {
      body = h('p.field__hint', {text:'正在读取笔记…'});
    } else if (!list.total) {
      body = h('div.notes-toc__empty', null,
        h('p.field__hint', {text: filters.keyword || filters.platform || filters.sourceId ||
          filters.tags.length || filters.verdict
          ? '没有符合条件的笔记。换个关键词或清除筛选看看。'
          : '还没有笔记。打开任意内容，在“留下点什么”里记一句。'}));
    } else {
      body = h('ul.notes-toc__list', {'data-refresh-key':'notes-toc'},
        list.items.map(function (item) {
          var active = item.id === selectedId;
          return h('li', null, h('button.notes-toc__item' + (active ? '.is-active' : ''), {
            type:'button', 'aria-current': active ? 'true' : null,
            title: item.title,
            onclick: function () { select(app, item.id); },
          }, h('span.notes-toc__title', {text: item.title})));
        }));
    }
    return h('aside.notes-toc', {'aria-label':'笔记目录','data-refresh-key':'notes-toc-wrap'},
      h('div.notes-toc__tools', null,
        ui.searchInput('搜索标题或笔记…', filters.keyword, function (value) {
          filters.keyword = value;
          offset = 0;
          list.loaded = false;
          renderView(app);
        }, {ariaLabel:'搜索笔记'}),
        h('div.notes-toc__filters', null,
          ui.select([{value:'',label:'全部平台'}].concat(scope.channels.map(function (row) {
            return {value: row.id, label: (SF.catalog.platform(row.id) || {}).name || row.id};
          })), filters.platform, function (value) {
            filters.platform = value || '';
            offset = 0;
            list.loaded = false;
            renderView(app);
          }, {ariaLabel:'按平台筛选'}),
          ui.select([{value:'',label:'全部来源'}].concat(scope.sources.map(function (row) {
            return {value: row.id, label: row.name || row.id};
          })), filters.sourceId, function (value) {
            filters.sourceId = value || '';
            offset = 0;
            list.loaded = false;
            renderView(app);
          }, {ariaLabel:'按来源筛选'}),
          ui.select([{value:'',label:'不限结论'},
                     {value:'using', label:'在用'},
                     {value:'watching', label:'观望'},
                     {value:'dropped', label:'放弃'}],
            filters.verdict, function (value) {
              filters.verdict = value || '';
              offset = 0;
              list.loaded = false;
              renderView(app);
            }, {ariaLabel:'按项目结论筛选'}),
          ui.select(SORTS, sort, function (value) {
            sort = value || 'updated';
            offset = 0;
            list.loaded = false;
            renderView(app);
          }, {ariaLabel:'笔记排序'})),
        tagFilter(app)),
      body,
      list.total ? h('p.notes-toc__foot', {text:'共 ' + list.total + ' 篇 · 目录只显示原标题'}) : null,
      (list.next_offset != null || offset > 0) ? h('div.notes-toc__pager', null,
        offset > 0 ? ui.btn('上一页', {onClick:function () {
          offset = Math.max(0, offset - PAGE);
          list.loaded = false;
          renderView(app);
        }}) : null,
        list.next_offset != null ? ui.btn('更多', {onClick:function () {
          offset = list.next_offset;
          list.loaded = false;
          renderView(app);
        }}) : null) : null);
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
            list.loaded = false;
            renderView(app);
          },
        }, h('span', {text: tag.name}), h('span.notes-toc__tag-count', {text: String(tag.count)}));
      }),
      filters.tags.length > 1 ? ui.select([{value:'any',label:'任一符合'},{value:'all',label:'全部符合'}],
        filters.tagMode, function (value) {
          filters.tagMode = value === 'all' ? 'all' : 'any';
          offset = 0;
          list.loaded = false;
          renderView(app);
        }, {ariaLabel:'标签筛选方式'}) : null);
  }

  /* ---------------- 右列：阅读区 ---------------- */

  function reader(app) {
    if (!selectedId) {
      return h('section.notes-reader', {'aria-label':'笔记阅读区'},
        ui.state({icon:'edit', title:'还没有选中笔记', desc:'左边挑一条标题，这里显示原内容和你的笔记。'}));
    }
    var item = list.items.find(function (i) { return i.id === selectedId; });
    var title = item ? item.title : '（这条笔记已不在当前范围里）';
    var updated = item ? item.note_updated_at : null;
    return h('section.notes-reader', {'aria-label':'笔记阅读区','data-refresh-key':'notes-reader:' + selectedId},
      h('div.notes-reader__head', null,
        h('h2.notes-reader__title', {text: title}),
        h('p.notes-reader__meta', {text: updated ? ('笔记更新于 ' + fmt.absolute(updated)) : '笔记更新时间未知'})),
      contentCard(app),
      SF.noteUi ? SF.noteUi.noteEditor({
        itemId: selectedId,
        item: detail.content || {},
        client: app.client,
        repaint: function () { renderView(app); },
        onChanged: function (info) {
          // 存好或删掉：目录位置、数量与范围都要跟上。
          info = info || {};
          list.loaded = false;
          scope.loaded = false;
          if (info.deleted) {
            // 被删掉的那条不在了：选相邻的一条。
            selectNeighbour(app);
          }
          renderView(app);
        },
      }) : null);
  }

  /** 原内容卡片：只放原内容的信息，不重复个人笔记。 */
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
    return h('div.notes-card', {'data-refresh-key':'notes-card:' + content.id},
      h('div.notes-card__meta', null,
        ui.platformTag(content.platform),
        h('span.notes-card__source', {text: content.channelName || content.platform}),
        h('span.tag', {text: content.intakeMethod === 'manual' ? '手动收录' : '自动采集'})),
      h('h3.notes-card__title', {text: content.title}),
      content.summary ? h('p.notes-card__summary', {text: content.summary}) : null,
      h('div.notes-card__tags', null,
        (content.tags || []).map(function (tag) { return ui.tag(tag.name); }),
        h('span.spacer'),
        viewContentButton(app, content)),
      h('p.notes-card__hint', {text:'这里只放原内容的信息；你的笔记在下面。'}));
  }

  /** 「查看内容」按钮：触发元素留着，关闭 modal 后焦点回到它。 */
  function viewContentButton(app, content) {
    var button = ui.btn('查看内容', {size:'sm', icon:'external', onClick:function () {
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
      list.stale = true;
      scope.stale = true;
    }
  }

  function reset() {
    list = {loaded:false, loading:false, error:null, items:[], total:0, next_offset:null, seq:list.seq};
    scope = {loaded:false, loading:false, error:null, channels:[], sources:[], tags:[]};
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
