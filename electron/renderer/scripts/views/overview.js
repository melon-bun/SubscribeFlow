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

  var cache = {}, queryKey = '', dayCache = {}, dayKey = '';
  function monthDate(app) { return new Date(app.calendarMonth + '-01T00:00:00'); }
  function calendarQuery(app) {
    var query={month:app.calendarMonth};
    if(app.filters.priority) query.priority=app.filters.priority;
    if(app.filters.platform) query.platform=app.filters.platform;
    if(app.filters.channelId) query.channelId=app.filters.channelId;
    if(app.filters.quick!=='all') query.state=app.filters.quick;
    if(app.search) query.keyword=app.search;
    return query;
  }
  function loadCalendar(app) {
    var current=cache; current.loading=true;
    app.client.getCalendar(calendarQuery(app)).then(function(result) {
      if(cache!==current) return;
      current.summary=result; current.loaded=true; current.loading=false;
      SF.app.renderContent();
    }).catch(function(err) {
      if(cache!==current) return;
      current.error=err; current.loaded=true; current.loading=false; SF.app.renderContent();
    });
  }
  function loadDay(app,more) {
    var current=dayCache, query=calendarQuery(app);
    delete query.month;
    Object.assign(query,{limit:20,offset:more?current.next_offset:0,from:app.selectedDate,to:app.selectedDate});
    current.loading=true; current.error=null;
    app.client.listContents(query).then(function(result) {
      if(dayCache!==current) return;
      current.items=more ? current.items.concat(result.items.filter(function(item) { return !current.items.some(function(old) { return old.id===item.id; }); })) : result.items;
      current.total=result.total; current.next_offset=result.next_offset;
      current.loaded=true; current.loading=false; SF.app.renderContent();
    }).catch(function(err) {
      if(dayCache!==current) return;
      current.error=err; current.loaded=true; current.loading=false; SF.app.renderContent();
    });
  }
  function render(app) {
    if (app.overviewMode === 'priority') return renderPriorities(app);
    if (!app.calendarMonth) app.calendarMonth = fmt.ymd(app.now).slice(0,7);
    if(!app.selectedDate || app.selectedDate.slice(0,7)!==app.calendarMonth) app.selectedDate=app.calendarMonth+'-01';
    var key=JSON.stringify(calendarQuery(app));
    if(key!==queryKey) { queryKey=key; cache={}; }
    if(!cache.loaded && !cache.loading) loadCalendar(app);
    var selectedKey=key+':'+app.selectedDate;
    if(selectedKey!==dayKey) { dayKey=selectedKey; dayCache={}; }
    if(cache.summary && !dayCache.loaded && !dayCache.loading) loadDay(app,false);
    var el=h('div.view',{'data-view':'overview','data-mode':'calendar'});
    SF.dom.append(el,[buildHead(app),buildStats(app),calendarFilters(app),h('div.view__body',null,buildBody(app)),
      h('div.inbox__toolbar.calendar-legend',{'aria-label':'日历优先级图例'},
        ['high','medium','low','none'].map(function(id) { return ui.priorityTag(id); }),
        h('span.muted',{text:'自动采集按发布日期，手动收录按添加时间；发布时间未知的自动内容可在收件箱和看板中查看。'}))]);
    return el;
  }
  function calendarFilters(app) {
    if(!cache.sourcesRequested) {
      var current=cache; current.sourcesRequested=true;
      app.client.listChannels({}).then(function(r) { if(cache===current) { current.sources=r.items; SF.app.renderContent(); } }).catch(function(err) { if(cache===current) { current.sourcesError=err.message; SF.app.renderContent(); } });
    }
    var counts=cache.summary && cache.summary.priorities;
    return h('div.inbox__toolbar.calendar-filters',null,
      ui.select([{value:'',label:'全部平台'}].concat(app.platforms.map(function(p) { return {value:p.id,label:catalog.platform(p.id).name}; })),app.filters.platform||'',function(v) { app.filters.platform=v||null; SF.app.render(); },{ariaLabel:'日历平台'}),
      ui.select([{value:'',label:'全部来源'}].concat((cache.sources||[]).map(function(c) { return {value:c.id,label:c.name}; })),app.filters.channelId||'',function(v) { app.filters.channelId=v||null; SF.app.renderContent(); },{ariaLabel:'日历来源'}),
      ui.select([{value:'',label:'全部优先级'}].concat(['high','medium','low','none'].map(function(id) { return {value:id,label:catalog.priority(id).name}; })),app.filters.priority||'',function(v) { app.filters.priority=v||null; SF.app.render(); },{ariaLabel:'日历优先级'}),
      ui.select([{value:'all',label:'全部处理状态'},{value:'unread',label:'未处理'},{value:'read',label:'已读'},{value:'deferred',label:'稍后处理'},{value:'archived',label:'已归档'}],app.filters.quick,function(v) { app.filters.quick=v; SF.app.render(); },{ariaLabel:'日历处理状态'}),
      h('label.priority-date',null,h('span',{text:'月份'}),h('input.input',{type:'month','aria-label':'日历月份',value:app.calendarMonth,onchange:function(e) { if(!e.target.value) return; app.calendarMonth=e.target.value; app.selectedDate=e.target.value+'-01'; SF.app.renderContent(); }})),
      ui.btn('未设置 · '+(counts?counts.none:'—'),{onClick:function() { app.filters.priority='none'; SF.app.render(); }}),
      ui.btn('重置筛选',{onClick:function() { app.filters={quick:'all',platform:null,channelId:null}; app.search=''; SF.app.render(); }}),
      cache.sourcesError ? ui.btn('重试来源筛选',{onClick:function() { cache.sourcesRequested=false; cache.sourcesError=null; SF.app.renderContent(); }}) : null);
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
    var summary=cache.summary, counts=summary && summary.priorities;
    return h('div.overview__filters',null,h('div.stat-row.grow',{'data-calendar-stats':''},
      ui.stat({value:summary?summary.total:'—',label:'本月匹配内容',icon:'file-text',tone:'brand'}),
      catalog.PRIORITY_ORDER.map(function(id) { var meta=catalog.priority(id); return ui.stat({value:counts?counts[id]:'—',label:meta.name,icon:meta.icon,tone:id==='medium'?'mid':id}); })));
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
    if(app.filters.day) { q.from=app.filters.day; q.to=app.filters.day; }
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
      h('label.priority-date',null,h('span',{text:'日历日期'}),h('input.input',{type:'date','aria-label':'看板日期',value:app.filters.day||'',onchange:function(e) { app.filters.day=e.target.value || null; SF.app.renderContent(); }})),
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
    else contents=h('div.kanban__list.scroll-y',{'data-scroll-key':'priority:' + id},
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
    var byDay={};
    cache.summary.days.forEach(function(day) { byDay[day.date]=day; });

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
          h("p.calendar-head__desc", { text: "日期格展示前三条；月份与每日计数包含所有匹配内容。点击日期查看完整列表。" })
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

  function buildDayCell(gridStart, index, month, app, byDay) {
    var date = fmt.addDays(gridStart, index);
    var key = fmt.ymd(date);
    var inMonth = date.getMonth() === month.getMonth();
    var day=byDay[key] || {total:0,items:[],priorities:{}};
    var items=day.items;
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
        'data-calendar-day':key,
        "aria-label": fmt.monthDay(date) + "，" + day.total + " 条内容" + ['high','medium','low','none'].filter(function(id) { return day.priorities[id]; }).map(function(id) { return '，'+catalog.priority(id).name+' '+day.priorities[id]+' 条'; }).join(''),
        onclick: function () {
          app.selectedDate = key; app.calendarMonth=key.slice(0,7);
          SF.app.renderContent();
        },
      },
      h('span.cal-day__heading',null,
        h("span.cal-day__num", { text: String(date.getDate()) }),
        isToday ? h("span.cal-day__today-tag", { text: "今天" }) : null,
        day.total ? h('span.cal-day__count',{text:String(day.total),'aria-hidden':'true'}) : null),
      items.length
        ? h(
            "span.cal-day__items",
            null,
            items.slice(0, MAX).map(function (c) {
              return h(
                "span.cal-pill.cal-pill--"+(c.priority==='medium'?'mid':c.priority||'none'),
                {title:catalog.priority(c.priority).name+' · '+c.title,'aria-label':catalog.priority(c.priority).name+' · '+c.title},
                h("span.cal-pill__dot"),
                h("span.cal-pill__text", { text: c.title })
              );
            }),
            day.total > MAX
              ? h("span.cal-pill.cal-pill--more", { text: "+" + (day.total - MAX) + " 条" })
              : null
          )
        : null
    );
  }

  function buildDayPanel(app,byDay) {
    var key=app.selectedDate, day=byDay[key] || {total:0}, items=dayCache.items || [];
    var list=h('div.day-panel__list.scroll-y',{'data-scroll-key':'day:' + key,'data-scroll-ready':String(!!dayCache.loaded)});
    if(dayCache.error && !items.length) {
      list.appendChild(ui.state({icon:'alert',title:'当日内容读取失败',desc:dayCache.error.message,actions:[{label:'重试当日内容',onClick:function() { dayCache={}; SF.app.renderContent(); }}]}));
    } else if(!dayCache.loaded) list.appendChild(ui.state({icon:'clock',title:'正在载入当日内容…'}));
    else if(!items.length) list.appendChild(ui.state({icon:'calendar',title:'这一天没有匹配内容',desc:'可以切换日期，或调整优先级及处理状态筛选。'}));
    else {
      items.forEach(function(item) { var row=ui.rowCard(item,{now:app.now,onSelect:function() { openDetail(app,item); }}); row.dataset.calendarItem=item.id; list.appendChild(row); });
      if(dayCache.error) list.appendChild(h('p.field__error',{role:'alert',text:dayCache.error.message}));
      if(dayCache.next_offset!=null) list.appendChild(ui.btn(dayCache.loading?'正在加载…':dayCache.error?'重试加载当日内容':'加载更多当日内容',{disabled:dayCache.loading,onClick:function() { loadDay(app,true); SF.app.renderContent(); }}));
    }
    return h('aside.day-panel',{'aria-label':'当日内容'},
      h('div.day-panel__head',null,h('div',null,h('div.day-panel__date',{text:fmt.monthDay(key)}),h('div.day-panel__weekday',{text:fmt.weekday(key)})),
        h('div.day-panel__count',{text:day.total+' 条内容'})),list,
      h('div.day-panel__foot',null,h('p.muted',{text:'已载入 '+items.length+' / '+day.total+' 条'}),
        day.total ? ui.btn('查看全部 '+day.total+' 条内容',{variant:'primary',onClick:function() { app.filters.day=key; SF.app.navigate('inbox'); }}) : null));
  }

  function openDetail(app, item) {
    var closed = false;
    var positions = new Map();
    var layer = ui.dialog({title:'内容详情',wide:true,body:ui.state({icon:'clock',title:'正在载入详情…'}),onClose:function () { closed=true; }});
    function repaint(fresh) { if (!closed) SF.dom.renderWithScroll(layer.el.querySelector('.dialog__body'), SF.views.inbox.detailBody(app,fresh,repaint), positions); }
    app.client.getContent(item.id).then(repaint).catch(function (err) { if(!closed) SF.dom.render(layer.el.querySelector('.dialog__body'),ui.state({icon:'alert',title:'详情读取失败',desc:err.message})); });
  }
  SF.views = SF.views || {};
  SF.views.overview = {render:render,reset:function () { cache = {}; dayCache = {}; board = {}; }};
})(window);
