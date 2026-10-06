/* ==========================================================================
   视图：内容总览
   日历模式：按天回顾更新节奏与当日内容。
   优先级模式：按重要程度分栏处理。
   ========================================================================== */
(function (global) {
  "use strict";

  var SF = (global.SF = global.SF || {});
  var h = SF.dom.h;
  var ui = SF.ui;
  var icon = SF.icon;
  var fmt = SF.fmt;
  var catalog = SF.catalog;

  var cache = {}, queryKey = '';
  function monthDate(app) { return new Date(app.calendarMonth + '-01T00:00:00'); }
  function load(app, more) {
    var current = cache; current.loading = true; current.error = null;
    var month = monthDate(app), last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    var query = {limit:100, offset:more ? current.next_offset : 0, from:app.calendarMonth + '-01', to:fmt.ymd(last) + 'T23:59:59.999999Z'};
    if (app.filters.priority) query.priority = app.filters.priority;
    if (app.filters.platform) query.platform = app.filters.platform;
    if (app.filters.channelId) query.channelId = app.filters.channelId;
    if (app.filters.quick !== 'all') query.state = app.filters.quick;
    if (app.search) query.keyword = app.search;
    app.client.listContents(query).then(function (result) {
      if (cache !== current) return;
      cache.items = more ? cache.items.concat(result.items.filter(function (item) { return !cache.items.some(function (prior) { return prior.id === item.id; }); })) : result.items;
      cache.total = result.total; cache.next_offset = result.next_offset; cache.loading = false; cache.loaded = true;
      SF.app.renderContent();
    }).catch(function (err) { if (cache !== current) return; cache.loading = false; cache.loaded = true; cache.error = err; SF.app.renderContent(); });
  }
  function render(app) {
    if (app.overviewMode === 'priority') return renderPriorities(app);
    if (!app.calendarMonth) app.calendarMonth = fmt.ymd(app.now).slice(0,7);
    var key = JSON.stringify([app.calendarMonth, app.filters, app.search]);
    if (key !== queryKey) { queryKey = key; cache = {}; }
    if (!cache.loaded && !cache.loading) load(app, false);
    var el = h('div.view', {'data-view':'overview'});
    SF.dom.append(el, [buildHead(app), buildStats(app), h('div.view__body', null, buildBody(app)),
      h('div.inbox__toolbar', null, h('span.muted', {text:'按来源日期归入日历；未知时间的内容请到收件箱查看。'}),
        cache.next_offset != null ? ui.btn(cache.loading ? '正在加载…' : '加载更多本月内容', {disabled:cache.loading, onClick:function () { load(app,true); SF.app.renderContent(); }}) : null)]);
    return el;
  }

  function buildHead(app) {
    var modes = h(
      "div.overview__modes",
      { role: "tablist", "aria-label": "浏览模式" },
      h(
        "button.segment__item" + (app.overviewMode === "calendar" ? ".is-active" : ""),
        { type: "button", role: "tab", "aria-selected": app.overviewMode === "calendar" ? "true" : "false", onclick: function () { SF.app.navigate("overview", { mode: "calendar" }); } },
        icon("calendar", 16),
        h("span", { text: "日历模式" })
      ),
      h(
        "button.segment__item" + (app.overviewMode === "priority" ? ".is-active" : ""),
        { type: 'button', role: 'tab', 'aria-selected':String(app.overviewMode==='priority'), onclick:function() { SF.app.navigate('overview',{mode:'priority'}); } },
        icon("priority", 16),
        h("span", { text: "优先级模式" })
      )
    );

    return h(
      "div.view__head",
      null,
      h(
        "div.view__head-text",
        null,
        h("h1", { class: "t-h1", text: "内容总览" }),
        h("p.view__desc", { text: "按日期回顾更新，或按优先级安排阅读。" })
      ),
      h("div.view__actions", null, modes)
    );
  }

  function buildStats(app) {
    var items = cache.items || [];
    return h('div.overview__filters', null, h('div.stat-row.grow', null,
      ui.stat({value:cache.total == null ? '—' : cache.total, label:'本月匹配内容', icon:'file-text', tone:'brand'}),
      ui.stat({value:items.length, label:'已载入', icon:'check', tone:'brand'}),
      ui.stat({value:items.filter(function(c) { return !c.state.read; }).length, label:'已载入未读', icon:'inbox', tone:'mid'}),
      ui.stat({value:items.filter(function(c) { return c.state.deferred; }).length, label:'已载入稍后处理', icon:'clock', tone:'low'})));
  }
  function buildBody(app) {
    if (cache.error) return ui.state({icon:'alert',title:'内容读取失败',desc:cache.error.message,actions:[{label:'重试',onClick:function () { cache = {}; SF.app.renderContent(); }}]});
    if (!cache.loaded) return ui.state({icon:'clock',title:'正在载入内容…'});
    return buildCalendar(app);
  }

  var board={}, boardKey='';
  var levels=['high','medium','low','none'];
  function boardQuery(app) {
    var q={limit:20};
    if(app.filters.quick!=='all') q.state=app.filters.quick;
    if(app.filters.platform) q.platform=app.filters.platform;
    if(app.filters.channelId) q.channelId=app.filters.channelId;
    if(app.search) q.keyword=app.search;
    if(app.filters.day) { q.from=app.filters.day; q.to=app.filters.day+'T23:59:59.999999Z'; }
    return q;
  }
  function loadGroup(app,id,more) {
    var owner=board, group=board[id] || (board[id]={});
    group.loading=true; group.error=null;
    app.client.listContents(Object.assign(boardQuery(app),{priority:id,offset:more?group.next_offset:0})).then(function(result) {
      if(board!==owner || board[id]!==group) return;
      group.items=more ? group.items.concat(result.items.filter(function(item) { return !group.items.some(function(old) { return old.id===item.id; }); })) : result.items;
      group.total=result.total; group.next_offset=result.next_offset; group.loaded=true; group.loading=false;
      SF.app.renderContent();
    }).catch(function(err) { if(board!==owner || board[id]!==group) return; group.loading=false; group.loaded=true; group.error=err; SF.app.renderContent(); });
  }
  function renderPriorities(app) {
    var key=JSON.stringify([boardQuery(app),app.filters.priority]);
    if(key!==boardKey) { boardKey=key; board={}; }
    levels.forEach(function(id) { if(!board[id] || (!board[id].loaded && !board[id].loading)) loadGroup(app,id,false); });
    if(!board.sourcesRequested) {
      var owner=board; board.sourcesRequested=true;
      app.client.listChannels({}).then(function(r) { if(board===owner) { board.sources=r.items; SF.app.renderContent(); } }).catch(function(err) { if(board===owner) { board.sourcesError=err.message; SF.app.renderContent(); } });
    }
    var shown=app.filters.priority ? [app.filters.priority] : catalog.PRIORITY_ORDER;
    var stats=h('div.overview__filters',null,h('div.stat-row.grow',null,levels.map(function(id) {
      var group=board[id], meta=catalog.priority(id);
      return ui.stat({value:group && group.total!=null && !group.error?group.total:'—',label:meta.name,icon:meta.icon,tone:id==='medium'?'mid':id==='none'?'brand':id});
    })));
    var filters=h('div.inbox__toolbar.priority-filters',null,
      ui.select([{value:'',label:'全部平台'}].concat(app.platforms.map(function(p) { return {value:p.id,label:catalog.platform(p.id).name}; })),app.filters.platform||'',function(v) { app.filters.platform=v||null; SF.app.render(); },{ariaLabel:'看板平台'}),
      ui.select([{value:'',label:'全部来源'}].concat((board.sources||[]).map(function(c) { return {value:c.id,label:c.name}; })),app.filters.channelId||'',function(v) { app.filters.channelId=v||null; SF.app.renderContent(); },{ariaLabel:'看板来源'}),
      ui.select([{value:'all',label:'全部处理状态'},{value:'unread',label:'未处理'},{value:'read',label:'已读'},{value:'deferred',label:'稍后处理'},{value:'archived',label:'已归档'}],app.filters.quick,function(v) { app.filters.quick=v; SF.app.render(); },{ariaLabel:'看板处理状态'}),
      h('label.priority-date',null,h('span',{text:'发布日期'}),h('input.input',{type:'date','aria-label':'看板发布日期',value:app.filters.day||'',onchange:function(e) { app.filters.day=e.target.value || null; SF.app.renderContent(); }})),
      ui.select([{value:'',label:'高 / 中 / 低'}].concat(levels.map(function(id) { return {value:id,label:catalog.priority(id).name}; })),app.filters.priority||'',function(v) { app.filters.priority=v||null; SF.app.render(); },{ariaLabel:'看板优先级'}),
      ui.btn('重置筛选',{onClick:function() { app.filters={quick:'all',platform:null,channelId:null}; app.search=''; SF.app.render(); }}),
      ui.btn('设置来源优先级',{onClick:function() { SF.app.navigate('channels',{tab:'priorities'}); }}));
    var unknown=board.none;
    return h('div.view',{'data-view':'overview'},buildHead(app),stats,filters,
      board.sourcesError ? h('p.field__error',{role:'alert',text:'来源筛选读取失败：'+board.sourcesError}) : null,
      h('div.priority-scope',null,h('span.muted',{text:'统计当前条件下的全部匹配内容；每栏按最新发布排列并独立加载。'}),
        ui.btn('未设置 · '+(unknown && unknown.total!=null ? unknown.total : '—'),{onClick:function() { app.filters.priority='none'; SF.app.render(); }})),
      h('div.view__body.priority-body',null,h('div.kanban'+(shown.length===1?'.kanban--single':''),null,shown.map(function(id) { return priorityColumn(app,id); }))));
  }
  function priorityColumn(app,id) {
    var group=board[id], meta=catalog.priority(id), tone=id==='medium'?'mid':id;
    var contents;
    if(group.error && !group.items) contents=ui.state({icon:'alert',title:'读取失败',desc:group.error.message,actions:[{label:'重试',onClick:function() { board[id]={}; SF.app.renderContent(); }}]});
    else if(!group.loaded) contents=h('p.kanban__empty',{text:'正在载入…'});
    else contents=h('div.kanban__list.scroll-y',null,
      (group.items||[]).length ? group.items.map(function(item) { return h('button.kanban__item',{type:'button','data-priority-item':item.id,onclick:function() { openDetail(app,item); }},
        h('div.kanban__item-head',null,item.cover?h('div.kanban__item-thumb',null,h('img',{src:item.cover,alt:'',loading:'lazy'})):null,h('div.kanban__item-title',{text:item.title})),
        h('div.kanban__item-author',null,ui.avatar(item.channelName),h('span',{text:item.channelName}),ui.platformTag(item.platform)),
        h('div.kanban__item-foot',null,h('span',{text:fmt.publication(item,true)}),h('span',{text:item.priorityOverride?'单独设置':'跟随来源'}))); }) : h('p.kanban__empty',{text:'当前条件下没有'+meta.name+'内容'}),
      group.error ? h('p.field__error',{role:'alert',text:group.error.message}) : null,
      group.next_offset!=null ? ui.btn(group.loading?'正在加载…':group.error?'重试加载':'加载更多',{disabled:group.loading,onClick:function() { loadGroup(app,id,true); SF.app.renderContent(); }}):null);
    return h('section.kanban__col.kanban__col--'+tone,{'aria-label':meta.name,'data-priority-column':id},
      h('div.kanban__head',null,h('span.kanban__head-icon',null,icon(meta.icon,14)),h('span.kanban__head-name',{text:meta.name}),ui.countPill(group.total==null?'—':group.total,tone)),
      h('p.kanban__head-desc',{text:meta.action}),contents,
      h('div.priority-column-foot',null,h('span.muted',{text:'已载入 '+(group.items||[]).length+' 条'}),ui.btn('查看全部',{size:'sm',onClick:function() { app.filters.priority=id; SF.app.navigate('inbox'); }})));
  }

  /* ---------------- 日历模式 ---------------- */

  function buildCalendar(app) {
    var month = monthDate(app);
    var byDay = groupByDay(cache.items);

    var first = new Date(month.getFullYear(), month.getMonth(), 1);
    var startOffset = (first.getDay() + 6) % 7; /* 周一为一周起点，与设计稿一致 */
    var gridStart = fmt.addDays(first, -startOffset);
    var daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    var totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

    var weekRow = h(
      "div.calendar-week",
      null,
      ["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(function (d) {
        return h("div.calendar-week__cell", { text: d });
      })
    );

    var cells = [];
    for (var i = 0; i < totalCells; i++) {
      cells.push(buildDayCell(gridStart, i, month, app, byDay));
    }

    var grid = h("div.calendar-grid", { role: "grid", "aria-label": fmt.yearMonth(month) }, cells);

    var panel = h(
      "section.calendar-panel",
      null,
      h(
        "div.calendar-head",
        null,
        h(
          "div",
          null,
          h("h2.calendar-head__title", { text: fmt.yearMonth(month) }),
          h("p.calendar-head__desc", { text: "点击日期查看当日已载入内容；分页未加载完时，计数仅包含已载入部分。" })
        ),
        h(
          "div.calendar-head__nav",
          null,
          ui.btn("今天", {
            onClick: function () {
              app.calendarMonth = fmt.ymd(app.now).slice(0,7);
              app.selectedDate = fmt.ymd(app.now);
              SF.app.renderContent();
            },
          }),
          ui.iconBtn("chevron-left", "上个月", function () { shiftMonth(app, -1); }),
          ui.iconBtn("chevron-right", "下个月", function () { shiftMonth(app, 1); })
        )
      ),
      /* 星期行与格子区同处一个滚动容器：格子区高度随行数变化，
         容器不够高时整体滚动（星期行吸顶），而不是把最后一周裁掉。 */
      h("div.calendar-scroll.scroll-y", null, weekRow, grid)
    );

    return h("div.calendar-layout", null, panel, buildDayPanel(app, byDay));
  }

  function shiftMonth(app, delta) {
    var date = monthDate(app); date.setMonth(date.getMonth() + delta);
    app.calendarMonth = fmt.ymd(date).slice(0,7); app.selectedDate = fmt.ymd(date);
    SF.app.renderContent();
  }

  function groupByDay(items) {
    var map = {};
    items.forEach(function (c) {
      var k = fmt.publicationDay(c);
      if (!k) return;
      (map[k] || (map[k] = [])).push(c);
    });
    Object.keys(map).forEach(function (k) {
      map[k].sort(function (a, b) { return String(b.publishedAt).localeCompare(String(a.publishedAt)); });
    });
    return map;
  }

  function buildDayCell(gridStart, index, month, app, byDay) {
    var date = fmt.addDays(gridStart, index);
    var key = fmt.ymd(date);
    var inMonth = date.getMonth() === month.getMonth();
    var items = byDay[key] || [];
    var isToday = fmt.sameDay(date, app.now);
    var isSelected = key === app.selectedDate;
    var MAX = 3;

    var cls = "button.cal-day";
    if (!inMonth) cls += ".is-outside";
    if (isToday) cls += ".is-today";
    if (isSelected) cls += ".is-selected";

    return h(
      cls.replace("button.", "button."),
      {
        type: "button",
        role: "gridcell",
        "aria-label": fmt.monthDay(date) + "，" + items.length + " 条内容",
        onclick: function () {
          app.selectedDate = key;
          SF.app.renderContent();
        },
      },
      h("span.cal-day__num", { text: String(date.getDate()) }),
      isToday ? h("span.cal-day__today-tag", { text: "今天" }) : null,
      items.length
        ? h(
            "span.cal-day__items",
            null,
            items.slice(0, MAX).map(function (c) {
              return h(
                "span.cal-pill.cal-pill--neutral",
                null,
                h("span.cal-pill__dot"),
                h("span.cal-pill__text", { text: c.title })
              );
            }),
            items.length > MAX
              ? h("span.cal-pill.cal-pill--more", { text: "+" + (items.length - MAX) + " 条" })
              : null
          )
        : null
    );
  }

  function buildDayPanel(app, byDay) {
    var key = app.selectedDate || fmt.ymd(app.now);
    var items = byDay[key] || [];
    var date = new Date(key.replace(/-/g, "/"));

    var list = h("div.day-panel__list.scroll-y");
    if (!items.length) {
      list.appendChild(
        h("div.state", { style: { "min-height": "160px" } },
          h("div.state__icon", null, icon("calendar", 26)),
          h("p.state__title", { text: "这一天没有更新" }),
          h("p.state__desc", { text: "选择其他日期查看当天收到的内容。" })
        )
      );
    } else {
      items.forEach(function (c) {
        list.appendChild(
          ui.rowCard(c, {
            now: app.now,
            onSelect: function () { openDetail(app, c); },
          })
        );
      });
    }

    return h(
      "aside.day-panel",
      { "aria-label": "当日内容" },
      h(
        "div.day-panel__head",
        null,
        h(
          "div",
          null,
          h("div.day-panel__date", { text: fmt.monthDay(date) }),
          h("div.day-panel__weekday", { text: fmt.weekday(date) })
        ),
        h("div.day-panel__count", { text: items.length + " 条内容" })
      ),
      list,
      items.length
        ? h("div.day-panel__foot", null, ui.btn("查看全部 " + items.length + " 条内容", {
            variant: "primary",
            onClick: function () { app.filters.day = key; SF.app.navigate("inbox"); },
          }))
        : null
    );
  }

  function openDetail(app, item) {
    var closed = false;
    var layer = ui.dialog({title:'内容详情',wide:true,body:ui.state({icon:'clock',title:'正在载入详情…'}),onClose:function () { closed=true; }});
    function repaint(fresh) { if (!closed) SF.dom.render(layer.el.querySelector('.dialog__body'), SF.views.inbox.detailBody(app,fresh,repaint)); }
    app.client.getContent(item.id).then(repaint).catch(function (err) { if(!closed) SF.dom.render(layer.el.querySelector('.dialog__body'),ui.state({icon:'alert',title:'详情读取失败',desc:err.message})); });
  }
  SF.views = SF.views || {};
  SF.views.overview = {render:render,reset:function () { cache = {}; board = {}; }};
})(window);
