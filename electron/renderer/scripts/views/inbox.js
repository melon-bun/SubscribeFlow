/* F1 收件箱与详情布局；所有持久化与采集由 AppClient 完成。 */
(function (global) {
  'use strict';
  var SF = global.SF, h = SF.dom.h, ui = SF.ui, fmt = SF.fmt, icon = SF.icon;
  var cache = {}, offset = 0, queryKey = '', selected = new Set();
  var previousIds = [], selectLast = false;
  /* 标签目录单独缓存：筛选面板与详情编辑器都要用，不该跟着内容列表一起失效。 */
  var tagCache = {}, tagPanelOpen = false;
  /* 后端 content.bulk_set_tags 的硬上限。界面先拦一道，好过只丢一个后端错误码上来。 */
  var BULK_LIMIT = 100, BULK_CLEAR = '__clear__';

  /* ---------------- 标签目录 ---------------- */

  /**
   * 取一份标签目录。就绪后回调 done，供「容器自己重画」的场景使用：
   * 详情弹窗被 overview 复用（见 overview.js 的 openDetail），它不受主区域重绘影响，
   * 只能由自己这块 DOM 重新画一次。
   */
  function ensureTags(app, done) {
    if (tagCache.loaded) { if (done) done(); return; }
    tagCache.waiting = tagCache.waiting || [];
    if (tagCache.loading) { if (done) tagCache.waiting.push(done); return; }
    /* 目录拿不到时退化成空列表：内容侧照常可用，只是没有可添加的标签。 */
    if (!app.client || !app.client.listTags) { tagCache = {loaded: true, items: []}; if (done) done(); return; }
    var current = tagCache; current.loading = true;
    if (done) current.waiting.push(done);
    function flush() { (current.waiting || []).forEach(function (fn) { try { fn(); } catch (e) {} }); current.waiting = []; }
    app.client.listTags({}).then(function (r) {
      if (tagCache !== current) return;
      Object.assign(tagCache, r, {loaded: true, loading: false});
      flush();
    }).catch(function (err) {
      if (tagCache !== current) return;
      Object.assign(tagCache, {loaded: true, loading: false, error: err, items: []});
      flush();
    });
  }

  function allTags() { return tagCache.items || []; }
  function enabledTags() { return allTags().filter(function (t) { return t.enabled !== false; }); }

  /** 标签色块的唯一入口。SF.tagUi 未加载时退回纯文字，
      避免共享组件把标签对象当字符串渲染成一串 [object Object]。 */
  function chip(tag, opts) {
    if (SF.tagUi) return SF.tagUi.tagChip(tag, opts || {});
    return h('span.tag', {text: tag.name});
  }

  /** 保留失效条件的可见入口，避免目录变动后留下不可清除的隐藏筛选。 */
  function pickedTags(app) {
    var ids = app.filters.tags || [];
    return ids.map(function (id) {
      return allTags().find(function (t) { return t.id === id; }) || {
        id: id, name: tagCache.loaded && !tagCache.error ? '已删除标签' : '标签暂不可用', color: 'slate', unavailable: true
      };
    });
  }

  function query(app) {
    var q = {limit: 20, offset: offset};
    if (app.filters.quick !== 'all') q.state = app.filters.quick;
    if (app.filters.priority) q.priority = app.filters.priority;
    if (app.filters.platform) q.platform = app.filters.platform;
    if (app.filters.channelId) q.channelId = app.filters.channelId;
    if (app.filters.sourceId) q.sourceId = app.filters.sourceId;
    if (app.filters.intakeMethod) q.intakeMethod = app.filters.intakeMethod;
    if (app.search) q.keyword = app.search;
    if (app.filters.day) { q.from = app.filters.day; q.to = app.filters.day; }
    /* tags 为空等价于不筛选，所以只在真的选了标签时才下发。
       any 是后端默认值，不下发 tagMode，避免把默认语义写死在请求里。 */
    var tags = app.filters.tags || [];
    if (tags.length) { q.tags = tags; if (app.filters.tagMode === 'all') q.tagMode = 'all'; }
    return q;
  }

  function render(app) {
    var key = JSON.stringify([app.filters, app.search]);
    if (key !== queryKey) { queryKey = key; offset = 0; cache = {}; selected.clear(); previousIds = []; selectLast = false; }
    if (!cache.loaded && !cache.loading) {
      var current = cache; current.loading = true;
      app.client.listContents(query(app)).then(function (r) {
        if (cache !== current) return;
        if (!r.items.length && offset) {
          offset = r.total ? Math.floor((r.total - 1) / 20) * 20 : 0;
          selectLast = true;
          if (r.total) { cache = {}; SF.app.renderContent(); return; }
        }
        Object.assign(cache, r, {loaded: true, loading: false});
        if (!r.items.some(function (c) { return c.id === app.selectedId; })) {
          var ids = r.items.map(function (c) { return c.id; });
          var index = previousIds.indexOf(app.selectedId);
          var next = index < 0 ? null : previousIds.slice(index + 1).find(function (id) { return ids.includes(id); });
          var previous = index < 0 ? null : previousIds.slice(0, index).reverse().find(function (id) { return ids.includes(id); });
          // 页末移出时，后端可能用下一页的第一条补上当前位置。
          if (!next && index >= 0 && !selectLast) next = ids.slice(previous ? ids.indexOf(previous) + 1 : 0).find(function (id) { return !previousIds.includes(id); });
          if (!next) next = previous;
          app.selectedId = next || (selectLast ? ids[ids.length - 1] : ids[0]);
        }
        previousIds = r.items.map(function (c) { return c.id; });
        selectLast = false;
        selected = new Set(Array.from(selected).filter(function (id) { return r.items.some(function (c) { return c.id === id; }); }));
        SF.app.renderContent();
      }).catch(function (err) { if (cache !== current) return; Object.assign(cache, {loaded: true, loading: false, error: err}); SF.app.renderContent(); });
    }
    /* 目录就绪后只重画真正依赖它的地方：筛选面板开着才需要整块重画，
       详情里的编辑器自己 repaint。目录到达不该把用户正在操作的 DOM 整页换掉——
       那会让进行中的点击落空，也让读屏焦点丢失。 */
    if (!tagCache.loaded) ensureTags(app, function () { if (tagPanelOpen) SF.app.renderContent(); });
    var isInbox = app.filters.quick === 'unread';
    var titles = {unread:'收件箱',all:'全部更新',read:'已读',deferred:'稍后处理',archived:'已归档'};
    var descriptions = {unread:'待处理的创作者更新；标记已读、稍后处理或归档后会移出收件箱。',
      all:'查看所有已保存的内容，包括已读、稍后处理和已归档。',read:'已标记为已读的内容。',deferred:'已留待稍后处理的内容。',archived:'已归档的内容。'};
    var head = h('div.view__head', null,
      h('div.view__head-text', null, h('div.view__title', null, h('h1.t-h1', {text:titles[app.filters.quick] || '内容'}), ui.countPill(cache.total == null ? '—' : cache.total, 'brand')),
        h('p.view__desc', {text:descriptions[app.filters.quick] || '按日期查看收录的内容。'})),
      h('div.view__actions', null, h('span.muted', {text:'按日历时间排列'}),
        ui.btn('添加内容', {variant:'primary', icon:'plus', disabled:!app.session.capabilities.canIntake,
          title: app.session.capabilities.canIntake ? '粘贴链接收录单条内容' : '当前渠道尚未支持单条链接收录',
          onClick:function () { SF.intakeDialog.open(app); }}),
        ui.btn('重新查询', {icon:'refresh', onClick:function () { cache = {}; SF.app.refreshData(true); }})));
    var chips = h('div.inbox__toolbar', null,
      h('div.chips', null,
        h('button.chip' + (!app.filters.platform ? '.is-active' : ''), {type:'button', onclick:function () { app.filters.platform = null; SF.app.render(); }},
          h('span', {text:'全部'}), h('span.chip__count', {text:String(app.counts.total || 0)})),
        app.platforms.map(function (p) {
          return h('button.chip' + (app.filters.platform === p.id ? '.is-active' : ''), {type:'button', onclick:function () { app.filters.platform = p.id; SF.app.render(); }},
            h('span', {text:SF.catalog.platform(p.id).name}), h('span.chip__count', {text:String(p.count || 0)}));
        }),
        app.filters.channelId || app.filters.sourceId || app.filters.day ? ui.btn('清除来源 / 日期筛选', {onClick:function () { app.filters.channelId = null; app.filters.sourceId = null; delete app.filters.day; SF.app.render(); }}) : null));
    chips.appendChild(ui.select([{value:'',label:'全部优先级'}].concat(['high','medium','low','none'].map(function(id) { return {value:id,label:SF.catalog.priority(id).name}; })), app.filters.priority || '', function(value) { app.filters.priority=value || null; SF.app.render(); }, {ariaLabel:'筛选优先级'}));
    if (!cache.sourcesRequested) {
      var sourceOwner=cache; sourceOwner.sourcesRequested=true;
      app.client.listContentSources({}).then(function(r) {if(cache===sourceOwner) {sourceOwner.sources=r.items; SF.app.renderContent();}})
        .catch(function(err) {if(cache===sourceOwner) {sourceOwner.sourcesError=err; SF.app.renderContent();}});
    }
    chips.appendChild(ui.select([{value:'',label:'全部来源'}].concat((cache.sources||[]).map(function(s) {return {value:s.id,label:SF.catalog.platform(s.platform).name+' · '+s.name};})), app.filters.sourceId||'',function(v) {app.filters.sourceId=v||null;app.filters.channelId=null;SF.app.render();},{ariaLabel:'筛选来源'}));
    chips.appendChild(ui.select([{value:'',label:'全部收录方式'},{value:'subscription',label:'自动采集'},{value:'manual',label:'手动收录'}],app.filters.intakeMethod||'',function(v) {app.filters.intakeMethod=v||null;SF.app.render();},{ariaLabel:'筛选收录方式'}));
    if(cache.sourcesError) chips.appendChild(ui.btn('重试来源筛选',{size:'sm',title:cache.sourcesError.message,onClick:function() {cache.sourcesRequested=false;cache.sourcesError=null;SF.app.renderContent();}}));
    /* 标签筛选入口紧跟优先级，和其它筛选项同属一条工具栏；面板展开时插在工具栏下方。 */
    var picked = pickedTags(app);
    chips.appendChild(ui.btn('标签' + (picked.length ? ' · ' + picked.length : ''), {icon:'tag', onClick:function () { tagPanelOpen = !tagPanelOpen; SF.app.renderContent(); }}));
    var tagPanel = tagPanelOpen ? tagFilterPanel(app) : null;
    var body;
    if (cache.error) body = ui.state({icon:'alert', title:'内容读取失败', desc:cache.error.message, actions:[{label:'重试', onClick:function () { cache = {}; SF.app.renderContent(); }}]});
    else if (!cache.loaded) body = ui.skeletonCards(4);
    else if (!cache.items.length) body = ui.state({icon:'inbox', title:isInbox ? '当前没有待处理内容' : '当前没有内容', desc:isInbox ? '添加来源并手动刷新，或在“全部更新”和对应分类中查看已处理内容。' : '添加来源并手动刷新，或清除筛选后查看已保存的内容。', actions:[
      {label:'添加来源', variant:'primary', onClick:function () { SF.app.navigate('channels'); }},
      {label:'清除筛选', onClick:function () { app.filters = {quick:app.filters.quick, platform:null, channelId:null}; app.search = ''; SF.app.render(); }}].concat(isInbox ? [
      {label:'查看全部更新', onClick:function () { app.filters = {quick:'all', platform:null, channelId:null}; app.search = ''; SF.app.render(); }}] : [])});
    else body = h('div.inbox__grid.scroll-y', {'data-scroll-key':'contents:' + offset}, cache.items.map(function (item) {
      return h('div.content-selection', null, ui.check(selected.has(item.id), function () { if (selected.has(item.id)) selected.delete(item.id); else selected.add(item.id); SF.app.renderContent(); }, '选择 ' + item.title),
        withTags(ui.contentCard(item, {selected:app.selectedId === item.id, now:app.now,
          onSelect:function () { app.selectedId = item.id; SF.app.renderContent(); },
          onMenu:function (e) { e.stopPropagation(); ui.menu([
            {label:item.state.read ? '标记为未读' : '标记为已读', onClick:function () { update(app, item.id, {read:!item.state.read}); }},
            {label:'打开原文', onClick:function () { SF.app.act('open:' + item.id, function () { return app.client.openContent(item.id); }); }}
          ], e.currentTarget); }}), item));
    }));
    var bulk = selected.size ? h('div.inbox__toolbar', null, h('span', {text:'已选 ' + selected.size + ' 条'}),
      ['已读', '稍后处理', '归档'].map(function (label, i) { return ui.btn(label, {onClick:function () {
        var ids = Array.from(selected), state = {}; state[['read','deferred','archived'][i]] = true;
        SF.app.act('bulk', async function () { await app.client.bulkUpdate(ids, {state:state}); selected.clear(); await SF.app.refreshData(true); });
      }}); }), ui.select([{value:'',label:'批量设置优先级'},{value:'inherit',label:'恢复跟随来源'}].concat(SF.catalog.PRIORITY_ORDER.map(function(id) { return {value:id,label:SF.catalog.priority(id).name}; })), '', function(value) { if (!value) return; var ids=Array.from(selected); SF.app.act('bulk',async function() { await app.client.bulkUpdate(ids,{priority:value==='inherit' ? null : value}); selected.clear(); await SF.app.refreshData(true); }); },{ariaLabel:'批量设置优先级'}), bulkTagControl(app), ui.btn('取消选择', {onClick:function () { selected.clear(); SF.app.renderContent(); }})) : null;
    var pager = cache.loaded && !cache.error ? h('div.inbox__toolbar', null,
      h('span.muted', {text:'共 ' + cache.total + ' 条 · 第 ' + (Math.floor(offset / 20) + 1) + ' 页'}),
      ui.btn('上一页', {disabled:offset === 0, onClick:function () { offset = Math.max(0, offset - 20); cache = {}; previousIds = []; selectLast = false; selected.clear(); SF.app.renderContent(); }}),
      ui.btn('下一页', {disabled:cache.next_offset == null, onClick:function () { offset = cache.next_offset; cache = {}; previousIds = []; selectLast = false; selected.clear(); SF.app.renderContent(); }})) : null;
    var item = cache.items && cache.items.find(function (c) { return c.id === app.selectedId; });
    return {main:h('div.view', {'data-view':'inbox'}, head, h('div.view__body.inbox', null, chips, tagPanel, bulk, body, pager)),
      aside:item && !cache.error ? h('aside.detail', {'aria-label':'内容详情'},
        h('div.detail__head', null, h('span', {text:'内容详情'}), h('div.spacer'), ui.iconBtn('close', '关闭详情', function () { app.selectedId = null; SF.app.renderContent(); })),
        h('div.detail__body.scroll-y', {'data-scroll-key':'detail:' + item.id}, detailBody(app, item, function (fresh, settled) { repaintContent(app, fresh, settled); }))) : null};
  }
  function repaintContent(app, fresh, settled) {
    // 写入等待期间列表可能失效或离开此页，迟到回执不能访问已清空的缓存。
    var index = (cache.items || []).findIndex(function (item) { return item.id === fresh.id; });
    if (index >= 0 && !settled) cache.items[index] = fresh;
    if (app.route.name === 'inbox') SF.app.renderContent();
  }
  function contentPending(id) { return SF.app.isPending('content:' + id); }
  function saveContent(app, item, patch, repaint) {
    if (contentPending(item.id)) return SF.app.act('content:' + item.id, function () {});
    var fresh = item;
    var saving = SF.app.act('content:' + item.id, async function () {
      fresh = await app.client.updateContent(item.id, patch);
      if (repaint) repaint(fresh);
      await SF.app.refreshData(true);
    });
    // 数据可先回显，但控件要等整个写入/刷新动作结束才重新可用。
    if (repaint) repaint(fresh);
    return saving.then(function () { if (repaint) repaint(fresh, true); });
  }
  function update(app, id, state) {
    var item = (cache.items || []).find(function (entry) { return entry.id === id; });
    return saveContent(app, item || {id:id}, {state:state}, function (fresh, settled) { repaintContent(app, fresh, settled); });
  }

  /* ---------------- 卡片上的标签 ---------------- */

  /**
   * 共享卡片已经预留了 .content-card__tags 容器，但它按纯文本渲染标签对象。
   * 这里换成真正的色块，而不是去改共享组件——标签的呈现规则归 tagUi 管。
   * 没有标签时容器本来就不存在，也不补占位：每张卡片挂一个「无标签」只是噪音。
   */
  function withTags(card, item) {
    var slot = card.querySelector('.content-card__tags'), tags = item.tags || [];
    if (!slot || !tags.length) return card;
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    tags.forEach(function (t) {
      slot.appendChild(chip(t, {title: t.origin === 'suggested' ? t.name + ' · 识别建议，未经确认' : t.name}));
    });
    return card;
  }

  /* ---------------- 详情里的标签编辑器 ---------------- */

  function priorityControls(app,item,repaint) {
    return h('div.detail__section',null,h('div.detail__section-title',{text:'优先级'}),
      h('p.field__hint',{text:item.priorityOverride ? '此内容已单独设置，不受来源默认值变化影响。' : '跟随来源 · 当前' + SF.catalog.priority(item.priority).name}),
      h('div.priority-grid',{'aria-label':'内容优先级'}, SF.catalog.PRIORITY_ORDER.map(function(id) {
        var meta=SF.catalog.priority(id);
        return h('button.priority-opt.priority-opt--'+id+(item.priorityOverride===id?'.is-active':''),{type:'button',disabled:contentPending(item.id),'aria-pressed':String(item.priorityOverride===id),onclick:function() { save(id); }},
          h('span.priority-opt__icon',null,icon(meta.icon,14)),h('span.priority-opt__name',{text:meta.name}));
      })),
      ui.btn('跟随来源',{size:'sm',disabled:contentPending(item.id)||!item.priorityOverride,onClick:function() { save(null); }}));
    function save(priority) {
      saveContent(app, item, {priority:priority}, repaint);
    }
  }

  function tagControls(app, item, repaint) {
    var box = h('div.detail__section', null);
    function paint() {
      while (box.firstChild) box.removeChild(box.firstChild);
      var tags = item.tags || [];
      var suggested = tags.some(function (t) { return t.origin === 'suggested'; });
      box.appendChild(h('div.detail__section-title', {text:'标签'}));
      box.appendChild(h('p.field__hint', {text: suggested
        ? '在对话框里点选标签，确认挂载后保存。带「识别」角标的是自动识别建议，可以直接移除，也可以保留。'
        : '在对话框里点选标签，确认挂载后保存。'}));
      if (!SF.tagUi) {
        /* 标签控件没加载时只展示现状，不给一个点了没反应的添加入口。 */
        box.appendChild(h('div.tag-editor__chips', null, tags.length
          ? tags.map(function (t) { return chip(t); })
          : h('span.muted', {text:'还没有标签'})));
        box.appendChild(h('p.field__hint', {text:'标签控件尚未加载，暂时无法修改。'}));
        return;
      }
      box.appendChild(SF.tagUi.tagEditor({
        selected: tags,
        allTags: allTags(),
        loading: !tagCache.loaded || !!tagCache.error,
        emptyHint: '还没有标签',
        selectLabel: '为这条内容添加标签',
        /* 对话框里回车新建标签：省掉「先关掉对话框去标签页建好再回来」这一趟。 */
        onCreateTag: function (name, done) {
          SF.app.act('tag:new', async function () {
            var tag = await app.client.createTag({
              name: name,
              color: SF.tagCatalog.nextColor(allTags()),
            });
            allTags().push(tag);
            done(tag);
          });
        },
        onChange: function (next) { save(next.map(function (t) { return t.id; })); }
      }));
      if (tagCache.error) box.appendChild(h('div', null,
        h('p.field__error', {text:'标签目录读取失败：' + tagCache.error.message}),
        ui.btn('重试读取标签', {size:'sm', onClick:function () {
          SF.views.inbox.invalidateTags();
          ensureTags(app, function () { if (box.isConnected) paint(); });
          paint();
        }})));
    }
    function save(ids) {
      SF.app.act('tags:' + item.id, async function () {
        var fresh = await app.client.setContentTags(item.id, ids);
        item = fresh;
        /* 标签的 contentCount 变了，筛选面板上的计数要跟着重取。 */
        SF.views.inbox.invalidateTags();
        if (repaint) repaint(fresh);
        await SF.app.refreshData(true);
      });
    }
    paint();
    /* 目录晚到时只重画这一块：这个详情区被 overview 的弹窗复用，不能靠主区域重绘带回来。 */
    if (!tagCache.loaded) ensureTags(app, function () { if (box.isConnected) paint(); });
    return box;
  }

  /* ---------------- 标签筛选 ---------------- */

  function toggleTagFilter(app, id) {
    var ids = (app.filters.tags || []).slice();
    var i = ids.indexOf(id);
    if (i >= 0) ids.splice(i, 1); else ids.push(id);
    app.filters.tags = ids;
    /* 清空后回到默认语义，避免上一次留下的 all 影响下一次筛选。 */
    if (!ids.length) app.filters.tagMode = 'any';
    SF.app.render();
  }

  function tagFilterPanel(app) {
    var picked = pickedTags(app), mode = app.filters.tagMode === 'all' ? 'all' : 'any';
    var list = allTags().concat(picked.filter(function (t) { return t.unavailable; }));
    return h('div.tag-filter', {role:'group', 'aria-label':'按标签筛选'},
      h('div.tag-filter__head', null,
        h('span.tag-filter__title', {text:'按标签筛选'}),
        h('div.spacer'),
        ui.btn('收起', {size:'sm', onClick:function () { tagPanelOpen = false; SF.app.renderContent(); }}),
        ui.btn('清除标签筛选', {size:'sm', disabled:!picked.length, onClick:function () { app.filters.tags = []; app.filters.tagMode = 'any'; SF.app.render(); }})),
      tagCache.error ? h('p.field__hint.field__error', {text:'标签目录读取失败：' + tagCache.error.message}) : null,
      !list.length && !tagCache.loading ? h('p.field__hint', {text:'还没有任何标签，先到标签管理里创建后再回来筛选。'}) : null,
      list.length ? h('div.tag-filter__tags', null, list.map(function (t) {
        var on = (app.filters.tags || []).indexOf(t.id) >= 0;
        return h('button.chip.chip--tag' + (on ? '.is-active' : ''), {type:'button', 'aria-pressed':String(on), 'data-tag-filter':t.id,
          title:t.name + (t.unavailable ? '（点击移除筛选）' : t.enabled === false ? '（已停用）' : ''),
          onclick:function () { toggleTagFilter(app, t.id); }},
          SF.tagUi ? SF.tagUi.colorDot(t.color, 8) : null,
          h('span', {text:t.name}),
          h('span.chip__count', {text:String(t.contentCount || 0)}));
      })) : null,
      /* 只选一个标签时两种语义等价，所以少于两个就禁用切换，但文案照实说明当前是哪种。 */
      h('div.tag-filter__mode', null,
        h('div.segment.segment--fill', {role:'group', 'aria-label':'标签筛选方式'},
          [['any','任一符合'],['all','全部符合']].map(function (entry) {
            return h('button.segment__item' + (mode === entry[0] ? '.is-active' : ''), {type:'button', 'aria-pressed':String(mode === entry[0]),
              disabled: picked.length < 2,
              title: picked.length < 2 ? '选择 2 个以上标签后才能区分两种语义' : null,
              onclick:function () { app.filters.tagMode = entry[0]; SF.app.render(); }},
              h('span', {text:entry[1]}));
          })),
        h('p.tag-filter__hint', {'aria-live':'polite', text:tagFilterHint(app)})));
  }

  /** 一句话讲清当前语义。同一个筛选入口下「任一」和「全部」的结果差别很大，不写清楚会默认成前者。 */
  function tagFilterHint(app) {
    var picked = pickedTags(app), names = picked.map(function (t) { return t.name; }).join('、');
    var all = app.filters.tagMode === 'all';
    var text;
    if (!picked.length) text = '当前不按标签筛选：显示符合其余筛选条件的全部内容。';
    else if (picked.length === 1) text = '当前语义：内容带有「' + names + '」即显示（只选一个时两种语义结果相同）。';
    else if (all) text = '当前语义：内容必须同时带有全部 ' + picked.length + ' 个所选标签（' + names + '）才显示。';
    else text = '当前语义：内容带有所选 ' + picked.length + ' 个标签（' + names + '）中的任意一个即显示。';
    return text + '标签筛选可与平台、来源、优先级、处理状态和关键词叠加。';
  }

  /* ---------------- 批量打标 ---------------- */

  /**
   * 与批量优先级同构：工具栏上一个下拉，选完即执行。
   * 语义是「以这批标签整体替换所选内容的标签」，与后端 set_content_tags 的替换语义一致，
   * 因此破坏性比批量优先级更强，先确认再执行。
   */
  function bulkTagControl(app) {
    var tags = enabledTags();
    if (!tags.length) return null;
    var options = [{value:'',label:'批量打标'},{value:BULK_CLEAR,label:'清除全部标签'}].concat(tags.map(function (t) {
      return {value:t.id, label:t.name};
    }));
    return ui.select(options, '', function (value) {
      if (!value) return;
      var ids = Array.from(selected);
      if (ids.length > BULK_LIMIT) {
        ui.toast('批量打标一次最多 ' + BULK_LIMIT + ' 条，当前已选 ' + ids.length + ' 条，请先缩小选择范围。', 'error');
        return;
      }
      var tagIds = value === BULK_CLEAR ? [] : [value];
      var name = tags.filter(function (t) { return t.id === value; })[0];
      ui.confirm({
        title: value === BULK_CLEAR ? '清除所选内容的标签' : '批量打标',
        message: value === BULK_CLEAR
          ? '将清除 ' + ids.length + ' 条内容上的全部标签，此操作不可撤销。'
          : '将把 ' + ids.length + ' 条内容的标签整体替换为「' + (name ? name.name : '') + '」，原有标签会被移除。',
        confirmText: '确认'
      }).then(function (ok) {
        /* 取消时重画一次：下拉框停在刚才的选项上会让人以为已经生效。 */
        if (!ok) { SF.app.renderContent(); return; }
        SF.app.act('bulk', async function () {
          await app.client.bulkSetTags(ids, tagIds);
          selected.clear();
          tagCache = {};
          await SF.app.refreshData(true);
        });
      });
    }, {ariaLabel:'批量打标'});
  }

  /* ---------------- 详情 ---------------- */

  // 想法和公众号文章带的是完整正文，不是简介：按整段换行排版。
  function fullText(item) { return item.kind === 'pin' || item.kind === 'article'; }
  var BODY_LINES = 20;
  /**
   * 正文超过 20 行时先折叠，避免一篇文章把整个右侧详情挤爆。
   * 折叠与否按**挂载后**的高度判断：20 行是触发线，但窄窗口下一行会折行，
   * 真正被截断才显示「展开内容」，不给一个点了没反应的按钮。
   */
  function bodySection(item, whole) {
    var fallback = whole ? '这条内容没有文字正文，可打开原文查看。' : '此内容尚未提供摘要，可补充详情或打开原文。';
    var text = item.summary || fallback;
    var lines = text.split('\n').filter(function (line) { return line.trim(); }).length;
    var section = h('div.detail__section', null,
      h('div.detail__section-title', {text:whole ? (item.kind==='pin' ? '想法正文' : '文章正文') : '内容摘要'}));
    if (!whole || !item.summary || lines <= BODY_LINES) {
      section.appendChild(h('p.detail__summary'+(whole ? '.detail__text' : ''), {text:text}));
      return section;
    }
    var para = h('p.detail__summary.detail__text.is-clamped', {text:text});
    var toggle = h('button.detail__more-btn', {type:'button','aria-expanded':'false',hidden:true});
    var setExpanded = function (value) {
      para.classList.toggle('is-clamped', !value);
      toggle.textContent = value ? '收起内容' : '展开内容';
      toggle.setAttribute('aria-expanded', String(value));
    };
    toggle.addEventListener('click', function () { setExpanded(toggle.getAttribute('aria-expanded') !== 'true'); });
    setExpanded(false);
    // 折行多少与窗口宽度有关，只有挂载后才知道要不要给这个按钮。
    requestAnimationFrame(function () {
      if (!para.isConnected) return;
      if (para.scrollHeight > para.clientHeight + 1) toggle.hidden = false;
      else para.classList.remove('is-clamped');
    });
    section.appendChild(para);
    section.appendChild(h('div.detail__more', null, toggle));
    return section;
  }
  function detailBody(app, item, repaint) {
    var canDetail = item.canFetchDetail !== false && !!item.channelId && app.session.channels.some(function (c) { return c.channel === item.platform && c.operations.get_item_detail && c.operations.get_item_detail.supported; });
    var whole = fullText(item);
    return h('div.detail-preview', null,
      item.cover ? h('div.detail__cover', null, h('img', {src:item.cover, alt:'', referrerPolicy:'no-referrer'})) : null,
      h('h2.detail__title', {text:item.title}),
      h('div.detail__byline', null, ui.avatar(item.channelName, null, 'md'), h('div.detail__byline-text', null,
        h('div.detail__byline-name', null, h('span', {text:item.channelName}), ui.platformTag(item.platform),h('span.tag',{text:item.intakeMethod==='manual'?'手动收录':'自动采集'})), h('div.detail__byline-time', {text:'原始发布 · '+fmt.publication(item)}), item.intakeMethod==='manual' ? h('div.detail__byline-time',{text:fmt.intakeTime(item)+'（本地时间，日历按此时间归档）'}) : null)),
      bodySection(item, whole),
      priorityControls(app,item,repaint),
      tagControls(app, item, repaint),
      h('div.detail__section', null, h('div.detail__section-title', {text:'整理内容（单选）'}),
        h('p.field__hint', {text:'选择一项会取消其他状态，再次点击可取消。'}),
        h('div.op-grid', {role:'group','aria-label':'整理内容（单选）'},
        [['read','已读','check'],['deferred','稍后处理','clock'],['archived','归档','archive']].map(function (entry) {
          return h('button.op-btn', {type:'button', disabled:contentPending(item.id), 'aria-pressed':String(item.state[entry[0]]), onclick:function () {
            var state = {}; state[entry[0]] = !item.state[entry[0]];
            saveContent(app, item, {state:state}, repaint);
          }}, icon(entry[2],18), h('span',{text:entry[1]}));
        }))),
      h('div.detail__section.col', {style:{gap:'12px'}},
        canDetail ? ui.btn('补充详情', {icon:'refresh', onClick:function () { SF.app.act('detail:' + item.id, async function () { await app.client.fetchDetail(item.id); ui.toast('详情任务已创建'); await SF.app.refreshData(true); }); }}) : null,
        ui.btn('打开原文', {variant:'primary', block:true, icon:'external', onClick:function () { SF.app.act('open:' + item.id, function () { return app.client.openContent(item.id); }); }})));
  }
  /* 数据刷新时只丢内容缓存。标签目录不跟着内容刷新失效——它变化极慢，
     每次刷新都重取只会多出一轮异步往返和一次多余重绘。真正该重取的是
     tags.changed 事件，以及本视图自己写入标签之后。 */
  SF.views = SF.views || {};
  SF.views.inbox = {render:render, reset:function () { cache = {}; }, detailBody:detailBody,
    invalidateTags:function () { tagCache = {}; }};
})(window);
