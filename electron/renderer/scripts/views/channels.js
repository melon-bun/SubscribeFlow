/* 沿用 F1 渠道表格、弹层和底部双面板，接入真实订阅、连接与任务。 */
(function (global) {
  'use strict';
  var SF = global.SF, h = SF.dom.h, ui = SF.ui, fmt = SF.fmt;
  var cache = {}, keyword = '', searchTimer;
  var runStates = new Map(), runScrollPositions = new Map();
  /* M45 公众号付费渠道（wxrank）。
     渠道状态、页数、调用次数、积分与余额全部来自 Core 的渠道状态接口：
     界面不推算费用，也不显示本地预算上限——本期没有余额闸门，
     余额只是服务端最近一次的观察值，读不到就是「未知」。 */
  var wxrank = {loaded:false, loading:false, stale:false, data:null, error:null, promise:null,
                draftKey:'', draftBiz:'', checkText:'', testText:''};
  function reload() { cache = {keyword:keyword}; renderView(); }
  function renderView() { SF.app.renderView('channels'); }
  function invalidate(reasons) {
    var relevant = ['all', 'channels'].some(function (name) { return reasons && (reasons.has ? reasons.has(name) : reasons.indexOf(name) >= 0); });
    if (!relevant) return;
    cache.stale = true; cache.revision = (cache.revision || 0) + 1;
    /* M45：全量刷新时重读一次渠道状态，密钥与用量不会停在旧值上。
       只读本地，不发请求也不花钱。 */
    if (reasons && (reasons.has ? reasons.has('all') : reasons.indexOf('all') >= 0)) wxrank.stale = true;
  }
  function whenIdle() {
    var pending = [cache.promise, cache.coveragePromise, wxrank.promise].filter(Boolean);
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
  /* 「静流」§渠道管理：最近任务改成「状态点 + 文字」，失败用红色。
     状态点本身带 title，鼠标悬停能看到具体状态与时间。 */
  function latestRun(app, id) {
    var job = app.runs.find(function (run) { return run.channelId === id; });
    if (!job) return h('span.muted',{text:'尚未采集'});
    var tone = job.state === 'failed' ? 'bad'
      : job.state === 'succeeded' ? 'ok'
      : ['running','queued'].includes(job.state) ? 'busy'
      : ['partial','waiting','interrupted','cancelled'].includes(job.state) ? 'warn' : null;
    return h('div.table__time',null,
      h('span.run-cell',null,ui.statusDot(tone, fmt.runState(job.state)),h('span',{text:fmt.runState(job.state)})),
      h('small',{text:fmt.relative(job.startedAt,app.now)}));
  }
  function updateRuns(app) {
    var active = ['queued', 'running', 'waiting'];
    app.runs.forEach(function (run) {
      if ((!runStates.has(run.id) || active.includes(runStates.get(run.id))) && !active.includes(run.state)) {
        cache.coverageDirty = cache.coverageDirty || new Set();
        cache.coverageDirty.add(run.channelId);
        /* M45：付费任务结束后重读一次渠道状态，用量与余额才对得上。 */
        var sub = (cache.items || []).filter(function (s) { return s.id === run.channelId; })[0];
        if (sub && sub.paid) wxrank.stale = true;
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
    if (wxrank.stale) ensureWxrankStatus(app);
  }
  function descriptorFor(app, connection) {
    return (app.session.channels || []).filter(function (d) { return d.channel === connection.channel && d.backend === connection.backend; })[0] || {};
  }
  // 只有能定位来源的渠道才出现在「添加渠道或创作者」里。
  function subscribable(app, connection) {
    var ops = descriptorFor(app, connection).operations || {};
    return !!(ops.resolve_source && ops.resolve_source.supported);
  }
  function render(app) {
    if (cache.keyword !== keyword) cache = {keyword:keyword};
    if (!runStates.size) app.runs.forEach(function (run) { runStates.set(run.id, run.state); });
    ensureWxrankStatus(app);
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
    /* M42：来源默认优先级已经搬进设置页的「优先级设置」。
       这里只剩渠道本身，不再挂一个空的切换栏。 */
    else body = h('div.col.grow.channels-content.scroll-y', {style:{gap:'20px'},'data-refresh-key':'channel-content'},
      cache.refreshError ? h('p.field__error',{role:'status','data-refresh-key':'channel-refresh-error',text:'更新失败，正在显示已加载内容：' + cache.refreshError.message}) : null,
      channelList(app),
      !cache.loaded ? null : bottomPanels(app));
    return h('div.view', {'data-view':'channels','data-refresh-key':'channels'}, h('div.view__head', null,
      h('div.view__head-text', null, h('h1.t-h1',{text:'渠道管理'}), h('p.view__desc',{text:'管理关注的创作者，选择手动或自动刷新，并查看采集状态。'})),
      h('div.view__actions', null, ui.btn('添加渠道或创作者',{variant:'primary',icon:'plus',disabled:!app.session.capabilities.canManageChannels,onClick:function () { addDialog(app); }}))),
      h('div.view__body', null, body));
  }
  function channelList(app) {
    var toolbar = h('div.channels__toolbar', {'data-refresh-key':'channel-toolbar'}, h('h2.t-h2',{text:'全部渠道（' + (cache.items ? cache.items.length : '—') + '）'}), h('div.spacer'),
      ui.searchInput('搜索创作者或链接...', keyword, function (v) { keyword = v; clearTimeout(searchTimer); searchTimer = setTimeout(reload,240); }),
      ui.btn('重新查询',{icon:'refresh',onClick:function () { SF.app.refreshData(true); }}));
    if (!cache.loaded) return h('div.channels__list',{'data-refresh-key':'channel-list'},toolbar,ui.state({icon:'clock',title:'正在载入渠道…'}));
    if (!cache.items.length) return h('div.channels__list',{'data-refresh-key':'channel-list'},toolbar,h('div.panel',null,ui.state({icon:'folder-open',title:keyword ? '没有匹配的来源' : '还没有添加任何来源',desc:'使用作者 UID、主页链接或搜索结果添加来源，然后手动刷新。',actions:[{label:'添加来源',variant:'primary',onClick:function () { addDialog(app); }}]})));
    return h('div.channels__list',{'data-refresh-key':'channel-list'},toolbar,h('div.panel.channels__table-wrap',null,h('table.table.dt.live-channels',null,
      /* 「静流」§渠道管理：平台列并入创作者名前的平台方块，表格少一列。 */
      h('thead',null,h('tr',null,['创作者 / 频道名','主页','同步方式','状态','覆盖范围','最近任务','操作'].map(function (label) { return h('th',{text:label}); }))),
      h('tbody',null,cache.items.map(function (c,i) {
        var cov = cache.coverage[i];
        return h('tr',{'data-channel-id':c.id,'data-refresh-key':'channel:' + c.id,'data-refresh-boundary':true,
          'data-refresh-preserve':JSON.stringify([c,cov])},
          /* 「静流」§.who：头像在左，平台方块跟着名字走（名字行里），
             整列都扫得见的只有头像 + 名字 + UID。 */
          h('td',null,h('div.channel-cell',null,ui.avatar(c.name),h('div.channel-cell__text',null,h('div.channel-cell__name',null,ui.platformIcon(c.platform),h('span',{text:c.name})),h('div.channel-cell__desc',null,h('span',{text:'UID '}),h('span.mono',{text:c.externalId}))))),
          h('td',null,c.capabilities.canOpenHomepage === false
            /* M45：公众号渠道的来源地址是内部定位用的公众号地址，不是可浏览主页。 */
            ? ui.btn('打开主页',{size:'sm',disabled:true,title:'该地址是内部定位用的公众号地址，不是可浏览主页；文章原文在内容详情里打开。'})
            : ui.btn('打开主页',{size:'sm',icon:'external',onClick:function () { SF.app.act('source:' + c.id,function () { return app.client.openChannel(c.id); }); }})),
          h('td',null,h('div.cadence',null,
            h('b',null,ui.btn(c.frequency,{size:'sm',onClick:function () { scheduleDialog(app,c); },ariaLabel:'设置同步方式 ' + c.name})),
            h('small',{text:scheduleText(c)}))),
          h('td',null,ui.toggle(c.enabled,function (enabled) { SF.app.act('subscription:' + c.id,async function () { await app.client.setChannelEnabled(c.id,enabled); await SF.app.refreshData(true); }); },{label:(c.enabled?'暂停 ':'恢复 ') + c.name})),
          h('td',null,h('button.badge.coverage-cell' + (cov.complete?'':'.coverage-cell--limited'),{type:'button',title:cov.detail,onclick:function () { ui.dialog({title:c.name + ' · 覆盖范围',body:ui.notice({tone:cov.complete?'info':'warn',text:cov.detail})}); }},SF.icon(cov.complete?'check':'clock',14),h('span',{text:cov.label}))),
          h('td',{'data-channel-run':c.id},latestRun(app,c.id)),
          h('td',null,h('div.ops.table__ops',null,
            ui.iconBtn('refresh','刷新来源',function () { if (c.paid) wxrankRunDialog(app,c,'recent'); else startRun(app,c,'recent'); },{disabled:!c.enabled || !c.capabilities.canRefresh}),
            ui.iconBtn('clock','回溯历史',function () { if (c.paid) { wxrankRunDialog(app,c,'backfill'); return; } var pages = collectPages(c,c.defaultBackfillBudget || 10); ui.confirm({title:'回溯 ' + c.name,message:c.checkedItems ? '本次按主页顺序检查前 ' + pages + ' 条' + (c.contentNoun || '内容') + '。已收录的也占一个名额，跳过详情后不向后补足；结果不代表全部历史。' : c.incrementalDetails ? '本次最多读取 ' + pages + ' 条' + (c.contentNoun || '内容') + '详情，已完整收录的会跳过；主页分页扫描有上限，结果不代表全部历史。' : '本次最多采集 ' + (c.collectItems || pages*(c.pageSize || 20)) + ' 条内容。已收录或解析失败的条目也占名额，不向后补足；回溯成功不代表全部历史已获取。',confirmText:'开始回溯'}).then(function (ok) { if(ok) startRun(app,c,'backfill'); }); },{disabled:!c.enabled || !c.capabilities.canBackfill}),
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
    /* 付费渠道按整页采集：这个条数用来折算扫描页数，不是保存条数的硬上限。 */
    var paid = c.paid;
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
        ui.toast(items ? paid ? '刷新与回溯每次最多扫描 ' + items + ' 条（折算页数）' : c.checkedItems ? '刷新与回溯每次检查前 ' + items + ' 条' + (c.contentNoun || '内容') : '刷新与回溯每次最多采集 ' + items + ' 条' : '已恢复默认采集条数');
      } catch(err) { error.textContent = err.message; }
      finally { saving = false; save.disabled = false; input.disabled = false; }
    }});
    var layer = ui.dialog({title:c.name + ' · 采集条数',body:h('div.col',{style:{gap:'16px'}},
      h('div.field',null,h('label.field__label',{htmlFor:'collect-items',text:'每次采集条数（1-50）'}),input,
        h('p.field__hint',{text: paid ? (current ? '刷新与回溯每次最多扫描 ' + current + ' 条（折算页数）。' : '当前使用默认：刷新来源 1 页，回溯历史 3 页。留空并保存可恢复默认。') : c.checkedItems ? '默认刷新检查前 ' + c.defaultRefreshBudget + ' 条、回溯检查前 ' + c.defaultBackfillBudget + ' 条' + (c.contentNoun || '内容') + '；已收录的也占名额，只跳过详情。' : c.incrementalDetails ? '默认刷新最多 ' + c.defaultRefreshBudget + ' 条、回溯最多 ' + c.defaultBackfillBudget + ' 条详情；已完整收录的笔记跳过详情访问。' : current ? '刷新与回溯每次最多采集 ' + current + ' 条内容。' : '当前使用默认：刷新来源 1 页，回溯历史 10 页。留空并保存可恢复默认。'})),
      h('p.muted',{text: paid ? '付费渠道按整页采集：这个条数用来折算扫描页数（每次调用买下一整页），实际保存条数可能多于设定值。' : c.checkedItems ? '例如设置 5，前 5 条都已收录时不打开任何详情，也不继续向后找旧笔记补足 5 条。' : c.incrementalDetails ? '此设置限制本轮详情读取条数，主页扫描单独设有上限；可能因验证、取消或超时提前停止。' : '平台按页读取，最后一页只保存设定条数内的内容；例如填 35 最多采集 35 条。已收录或解析失败的条目也占名额，不向后补足。'}),error),
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
      /* M45：付费渠道的自动检查每次都要调用付费接口，必须先说清。 */
      c.paid ? ui.notice({tone:'warn',text:'启用自动检查后，每次检查都会调用付费接口并产生费用。默认仍是手动刷新。'}) : null,
      h('p.muted',{text:'自动模式只在应用运行、电脑未休眠时检查。首次自动检查在设定间隔后执行，也可随时手动刷新。'}),error),
      footer:[ui.btn('取消',{onClick:function () { layer.close(); }}),save]});
  }
  function bottomPanels(app) {
    return h('div.channels__bottom',{'data-refresh-key':'channel-bottom'},
      h('section.panel.live-panel',null,h('h2.t-h2',{text:'渠道与连接'}),app.session.connections.map(function (c) {
        return connectionRow(app,c);
      }),h('p.field__hint',{text:'自动采集遇到登录或访问验证会暂停，处理后检查连接即可恢复。采集失败时仍可查看本地内容。'})),
      runsPanel(app));
  }

  /* M24：渠道与连接折叠列表。
     展开状态只存在本次会话：离开再回来还在，重启应用全部收起。
     用稳定连接 ID 记录，不同渠道互不影响。 */
  var expandedConnections = new Set();

  function toggleConnection(id) {
    if (expandedConnections.has(id)) expandedConnections.delete(id);
    else expandedConnections.add(id);
    renderView();
  }

  /**
   * 连接状态（M24）：只用 readiness 的真实语义映射。
   *
   * 「无需登录」只说明这个能力不要求登录，不等于可用性检查已经通过：
   * 真正跑过采集检查（operation=list_items）的 ready 才算「可用」，
   * 其余按各自能力如实说明，不拿一句「无需登录」糊弄过去。
   */
  function connectionStatus(app, c) {
    var ops = descriptorFor(app, c).operations || {};
    var intakeOnly = !(ops.resolve_source && ops.resolve_source.supported);
    var r = c.readiness;
    if (SF.app.isPending('check:' + c.id)) {
      return {tone:'brand', label:'检查中', reason:'正在检查采集环境…'};
    }
    if (intakeOnly) {
      // 仅自主添加的渠道没有采集环境可查：说清它能做什么，不假装有状态可查。
      if (r && r.state === 'blocked') return {tone:'danger', label:'连接异常', reason:r.reason};
      return {tone:'neutral', label:'仅自主添加', reason:'只支持在收件箱粘贴文章链接收录，不订阅也不采集。'};
    }
    if (!r || r.state === 'unknown') return {tone:'neutral', label:'待检查', reason:'尚未检查采集环境'};
    if (r.state === 'ready') {
      if (r.operation === 'list_items') return {tone:'success', label:'可用', reason:r.reason};
      // 公开读取类渠道：能力不要求登录，但可用性还没被真正检查过。
      return {tone:'neutral', label:'待检查', reason:r.reason};
    }
    if (r.state === 'blocked') {
      if (r.authentication === 'required' || r.authentication === 'expired') {
        return {tone:'warn', label:'需登录', reason:r.reason};
      }
      if ((r.actions || []).indexOf('open_browser') >= 0) {
        return {tone:'warn', label:'需处理访问验证', reason:r.reason};
      }
      return {tone:'danger', label:'连接异常', reason:r.reason};
    }
    return {tone:'danger', label:'连接异常', reason:r.reason || '连接不可用'};
  }

  function connectionRow(app, c) {
    var ops = descriptorFor(app, c).operations || {};
    var intakeOnly = !(ops.resolve_source && ops.resolve_source.supported);
    var paidConnection = descriptorFor(app,c).paid ? c : null;
    var status = connectionStatus(app, c);
    if (paidConnection) status = {tone:'neutral', label:'含付费 API'};
    var r = c.readiness;
    var open = expandedConnections.has(c.id);
    var detailId = 'connection-detail-' + c.id;
    var name = SF.catalog.platform(c.channel).name;
    return h('div.connection-row' + (open ? '.is-open' : ''),{'data-connection-id':c.id},
      h('button.connection-row__head',{
        type:'button',
        'aria-expanded':open ? 'true' : 'false',
        'aria-controls':detailId,
        onclick:function () { toggleConnection(c.id); }
      },
        SF.icon(open ? 'chevron-down' : 'chevron-right',14),
        h('span.connection-row__name',{text:name}),
        h('span.spacer'),
        h('span.badge.badge--' + status.tone,{text:status.label})),
      h('div.connection-row__detail',{id:detailId},
        paidConnection
          ? h('p.muted',{text:'文章链接可在收件箱直接收录，无需登录。公众号订阅请配置下方付费 API。'})
          : intakeOnly
          ? h('p.muted',{text:'仅支持自主添加：在收件箱使用「添加内容」收录单条链接，此连接不提供来源订阅。'})
          : (c.backend === 'electron-session'
              ? h('p.muted',{text:'使用应用内独立会话，无需启动 Chrome。登录后关闭登录窗口，再检查连接。'})
              : c.backend === 'direct-http'
                ? h('p.muted',{text:'由核心进程直接读取公开网页，不使用浏览器会话，也不需要登录。'})
                : null),
        paidConnection ? null : h('p',{text:r ? r.reason : '尚未检查采集环境'}),
        paidConnection ? null : h('p.muted',{text:'认证：' + ({unknown:'尚未确认',required:'需要登录',available:'已有可用会话',not_required:'无需登录'}[r && r.authentication] || '尚未确认')}),
        !paidConnection && r ? h('p.muted',{text:'检查时间：' + fmt.absolute(r.checked_at)}) : null,
        paidConnection ? wxrankCard(app,paidConnection) : h('div.row.row-gap-3',null,
          !intakeOnly && c.backend === 'electron-session' ? ui.btn('应用内登录 ' + name,{onClick:function () { SF.app.act('login:' + c.id,function () { return app.client.loginConnection(c.id); }); }}) : null,
          ui.btn('检查连接',{onClick:function () {
            // 结果直接写回会话数据：状态立刻更新，不必等全量刷新的时序；
            // 动作结束后再重绘一次，那时「检查中」已经解除。展开状态不受影响。
            SF.app.act('check:' + c.id,async function () {
              renderView();                                  // 「检查中」立刻出现
              var result = await app.client.checkConnection(c.id);
              var connection = (app.session.connections || []).filter(function (x) { return x.id === c.id; })[0];
              if (connection) connection.readiness = result;
              await SF.app.refreshData(true);
            }).finally(function () { renderView(); });
          }}))));
  }

  /* ---------------- M45 公众号付费渠道（wxrank） ----------------
     这一段的规矩只有一条：界面不替 Core 算钱。
     页数、调用次数、积分、余额都照渠道状态接口给的显示；
     读不到就写「未知」，绝不填 0，也绝不假装渠道可用。 */

  function wxrankConnection(app) {
    return (app.session.connections || []).filter(function (c) { return descriptorFor(app,c).paid; })[0] || null;
  }
  function wxrankStatus() { return wxrank.data; }
  /** 按来源找它的任务计划：页数、调用次数、积分与检查点。
      来源标识有两种说法：来源表的 id，或规范来源键。
      两种都认，免得两边口径一改就找不到费用。 */
  function wxrankSource(channel) {
    var status = wxrankStatus();
    if (!status || !status.sources || !channel) return null;
    var list = status.sources;
    var bySubscription = list.filter(function (s) { return s.subscriptionId && s.subscriptionId === channel.id; })[0];
    if (bySubscription) return bySubscription;
    var byId = list.filter(function (s) { return s.sourceId === channel.id; })[0];
    if (byId) return byId;
    var byExternal = list.filter(function (s) { return s.externalId && channel.externalId && s.externalId === channel.externalId; })[0];
    return byExternal || null;
  }
  /** 读一次渠道状态。失败不拖垮页面：卡片显示失败与重试，其余照常渲染。 */
  function ensureWxrankStatus(app) {
    if (!wxrankConnection(app)) return;
    if (wxrank.loading) return;
    if (wxrank.loaded && !wxrank.stale) return;
    var current = wxrank;
    current.loading = true; current.stale = false;
    current.promise = Promise.resolve().then(function () {
      if (!app.client || typeof app.client.getWxrankStatus !== 'function') throw new Error('渠道状态接口尚未接通');
      return app.client.getWxrankStatus();
    }).then(function (data) {
      if (wxrank !== current) return;
      current.data = data || {}; current.loaded = true; delete current.error;
    }).catch(function (err) {
      if (wxrank !== current) return;
      current.loaded = true; current.error = err;
    }).finally(function () {
      current.loading = false; current.promise = null;
      renderView();
      if (current.stale) ensureWxrankStatus(app);
    });
  }
  function refreshWxrankStatus(app) {
    wxrank.stale = true;
    ensureWxrankStatus(app);
  }
  /** 一次付费任务的费用说明：次数与积分照 Core 给的实际配置显示。 */
  function wxrankCostText(plan) {
    if (!plan) return null;
    var calls = plan.totalCalls == null ? plan.listCalls : plan.totalCalls;
    var parts = [];
    if (calls != null) parts.push('本次最多 ' + calls + ' 次调用');
    if (plan.credits != null) parts.push('约 ' + plan.credits + ' 积分');
    return parts.length ? parts.join(' · ') : null;
  }
  /** 检查点说明。过期或版本变化一律说「本次从头重扫」，不能说成续采。 */
  function wxrankCheckpointText(cp) {
    if (!cp) return null;
    if (cp.state === 'expired') return '检查点已过期，本次从头重扫';
    if (cp.state === 'version_mismatch') return '密钥或解析版本已变化，本次从头重扫';
    return cp.note || '本次从头开始';
  }

  /** 公众号付费渠道卡片：密钥、本地检查、显式付费测试、用量与缓存。 */
  function wxrankCard(app, c) {
    var status = wxrankStatus();
    var title = '公众号 · 付费API';
    var head = h('div.row.row-gap-3',null,
      h('h3.t-h3',{text:title}),
      status ? h('span.badge.badge--' + (status.configured ? 'success' : 'neutral'),{text:status.configured ? '已配置' : '未配置'}) : null,
      h('div.spacer'),
      status ? ui.toggle(status.enabled !== false,function (on) { setWxrankEnabled(app,on); },{label:'启用公众号付费采集'}) : null);
    var body;
    if (wxrank.error) {
      body = h('div.col',{style:{gap:'12px'}},
        ui.notice({tone:'danger',title:'读取渠道配置失败',text:(wxrank.error && wxrank.error.message) || '渠道状态读取失败'}),
        ui.btn('重试',{onClick:function () { refreshWxrankStatus(app); }}));
    } else if (!status) {
      body = h('p.muted',{text:'正在读取渠道配置…'});
    } else {
      body = wxrankCardBody(app,c,status);
    }
    return h('div.col.wxrank-card',{style:{gap:'16px'},'data-refresh-key':'wxrank-card'},head,
      ui.notice({tone:'warn',text:'本方案需要使用第三方在线付费 API，解析、刷新、回溯及自动检查均可能产生费用，请谨慎使用。'}),body);
  }

  function wxrankCardBody(app, c, status) {
    var credits = status.creditsPerCall;
    var usage = status.usage || {};
    var balance = status.balance;
    var observed = status.balanceObservedAt ? fmt.absolute(status.balanceObservedAt) : null;
    var parts = [];

    if (status.enabled === false) parts.push(ui.notice({tone:'warn',text:'渠道已停用：付费调用会被核心拒绝。'}));

    /* 密钥：保存后不再回显，界面只显示是否已配置。 */
    var keyError = h('p.field__error',{role:'alert'});
    var keyInput = h('input.input',{id:'wxrank-secret',type:'password',autocomplete:'off',spellcheck:'false',
      placeholder:status.configured ? '输入新密钥以替换' : '粘贴渠道密钥',value:wxrank.draftKey,
      oninput:function (e) { wxrank.draftKey = e.target.value; }});
    parts.push(h('div.field',{'data-refresh-boundary':''},
      h('label.field__label',{htmlFor:'wxrank-secret',text:'渠道密钥'}),
      keyInput,
      h('div.row.row-gap-3',null,
        ui.btn('保存密钥',{variant:'primary',onClick:function () { saveWxrankKey(app,keyInput,keyError); }}),
        status.configured ? ui.btn('清除密钥',{variant:'danger-soft',onClick:function () { clearWxrankKey(app); }}) : null),
      h('p.field__hint',{text:'保存后由系统保护能力加密，界面不再回显，只显示是否已配置。'}),
      keyError));

    /* 免费本地检查：不发网络请求，也不能证明密钥可用。 */
    parts.push(h('div.row.row-gap-3',null,
      ui.btn('检查配置',{onClick:function () { checkWxrankConfig(app,c); }}),
      wxrank.checkText ? h('span.muted',{text:wxrank.checkText}) : null));
    parts.push(h('p.field__hint',{text:'只查本地是否已配置，不发网络请求，也不能证明密钥可用。'}));

    /* 显式付费测试：会花钱，必须先确认。 */
    var bizError = h('p.field__error',{role:'alert'});
    var bizInput = h('input.input',{id:'wxrank-biz',autocomplete:'off',placeholder:'公众号 biz（Mz…）',value:wxrank.draftBiz,
      oninput:function (e) { wxrank.draftBiz = e.target.value; }});
    parts.push(h('div.field',{'data-refresh-boundary':''},
      h('label.field__label',{htmlFor:'wxrank-biz',text:'付费测试'}),
      h('div.row.row-gap-3',null,bizInput,
        ui.btn(credits == null ? '测试接口' : '测试接口 · 预计 ' + credits + ' 积分',{onClick:function () { testWxrank(app,c,bizInput,bizError); }})),
      h('p.field__hint',{text:'需要公众号 biz；这次调用绕过解析缓存，会真的产生一次付费调用。'}),
      wxrank.testText ? h('p.muted',{text:wxrank.testText}) : null,
      bizError));

    /* 本地用量：只显示已确认值与未知次数，余额读不到就写未知。 */
    parts.push(h('div.col',{style:{gap:'4px'}},
      h('p',{text:'本月已确认用量 ' + (usage.confirmedCredits == null ? 0 : usage.confirmedCredits) + ' 积分'}),
      h('p',{text:'扣费结果未知 ' + (usage.unknownCount == null ? 0 : usage.unknownCount) + ' 次'}),
      h('p',{text:'最近服务端余额 ' + (balance == null ? '未知' : String(balance) + (observed ? '（观察于 ' + observed + '）' : ''))})));
    parts.push(h('div.row.row-gap-3',null,ui.btn('清理解析缓存',{onClick:function () { clearWxrankCache(app); }})));

    /* 限制说明照 Core 给的逐条显示。 */
    (status.limits || []).forEach(function (text) { parts.push(h('p.field__hint',{text:text})); });
    return h('div.col',{style:{gap:'16px'}},parts);
  }

  function saveWxrankKey(app, input, error) {
    var value = String(input.value || '').trim();
    if (!value) { error.textContent = '请输入密钥'; return; }
    SF.app.act('wxrank-secret',async function () {
      try {
        await app.client.saveSettings({section:'channels',patch:{wxrank:{enabled:true}},credentials:{wxrank:value}});
        wxrank.draftKey = ''; input.value = '';
        ui.toast('密钥已保存');
      } catch (err) { error.textContent = err.message; return; }
      refreshWxrankStatus(app);
    });
  }
  function clearWxrankKey(app) {
    ui.confirm({title:'清除渠道密钥？',message:'清除后这个渠道不能再调用付费接口，需要重新输入密钥；渠道同时停用。',confirmText:'清除密钥',danger:true}).then(function (ok) {
      if (!ok) return;
      SF.app.act('wxrank-clear',async function () {
        try {
          await app.client.saveSettings({section:'channels',patch:{wxrank:{enabled:false}},credentials:{wxrank:null}});
          wxrank.draftKey = '';
          ui.toast('密钥已清除');
        } catch (err) { ui.toast(err.message,'error'); return; }
        refreshWxrankStatus(app);
      });
    });
  }
  function setWxrankEnabled(app, on) {
    SF.app.act('wxrank-enabled',async function () {
      try {
        await app.client.saveSettings({section:'channels',patch:{wxrank:{enabled:on}}});
        ui.toast(on ? '已启用公众号付费采集' : '已停用公众号付费采集');
      } catch (err) { ui.toast(err.message,'error'); }
      refreshWxrankStatus(app);
    });
  }
  /** 「检查配置」只做本地检查：结果只能说已配置，不能说密钥有效。 */
  function checkWxrankConfig(app, c) {
    SF.app.act('wxrank-check:' + c.id,async function () {
      try {
        var result = await app.client.checkConnection(c.id);
        wxrank.checkText = result && result.state === 'ready' ? '已配置，未联网验证' : ((result && result.reason) || '本地检查未通过');
      } catch (err) {
        wxrank.checkText = '本地检查失败：' + (err.message || '');
      }
      renderView();
    });
  }
  /** 显式付费测试：确认之后才发请求，费用与缓存绕过都写在确认里。 */
  function testWxrank(app, c, input, error) {
    var biz = String(input.value || '').trim();
    if (!biz) { error.textContent = '请填写公众号 biz'; return; }
    var credits = wxrankStatus() ? wxrankStatus().creditsPerCall : null;
    ui.confirm({title:'测试接口 · 会产生付费调用',
      message:'这次会真的调用付费接口，绕过解析缓存，产生一次付费调用' + (credits == null ? '' : '（约 ' + credits + ' 积分）') + '。确认继续？',
      confirmText:'付费测试'}).then(function (ok) {
      if (!ok) return;
      SF.app.act('wxrank-test:' + c.id,async function () {
        try {
          var result = await app.client.testWxrankChannel(biz,c.id);
          wxrank.testText = '已解析：' + ((result && result.name) || biz) + (result && result.externalId ? '（' + result.externalId + '）' : '');
        } catch (err) {
          wxrank.testText = '测试失败：' + (err.message || '');
        }
        refreshWxrankStatus(app);
      });
    });
  }
  function clearWxrankCache(app) {
    SF.app.act('wxrank-cache',async function () {
      try {
        var result = await app.client.clearWxrankCache();
        ui.toast('已清理 ' + ((result && result.cleared) || 0) + ' 条解析缓存');
      } catch (err) { ui.toast(err.message,'error'); return; }
      refreshWxrankStatus(app);
    });
  }
  /** 付费任务的确认框：费用按实际配置推导，空页同样收费也要说清。 */
  async function wxrankRunDialog(app, c, kind) {
    /* 费用必须按实际配置显示。刚添加完来源时状态还没读到它，
       这里先补读一次再开对话框，不让用户看到「读不到费用」。 */
    if (!wxrankSource(c)) {
      try {
        wxrank.data = await app.client.getWxrankStatus();
        wxrank.loaded = true; delete wxrank.error;
      } catch (err) { /* 读不到就按未知显示，不假装知道。 */ }
    }
    var backfill = kind === 'backfill';
    var source = wxrankSource(c);
    /* 任务种类：界面叫「刷新」，Core 的字段叫 refresh。 */
    var planKey = backfill ? 'backfill' : 'refresh';
    var plan = source ? source[planKey] : null;
    var rows = [h('p',{text:wxrankCostText(plan) || '读不到本次费用（渠道状态读取失败），但本次仍可能产生费用。'})];
    if (plan) {
      rows.push(h('p.muted',{text:'最多 ' + (plan.pages == null ? '—' : plan.pages) + ' 页 · 解析 ' + (plan.parseCalls == null ? 0 : plan.parseCalls) + ' 次 · 取列表 ' + (plan.listCalls == null ? 0 : plan.listCalls) + ' 次'}));
    }
    var checkpoint = wxrankCheckpointText(plan ? plan.checkpoint : null);
    if (checkpoint) rows.push(h('p',{text:(backfill ? '回溯起点：' : '刷新起点：') + checkpoint}));
    rows.push(h('p.field__hint',{text:'按整页采集：一次调用买下一整页，实际保存条数可能多于设定的采集条数。'}));
    rows.push(h('p.field__hint',{text:'即使本次采到 0 条新内容，也可能已经产生费用——空页同样收费。'}));
    var layer = ui.dialog({title:(backfill ? '回溯历史 · ' : '刷新来源 · ') + c.name,
      body:h('div.col',{style:{gap:'12px'}},rows),
      footer:[ui.btn('取消',{onClick:function () { layer.close(); }}),
        ui.btn(backfill ? '开始回溯' : '开始刷新',{variant:'primary',onClick:function () { layer.close(); startRun(app,c,kind); }})]});
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
    if (!connections.length) { ui.toast('没有可添加来源的渠道，请先启用支持订阅的连接','error'); return; }
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
      if(login) login.disabled=value || !loginSupported(); if(check) check.disabled=value;
    }
    function searchSupported() {
      var c = connections.find(function (v) { return v.id === connectionId; });
      return app.session.channels.some(function (d) { return d.channel === c.channel && d.backend === c.backend && d.operations.search_sources && d.operations.search_sources.supported; });
    }
    function loginSupported() {
      var connection = connections.find(function (c) { return c.id === connectionId; });
      if (!connection || connection.backend !== 'electron-session') return false;
      var operations = descriptorFor(app,connection).operations || {};
      return Object.keys(operations).some(function (name) {
        return operations[name].supported && operations[name].authentication !== 'not_required';
      });
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
        }); setBusy(false); paintCost();
      }}); button.dataset.connectionId=c.id; button.setAttribute('aria-pressed',String(c.id===connectionId)); return button;
    }));
    /* M45：公众号付费渠道首次添加要解析一次，先说清这次要花多少。 */
    var cost=h('p.field__hint');
    function paintCost() {
      var selected=connections.filter(function(c) { return c.id===connectionId; })[0];
      if(!selected || !descriptorFor(app,selected).paid) { cost.textContent=''; return; }
      var status=wxrankStatus();
      var addCost=status ? status.addCost : null;
      var credits=addCost && addCost.credits != null ? addCost.credits : (status ? status.creditsPerCall : null);
      cost.textContent='首次添加要付费解析一次公众号' + (credits == null ? '（当前费用未读取）' : '，约 ' + credits + ' 积分') + '；确认添加命中缓存，不再收费。';
    }
    paintCost();
    var resolve=ui.btn('解析 UID / 主页',{onClick:function () { locate(false); }});
    var search=ui.btn('搜索作者',{variant:'primary',disabled:!searchSupported(),onClick:function () { locate(true); }});
    var login=ui.btn('应用内登录',{disabled:!loginSupported(),onClick:function () { SF.app.act('login:' + connectionId,function () { return app.client.loginConnection(connectionId); }); }});
    var check=ui.btn('检查连接',{onClick:function () { SF.app.act('check:' + connectionId,async function () { var status=await app.client.checkConnection(connectionId); if(!closed) error.textContent=status.state==='ready' ? '' : status.reason; await SF.app.refreshData(true); }); }});
    var layer=ui.dialog({title:'添加渠道或创作者',wide:true,body:h('div.col',{style:{gap:'16px'}},
      h('div.field',null,h('span.field__label',{text:'来源平台'}),platform),
      h('div.field',null,h('label.field__label',{htmlFor:'source-input',text:'作者 UID、主页或名称'}),input),
      h('div.row.row-gap-3',null,search,resolve,login,check),h('p.field__hint',{text:'输入昵称搜索并选择正确作者。首次使用或登录失效时，先在应用内登录，关闭登录窗口后检查连接。'}),cost,results,error,
      h('label.row.row-gap-3',null,confirm,h('span',{text:'我已核对账号，确认追踪此作者'}))),
      footer:[h('p.field__hint',{text:'添加后手动刷新。相同 UID 不会重复订阅。'}),h('div.spacer'),ui.btn('取消',{onClick:function(){layer.close();}}),add],
      beforeClose:function(){return !searchLocked;},onClose:function(){closed=true;requestId++;}});
  }
  SF.views = SF.views || {};
  SF.views.channels = {render:render,reset:function(){cache={};},invalidate:invalidate,whenIdle:whenIdle,updateRuns:updateRuns};
})(window);
