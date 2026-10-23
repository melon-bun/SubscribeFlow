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
  /* 来源目录独立于日历缓存：缓存每改一次筛选就会被清空，
     来源列表跟着清空会让「来源」下拉在重新渲染时闪回「全部来源」——
     明明选着某个来源，按钮上却写着「全部来源」。 */
  var sourceState = {};

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
  function loadSources(app,mode) {
    var state=sourceState;
    if(!needsLoad(state)) return;
    request(state,function() { return app.client.listContentSources({}); },function(result) { state.items=result.items; },function() {
      if(visible(app,mode)) SF.app.renderView('overview');
    });
  }
  function monthDate(app) { return new Date(app.calendarMonth + '-01T00:00:00'); }

  /* 「静流」§内容总览：参考页的月份与日期筛选是 .select 按钮（图标 + 文字），
     不是原生 input——原生控件在 macOS 上会露出系统外观，还把筛选条撑到换行。
     月份以「今天」所在月为基准回溯 12 个月；当前选中的月份若不在表里，插到最前。 */
  function monthOptions(app) {
    var base = new Date(app.now || Date.now());
    var out = [];
    for (var i = 0; i <= 12; i++) {
      var d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      out.push({ value: fmt.ymd(d).slice(0,7), label: d.getFullYear() + ' 年 ' + (d.getMonth()+1) + ' 月' });
    }
    if (app.calendarMonth && !out.some(function (o) { return o.value === app.calendarMonth; })) {
      var sel = new Date(app.calendarMonth + '-01T00:00:00');
      out.unshift({ value: app.calendarMonth, label: sel.getFullYear() + ' 年 ' + (sel.getMonth()+1) + ' 月' });
    }
    return out;
  }

  /* 日期筛选：参考页是「📅 任意日期」。这里给「任意日期」+ 最近 14 天
     （菜单放得下，不需要滚动就能看全）。 */
  function dateOptions(app) {
    var base = new Date(app.now || Date.now());
    var out = [{ value: '', label: '任意日期' }];
    for (var i = 0; i < 14; i++) {
      var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
      out.push({ value: fmt.ymd(d), label: fmt.monthDay(d) + ' · ' + fmt.weekdayShort(d) });
    }
    return out;
  }
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
      h('div.legend',{'aria-label':'日历优先级图例'},
        ['high','medium','low','none'].map(function(id) {
          return h('span.prio',null,ui.prioSig(id),h('span',{text:catalog.priority(id).name}));
        }),
        h('span.caption',{text:'自动采集按发布日期，手动收录按添加时间；发布时间未知的内容在收件箱和看板中查看。'}))]);
    return el;
  }
  /* 「静流」§内容总览：筛选行里的「未设置」是一枚芯片。
     正在按「未设置」筛选时，芯片上带一个 × 用来取消；否则点它就是切过去。 */
  function noneChip(app, counts) {
    var n = counts && counts.none != null ? String(counts.none) : '—';
    if (app.filters.priority === 'none') {
      return h('span.fchip.is-active',null,
        h('span',{text:'未设置 · '}),
        h('span.n',{text:n}),
        ui.iconBtn('close','取消这个筛选',function () { app.filters.priority=null; SF.app.renderView('overview'); },{size:14}));
    }
    return h('button.fchip',{type:'button',title:'只看未设置优先级的内容',
      onclick:function () { app.filters.priority='none'; SF.app.renderView('overview'); }},
      h('span',{text:'未设置 · '}),h('span.n',{text:n}));
  }

  /* 「静流」§内容总览：筛选条上的下拉一律用 .select 按钮（参考页形态）——
     1px 内描边、宽度只由按钮文字决定、箭头紧贴文字。
     原生 <select> 的宽度由**最长选项**决定：真实来源名一长（知乎 · 深杯酒满），
     「全部来源」就被撑成巨幅，整条筛选行随之失控、「重置筛选」被挤到第二行。 */
  function filterSelect(options, value, onChange, ariaLabel) {
    return ui.dropdown(options, value, onChange, { ariaLabel: ariaLabel, labelClass: 'select__label' });
  }

  /* 来源下拉：选项来自异步查询，就绪前菜单里只有「全部来源」。
     把已加载的来源数挂在按钮上（data-sources），自动化脚本据此判断「菜单已就绪」——
     否则会在列表到位前点开菜单，拿到一个缺选项的菜单却看不出问题。 */
  function sourceSelect(app, sources, onChange, ariaLabel) {
    var btn = filterSelect(
      [{value:'',label:'全部来源'}].concat((sources.items||[]).map(function(c) {
        return {value:c.id,label:catalog.platform(c.platform).name+" · "+c.name};
      })),
      app.filters.sourceId||'', onChange, ariaLabel);
    if (btn) btn.setAttribute('data-sources', String((sources.items||[]).length));
    return btn;
  }

  function calendarFilters(app) {
    loadSources(app,'calendar');
    var sources=sourceState;
    var counts=cache.summary && cache.summary.priorities;
    return h('div.inbox__toolbar.calendar-filters',null,
      filterSelect([{value:'',label:'全部平台'}].concat(app.platforms.map(function(p) { return {value:p.id,label:catalog.platform(p.id).name}; })),app.filters.platform||'',function(v) { app.filters.platform=v||null; SF.app.renderView('overview'); },'日历平台'),
      sourceSelect(app, sources, function(v) { app.filters.sourceId=v||null; app.filters.channelId=null; SF.app.renderContent(); },'日历来源'),
      filterSelect([{value:'',label:'全部优先级'}].concat(['high','medium','low','none'].map(function(id) { return {value:id,label:catalog.priority(id).name}; })),app.filters.priority||'',function(v) { app.filters.priority=v||null; SF.app.renderView('overview'); },'日历优先级'),
      filterSelect([{value:'',label:'全部收录方式'},{value:'subscription',label:'自动采集'},{value:'manual',label:'手动收录'}],app.filters.intakeMethod||'',function(v) {app.filters.intakeMethod=v||null;SF.app.renderView('overview');},'日历收录方式'),
      filterSelect([{value:'all',label:'全部处理状态'},{value:'unread',label:'未处理'},{value:'read',label:'已读'},{value:'deferred',label:'稍后处理'},{value:'archived',label:'已归档'}],app.filters.quick,function(v) { app.filters.quick=v; SF.app.renderView('overview'); },'日历处理状态'),
      ui.dropdown(monthOptions(app),app.calendarMonth,function(v) { if(!v||v===app.calendarMonth) return; app.calendarMonth=v; app.selectedDate=v+'-01'; SF.app.renderContent(); },{icon:'calendar',arrow:false,labelClass:'num',ariaLabel:'日历月份'}),
      noneChip(app, counts),
      ui.btn('重置筛选',{onClick:function() { app.filters={quick:'all',platform:null,channelId:null}; SF.app.clearSearch(); SF.app.renderView('overview'); }}),
      sources.error ? ui.btn('重试来源筛选',{onClick:function() { markStale(sources); SF.app.renderContent(); }}) : null);
  }

  function buildHead(app) {
    /* 「静流」§内容总览：视图切换做成分段控件，和橙色「添加内容」分开。 */
    var modes = ui.seg(
      [
        { value: "calendar", label: "日历模式", icon: "calendar" },
        { value: "priority", label: "优先级模式", icon: "priority" },
      ],
      app.overviewMode,
      function (value) { SF.app.navigate("overview", { mode: value }); },
      { ariaLabel: "浏览模式" }
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
        /* 顺序也按方案：分段在前，主操作在后——橙色是本页唯一的主操作。 */
        modes,
        ui.btn("添加内容", {
          variant: "primary", icon: "plus",
          disabled: !app.session.capabilities.canIntake,
          title: app.session.capabilities.canIntake ? "粘贴链接收录单条内容" : "当前渠道尚未支持单条链接收录",
          onClick: function () { SF.intakeDialog.open(app); },
        })
      )
    );
  }

  function buildStats(app) {
    var summary=cache.summary, counts=summary && summary.priorities;
    /* 「静流」§内容总览：统计卡加一条占比细条；等级用信号条表达。
       占比 = 该等级条数 / 全部匹配条数。 */
    var total = summary ? summary.total : 0;
    function shareOf(n) { return total > 0 && typeof n === 'number' ? n / total : 0; }
    return h('div.overview__filters',null,h('div.stat-row.grow',{'data-calendar-stats':''},
      ui.stat({value:summary?summary.total:'—',label:'本月匹配内容',icon:'file-text',tone:'brand'}),
      catalog.PRIORITY_ORDER.map(function(id) {
        var meta=catalog.priority(id);
        var n = counts ? counts[id] : null;
        return ui.stat({
          value: n==null ? '—' : n,
          label: meta.name,
          level: id==='medium' ? 'mid' : id,
          share: n==null ? 0 : shareOf(n),
        });
      })));
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
    loadSources(app,'priority');
    var sources=sourceState;
    var shown=app.filters.priority ? [app.filters.priority] : catalog.PRIORITY_ORDER;
    var stats=h('div.overview__filters',null,h('div.stat-row.grow',null,levels.map(function(id) {
      var group=board[id], meta=catalog.priority(id);
      var n = group && group.total!=null && !group.error ? group.total : null;
      /* 占比以看板四项合计为分母：这一组统计的是当前条件下的全部匹配内容。 */
      var sum = levels.reduce(function(acc, k) {
        var g = board[k];
        return acc + (g && g.total!=null && !g.error ? g.total : 0);
      }, 0);
      return ui.stat({
        value: n==null ? '—' : n,
        label: meta.name,
        level: id==='medium' ? 'mid' : id==='none' ? 'none' : id,
        share: n==null || !sum ? 0 : n / sum,
      });
    })));
    var filters=h('div.inbox__toolbar.priority-filters',null,
      filterSelect([{value:'',label:'全部平台'}].concat(app.platforms.map(function(p) { return {value:p.id,label:catalog.platform(p.id).name}; })),app.filters.platform||'',function(v) { app.filters.platform=v||null; SF.app.renderView('overview'); },'看板平台'),
      sourceSelect(app, sources, function(v) { app.filters.sourceId=v||null; app.filters.channelId=null; SF.app.renderContent(); },'看板来源'),
      filterSelect([{value:'',label:'全部收录方式'},{value:'subscription',label:'自动采集'},{value:'manual',label:'手动收录'}],app.filters.intakeMethod||'',function(v) {app.filters.intakeMethod=v||null;SF.app.renderView('overview');},'看板收录方式'),
      filterSelect([{value:'all',label:'全部处理状态'},{value:'unread',label:'未处理'},{value:'read',label:'已读'},{value:'deferred',label:'稍后处理'},{value:'archived',label:'已归档'}],app.filters.quick,function(v) { app.filters.quick=v; SF.app.renderView('overview'); },'看板处理状态'),
      ui.dropdown(dateOptions(app),app.filters.day||'',function(v) { app.filters.day=v||null; SF.app.renderContent(); },{icon:'calendar',arrow:false,ariaLabel:'看板日期'}),
      filterSelect([{value:'',label:'全部优先级'}].concat(levels.map(function(id) { return {value:id,label:catalog.priority(id).name}; })),app.filters.priority||'',function(v) { app.filters.priority=v||null; SF.app.renderView('overview'); },'看板优先级'),
      ui.btn('重置筛选',{onClick:function() { app.filters={quick:'all',platform:null,channelId:null}; SF.app.clearSearch(); SF.app.renderView('overview'); }}),
      /* 参考页把「设置来源优先级」顶到筛选条最右（同一条行内，不换行）。 */
      ui.btn('设置来源优先级',{style:{'margin-left':'auto'},onClick:function() { SF.app.navigate('channels',{tab:'priorities'}); }}));
    var unknown=board.none;
    return h('div.view',{'data-view':'overview','data-mode':'priority'},buildHead(app),stats,filters,
      sources.error ? h('div.inbox__toolbar',null,h('p.field__error',{role:'alert',text:'来源筛选读取失败：'+sources.error.message}),ui.btn('重试来源筛选',{onClick:function() { markStale(sources); SF.app.renderContent(); }})) : null,
      h('div.priority-scope',null,h('span.muted',{text:'统计当前条件下的全部匹配内容；每栏按日历时间排列并独立加载。'}),
        noneChip(app, unknown && unknown.total!=null ? {none: unknown.total} : null)),
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
        h('div.kanban__item-meta',null,
          h('span.kanban__item-author',null,ui.platformTag(item.platform),h('span.t-ellipsis',{text:item.channelName,title:item.channelName})),
          h('span.kanban__item-date',{text:fmt.publication(item,true)}),
          h('span.kanban__item-rule'+(item.priorityOverride?'.is-own':''),{text:item.priorityOverride?'单独设置':'跟随来源'}))); }) : emptyColumn(app,id,meta),
      group.error ? h('div',null,h('p.field__error',{role:'alert',text:group.error.message}),!group.requestMore ? ui.btn('重试更新本栏',{onClick:function() { loadGroup(app,id,false); SF.app.renderContent(); }}) : null) : null,
      group.next_offset!=null ? ui.btn(group.loading?'正在加载…':group.error && group.requestMore?'重试加载':'加载更多',{disabled:group.loading,onClick:function() { loadGroup(app,id,true); SF.app.renderContent(); }}):null);
    return h('section.kanban__col.kanban__col--'+tone,{'aria-label':meta.name,'data-priority-column':id,'data-refresh-key':'priority-column:'+boardKey+':'+id},
      h('div.kanban__head',null,h('span.kanban__head-icon',null,ui.prioSig(id)),h('span.kanban__head-name',{text:meta.name}),ui.countPill(group.total==null?'—':group.total,tone)),
      h('p.kanban__head-desc',{text:meta.action}),contents,
      h('div.priority-column-foot',null,h('span.muted',{text:'已载入 '+(group.items||[]).length+' 条'}),ui.btn('查看全部',{size:'sm',onClick:function() { app.filters.priority=id; SF.app.navigate('inbox'); }})));
  }

  /* 「静流」§内容总览：看板空列要给出「原因」和「下一步」，不是只留一句空话。
     原因区分「被筛选条件挡住」和「本来就没有」；下一步按钮都走次级墨色，
     橙色主操作在本页只保留页头那一个「添加内容」。 */
  function emptyColumn(app, id, meta) {
    var f = app.filters || {};
    var filtered = !!(f.platform || f.sourceId || f.channelId || f.intakeMethod || f.priority || f.day ||
      (f.tags && f.tags.length) || (f.quick && f.quick !== 'all') || app.search);
    var reason = filtered
      ? '当前筛选条件下没有' + meta.name + '内容。'
      : '目前还没有' + meta.name + '内容。';
    var hint = filtered
      ? '放宽筛选条件，或直接查看全部内容。'
      : (id === 'none' ? '可以先给来源设一个默认优先级。' : '来源设置优先级后，新内容会自动落到这一栏。');
    var steps = [];
    if (filtered) {
      steps.push({ label: '放宽筛选条件', onClick: function () {
        app.filters = { quick: 'all', platform: null, channelId: null }; SF.app.clearSearch(); SF.app.renderView('overview');
      } });
    }
    if (id === 'none') {
      steps.push({ label: '设置来源优先级', onClick: function () { SF.app.navigate('channels', { tab: 'priorities' }); } });
    }
    steps.push({ label: '查看全部内容', onClick: function () { SF.app.navigate('inbox'); } });
    return h('div.kanban__empty', null,
      h('p.kanban__empty-reason', { text: reason }),
      h('p.kanban__empty-hint', { text: hint }),
      h('div.kanban__empty-actions', null, steps.map(function (s) {
        return ui.btn(s.label, { variant: 'ink', size: 'sm', onClick: s.onClick });
      })));
  }

  /* ---------------- 日历模式 ---------------- */

  function buildCalendar(app) {
    var month = monthDate(app);
    var byDay={};
    cache.summary.days.forEach(function(day) { byDay[day.date]=day; });

    /* 「静流」§内容总览：每格底部一条信号青热度条，长度按当天条数在当月内的占比。
       基准取当月最大值；相邻月份格子同样按当月基准换算，避免跨月数量级干扰。 */
    var monthKey = fmt.ymd(month).slice(0,7);
    var monthMax = 0;
    Object.keys(byDay).forEach(function(k){
      if (k.slice(0,7) !== monthKey) return;
      var t = (byDay[k] && byDay[k].total) || 0;
      if (t > monthMax) monthMax = t;
    });

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
      cells.push(buildDayCell(gridStart, i, month, app, byDay, monthMax));
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

  function buildDayCell(gridStart, index, month, app, byDay, monthMax) {
    var date = fmt.addDays(gridStart, index);
    var key = fmt.ymd(date);
    var inMonth = date.getMonth() === month.getMonth();
    var day=byDay[key] || {total:0,items:[],priorities:{}};
    var items=day.items;
    var isToday = fmt.sameDay(date, app.now);
    var isSelected = key === app.selectedDate;
    var MAX = 3;

    /* 热度条：宽度 = 当天条数 / 当月最大条数；留 8% 下限让单条内容也看得见。
       纯装饰，读数已由格子的 aria-label 承担。 */
    var heatRatio = monthMax > 0 ? Math.min(1, (day.total || 0) / monthMax) : 0;
    var heat = day.total
      ? h('span.cal-day__heat', {'aria-hidden':'true'}, h('i', { style: { "--w": Math.max(8, heatRatio * 100) + "%" } }))
      : null;

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
        : null,
      heat
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
        markStale(sourceState);
      }
    },
    whenIdle:whenIdle,
    reset:function () { cache = {}; dayCache = {}; board = {}; }
  };
})(window);
