/* 沿用 F1 渠道表格、弹层和底部双面板，接入真实订阅、连接与任务。 */
(function (global) {
  'use strict';
  var SF = global.SF, h = SF.dom.h, ui = SF.ui, fmt = SF.fmt;
  var cache = {}, keyword = '', searchTimer;
  var runStates = new Map(), runScrollPositions = new Map();
  function reload() { cache = {keyword:keyword}; renderView(); }
  function renderView() { SF.app.renderView('channels'); }
  function invalidate(reasons) {
    var relevant = ['all', 'channels'].some(function (name) { return reasons && (reasons.has ? reasons.has(name) : reasons.indexOf(name) >= 0); });
    if (!relevant) return;
    cache.stale = true; cache.revision = (cache.revision || 0) + 1;
  }
  function whenIdle() {
    var pending = [cache.promise, cache.coveragePromise].filter(Boolean);
    return pending.length ? Promise.all(pending).then(whenIdle) : Promise.resolve();
  }
  function freshSource(previous, fresh) {
    if (!previous) return fresh;
    Object.keys(previous).forEach(function (key) { if (!(key in fresh)) delete previous[key]; });
    return Object.assign(previous, fresh);
  }
  function refreshCoverage(app) {
    if (!cache.loaded || !cache.items || cache.loading || cache.coveragePromise || !cache.coverageDirty || !cache.coverageDirty.size) return;
    var current = cache, ids = Array.from(current.coverageDirty);
    current.coverageDirty.clear();
    current.coveragePromise = (async function () {
      for (var id of ids) {
        if (current !== cache) return;
        var index = current.items.findIndex(function (source) { return source.id === id; });
        if (index < 0) continue;
        try {
          var coverage = await app.client.getSyncCoverage(id);
          if (current !== cache) return;
          index = current.items.findIndex(function (source) { return source.id === id; });
          if (index >= 0) current.coverage[index] = coverage;
        } catch (error) { if (current === cache) current.refreshError = error; }
      }
    })().finally(function () {
      current.coveragePromise = null;
      if (current === cache) { renderView(); refreshCoverage(app); }
    });
  }
  function latestRun(app, id) {
    var job = app.runs.find(function (run) { return run.channelId === id; });
    return job ? h('div.table__time',null,h('span',{text:fmt.runState(job.state)}),h('small',{text:fmt.relative(job.startedAt,app.now)})) : h('span.muted',{text:'尚未采集'});
  }
  function updateRuns(app) {
    var active = ['queued', 'running', 'waiting'];
    app.runs.forEach(function (run) {
      if ((!runStates.has(run.id) || active.includes(runStates.get(run.id))) && !active.includes(run.state)) {
        cache.coverageDirty = cache.coverageDirty || new Set();
        cache.coverageDirty.add(run.channelId);
      }
      runStates.set(run.id, run.state);
    });
    var ids = new Set(app.runs.map(function (run) { return run.id; }));
    runStates.forEach(function (_state, id) { if (!ids.has(id)) runStates.delete(id); });
    var host = document.querySelector('[data-view="channels"]');
    if (!host) return;
    host.querySelectorAll('[data-channel-run]').forEach(function (cell) {
      SF.dom.render(cell, latestRun(app, cell.dataset.channelRun));
    });
    var panel = host.querySelector('[data-runs-panel]');
    if (panel) SF.dom.reconcileWithScroll(panel, Array.from(runsPanel(app).childNodes), runScrollPositions);
    refreshCoverage(app);
  }
  function descriptorFor(app, connection) {
    return (app.session.channels || []).filter(function (d) { return d.channel === connection.channel && d.backend === connection.backend; })[0] || {};
  }
  // 只有能定位来源的渠道才出现在「添加渠道或创作者」里。微信只支持自主
  // 添加，把它放进订阅表单只会让用户走进一个注定失败的流程。
  function subscribable(app, connection) {
    var ops = descriptorFor(app, connection).operations || {};
    return !!(ops.resolve_source && ops.resolve_source.supported);
  }
  function render(app) {
    if (cache.keyword !== keyword) cache = {keyword:keyword};
    if (!runStates.size) app.runs.forEach(function (run) { runStates.set(run.id, run.state); });
    if ((!cache.loaded || cache.stale) && !cache.loading) {
      var current = cache, revision = current.revision || 0, requestKeyword = keyword;
      current.loading = true; current.stale = false;
      delete current.refreshError;
      current.promise = app.client.listChannels({keyword:requestKeyword}).then(async function (result) {
        var coverage = [];
        // Keep bridge requests bounded even when many authors are subscribed.
        for (var c of result.items) {
          if (current !== cache || requestKeyword !== keyword || (current.revision || 0) !== revision) return;
          try { coverage.push(await app.client.getSyncCoverage(c.id)); }
          catch (err) {
            var previous = (current.items || []).findIndex(function (source) { return source.id === c.id; });
            coverage.push(previous >= 0 && current.coverage[previous] || {label:'覆盖读取失败', detail:err.message, complete:false});
            if (current.loaded) current.refreshError = err;
          }
        }
        if (current !== cache || requestKeyword !== keyword) return;
        if ((current.revision || 0) !== revision) { current.stale = true; return; }
        var previous = new Map((current.items || []).map(function (source) { return [source.id, source]; }));
        Object.assign(cache, {loaded:true, loading:false, items:result.items.map(function (source) { return freshSource(previous.get(source.id), source); }), coverage:coverage});
        delete current.error;
      }).catch(function (err) {
        if (current !== cache || requestKeyword !== keyword) return;
        if ((current.revision || 0) !== revision) { current.stale = true; return; }
        if (current.loaded) current.refreshError = err;
        else Object.assign(current, {loaded:true, error:err});
      }).finally(function () {
        current.loading = false; current.promise = null;
        if (current === cache && requestKeyword === keyword) renderView();
      });
    }
    refreshCoverage(app);
    var body;
    if (cache.error) body = ui.state({icon:'alert',title:'渠道读取失败',desc:cache.error.message,actions:[{label:'重试',onClick:reload}]});
    else body = h('div.col.grow.channels-content.scroll-y', {style:{gap:'20px'},'data-refresh-key':'channel-content:' + app.channelTab},
      cache.refreshError ? h('p.field__error',{role:'status','data-refresh-key':'channel-refresh-error',text:'更新失败，正在显示已加载内容：' + cache.refreshError.message}) : null,
      app.channelTab==='priorities' ? cache.loaded ? prioritySettings(app) : ui.state({icon:'clock',title:'正在载入渠道…'}) : channelList(app),
      app.channelTab==='priorities' || !cache.loaded ? null : bottomPanels(app));
    return h('div.view', {'data-view':'channels','data-refresh-key':'channels:' + app.channelTab}, h('div.view__head', null,
      h('div.view__head-text', null, h('h1.t-h1',{text:'渠道管理'}), h('p.view__desc',{text:'管理关注的创作者，选择手动或自动刷新，并查看采集状态。'})),
      h('div.view__actions', null, ui.btn('添加渠道或创作者',{variant:'primary',icon:'plus',disabled:!app.session.capabilities.canManageChannels,onClick:function () { addDialog(app); }}))),
      h('div.inbox__toolbar',null,['list','priorities'].map(function(tab) { return ui.btn(tab==='list'?'渠道列表':'优先级设置',{variant:app.channelTab===tab?'primary':'ghost',onClick:function() { app.channelTab=tab; SF.app.navigate('channels',{tab:tab}); SF.app.renderContent(); }}); })),
      h('div.view__body', null, body));
  }
  function prioritySettings(app) {
    return h('section.panel.source-priorities',{'aria-label':'来源优先级设置'},
      h('h2.t-h2',{text:'来源默认优先级'}),
      h('p.view__desc',{text:'未单独设置的历史和新内容都会跟随来源；单条内容的手动设置会保留。'}),
      keyword ? ui.btn('显示全部来源',{onClick:function() { keyword=''; reload(); }}) : null,
      cache.items.length ? cache.items.map(function(c) {
        var saving=false;
        var select=ui.select([{value:'',label:'未设置'}].concat(SF.catalog.PRIORITY_ORDER.map(function(id) { return {value:id,label:SF.catalog.priority(id).name}; })), c.defaultPriority || '',async function(value) {
          if(saving) return; saving=true; select._input.disabled=true;
          try { await app.client.savePrioritySettings({id:c.id,priority:value || null}); ui.toast('来源优先级已保存'); await SF.app.refreshData(true); }
          catch(err) { select._input.value=c.defaultPriority || ''; ui.toast(err.message,'danger'); }
          finally { saving=false; select._input.disabled=false; }
        },{ariaLabel:'来源优先级 '+c.name});
        return h('div.source-priority-row',{'data-priority-source':c.id,'data-refresh-key':'source-priority:' + c.id,
          'data-refresh-boundary':true,'data-refresh-preserve':JSON.stringify(c)},ui.avatar(c.name),h('div.grow',null,h('strong',{text:c.name}),h('div.muted',{text:SF.catalog.platform(c.platform).name+' · '+(c.enabled?'追踪中':'已暂停')})),select);
      }) : ui.state({icon:'folder-open',title:'还没有可设置的来源',desc:'添加来源后可在这里设置默认优先级。'}));
  }
  function channelList(app) {
    var toolbar = h('div.channels__toolbar', {'data-refresh-key':'channel-toolbar'}, h('h2.t-h2',{text:'全部渠道（' + (cache.items ? cache.items.length : '—') + '）'}), h('div.spacer'),
      ui.searchInput('搜索创作者或链接...', keyword, function (v) { keyword = v; clearTimeout(searchTimer); searchTimer = setTimeout(reload,240); }),
      ui.btn('重新查询',{icon:'refresh',onClick:function () { SF.app.refreshData(true); }}));
    if (!cache.loaded) return h('div',{'data-refresh-key':'channel-list'},toolbar,ui.state({icon:'clock',title:'正在载入渠道…'}));
    if (!cache.items.length) return h('div',{'data-refresh-key':'channel-list'},toolbar,h('div.panel',null,ui.state({icon:'folder-open',title:keyword ? '没有匹配的来源' : '还没有添加任何来源',desc:'使用作者 UID、主页链接或搜索结果添加来源，然后手动刷新。',actions:[{label:'添加来源',variant:'primary',onClick:function () { addDialog(app); }}]})));
    return h('div',{'data-refresh-key':'channel-list'},toolbar,h('div.panel.channels__table-wrap',null,h('table.table.live-channels',null,
      h('thead',null,h('tr',null,['平台','创作者 / 频道名','主页','同步方式','状态','覆盖范围','最近任务','操作'].map(function (label) { return h('th',{text:label}); }))),
      h('tbody',null,cache.items.map(function (c,i) {
        var cov = cache.coverage[i];
        return h('tr',{'data-channel-id':c.id,'data-refresh-key':'channel:' + c.id,'data-refresh-boundary':true,
          'data-refresh-preserve':JSON.stringify([c,cov])},
          h('td',null,ui.platformIcon(c.platform)),
          h('td',null,h('div.channel-cell',null,ui.avatar(c.name),h('div.channel-cell__text',null,h('div.channel-cell__name',{text:c.name}),h('div.channel-cell__desc',{text:'UID ' + c.externalId})))),
          h('td',null,ui.btn('打开主页',{size:'sm',icon:'external',onClick:function () { SF.app.act('source:' + c.id,function () { return app.client.openChannel(c.id); }); }})),
          h('td',null,h('div.table__time',null,
            ui.btn(c.frequency,{size:'sm',onClick:function () { scheduleDialog(app,c); },ariaLabel:'设置同步方式 ' + c.name}),
            h('small',{text:scheduleText(c)}))),
          h('td',null,ui.toggle(c.enabled,function (enabled) { SF.app.act('subscription:' + c.id,async function () { await app.client.setChannelEnabled(c.id,enabled); await SF.app.refreshData(true); }); },{label:(c.enabled?'暂停 ':'恢复 ') + c.name})),
          h('td',null,h('button.coverage-cell' + (cov.complete?'':'.coverage-cell--limited'),{type:'button',title:cov.detail,onclick:function () { ui.dialog({title:c.name + ' · 覆盖范围',body:ui.notice({tone:cov.complete?'info':'warn',text:cov.detail})}); }},SF.icon(cov.complete?'check':'clock',14),h('span',{text:cov.label}))),
          h('td',{'data-channel-run':c.id},latestRun(app,c.id)),
          h('td',null,h('div.table__ops',null,
            ui.iconBtn('refresh','刷新来源',function () { startRun(app,c,'recent'); },{disabled:!c.enabled || !c.capabilities.canRefresh}),
            ui.iconBtn('clock','回溯历史',function () { var pages = collectPages(c,c.defaultBackfillBudget || 10); ui.confirm({title:'回溯 ' + c.name,message:c.checkedItems ? '本次按主页顺序检查前 ' + pages + ' 条' + (c.contentNoun || '内容') + '。已收录的也占一个名额，跳过详情后不向后补足；结果不代表全部历史。' : c.incrementalDetails ? '本次最多读取 ' + pages + ' 条' + (c.contentNoun || '内容') + '详情，已完整收录的会跳过；主页分页扫描有上限，结果不代表全部历史。' : '本次最多采集 ' + (c.collectItems || pages*(c.pageSize || 20)) + ' 条内容。已收录或解析失败的条目也占名额，不向后补足；回溯成功不代表全部历史已获取。',confirmText:'开始回溯'}).then(function (ok) { if(ok) startRun(app,c,'backfill'); }); },{disabled:!c.enabled || !c.capabilities.canBackfill}),
            ui.iconBtn('sliders',(c.collectItems ? '采集条数（当前 '+c.collectItems+' 条）' : '采集条数（默认）'),function () { collectDialog(app,c); },{disabled:!c.enabled,ariaLabel:'设置采集条数'}),
            ui.iconBtn('trash','取消追踪',function () { ui.confirm({title:'取消追踪 ' + c.name + '？',message:'已保存的历史内容会保留。再次添加相同 UID 可以恢复订阅。',confirmText:'取消追踪',danger:true}).then(function(ok) { if(ok) SF.app.act('subscription:' + c.id,async function () { await app.client.removeChannel(c.id); await SF.app.refreshData(true); }); }); },{danger:true}))));
      })))));
  }
  function startRun(app,c,kind) {
    return SF.app.act('run:' + c.id,async function () { await app.client.startChannelRun(c.id,{kind:kind}); ui.toast('采集任务已创建'); await SF.app.refreshData(true); });
  }
  // 页数只用于请求预算；保存内容仍受精确条数上限约束。
  var PAGE_ITEMS = 20;
  function collectPages(c,fallback) { var n = c.collectItems || 0; return n ? c.incrementalDetails ? n : Math.ceil(n / (c.pageSize || PAGE_ITEMS)) : fallback; }
  function collectDialog(app,c) {
    var saving = false, current = c.collectItems || 0;
    var error = h('p.field__error',{role:'alert'});
    var input = h('input.input',{id:'collect-items',type:'number',min:1,max:50,step:1,value:String(current || ''),placeholder:'留空使用默认',oninput:function () { error.textContent=''; }});
    var save = ui.btn('保存采集条数',{variant:'primary',onClick:async function () {
      if (saving) return;
      var raw = String(input.value).trim();
      var items = 0;
      if (raw !== '') {
        items = Number(raw);
        if (!Number.isInteger(items) || items < 1 || items > 50) { error.textContent = '请输入 1 到 50 之间的整数，或留空使用默认'; return; }
      }
      saving = true; save.disabled = true; input.disabled = true;
      try {
        await app.client.updateChannel(c.id,{collectItems:items});
        layer.close(); await SF.app.refreshData(true);
        ui.toast(items ? c.checkedItems ? '刷新与回溯每次检查前 ' + items + ' 条' + (c.contentNoun || '内容') : '刷新与回溯每次最多采集 ' + items + ' 条' : '已恢复默认采集条数');
      } catch(err) { error.textContent = err.message; }
      finally { saving = false; save.disabled = false; input.disabled = false; }
    }});
    var layer = ui.dialog({title:c.name + ' · 采集条数',body:h('div.col',{style:{gap:'16px'}},
      h('div.field',null,h('label.field__label',{htmlFor:'collect-items',text:'每次采集条数（1-50）'}),input,
        h('p.field__hint',{text: c.checkedItems ? '默认刷新检查前 ' + c.defaultRefreshBudget + ' 条、回溯检查前 ' + c.defaultBackfillBudget + ' 条' + (c.contentNoun || '内容') + '；已收录的也占名额，只跳过详情。' : c.incrementalDetails ? '默认刷新最多 ' + c.defaultRefreshBudget + ' 条、回溯最多 ' + c.defaultBackfillBudget + ' 条详情；已完整收录的笔记跳过详情访问。' : current ? '刷新与回溯每次最多采集 ' + current + ' 条内容。' : '当前使用默认：刷新来源 1 页，回溯历史 10 页。留空并保存可恢复默认。'})),
      h('p.muted',{text:c.checkedItems ? '例如设置 5，前 5 条都已收录时不打开任何详情，也不继续向后找旧笔记补足 5 条。' : c.incrementalDetails ? '此设置限制本轮详情读取条数，主页扫描单独设有上限；可能因验证、取消或超时提前停止。' : '平台按页读取，最后一页只保存设定条数内的内容；例如填 35 最多采集 35 条。已收录或解析失败的条目也占名额，不向后补足。'}),error),
      footer:[ui.btn('取消',{onClick:function () { layer.close(); }}),save]});
  }
  function scheduleText(c) {
    var s = c.schedule;
    if (!s || s.state === 'manual') return '按需获取更新';
    if (s.state === 'running') return '正在检查更新';
    if (['blocked','paused','suspended'].includes(s.state)) return s.reason;
    return s.next_due ? (s.state === 'retrying' ? '重试：' : '下次：') + fmt.absolute(s.next_due*1000) : s.reason;
  }
  function scheduleDialog(app,c) {
    var mode = c.syncMode || 'manual', saving = false;
    var interval = h('input.input',{id:'refresh-interval',type:'number',min:5/60,max:72,step:'any',value:String((c.intervalSeconds || 86400)/3600)});
    var error = h('p.field__error',{role:'alert'});
    var select = ui.select([{value:'manual',label:'手动刷新'},{value:'automatic',label:'自动刷新'}],mode,function(value) {
      mode = value; interval.disabled = mode === 'manual'; error.textContent='';
    },{ariaLabel:'同步模式'});
    interval.disabled = mode === 'manual';
    var save = ui.btn('保存同步设置',{variant:'primary',onClick:async function () {
      if (saving) return;
      var hours = Number(interval.value), minutes = Math.round(hours*60);
      if (!Number.isFinite(hours) || minutes < 5 || minutes > 4320 || Math.abs(hours*60-minutes)>0.000001) {
        error.textContent='请输入 5 分钟到 72 小时之间的间隔，精确到分钟；例如 0.5 小时'; return;
      }
      saving = true; save.disabled = true; select._input.disabled = true; interval.disabled = true;
      try {
        await app.client.updateChannel(c.id,{syncMode:mode,intervalSeconds:minutes*60});
        layer.close(); await SF.app.refreshData(true); ui.toast(mode === 'manual' ? '已切换为手动刷新' : '已保存自动刷新计划');
      } catch(err) { error.textContent=err.message; }
      finally { saving = false; save.disabled = false; select._input.disabled = false; interval.disabled = mode === 'manual'; }
    }});
    var layer = ui.dialog({title:c.name + ' · 同步设置',body:h('div.col',{style:{gap:'16px'}},
      h('div.field',null,h('span.field__label',{text:'同步模式'}),select),
      h('div.field',null,h('label.field__label',{htmlFor:'refresh-interval',text:'自动刷新间隔（小时）'}),interval,
        h('p.field__hint',{text:'默认 24 小时，最多 72 小时，最少 5 分钟。可输入小数，切回手动会保留此设置。'})),
      h('p.muted',{text:'自动模式只在应用运行、电脑未休眠时检查。首次自动检查在设定间隔后执行，也可随时手动刷新。'}),error),
      footer:[ui.btn('取消',{onClick:function () { layer.close(); }}),save]});
  }
  function bottomPanels(app) {
    return h('div.channels__bottom',{'data-refresh-key':'channel-bottom'},
      h('section.panel.live-panel',null,h('h2.t-h2',{text:'渠道与连接'}),app.session.connections.map(function (c) {
        var r = c.readiness, ops = descriptorFor(app, c).operations || {};
        var intakeOnly = !(ops.resolve_source && ops.resolve_source.supported);
        return h('div.connection-card',null,h('h3',{text:SF.catalog.platform(c.channel).name}),
          intakeOnly
            ? h('p.muted',{text:'仅支持自主添加：在收件箱粘贴文章链接即可收录，无需登录，也不订阅公众号。'})
            : (c.backend === 'electron-session'
                ? h('p.muted',{text:'使用应用内独立会话，无需启动 Chrome。登录后关闭登录窗口，再检查连接。'})
                : c.backend === 'direct-http'
                  ? h('p.muted',{text:'由核心进程直接读取公开网页，不使用浏览器会话，也不需要登录。'})
                  : null),
          h('p',{text:r ? r.reason : '尚未检查采集环境'}),
          h('p.muted',{text:'认证：' + ({unknown:'尚未确认',required:'需要登录',available:'已有可用会话',not_required:'无需登录'}[r && r.authentication] || '尚未确认')}),
          r ? h('p.muted',{text:'检查时间：' + fmt.absolute(r.checked_at)}) : null,
          h('div.row.row-gap-3',null,
            !intakeOnly && c.backend === 'electron-session' ? ui.btn('应用内登录 ' + SF.catalog.platform(c.channel).name,{onClick:function () { SF.app.act('login:' + c.id,function () { return app.client.loginConnection(c.id); }); }}) : null,
            ui.btn('检查连接',{onClick:function () { SF.app.act('check:' + c.id,async function () { await app.client.checkConnection(c.id); await SF.app.refreshData(true); }); }})));
      }),h('p.field__hint',{text:'自动采集遇到登录或访问验证会暂停，处理后检查连接即可恢复。采集失败时仍可查看本地内容。'})),
      runsPanel(app));
  }
  function runsPanel(app) {
    return h('section.panel.live-panel',{'data-runs-panel':'','data-refresh-key':'recent-runs'},h('h2.t-h2',{text:'最近任务（最多 100 条）'}),
        app.runs.length ? h('div.run-list',null,app.runs.map(function (run) {
          var canCancel = ['queued','running','waiting'].includes(run.state);
          var canRetry = ['failed','partial','waiting','interrupted','cancelled'].includes(run.state);
          return h('div.run-row',{'data-run-id':run.id,'data-refresh-key':'run:' + run.id,
            'data-refresh-boundary':true,'data-refresh-preserve':JSON.stringify(run)},h('div.row',null,h('strong',{text:run.channelName}),h('div.spacer'),ui.tag(fmt.runState(run.state))),
            h('p',{text:run.message}), h('p.muted',{text:({manual:'手动',automatic:'自动',recovery:'恢复'}[run.trigger] || '手动') + ' · ' + ({initial:'初次获取',refresh:'近期刷新',backfill:'历史回溯',detail:'详情补充'}[run.kind] || run.kind) + (run.kind === 'detail' ? ' · 更新已有内容' : Object.keys(run.acquisitionMetrics || {}).length ? ' · 已保存 ' + run.items + ' 条 · 新增 ' + run.newItems + ' 条' : ' · 已提交 ' + run.pages + ' 页 · ' + run.items + ' 条 · 新增 ' + run.newItems + ' 条')}),
            run.kind !== 'detail' ? h('p.scope-note',{text:fmt.coverage(run.scope)}) : null,
            ['queued','running'].includes(run.state) ? ui.progress(0,true) : null,
            canCancel ? ui.btn('取消任务',{onClick:function () { SF.app.act('cancel:' + run.id,async function () { await app.client.cancelRun(run.id); await SF.app.refreshData(true); }); }}) : null,
            canRetry ? ui.btn('重试任务',{onClick:function () { SF.app.act('retry:' + run.id,async function () { await app.client.retryRun(run.id); await SF.app.refreshData(true); }); }}) : null);
        })) : h('p.muted',{text:'还没有采集任务'}));
  }
  function addDialog(app) {
    var connections = app.session.connections.filter(function (c) { return c.enabled && subscribable(app, c); });
    if (!connections.length) { ui.toast('没有可添加来源的渠道；微信公众号请在收件箱用「添加内容」','error'); return; }
    var connectionId = connections[0].id, chosen = null, requestId = 0, busy = false, closed = false, searchLocked = false;
    var disabledBefore = new Map();
    var input = h('input.input',{id:'source-input',placeholder:'输入作者 UID、主页链接或搜索名称',autocomplete:'off'});
    var results = h('div.source-results'), error = h('p.field__error',{'role':'alert'});
    var confirm = h('input',{type:'checkbox',id:'source-confirm',disabled:true});
    var add = ui.btn('确认添加',{variant:'primary',disabled:true,onClick:async function () {
      if (busy || !chosen || !confirm.checked) return;
      busy = true; setBusy(true); error.textContent = '';
      try {
        await app.client.createChannel({platform:chosen.channel,connectionId:connectionId,link:chosen.url,confirmed:true});
        layer.close(); await SF.app.refreshData(true); ui.toast('已添加来源，可点击刷新获取内容');
      } catch (err) { error.textContent = err.message; }
      finally { busy = false; if (!closed) setBusy(false); }
    }});
    function clearChoice() { requestId++; chosen=null; confirm.checked=false; confirm.disabled=true; add.disabled=true; results.replaceChildren(); error.textContent=''; }
    input.addEventListener('input',clearChoice);
    confirm.addEventListener('change',function () { add.disabled = busy || !chosen || !confirm.checked; });
    function setBusy(value) {
      if(value) {
        layer.el.querySelectorAll('button, input, select, textarea').forEach(function(control) {
          if(!disabledBefore.has(control)) disabledBefore.set(control,control.disabled);
          control.disabled=true;
        });
      } else {
        disabledBefore.forEach(function(disabled,control) { control.disabled=disabled; }); disabledBefore.clear();
      }
      input.disabled=value; platform.querySelectorAll('button').forEach(function(button) { button.disabled=value; });
      resolve.disabled=value; search.disabled=value || !searchSupported();
      confirm.disabled=value || !chosen; add.disabled=value || !chosen || !confirm.checked;
      if(login) login.disabled=value; if(check) check.disabled=value;
    }
    function searchSupported() {
      var c = connections.find(function (v) { return v.id === connectionId; });
      return app.session.channels.some(function (d) { return d.channel === c.channel && d.backend === c.backend && d.operations.search_sources && d.operations.search_sources.supported; });
    }
    function choose(source) {
      if(busy || closed) return;
      chosen = source; confirm.checked=false; confirm.disabled=false; add.disabled=true;
      results.replaceChildren(ui.notice({tone:'info',title:source.name + ' · 作者 ID ' + source.external_id,
        text:(source.description ? source.description + '\n' : '') + source.url + (source.confirmed ? ' · 请核对是否为你要订阅的作者。' : ' · 仅完成地址解析，尚未验证账号存在，请核对作者 ID。')}));
    }
    async function locate(searching) {
      if(busy) return;
      clearChoice(); var ticket = requestId, text=input.value.trim();
      if(!text) { error.textContent='请输入 UID、主页或名称'; return; }
      var selected=connections.find(function(c) { return c.id===connectionId; });
      searchLocked=searching && selected.backend==='electron-session';
      busy=true; setBusy(true); var timeout;
      if(searchLocked) results.replaceChildren(h('p',{role:'status',text:'正在搜索'+SF.catalog.platform(selected.channel).name+'作者…（最多 60 秒）'}));
      try {
        var query={connectionId:connectionId,text:text};
        var pending=app.client[searching?'searchSources':'resolveSource'](query);
        var response=await (searchLocked ? Promise.race([pending,new Promise(function(_resolve,reject) {
          timeout=setTimeout(function() { reject(new Error('作者搜索超过 60 秒，已停止，请稍后重试。')); },60000);
        })]) : pending);
        if(closed || requestId!==ticket) return;
        if(!searching) { busy=false; choose(response); }
        else if(!response.items.length) results.replaceChildren(h('p',{text:'没有匹配的作者，请修改关键词或使用 UID。'}));
        else results.replaceChildren.apply(results,response.items.map(function(source) {
          return h('button.btn.source-candidate',{type:'button','data-source-id':source.external_id,onclick:function () { choose(source); }},source.avatar ? h('img.source-candidate__avatar',{src:source.avatar,alt:'',referrerpolicy:'no-referrer'}) : ui.avatar(source.name),h('div.col',null,h('strong',{text:source.name + ' · 作者 ID ' + source.external_id}),source.description ? h('span.muted',{text:source.description}) : null));
        }));
      } catch(err) { if(!closed && requestId===ticket) { results.replaceChildren(); error.textContent=err.message; } }
      finally { clearTimeout(timeout); busy=false; searchLocked=false; if(!closed) setBusy(false); }
    }
    var platform=h('div.row.row-gap-3.source-platforms',{role:'group','aria-label':'来源平台'},connections.map(function(c) {
      var button=ui.btn(SF.catalog.platform(c.channel).name,{variant:c.id===connectionId?'primary':'ghost',onClick:function() {
        if(busy) return; connectionId=c.id; clearChoice();
        platform.querySelectorAll('button').forEach(function(button) {
          var active=button.dataset.connectionId===connectionId;
          button.classList.toggle('btn--primary',active);button.classList.toggle('btn--ghost',!active);button.setAttribute('aria-pressed',String(active));
        }); setBusy(false);
      }}); button.dataset.connectionId=c.id; button.setAttribute('aria-pressed',String(c.id===connectionId)); return button;
    }));
    var resolve=ui.btn('解析 UID / 主页',{onClick:function () { locate(false); }});
    var search=ui.btn('搜索作者',{variant:'primary',disabled:!searchSupported(),onClick:function () { locate(true); }});
    var login=ui.btn('应用内登录',{onClick:function () { SF.app.act('login:' + connectionId,function () { return app.client.loginConnection(connectionId); }); }});
    var check=ui.btn('检查连接',{onClick:function () { SF.app.act('check:' + connectionId,async function () { var status=await app.client.checkConnection(connectionId); if(!closed) error.textContent=status.state==='ready' ? '' : status.reason; await SF.app.refreshData(true); }); }});
    var layer=ui.dialog({title:'添加渠道或创作者',wide:true,body:h('div.col',{style:{gap:'16px'}},
      h('div.field',null,h('span.field__label',{text:'来源平台'}),platform),
      h('div.field',null,h('label.field__label',{htmlFor:'source-input',text:'作者 UID、主页或名称'}),input),
      h('div.row.row-gap-3',null,search,resolve,login,check),h('p.field__hint',{text:'输入昵称搜索并选择正确作者。首次使用或登录失效时，先在应用内登录，关闭登录窗口后检查连接。'}),results,error,
      h('label.row.row-gap-3',null,confirm,h('span',{text:'我已核对账号，确认追踪此作者'}))),
      footer:[h('p.field__hint',{text:'添加后手动刷新。相同 UID 不会重复订阅。'}),h('div.spacer'),ui.btn('取消',{onClick:function(){layer.close();}}),add],
      beforeClose:function(){return !searchLocked;},onClose:function(){closed=true;requestId++;}});
  }
  SF.views = SF.views || {};
  SF.views.channels = {render:render,reset:function(){cache={};},invalidate:invalidate,whenIdle:whenIdle,updateRuns:updateRuns};
})(window);
