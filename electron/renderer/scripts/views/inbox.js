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

  function hasReason(reasons, names) {
    return names.some(function (name) { return reasons && (reasons.has ? reasons.has(name) : reasons.indexOf(name) >= 0); });
  }
  function invalidate(reasons) {
    if (!hasReason(reasons, ['all', 'content', 'tags', 'channels'])) return;
    cache.stale = true;
    cache.revision = (cache.revision || 0) + 1;
    if (hasReason(reasons, ['all', 'channels'])) cache.sourcesRequested = false;
    if (hasReason(reasons, ['all', 'tags'])) invalidateTags();
  }
  function invalidateTags() {
    tagCache.stale = true;
    tagCache.revision = (tagCache.revision || 0) + 1;
  }
  function renderView() { SF.app.renderView('inbox'); }
  function identity(app) { return JSON.stringify([app.filters, app.search, reminderView(app)]); }
  function mergeItem(previous, fresh) {
    if (!previous) return fresh;
    Object.keys(previous).forEach(function (key) { if (!(key in fresh)) delete previous[key]; });
    return Object.assign(previous, fresh);
  }
  function whenIdle() {
    var pending = [cache.promise, cache.sourcesPromise, tagCache.promise].filter(Boolean);
    return pending.length ? Promise.all(pending).then(whenIdle) : Promise.resolve();
  }

  /* ---------------- 标签目录 ---------------- */

  /**
   * 取一份标签目录。就绪后回调 done，供「容器自己重画」的场景使用：
   * 详情弹窗被 overview 复用（见 overview.js 的 openDetail），它不受主区域重绘影响，
   * 只能由自己这块 DOM 重新画一次。
   */
  function ensureTags(app, done) {
    if (tagCache.loaded && !tagCache.stale) { if (done) done(); return; }
    tagCache.waiting = tagCache.waiting || [];
    if (tagCache.loading) { if (done) tagCache.waiting.push(done); return; }
    /* 目录拿不到时退化成空列表：内容侧照常可用，只是没有可添加的标签。 */
    if (!app.client || !app.client.listTags) { tagCache = {loaded: true, items: []}; if (done) done(); return; }
    var current = tagCache, revision = current.revision || 0;
    current.loading = true; current.stale = false;
    if (done) current.waiting.push(done);
    function flush() { (current.waiting || []).forEach(function (fn) { try { fn(); } catch (e) {} }); current.waiting = []; }
    current.promise = app.client.listTags({}).then(function (r) {
      if (tagCache !== current) return;
      if ((current.revision || 0) !== revision) { current.stale = true; return; }
      Object.assign(tagCache, r, {loaded: true, loading: false});
      var count = r.total == null ? (r.items || []).length : r.total;
      if (app.tagCount !== count) { app.tagCount = count; SF.app.refreshSidebarCounts(); }
      delete current.error;
      flush();
    }).catch(function (err) {
      if (tagCache !== current) return;
      if ((current.revision || 0) !== revision) { current.stale = true; return; }
      Object.assign(tagCache, {loaded: true, loading: false, error: err});
      if (!current.items) current.items = [];
      flush();
    }).finally(function () {
      current.loading = false; current.promise = null;
      if (current === tagCache) {
        if (current.stale) ensureTags(app);
        renderView();
      }
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

  /**
   * 提醒口径（计划 §4.3）。直接复用 Core 的共享谓词：state=pending 与
   * view=high_unarchived 与 reminder.summary 出自同一段 SQL，页面看到的就是
   * 通知里那两个集合本身。
   */
  function reminderView(app) {
    return app.reminderView === 'high_unarchived' ? 'high_unarchived'
      : app.reminderView === 'pending' ? 'pending' : null;
  }

  function query(app) {
    var q = {limit: 20, offset: offset};
    var view = reminderView(app);
    if (view === 'high_unarchived') {
      // 口径已含「最终优先级为高且未归档」，再叠加其它筛选只会让数字对不上。
      q.view = 'high_unarchived';
      q.state = null;
      return q;
    }
    if (view === 'pending') q.state = 'pending';
    if (app.filters.quick !== 'all' && !view) q.state = app.filters.quick;
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
    var key = identity(app);
    if (key !== queryKey) { queryKey = key; offset = 0; cache = {}; selected.clear(); previousIds = []; selectLast = false; }
    if ((!cache.loaded || cache.stale) && !cache.loading) {
      var current = cache, revision = current.revision || 0, requestOffset = offset;
      current.loading = true; current.stale = false;
      current.promise = app.client.listContents(query(app)).then(function (r) {
        if (cache !== current || identity(app) !== key || offset !== requestOffset) return;
        if ((current.revision || 0) !== revision) { current.stale = true; return; }
        if (!r.items.length && offset) {
          offset = r.total ? Math.floor((r.total - 1) / 20) * 20 : 0;
          selectLast = true;
          if (r.total) { cache = {}; renderView(); return; }
        }
        var hadData = !!current.loaded;
        var previousItems = new Map((current.items || []).map(function (item) { return [item.id, item]; }));
        r.items = r.items.map(function (item) { return mergeItem(previousItems.get(item.id), item); });
        Object.assign(cache, r, {loaded: true, loading: false});
        delete current.error; delete current.refreshError;
        if (app.route.name === 'inbox' && (!hadData || app.selectedId != null) && !r.items.some(function (c) { return c.id === app.selectedId; })) {
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
      }).catch(function (err) {
        if (cache !== current || identity(app) !== key || offset !== requestOffset) return;
        if ((current.revision || 0) !== revision) { current.stale = true; return; }
        if (current.loaded) current.refreshError = err;
        else { current.loaded = true; current.error = err; }
      }).finally(function () {
        current.loading = false; current.promise = null;
        if (cache === current && identity(app) === key && offset === requestOffset) renderView();
      });
    }
    /* 目录就绪后只重画真正依赖它的地方：筛选面板开着才需要整块重画，
       详情里的编辑器自己 repaint。目录到达不该把用户正在操作的 DOM 整页换掉——
       那会让进行中的点击落空，也让读屏焦点丢失。 */
    if (!tagCache.loaded || tagCache.stale) ensureTags(app);
    var isInbox = app.filters.quick === 'unread';
    var titles = {unread:'收件箱',all:'全部更新',read:'已读',deferred:'稍后处理',archived:'已归档'};
    var descriptions = {unread:'待处理的创作者更新；标记已读、稍后处理或归档后会移出收件箱。',
      all:'查看所有已保存的内容，包括已读、稍后处理和已归档。',read:'已标记为已读的内容。',deferred:'已留待稍后处理的内容。',archived:'已归档的内容。'};
    /* 提醒口径切换：两个集合与通知里的数字同源，可以直接对照。 */
    var view = reminderView(app);
    /* M20：提醒口径里点名的「高」按当前显示名走，改名后口径名称跟着变。 */
    var highName = SF.catalog.priority('high').name;
    var viewToggle = h('div.chips.chips--views', {role:'group', 'aria-label':'提醒口径'}, [
      {id:'pending', label:'未处理', hint:'收件箱与稍后处理的并集，不含已读与已归档'},
      {id:'high_unarchived', label:highName + '未归档', hint:'最终优先级为「' + highName + '」且未归档，包含已读内容'},
    ].map(function (item) {
      var active = view === item.id;
      return ui.btn(item.label, {
        variant: active ? 'primary' : undefined,
        title: item.hint,
        'aria-pressed': active ? 'true' : 'false',
        onClick: function () {
          SF.app.openReminderView(app, item.id);
        },
      });
    }));
    if (!view) viewToggle = null;
    var head = h('div.view__head', {'data-refresh-key':'inbox-head'},
      h('div.view__head-text', null,
        h('div.view__title', null,
          h('h1.t-h1', {text: view ? (view === 'pending' ? '未处理' : highName + '未归档') : (titles[app.filters.quick] || '内容')}),
          ui.countPill(cache.total == null ? '—' : cache.total, 'brand')),
        h('p.view__desc', {text: view
          ? (view === 'pending' ? '收件箱与稍后处理的并集；已读与已归档不计入。与提醒里的「未处理」数字同源。'
                                : '最终优先级为「' + highName + '」且尚未归档的内容，包含已读内容。与提醒里的「' + highName + '未归档」数字同源。')
          : (descriptions[app.filters.quick] || '按日期查看收录的内容。')}),
        viewToggle),
      /* 「静流」§主界面：动作按「信息 → 次级操作 → 主操作」排，
         橙色主操作每屏只出现一次，放在最右。 */
      h('div.view__actions', null,
        h('span.muted', {text:'按日历时间排列'}),
        ui.btn('重新查询', {icon:'refresh', onClick:function () { invalidate(['content']); SF.app.refreshData(true); }}),
        ui.btn('添加内容', {variant:'primary', icon:'plus', disabled:!app.session.capabilities.canIntake,
          title: app.session.capabilities.canIntake ? '粘贴链接收录单条内容' : '当前渠道尚未支持单条链接收录',
          onClick:function () { SF.intakeDialog.open(app); }})));
    var chips = h('div.inbox__toolbar', {'data-refresh-key':'inbox-filters'},
      /* 「静流」§落地改动清单 4：平台筛选用分段控件（凹槽 + 浮起滑块），
         每一段带平台方块和计数，不再是一排药丸按钮。 */
      ui.seg(
        [{value:'',label:'全部',count:app.counts.total || 0}].concat(app.platforms.map(function (p) {
          return {
            value: p.id,
            /* 方案样张里平台筛选写的是「公众号」而不是「微信公众号」——
               用短名，分段控件才不会把筛选条撑到换行。 */
            label: SF.catalog.platform(p.id).short || SF.catalog.platform(p.id).name,
            count: p.count || 0,
            node: ui.platformIcon(p.id, {className:'plat--sm', decorative:true}),
          };
        })),
        app.filters.platform || '',
        function (value) { app.filters.platform = value || null; SF.app.render(); },
        {ariaLabel:'按平台筛选', role:'group'}),
      /* 分段控件与下拉之间一条细竖线：把「切换维度」和「筛选条件」分开。 */
      h('span.filters__sep', {'aria-hidden':'true'}));
    if (app.filters.channelId || app.filters.sourceId || app.filters.day) {
      chips.appendChild(ui.btn('清除来源 / 日期筛选', {onClick:function () { app.filters.channelId = null; app.filters.sourceId = null; delete app.filters.day; SF.app.render(); }}));
    }
    chips.appendChild(ui.dropdown([{value:'',label:'全部优先级'}].concat(['high','medium','low','none'].map(function(id) { return {value:id,label:SF.catalog.priority(id).name}; })), app.filters.priority || '', function(value) { app.filters.priority=value || null; SF.app.render(); }, {ariaLabel:'筛选优先级'}));
    if (!cache.sourcesRequested && !cache.sourcesPromise) {
      var sourceOwner=cache; sourceOwner.sourcesRequested=true;
      sourceOwner.sourcesPromise = app.client.listContentSources({}).then(function(r) {if(cache===sourceOwner) {sourceOwner.sources=r.items; delete sourceOwner.sourcesError; renderView();}})
        .catch(function(err) {if(cache===sourceOwner) {sourceOwner.sourcesError=err; renderView();}})
        .finally(function () { sourceOwner.sourcesPromise = null; if (cache === sourceOwner && !sourceOwner.sourcesRequested) renderView(); });
    }
    chips.appendChild(ui.dropdown([{value:'',label:'全部来源'}].concat((cache.sources||[]).map(function(s) {return {value:s.id,label:s.name};})), app.filters.sourceId||'',function(v) {app.filters.sourceId=v||null;app.filters.channelId=null;SF.app.render();},{ariaLabel:'筛选来源'}));
    chips.appendChild(ui.dropdown([{value:'',label:'全部收录方式'},{value:'subscription',label:'自动采集'},{value:'manual',label:'手动收录'}],app.filters.intakeMethod||'',function(v) {app.filters.intakeMethod=v||null;SF.app.render();},{ariaLabel:'筛选收录方式'}));
    if(cache.sourcesError) chips.appendChild(ui.btn('重试来源筛选',{size:'sm',title:cache.sourcesError.message,onClick:function() {cache.sourcesRequested=false;cache.sourcesError=null;SF.app.renderContent();}}));
    /* 标签筛选入口紧跟优先级，和其它筛选项同属一条工具栏；面板展开时插在工具栏下方。 */
    var picked = pickedTags(app);
    chips.appendChild(ui.selectBtn('标签' + (picked.length ? ' · ' + picked.length : ''), {icon:'tag', arrow:false, onClick:function () { tagPanelOpen = !tagPanelOpen; SF.app.renderContent(); }}));
    var tagPanel = tagPanelOpen ? tagFilterPanel(app) : null;
    var body;
    if (cache.error) body = ui.state({icon:'alert', title:'内容读取失败', desc:cache.error.message, actions:[{label:'重试', onClick:function () { cache = {}; SF.app.renderContent(); }}]});
    else if (!cache.loaded) body = ui.skeletonCards(4);
    else if (!cache.items.length) body = ui.state({icon:'inbox', title:isInbox ? '当前没有待处理内容' : '当前没有内容', desc:isInbox ? '添加来源并手动刷新，或在“全部更新”和对应分类中查看已处理内容。' : '添加来源并手动刷新，或清除筛选后查看已保存的内容。', actions:[
      {label:'添加来源', variant:'primary', onClick:function () { SF.app.navigate('channels'); }},
      {label:'清除筛选', onClick:function () { app.filters = {quick:app.filters.quick, platform:null, channelId:null}; app.search = ''; SF.app.render(); }}].concat(isInbox ? [
      {label:'查看全部更新', onClick:function () { app.filters = {quick:'all', platform:null, channelId:null}; app.search = ''; SF.app.render(); }}] : [])});
    else body = h('div.inbox__grid.scroll-y', {'data-scroll-key':'contents:' + offset,'data-refresh-key':'contents:' + offset}, cache.items.map(function (item) {
      var isCurrent = app.selectedId === item.id;
      return h('div.content-selection' + (isCurrent ? '.is-selected' : ''), {'data-refresh-key':'content-selection:' + item.id}, ui.check(selected.has(item.id), function () { if (selected.has(item.id)) selected.delete(item.id); else selected.add(item.id); SF.app.renderContent(); }, '选择 ' + item.title),
        withTags(ui.contentCard(item, {selected:isCurrent, now:app.now,
          onSelect:function () { app.selectedId = item.id; SF.app.renderContent(); },
          onMenu:function (e) { e.stopPropagation(); ui.menu([
            {label:item.state.read ? '标记为未读' : '标记为已读', onClick:function () { update(app, item.id, {read:!item.state.read}); }},
            {label:'打开原文', onClick:function () { SF.app.act('open:' + item.id, function () { return app.client.openContent(item.id); }); }}
          ], e.currentTarget); }}), item));
    }));
    var bulk = selected.size ? h('div.inbox__toolbar', {'data-refresh-key':'inbox-bulk'}, h('span', {text:'已选 ' + selected.size + ' 条'}),
      ['已读', '稍后处理', '归档'].map(function (label, i) { return ui.btn(label, {onClick:function () {
        var ids = Array.from(selected), state = {}; state[['read','deferred','archived'][i]] = true;
        SF.app.act('bulk', async function () { await app.client.bulkUpdate(ids, {state:state}); selected.clear(); await SF.app.refreshData(true); });
      }}); }), ui.select([{value:'',label:'批量设置优先级'},{value:'inherit',label:'恢复跟随来源'}].concat(SF.catalog.PRIORITY_ORDER.map(function(id) { return {value:id,label:SF.catalog.priority(id).name}; })), '', function(value) { if (!value) return; var ids=Array.from(selected); SF.app.act('bulk',async function() { await app.client.bulkUpdate(ids,{priority:value==='inherit' ? null : value}); selected.clear(); await SF.app.refreshData(true); }); },{ariaLabel:'批量设置优先级'}), bulkTagControl(app), ui.btn('取消选择', {onClick:function () { selected.clear(); SF.app.renderContent(); }})) : null;
    var pager = cache.loaded && !cache.error ? h('div.pager', {'data-refresh-key':'inbox-pager'},
      h('span.pager__count', null, '共 ', h('span.num', {text:String(cache.total)}), ' 条 · 第 ', h('span.num', {text:String(Math.floor(offset / 20) + 1)}), ' 页'),
      ui.btn('上一页', {variant:'ghost', size:'sm', disabled:offset === 0, onClick:function () { offset = Math.max(0, offset - 20); cache = {}; previousIds = []; selectLast = false; selected.clear(); SF.app.renderContent(); }}),
      ui.btn('下一页', {variant:'secondary', size:'sm', disabled:cache.next_offset == null, onClick:function () { offset = cache.next_offset; cache = {}; previousIds = []; selectLast = false; selected.clear(); SF.app.renderContent(); }})) : null;
    var item = cache.items && cache.items.find(function (c) { return c.id === app.selectedId; });
    /* 「静流」§详情面板：标题行右侧是位置读数与上一条 / 下一条 / 关闭。 */
    var listItems = cache.items || [];
    var listIndex = item ? listItems.findIndex(function (c) { return c.id === item.id; }) : -1;
    var step = function (delta) {
      var next = listItems[listIndex + delta];
      if (!next) return;
      app.selectedId = next.id;
      SF.app.renderContent();
    };
    var detailHead = h('div.detail__head', null,
      h('b', {text:'内容详情'}),
      listIndex >= 0 ? h('span.detail__counter', {text:(listIndex + 1) + ' / ' + listItems.length}) : null,
      h('div.detail__pager', null,
        ui.iconBtn('chevron-left', '上一条', function () { step(-1); }, {disabled: listIndex <= 0}),
        ui.iconBtn('chevron-right', '下一条', function () { step(1); }, {disabled: listIndex < 0 || listIndex >= listItems.length - 1}),
        ui.iconBtn('close', '关闭详情', function () { closeDetail(app); })));
    return {main:h('div.view', {'data-view':'inbox','data-refresh-key':'inbox:' + key + ':' + offset}, head, h('div.view__body.inbox', {'data-refresh-key':'inbox-body'}, chips, tagPanel, bulk,
      cache.refreshError ? h('p.field__error', {role:'status','data-refresh-key':'inbox-refresh-error',text:'更新失败，正在显示已加载内容：' + cache.refreshError.message}) : null, body, pager)),
      aside:item && !cache.error ? h('aside.detail', {'aria-label':'内容详情','data-refresh-key':'detail:' + item.id},
        detailHead,
        h('div.detail__body.scroll-y', {'data-scroll-key':'detail:' + item.id}, detailBody(app, item, function (fresh, settled) { repaintContent(app, fresh, settled); })),
        detailFoot(app, item, function (fresh, settled) { repaintContent(app, fresh, settled); })) : null};
  }
  /**
   * 关闭内容详情。笔记里还有没保存的文字时，先问保存还是放弃：
   * 不让用户以为关掉详情就等于丢掉了刚写的东西。
   */
  function closeDetail(app) {
    var itemId = app.selectedId;
    if (SF.noteUi && SF.noteUi.hasDirty(itemId)) {
      SF.noteUi.confirmLeave(app, itemId).then(function (proceed) {
        if (!proceed) return;
        app.selectedId = null;
        SF.app.renderContent();
      });
      return;
    }
    app.selectedId = null;
    SF.app.renderContent();
  }
  function repaintContent(app, fresh, settled) {
    // 写入等待期间列表可能失效或离开此页，迟到回执不能访问已清空的缓存。
    var index = (cache.items || []).findIndex(function (item) { return item.id === fresh.id; });
    if (index >= 0 && !settled) mergeItem(cache.items[index], fresh);
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
    /* 「静流」§组件样张的 .tag.more：卡片横向只放得下一个标签，
       其余收成「+N」——完整标签在详情面板里看。
       硬塞会把标签块挤成半个字，反而看不清。 */
    var shown = tags.slice(0, 1);
    shown.forEach(function (t) {
      slot.appendChild(chip(t, {compact: true, title: t.origin === 'suggested' ? t.name + ' · 识别建议，未经确认' : t.name}));
    });
    if (tags.length > shown.length) {
      var more = h('span.tag-chip.tag-chip--more', {
        title: tags.slice(shown.length).map(function (t) { return t.name; }).join('、'),
        text: '+' + (tags.length - shown.length),
      });
      slot.appendChild(more);
    }
    return card;
  }

  /* ---------------- 详情里的标签编辑器 ---------------- */

  /* 详情读数条。
   5.1 期（M32）：本期用**假数据**把读数条的版式与信息密度定下来，
   真实取数（contents.first_seen_at / acquisition_complete / tagging_tasks）
   在 5.2 期接入。
   假数据必须显式标注为「示例」，不能让用户误以为是真实采集数据。
   规则全部由 fx.css 的 [data-fx="on"] 控制，关闭效果时整条不显示。 */
  function readoutBar() {
    /* 「静流」§轻科幻层 4：读数条一行放得下，字段名短、取值紧。
       真实取数（contents.first_seen_at / acquisition_complete / tagging_tasks）
       仍在 5.2 期接；在此之前这行是版式示例，必须带「示例数据」标记。 */
    var rows = [
      { key: '采集', val: '09:14' },
      { key: '详情', val: '正文已采集' },
      { key: 'AI 打标', val: '3 个' },
    ];
    return h(
      'div.fx-readout',
      { 'data-fx-readout': 'demo' },
      rows.map(function (r) {
        return h('span.fx-readout__item', null,
          h('span.fx-readout__key', { text: r.key }),
          h('span.fx-readout__val', { text: r.val }));
      }),
      h('span.fx-readout__demo', { text: '示例数据' })
    );
  }

  function priorityControls(app,item,repaint) {
    /* 「静流」§5：优先级三张卡片 + 「跟随来源」合并为一个四段控件。
       段里只放固定等级字（高 / 中 / 低）——用户自定义的显示名可能很长
       （例如「开箱即用的项目_教程」），直接放进分段会把控件挤爆；
       完整名字放到标题行的提示里，悬停分段也能看到全名。 */
    var current = SF.catalog.priority(item.priority);
    var options = SF.catalog.PRIORITY_ORDER.map(function(id) {
      var meta = SF.catalog.priority(id);
      return {id:id, short:meta.short, name:meta.name};
    });
    options.unshift({id:'inherit', short:'跟随来源', name:'跟随来源'});
    return h('div.detail__section',{'data-refresh-key':'priority:' + item.id,'data-refresh-boundary':true,
      'data-refresh-preserve':JSON.stringify([item.priority, item.priorityOverride, contentPending(item.id)])},
      h('div.detail__section-title', null,
        h('span', {text:'优先级'}),
        /* 提示里用完整显示名：用户改过名（「开箱即用的项目_教程」）时，
           这里能看出当前到底是哪一档；太长由 CSS 省略。 */
        h('span.detail__section-hint', {text:(item.priorityOverride ? '已单独设置' : '跟随来源') + ' · 当前为' + current.name})),
      h('div.priority-grid',{'aria-label':'内容优先级'}, options.map(function(opt) {
        var active = opt.id==='inherit' ? !item.priorityOverride : item.priorityOverride===opt.id;
        var disabled = contentPending(item.id) || (opt.id==='inherit' && !item.priorityOverride);
        return h('button.priority-opt.priority-opt--'+(opt.id==='inherit'?'inherit':opt.id)+(active?'.is-active':''),
          {type:'button',disabled:disabled,'aria-pressed':String(active),title:opt.name,onclick:function() { save(opt.id==='inherit'?null:opt.id); }},
          opt.id==='inherit' ? null : ui.prioSig(opt.id),
          h('span.priority-opt__name',{text:opt.short}));
      })));
    function save(priority) {
      saveContent(app, item, {priority:priority}, repaint);
    }
  }

  function tagControls(app, item, repaint) {
    var box = h('div.detail__section', {'data-refresh-key':'tags:' + item.id,'data-refresh-boundary':true,
      'data-refresh-preserve':JSON.stringify([item.tags, tagCache.items, tagCache.loaded, tagCache.error && tagCache.error.message])});
    function paint() {
      while (box.firstChild) box.removeChild(box.firstChild);
      var tags = item.tags || [];
      var suggested = tags.some(function (t) { return t.origin === 'suggested'; });
      /* 「静流」§5：分节标题右侧是「AI 识别 N · 手动 M」的读数，
         颜色与字重都比标题弱一档，不与标题抢层级。 */
      var suggestedCount = tags.filter(function (t) { return t.origin === 'suggested'; }).length;
      box.appendChild(h('div.detail__section-title', null,
        h('span', {text:'标签'}),
        h('span.detail__section-hint', {text:'AI 识别 ' + suggestedCount + ' · 手动 ' + (tags.length - suggestedCount)})));
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
    if (!tagCache.loaded || tagCache.stale) ensureTags(app, function () { if (box.isConnected) paint(); });
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
    return h('div.tag-filter', {role:'group', 'aria-label':'按标签筛选','data-refresh-key':'inbox-tag-filters'},
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
    section.setAttribute('data-refresh-key', 'body:' + item.id);
    section.setAttribute('data-refresh-boundary', '');
    section.setAttribute('data-refresh-preserve', JSON.stringify([item.kind, item.summary]));
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
  /**
   * 详情作者行的时间：「原始发布 · 2026-10-11 10:00（Asia/Tokyo）」。
   * 不直接用 fmt.publication —— 那是给表格用的完整 ISO，
   * 放进 400px 的详情栏会顶出一行。
   */
  function publicationLine(item) {
    var heading = fmt.publicationHeading(item);
    var raw = item.publishedAt ? String(item.publishedAt) : '';
    var day = raw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return heading;
    var time = raw.slice(11, 16);
    var zone = item.publishedTimezone ? '（' + item.publishedTimezone + '）' : '';
    return heading + ' · ' + day + (/^\d{2}:\d{2}$/.test(time) ? ' ' + time : '') + zone;
  }

  /** 原文链接行里的短标识：取 URL 最后一段（BV 号、仓库名等）。 */
  function shortKey(item) {
    var url = String(item.url || '').split('?')[0].split('#')[0];
    var parts = url.replace(/^https?:\/\//, '').split('/').filter(Boolean);
    var last = parts.length ? parts[parts.length - 1] : url;
    return last.length > 26 ? last.slice(0, 26) + '…' : last;
  }

  /**
   * 详情顶图。「静流」§4：176px 高的取景框，右下角一行等宽读数，
   * 轻科幻层在图上叠一层取景框角标。数据来自这条内容本身，不编造。
   */
  function detailHero(item) {
    var platform = SF.catalog.platform(item.platform);
    var manual = item.intakeMethod === 'manual';
    return h('div.detail__hero' + (item.cover ? '' : '.detail__hero--empty'), null,
      item.cover ? h('img', {src:item.cover, alt:'', referrerPolicy:'no-referrer'}) : null,
      item.cover ? null : h('span.detail__hero-mark', {'aria-hidden':'true'}, icon('mountain', 96)),
      h('span.detail__hud', {'aria-hidden':'true'}),
      h('div.detail__readout', null,
        h('span' + (manual ? '' : '.is-live'), {text: manual ? '手动收录' : '已收录'}),
        h('span', {text: platform.name + ' · ' + shortKey(item)})));
  }

  /** 原文区：一条可点的链接行，点开即用系统浏览器打开。 */
  function linkSection(app, item) {
    return h('div.detail__section', null,
      h('div.detail__section-title', {text:'原文'}),
      h('button.detail__link-row', {
        type:'button', title:item.url,
        onclick:function () { SF.app.act('open:' + item.id, function () { return app.client.openContent(item.id); }); }},
        icon('link', 15),
        h('span.mono', {text:item.url}),
        icon('external', 15)));
  }

  function detailBody(app, item, repaint) {
    var whole = fullText(item);
    return h('div.detail-preview', null,
      detailHero(item),
      h('h2.detail__title', {text:item.title}),
      h('div.detail__byline', null, ui.avatar(item.channelName, null, 'md'), h('div.detail__byline-text', null,
        h('div.detail__byline-name', null, h('span', {text:item.channelName}), ui.platformTag(item.platform)),
        h('div.detail__byline-time', {text:publicationLine(item)+' · '+(item.intakeMethod==='manual'?'手动收录':'自动采集')}),
        item.intakeMethod==='manual' ? h('div.detail__byline-time',{text:fmt.intakeTime(item)+'（本地时间，日历按此时间归档）'}) : null)),
      readoutBar(),
      bodySection(item, whole),
      priorityControls(app,item,repaint),
      tagControls(app, item, repaint),
      linkSection(app, item),
      // M27：留下点什么。写在处理状态之后——
      // 它是用户自己的东西，和「打开原文」这类内容动作不是一回事。
      SF.noteUi ? SF.noteUi.noteEditor({
        itemId: item.id, item: item, client: app.client,
        // 结构变了要重画详情：重画整个视图，草稿在模块状态里，不会丢。
        repaint: function () { renderView(); },
        // 存好或删掉之后，内容列表的「有笔记」记号要跟着更新。
        onChanged: function () { SF.app.refreshData(true); },
      }) : null);
  }

  /**
   * 详情面板底部的固定操作条。
   *
   * 「静流」§5：已读／稍后／归档与「打开原文」固定在底部，
   * 滚动正文时它们一直可见。三个状态键是等分的一排图标按钮，
   * 「打开原文」用墨色——橙色主操作留给「保存」这类真主操作。
   */
  function detailFoot(app, item, repaint) {
    var canDetail = item.canFetchDetail !== false && !!item.channelId && app.session.channels.some(function (c) { return c.channel === item.platform && c.operations.get_item_detail && c.operations.get_item_detail.supported; });
    var states = [['read','已读','check'],['deferred','稍后','clock'],['archived','归档','archive']];
    return h('div.action-bar', {role:'group','aria-label':'内容操作'},
      h('div.state-group', null, states.map(function (entry) {
        return h('button.state-btn' + (item.state[entry[0]] ? '.is-on' : ''), {
          type:'button',
          disabled: contentPending(item.id),
          'aria-pressed': String(!!item.state[entry[0]]),
          onclick: function () {
            var state = {}; state[entry[0]] = !item.state[entry[0]];
            saveContent(app, item, {state:state}, repaint);
          },
        }, icon(entry[2],16), h('span',{text:entry[1]}));
      })),
      canDetail ? ui.btn('补充详情', {icon:'refresh', onClick:function () { SF.app.act('detail:' + item.id, async function () { await app.client.fetchDetail(item.id); ui.toast('详情任务已创建'); await SF.app.refreshData(true); }); }}) : null,
      ui.btn('打开原文', {variant:'ink', block:true, icon:'external', onClick:function () { SF.app.act('open:' + item.id, function () { return app.client.openContent(item.id); }); }}));
  }
  /* 数据刷新时只丢内容缓存。标签目录不跟着内容刷新失效——它变化极慢，
     每次刷新都重取只会多出一轮异步往返和一次多余重绘。真正该重取的是
     tags.changed 事件，以及本视图自己写入标签之后。 */
  SF.views = SF.views || {};
  /**
   * 离开页面前的确认：当前内容里的笔记还有未保存的文字时问一句。
   * 与设置页、识别设置同一套原则。
   */
  function confirmLeave(app) {
    var itemId = app.selectedId;
    if (!SF.noteUi || !SF.noteUi.hasDirty(itemId)) return Promise.resolve(true);
    return SF.noteUi.confirmLeave(app, itemId);
  }

  /** 当前详情里的笔记有没有未保存的文字（导航前先问一句）。 */
  function hasNoteDraft() {
    // 模块作用域里没有 app：状态对象在 SF.app.state 上。
    return !!(SF.noteUi && SF.noteUi.hasDirty(SF.app.state.selectedId));
  }

  SF.views.inbox = {render:render, reset:function () { cache = {}; }, invalidate:invalidate,
    whenIdle:whenIdle, detailBody:detailBody, invalidateTags:invalidateTags, confirmLeave:confirmLeave,
    hasNoteDraft:hasNoteDraft};
})(window);
