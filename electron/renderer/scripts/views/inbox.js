/* F1 收件箱与详情布局；所有持久化与采集由 AppClient 完成。 */
(function (global) {
  'use strict';
  var SF = global.SF, h = SF.dom.h, ui = SF.ui, fmt = SF.fmt, icon = SF.icon;
  var cache = {}, offset = 0, queryKey = '', selected = new Set();
  function query(app) {
    var q = {limit: 20, offset: offset};
    if (app.filters.quick !== 'all') q.state = app.filters.quick;
    if (app.filters.platform) q.platform = app.filters.platform;
    if (app.filters.channelId) q.channelId = app.filters.channelId;
    if (app.search) q.keyword = app.search;
    if (app.filters.day) { q.from = app.filters.day; q.to = app.filters.day + 'T23:59:59.999999Z'; }
    return q;
  }
  function render(app) {
    var key = JSON.stringify([app.filters, app.search]);
    if (key !== queryKey) { queryKey = key; offset = 0; cache = {}; selected.clear(); }
    if (!cache.loaded && !cache.loading) {
      var current = cache; current.loading = true;
      app.client.listContents(query(app)).then(function (r) {
        if (cache !== current) return;
        if (!r.items.length && offset) {
          offset = 0;
          if (r.total) { cache = {}; SF.app.renderContent(); return; }
        }
        Object.assign(cache, r, {loaded: true, loading: false});
        if (!r.items.some(function (c) { return c.id === app.selectedId; })) app.selectedId = r.items[0] && r.items[0].id;
        selected = new Set(Array.from(selected).filter(function (id) { return r.items.some(function (c) { return c.id === id; }); }));
        SF.app.renderContent();
      }).catch(function (err) { if (cache !== current) return; Object.assign(cache, {loaded: true, loading: false, error: err}); SF.app.renderContent(); });
    }
    var isInbox = app.filters.quick === 'unread';
    var titles = {unread:'收件箱',all:'全部更新',read:'已读',deferred:'稍后处理',archived:'已归档'};
    var descriptions = {unread:'待处理的创作者更新；标记已读、稍后处理或归档后会移出收件箱。',
      all:'查看所有已保存的内容，包括已读、稍后处理和已归档。',read:'已标记为已读的内容。',deferred:'已留待稍后处理的内容。',archived:'已归档的内容。'};
    var head = h('div.view__head', null,
      h('div.view__head-text', null, h('div.view__title', null, h('h1.t-h1', {text:titles[app.filters.quick] || '内容'}), ui.countPill(cache.total == null ? '—' : cache.total, 'brand')),
        h('p.view__desc', {text:descriptions[app.filters.quick] || '按发布时间查看创作者更新。'})),
      h('div.view__actions', null, h('span.muted', {text:'最新发布'}), ui.btn('重新查询', {icon:'refresh', onClick:function () { cache = {}; SF.app.refreshData(true); }})));
    var chips = h('div.inbox__toolbar', null,
      ui.btn('全部', {variant: !app.filters.platform ? 'primary' : 'ghost', onClick:function () { app.filters.platform = null; SF.app.render(); }}),
      app.platforms.map(function (p) { return ui.btn(SF.catalog.platform(p.id).name + ' ' + p.count, {variant: app.filters.platform === p.id ? 'primary' : 'ghost', onClick:function () { app.filters.platform = p.id; SF.app.render(); }}); }),
      app.filters.channelId || app.filters.day ? ui.btn('清除来源 / 日期筛选', {onClick:function () { app.filters.channelId = null; delete app.filters.day; SF.app.render(); }}) : null);
    var body;
    if (cache.error) body = ui.state({icon:'alert', title:'内容读取失败', desc:cache.error.message, actions:[{label:'重试', onClick:function () { cache = {}; SF.app.renderContent(); }}]});
    else if (!cache.loaded) body = ui.skeletonCards(4);
    else if (!cache.items.length) body = ui.state({icon:'inbox', title:isInbox ? '当前没有待处理内容' : '当前没有内容', desc:isInbox ? '添加来源并手动刷新，或在“全部更新”和对应分类中查看已处理内容。' : '添加来源并手动刷新，或清除筛选后查看已保存的内容。', actions:[
      {label:'添加来源', variant:'primary', onClick:function () { SF.app.navigate('channels'); }},
      {label:'清除筛选', onClick:function () { app.filters = {quick:app.filters.quick, platform:null, channelId:null}; app.search = ''; SF.app.render(); }}].concat(isInbox ? [
      {label:'查看全部更新', onClick:function () { app.filters = {quick:'all', platform:null, channelId:null}; app.search = ''; SF.app.render(); }}] : [])});
    else body = h('div.inbox__grid.scroll-y', null, cache.items.map(function (item) {
      return h('div.content-selection', null, ui.check(selected.has(item.id), function () { if (selected.has(item.id)) selected.delete(item.id); else selected.add(item.id); SF.app.renderContent(); }, '选择 ' + item.title),
        ui.contentCard(item, {selected:app.selectedId === item.id, now:app.now,
          onSelect:function () { app.selectedId = item.id; SF.app.renderContent(); },
          onMenu:function (e) { e.stopPropagation(); ui.menu([
            {label:item.state.read ? '标记为未读' : '标记为已读', onClick:function () { update(app, item.id, {read:!item.state.read}); }},
            {label:'打开原文', onClick:function () { SF.app.act('open:' + item.id, function () { return app.client.openContent(item.id); }); }}
          ], e.currentTarget); }}));
    }));
    var bulk = selected.size ? h('div.inbox__toolbar', null, h('span', {text:'已选 ' + selected.size + ' 条'}),
      ['已读', '稍后处理', '归档'].map(function (label, i) { return ui.btn(label, {onClick:function () {
        var ids = Array.from(selected), state = {}; state[['read','deferred','archived'][i]] = true;
        SF.app.act('bulk', async function () { await app.client.bulkUpdate(ids, {state:state}); selected.clear(); await SF.app.refreshData(true); });
      }}); }), ui.btn('取消选择', {onClick:function () { selected.clear(); SF.app.renderContent(); }})) : null;
    var pager = cache.loaded && !cache.error ? h('div.inbox__toolbar', null,
      h('span.muted', {text:'共 ' + cache.total + ' 条 · 第 ' + (Math.floor(offset / 20) + 1) + ' 页'}),
      ui.btn('上一页', {disabled:offset === 0, onClick:function () { offset = Math.max(0, offset - 20); cache = {}; selected.clear(); SF.app.renderContent(); }}),
      ui.btn('下一页', {disabled:cache.next_offset == null, onClick:function () { offset = cache.next_offset; cache = {}; selected.clear(); SF.app.renderContent(); }})) : null;
    var item = cache.items && cache.items.find(function (c) { return c.id === app.selectedId; });
    return {main:h('div.view', {'data-view':'inbox'}, head, h('div.view__body.inbox', null, chips, bulk, body, pager)),
      aside:item && !cache.error ? h('aside.detail', {'aria-label':'内容详情'},
        h('div.detail__head', null, h('span', {text:'内容详情'}), h('div.spacer'), ui.iconBtn('close', '关闭详情', function () { app.selectedId = null; SF.app.renderContent(); })),
        h('div.detail__body.scroll-y', null, detailBody(app, item, function (fresh) { var i = cache.items.findIndex(function (c) { return c.id === fresh.id; }); if (i >= 0) cache.items[i] = fresh; SF.app.renderContent(); }))) : null};
  }
  function update(app, id, state) {
    return SF.app.act('content:' + id, async function () { await app.client.updateContent(id, {state:state}); await SF.app.refreshData(true); });
  }
  function detailBody(app, item, repaint) {
    var canDetail = app.session.channels.some(function (c) { return c.channel === item.platform && c.operations.get_item_detail && c.operations.get_item_detail.supported; });
    return h('div.detail-preview', null,
      item.cover ? h('div.detail__cover', null, h('img', {src:item.cover, alt:'', referrerPolicy:'no-referrer'})) : null,
      h('h2.detail__title', {text:item.title}),
      h('div.detail__byline', null, ui.avatar(item.channelName, null, 'md'), h('div.detail__byline-text', null,
        h('div.detail__byline-name', null, h('span', {text:item.channelName}), ui.platformTag(item.platform)), h('div.detail__byline-time', {text:fmt.publication(item)}))),
      h('div.detail__section', null, h('div.detail__section-title', {text:'内容摘要'}), h('p.detail__summary', {text:item.summary || '此内容尚未提供摘要，可补充详情或打开原文。'})),
      h('div.detail__section', null, h('div.detail__section-title', {text:'整理内容'}), h('div.op-grid', null,
        [['read','已读','check'],['deferred','稍后处理','clock'],['archived','归档','archive']].map(function (entry) {
          return h('button.op-btn', {type:'button', 'aria-pressed':String(item.state[entry[0]]), onclick:function () {
            var state = {}; state[entry[0]] = !item.state[entry[0]];
            SF.app.act('content:' + item.id, async function () { var fresh = await app.client.updateContent(item.id, {state:state}); if (repaint) repaint(fresh); await SF.app.refreshData(true); });
          }}, icon(entry[2],18), h('span',{text:entry[1]}));
        }))),
      h('div.detail__section.col', {style:{gap:'12px'}},
        canDetail ? ui.btn('补充详情', {icon:'refresh', onClick:function () { SF.app.act('detail:' + item.id, async function () { await app.client.fetchDetail(item.id); ui.toast('详情任务已创建'); await SF.app.refreshData(true); }); }}) : null,
        ui.btn('打开原文', {variant:'primary', block:true, icon:'external', onClick:function () { SF.app.act('open:' + item.id, function () { return app.client.openContent(item.id); }); }})));
  }
  SF.views = SF.views || {};
  SF.views.inbox = {render:render, reset:function () { cache = {}; }, detailBody:detailBody};
})(window);
