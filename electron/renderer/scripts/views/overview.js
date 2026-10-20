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
  var pending = new Set();

  function needsLoad(state) { return !state.loading && (!state.loaded || state.stale); }
  function markStale(state) { state.stale=true; state.revision=(state.revision || 0)+1; }
  function visible(app, mode) { return app.route.name==='overview' && app.overviewMode===mode; }
  function redraw(app,mode,current) {
    if(visible(app,mode) && current()) SF.app.renderView('overview');
  }
  // An invalidation received during a request stays pending until its follow-up
  // query finishes. Failed refreshes retain data and wait for an explicit retry.
  function request(state,work,apply,finish) {
    if(state.loading) return;
    var revision=state.revision || 0, cancelled=false;
    state.loading=true; state.stale=false; state.error=null;
    var task=Promise.resolve().then(work).then(function(result) {
      if(result!==null) { apply(result); state.loaded=true; }
      else cancelled=true;
    }).catch(function(err) { state.error=err; state.loaded=true; }).then(function() {
      state.loading=false; state.stale=cancelled || (state.revision || 0)!==revision;
      finish();
    });
    pending.add(task);
    task.then(function() { pending.delete(task); });
    return task;
  }
  function whenIdle() {
    return Promise.all(Array.from(pending)).then(function() { return pending.size ? whenIdle() : undefined; });
  }
  // Core pages are capped at 100. Revalidate the entire visible window, then
  // swap it atomically so an already expanded list never shrinks to page one.
  function readWindow(app,query,count,current) {
    var items=[], next=0, total=0;
    function page() {
      if(!current()) return Promise.resolve(null);
      return app.client.listContents(Object.assign({},query,{offset:next,limit:Math.min(100,Math.max(20,count-items.length))})).then(function(result) {
        items=items.concat(result.items); total=result.total;
        var previous=next; next=result.next_offset;
        if(items.length<count && next!=null && next>previous) return page();
        return {items:items,total:total,next_offset:next};
      });
    }
    return page();
  }
  function loadSources(app,owner,current,mode) {
    var state=owner.sourceState || (owner.sourceState={});
    if(!needsLoad(state)) return;
    request(state,function() { return app.client.listContentSources({}); },function(result) { state.items=result.items; },function() {
      redraw(app,mode,current);
    });
  }
  function monthDate(app) { return new Date(app.calendarMonth + '-01T00:00:00'); }
  function calendarQuery(app) {
    var query={month:app.calendarMonth};
    if(app.filters.priority) query.priority=app.filters.priority;
    if(app.filters.platform) query.platform=app.filters.platform;
    if(app.filters.channelId) query.channelId=app.filters.channelId;
    if(app.filters.sourceId) query.sourceId=app.filters.sourceId;
    if(app.filters.intakeMethod) query.intakeMethod=app.filters.intakeMethod;
    if((app.filters.tags||[]).length) {query.tags=app.filters.tags;query.tagMode=app.filters.tagMode||"any";}
    if(app.filters.quick!=='all') query.state=app.filters.quick;
    if(app.search) query.keyword=app.search;
    return query;
  }
  function loadCalendar(app) {
    var current=cache, key=queryKey, query=calendarQuery(app);
    function owns() { return cache===current && queryKey===key && JSON.stringify(calendarQuery(app))===key; }
    request(current,function() { return app.client.getCalendar(query); },function(result) {
      if(owns()) current.summary=result;
    },function() { redraw(app,'calendar',owns); });
  }
  function loadDay(app,more) {
    var current=dayCache, key=dayKey, query=calendarQuery(app);
    if(current.loading) return;
    current.requestMore=!!more;
    delete query.month;
    Object.assign(query,{from:app.selectedDate,to:app.selectedDate});
    function owns() { return dayCache===current && dayKey===key && JSON.stringify(calendarQuery(app))+':'+app.selectedDate===key; }
    request(current,function() {
      return more ? app.client.listContents(Object.assign({},query,{limit:20,offset:current.next_offset})) : readWindow(app,query,Math.max(20,(current.items||[]).length),function() { return owns() && visible(app,'calendar'); });
    },function(result) {
      if(!owns()) return;
      current.items=more ? current.items.concat(result.items.filter(function(item) { return !current.items.some(function(old) { return old.id===item.id; }); })) : result.items;
      current.total=result.total; current.next_offset=result.next_offset;
    },function() { redraw(app,'calendar',owns); });
  }
  function render(app) {
    if (app.overviewMode === 'priority') return renderPriorities(app);
    if (!app.calendarMonth) app.calendarMonth = fmt.ymd(app.now).slice(0,7);
    if(!app.selectedDate || app.selectedDate.slice(0,7)!==app.calendarMonth) app.selectedDate=app.calendarMonth+'-01';
    var key=JSON.stringify(calendarQuery(app));
    if(key!==queryKey) { queryKey=key; cache={}; }
    if(needsLoad(cache)) loadCalendar(app);
    var selectedKey=key+':'+app.selectedDate;
    if(selectedKey!==dayKey) { dayKey=selectedKey; dayCache={}; }
    if(needsLoad(dayCache)) loadDay(app,false);
    var el=h('div.view',{'data-view':'overview','data-mode':'calendar'});
    SF.dom.append(el,[buildHead(app),buildStats(app),calendarFilters(app),h('div.view__body',null,buildBody(app)),
      h('div.inbox__toolbar.calendar-legend',{'aria-label':'日历优先级图例'},
        ['high','medium','low','none'].map(function(id) { return ui.priorityTag(id); }),
        h('span.muted',{text:'自动采集按发布日期，手动收录按添加时间；发布时间未知的自动内容可在收件箱和看板中查看。'}))]);
    return el;
  }
  function calendarFilters(app) {
    var owner=cache;
    loadSources(app,owner,function() { return cache===owner; },'calendar');
    var sources=cache.sourceState;
    var counts=cache.summary && cache.summary.priorities;
    return h('div.inbox__toolbar.calendar-filters',null,
      ui.select([{value:'',label:'全部平台'}].concat(app.platforms.map(function(p) { return {value:p.id,label:catalog.platform(p.id).name}; })),app.filters.platform||'',function(v) { app.filters.platform=v||null; SF.app.render(); },{ariaLabel:'日历平台'}),
      ui.select([{value:'',label:'全部来源'}].concat((sources.items||[]).map(function(c) { return {value:c.id,label:catalog.platform(c.platform).name+" · "+c.name}; })),app.filters.sourceId||'',function(v) { app.filters.sourceId=v||null; app.filters.channelId=null; SF.app.renderContent(); },{ariaLabel:'日历来源'}),
      ui.select([{value:'',label:'全部优先级'}].concat(['high','medium','low','none'].map(function(id) { return {value:id,label:catalog.priority(id).name}; })),app.filters.priority||'',function(v) { app.filters.priority=v||null; SF.app.render(); },{ariaLabel:'日历优先级'}),
      ui.select([{value:'',label:'全部收录方式'},{value:'subscription',label:'自动采集'},{value:'manual',label:'手动收录'}],app.filters.intakeMethod||'',function(v) {app.filters.intakeMethod=v||null;SF.app.render();},{ariaLabel:'日历收录方式'}),
      ui.select([{value:'all',label:'全部处理状态'},{value:'unread',label:'未处理'},{value:'read',label:'已读'},{value:'deferred',label:'稍后处理'},{value:'archived',label:'已归档'}],app.filters.quick,function(v) { app.filters.quick=v; SF.app.render(); },{ariaLabel:'日历处理状态'}),
      h('label.priority-date',null,h('span',{text:'月份'}),h('input.input',{type:'month','aria-label':'日历月份',value:app.calendarMonth,onchange:function(e) { if(!e.target.value) return; app.calendarMonth=e.target.value; app.selectedDate=e.target.value+'-01'; SF.app.renderContent(); }})),
      ui.btn('未设置 · '+(counts?counts.none:'—'),{onClick:function() { app.filters.priority='none'; SF.app.render(); }}),
      ui.btn('重置筛选',{onClick:function() { app.filters={quick:'all',platform:null,channelId:null}; app.search=''; SF.app.render(); }}),
      sources.error ? ui.btn('重试来源筛选',{onClick:function() { markStale(sources); SF.app.renderContent(); }}) : null);
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
      h(
        "div.view__actions",
        null,
        ui.btn("添加内容", {
          variant: "primary", icon: "plus",
          disabled: !app.session.capabilities.canIntake,
          title: app.session.capabilities.canIntake ? "粘贴链接收录单条内容" : "当前渠道尚未支持单条链接收录",
          onClick: function () { SF.intakeDialog.open(app); },
        }),
        modes
      )
    );
  }

  function buildStats(app) {
    var summary=cache.summary, counts=summary && summary.priorities;
    return h('div.overview__filters',null,h('div.stat-row.grow',{'data-calendar-stats':''},
      ui.stat({value:summary?summary.total:'—',label:'本月匹配内容',icon:'file-text',tone:'brand'}),
      catalog.PRIORITY_ORDER.map(function(id) { var meta=catalog.priority(id); return ui.stat({value:counts?counts[id]:'—',label:meta.name,icon:meta.icon,tone:id==='medium'?'mid':id}); })));
  }
  function buildBody(app) {
    if (cache.error && !cache.summary) return ui.state({icon:'alert',title:'内容读取失败',desc:cache.error.message,actions:[{label:'重试',onClick:function () { markStale(cache); SF.app.renderContent(); }}]});
    if (!cache.summary) return ui.state({icon:'clock',title:'正在载入内容…'});
    return h('div.calendar-content',{'data-refresh-key':'calendar:'+queryKey,style:{display:'contents'}},
      cache.error ? h('div.inbox__toolbar',null,h('p.field__error',{role:'alert',text:'月份更新失败：'+cache.error.message}),ui.btn('重试月份更新',{onClick:function() { markStale(cache); SF.app.renderContent(); }})) : null,buildCalendar(app));
  }

  var board={}, boardKey='';
  var levels=['high','medium','low','none'];
  function boardQuery(app) {
    var q={limit:20};
    if(app.filters.quick!=='all') q.state=app.filters.quick;
    if(app.filters.platform) q.platform=app.filters.platform;
    if(app.filters.channelId) q.channelId=app.filters.channelId;
    if(app.filters.sourceId) q.sourceId=app.filters.sourceId;
    if(app.filters.intakeMethod) q.intakeMethod=app.filters.intakeMethod;
    if((app.filters.tags||[]).length) {q.tags=app.filters.tags;q.tagMode=app.filters.tagMode||"any";}
    if(app.search) q.keyword=app.search;
    if(app.filters.day) { q.from=app.filters.day; q.to=app.filters.day; }
    return q;
  }
  function loadGroup(app,id,more) {
    var owner=board, key=boardKey, group=board[id] || (board[id]={});
    if(group.loading) return;
    group.requestMore=!!more;
    var query=Object.assign({},boardQuery(app),{priority:id});
    function owns() { return board===owner && board[id]===group && JSON.stringify(boardQuery(app))===key; }
    request(group,function() {
      return more ? app.client.listContents(Object.assign({},query,{offset:group.next_offset})) : readWindow(app,query,Math.max(20,(group.items||[]).length),function() { return owns() && visible(app,'priority'); });
    },function(result) {
      if(!owns()) return;
      group.items=more ? group.items.concat(result.items.filter(function(item) { return !group.items.some(function(old) { return old.id===item.id; }); })) : result.items;
      group.total=result.total; group.next_offset=result.next_offset;
    },function() { redraw(app,'priority',owns); });
  }
  function renderPriorities(app) {
    var key=JSON.stringify(boardQuery(app));
    if(key!==boardKey) { boardKey=key; board={}; }
    levels.forEach(function(id) { if(!board[id] || needsLoad(board[id])) loadGroup(app,id,false); });
    var owner=board;
    loadSources(app,owner,function() { return board===owner; },'priority');
    var sources=board.sourceState;
    var shown=app.filters.priority ? [app.filters.priority] : catalog.PRIORITY_ORDER;
    var stats=h('div.overview__filters',null,h('div.stat-row.grow',null,levels.map(function(id) {
      var group=board[id], meta=catalog.priority(id);
      return ui.stat({value:group && group.total!=null && !group.error?group.total:'—',label:meta.name,icon:meta.icon,tone:id==='medium'?'mid':id==='none'?'brand':id});
    })));
    var filters=h('div.inbox__toolbar.priority-filters',null,
      ui.select([{value:'',label:'全部平台'}].concat(app.platforms.map(function(p) { return {value:p.id,label:catalog.platform(p.id).name}; })),app.filters.platform||'',function(v) { app.filters.platform=v||null; SF.app.render(); },{ariaLabel:'看板平台'}),
      ui.select([{value:'',label:'全部来源'}].concat((sources.items||[]).map(function(c) { return {value:c.id,label:catalog.platform(c.platform).name+" · "+c.name}; })),app.filters.sourceId||'',function(v) { app.filters.sourceId=v||null; app.filters.channelId=null; SF.app.renderContent(); },{ariaLabel:'看板来源'}),
      ui.select([{value:'',label:'全部收录方式'},{value:'subscription',label:'自动采集'},{value:'manual',label:'手动收录'}],app.filters.intakeMethod||'',function(v) {app.filters.intakeMethod=v||null;SF.app.render();},{ariaLabel:'看板收录方式'}),
      ui.select([{value:'all',label:'全部处理状态'},{value:'unread',label:'未处理'},{value:'read',label:'已读'},{value:'deferred',label:'稍后处理'},{value:'archived',label:'已归档'}],app.filters.quick,function(v) { app.filters.quick=v; SF.app.render(); },{ariaLabel:'看板处理状态'}),
      h('label.priority-date',null,h('span',{text:'日历日期'}),h('input.input',{type:'date','aria-label':'看板日期',value:app.filters.day||'',onchange:function(e) { app.filters.day=e.target.value || null; SF.app.renderContent(); }})),
      ui.select([{value:'',label:'高 / 中 / 低'}].concat(levels.map(function(id) { return {value:id,label:catalog.priority(id).name}; })),app.filters.priority||'',function(v) { app.filters.priority=v||null; SF.app.render(); },{ariaLabel:'看板优先级'}),
      ui.btn('重置筛选',{onClick:function() { app.filters={quick:'all',platform:null,channelId:null}; app.search=''; SF.app.render(); }}),
      ui.btn('设置来源优先级',{onClick:function() { SF.app.navigate('channels',{tab:'priorities'}); }}));
    var unknown=board.none;
    return h('div.view',{'data-view':'overview','data-mode':'priority'},buildHead(app),stats,filters,
      sources.error ? h('div.inbox__toolbar',null,h('p.field__error',{role:'alert',text:'来源筛选读取失败：'+sources.error.message}),ui.btn('重试来源筛选',{onClick:function() { markStale(sources); SF.app.renderContent(); }})) : null,
      h('div.priority-scope',null,h('span.muted',{text:'统计当前条件下的全部匹配内容；每栏按日历时间排列并独立加载。'}),
        ui.btn('未设置 · '+(unknown && unknown.total!=null ? unknown.total : '—'),{onClick:function() { app.filters.priority='none'; SF.app.render(); }})),
      h('div.view__body.priority-body',null,h('div.kanban'+(shown.length===1?'.kanban--single':''),null,shown.map(function(id) { return priorityColumn(app,id); }))));
  }
  function priorityColumn(app,id) {
    var group=board[id], meta=catalog.priority(id), tone=id==='medium'?'mid':id;
    var contents;
    if(group.error && !group.items) contents=ui.state({icon:'alert',title:'读取失败',desc:group.error.message,actions:[{label:'重试',onClick:function() { markStale(board[id]); SF.app.renderContent(); }}]});
    else if(!group.loaded || (!group.items && group.loading)) contents=h('p.kanban__empty',{text:'正在载入…'});
    else contents=h('div.kanban__list.scroll-y',{'data-scroll-key':'priority:' + id},
      (group.items||[]).length ? group.items.map(function(item) { return h('button.kanban__item',{type:'button','data-priority-item':item.id,'data-refresh-key':'priority-item:'+item.id,onclick:function() { openDetail(app,item); }},
        h('div.kanban__item-head',null,item.cover?h('div.kanban__item-thumb',null,h('img',{src:item.cover,alt:'',loading:'lazy'})):null,h('div.kanban__item-title',{text:item.title})),
        h('div.kanban__item-author',null,ui.avatar(item.channelName),h('span',{text:item.channelName}),ui.platformTag(item.platform)),
        h('div.kanban__item-foot',null,h('span',{text:fmt.publication(item,true)}),h('span',{text:item.priorityOverride?'单独设置':'跟随来源'}))); }) : h('p.kanban__empty',{text:'当前条件下没有'+meta.name+'内容'}),
      group.error ? h('div',null,h('p.field__error',{role:'alert',text:group.error.message}),!group.requestMore ? ui.btn('重试更新本栏',{onClick:function() { loadGroup(app,id,false); SF.app.renderContent(); }}) : null) : null,
      group.next_offset!=null ? ui.btn(group.loading?'正在加载…':group.error && group.requestMore?'重试加载':'加载更多',{disabled:group.loading,onClick:function() { loadGroup(app,id,true); SF.app.renderContent(); }}):null);
    return h('section.kanban__col.kanban__col--'+tone,{'aria-label':meta.name,'data-priority-column':id,'data-refresh-key':'priority-column:'+boardKey+':'+id},
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
      h("div.calendar-scroll.scroll-y", {'data-scroll-key':'calendar:'+queryKey}, weekRow, grid)
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
        'data-refresh-key':'calendar-day:'+key,
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
      list.appendChild(ui.state({icon:'alert',title:'当日内容读取失败',desc:dayCache.error.message,actions:[{label:'重试当日内容',onClick:function() { markStale(dayCache); SF.app.renderContent(); }}]}));
    } else if(!dayCache.loaded || (!dayCache.items && dayCache.loading)) list.appendChild(ui.state({icon:'clock',title:'正在载入当日内容…'}));
    else if(!items.length) list.appendChild(ui.state({icon:'calendar',title:'这一天没有匹配内容',desc:'可以切换日期，或调整优先级及处理状态筛选。'}));
    else {
      items.forEach(function(item) { var row=ui.rowCard(item,{now:app.now,onSelect:function() { openDetail(app,item); }}); row.dataset.calendarItem=item.id; row.dataset.refreshKey='calendar-item:'+item.id; list.appendChild(row); });
      if(dayCache.error) list.appendChild(h('div',null,h('p.field__error',{role:'alert',text:dayCache.error.message}),!dayCache.requestMore ? ui.btn('重试更新当日内容',{onClick:function() { loadDay(app,false); SF.app.renderContent(); }}) : null));
      if(dayCache.next_offset!=null) list.appendChild(ui.btn(dayCache.loading?'正在加载…':dayCache.error && dayCache.requestMore?'重试加载当日内容':'加载更多当日内容',{disabled:dayCache.loading,onClick:function() { loadDay(app,true); SF.app.renderContent(); }}));
    }
    return h('aside.day-panel',{'aria-label':'当日内容','data-refresh-key':'day-panel:'+dayKey},
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
  SF.views.overview = {
    render:render,
    invalidate:function(reasons) {
      if(!['content','tags','channels','all'].some(function(reason) { return reasons.has(reason); })) return;
      markStale(cache); markStale(dayCache);
      levels.forEach(function(id) { if(board[id]) markStale(board[id]); });
      if(reasons.has('content') || reasons.has('channels') || reasons.has('all')) {
        if(cache.sourceState) markStale(cache.sourceState);
        if(board.sourceState) markStale(board.sourceState);
      }
    },
    whenIdle:whenIdle,
    reset:function () { cache = {}; dayCache = {}; board = {}; }
  };
})(window);
