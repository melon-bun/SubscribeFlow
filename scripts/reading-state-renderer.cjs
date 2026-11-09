'use strict';

// Full Electron / Core acceptance with an isolated on-disk database.
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function verify({window, core, root}) {
  const evaluate = code => window.webContents.executeJavaScript(code);
  const until = async (expression, timeout = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try { const value = await evaluate(expression); if (value) return value; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText'));
  };
  const button = label => evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(n => n.textContent.trim() === ${JSON.stringify(label)});
    if (!b || b.disabled) throw Error('Button unavailable: ' + ${JSON.stringify(label)});
    b.click();
  })()`);
  const setName = (id, value) => evaluate(`(() => {
    const input = document.querySelector('[data-reading-state-name="${id}"]');
    if (!input) throw Error('Missing name field: ${id}');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  const saved = () => core.call('settings.get');
  const resources = require('../electron/main/index.cjs').__resources;
  const read = '值得重温', archived = '已结束';
  await until(`SF.app.state.coreStatus.state === 'ready' && !!document.querySelector('.sidebar')`);

  if (process.env.SUBSCRIBE_FLOW_READING_PHASE === 'restart') {
    await until(`SF.catalog.readingState('read') === ${JSON.stringify(read)} && document.querySelector('[data-quick="archived"]').textContent.includes(${JSON.stringify(archived)})`);
    assert.deepEqual((await saved()).general.readingStateNames, {read, archived});
    assert.match(resources.notifier.format({pendingCount: 0, highUnarchivedCount: 1}), /不在「已结束」中/);
    await evaluate(`SF.app.openSettings()`);
    await until(`document.querySelector('[data-reading-state-name="read"]')?.value === ${JSON.stringify(read)}`);
    await button('恢复默认名称');
    assert.equal((await saved()).general.readingStateNames.read, read, '恢复默认只改草稿');
    await button('取消');
    assert.equal(await evaluate(`document.querySelector('[data-reading-state-name="read"]').value`), read);
    await button('恢复默认名称');
    await button('保存设置');
    await until(`SF.catalog.readingState('read') === '还会再看' && SF.views.settings.dirtySections().length === 0`);
    assert.deepEqual((await saved()).general.readingStateNames, {read: '还会再看', archived: '看完了'});
    console.log(JSON.stringify({readingStateRestart: 'passed', persisted: true, restoreDefaults: true}));
    return;
  }

  await core.stop();
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const day = await evaluate('SF.fmt.ymd(Date.now())');
  const seed = spawnSync(runtime.python, [path.join(root, 'python/tests/seed_renderer.py'), core.dataDir, day], {encoding: 'utf8'});
  assert.equal(seed.status, 0, seed.stderr);
  await core.start();
  await until(`SF.app.state.counts.total === 25 && document.querySelectorAll('.content-card').length === 20`);
  // Seed pre-existing read/archive records before the first general setting exists.
  const legacy = (await core.call('content.list', {limit: 2})).items.map(item => item.id);
  await core.call('content.update', {item_id: legacy[0], patch: {read: true}});
  await core.call('content.update', {item_id: legacy[1], patch: {archived: true}});
  await evaluate(`SF.app.refreshData(true, ['content'])`);
  await until(`SF.app.state.counts.unread === 23 && document.querySelectorAll('.content-card').length === 20`);
  window.setSize(1100, 760);
  const ids = await evaluate(`Array.from(document.querySelectorAll('.content-card')).map(n => n.dataset.contentId)`);
  const actions = require('./renderer-actions.cjs').rendererActions({evaluate, until});
  await actions.selectContent(ids[5]);
  await actions.checkContent(ids[5]);
  await evaluate(`document.querySelector('.inbox__grid.scroll-y').scrollTop = 200`);
  const selected = await evaluate(`SF.app.state.selectedId`);
  const scroll = await evaluate(`document.querySelector('.inbox__grid.scroll-y').scrollTop`);
  assert.ok(scroll > 0, '列表必须可滚动才能验证位置保留');
  const before = await core.call('content.get', {item_id: selected});
  const beforeSettings = await saved();
  await evaluate(`document.querySelector('.user-chip').click()`);
  await until(`document.querySelector('[data-reading-state-name="read"]')`);
  assert.equal(await evaluate(`document.querySelector('.settings__title').textContent`), '通用');
  assert.equal(await evaluate(`document.querySelectorAll('[data-reading-state-name]').length`), 2);
  assert.equal(await evaluate(`!!Array.from(document.querySelectorAll('input')).find(n => n.value === '稍后阅读')`), false);
  if (process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT) {
    fs.mkdirSync(process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT, {recursive: true});
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))`);
    fs.writeFileSync(path.join(process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT, 'general-settings-light.png'), (await window.webContents.capturePage()).toPNG());
  }

  await setName('read', '重复');
  await setName('archived', '重复');
  await button('保存设置');
  await until(`!!document.querySelector('[data-error-key="readingStateNames.archived"]')`);
  assert.deepEqual((await saved()).general, beforeSettings.general);
  await setName('read', '😀'.repeat(13));
  await setName('archived', archived);
  await button('保存设置');
  await until(`document.querySelector('[data-error-key="readingStateNames.read"]')?.textContent.includes('12')`);
  await setName('read', '稍后阅读');
  await button('保存设置');
  await until(`document.querySelector('[data-error-key="readingStateNames.read"]')?.textContent.includes('固定')`);
  assert.deepEqual((await saved()).general, beforeSettings.general);
  await setName('read', read);
  await setName('archived', archived);
  assert.equal(await evaluate(`SF.catalog.readingState('read')`), '还会再看', '未保存的名称不得生效');
  await evaluate(`location.hash = '#/inbox'`);
  await until(`!!document.querySelector('.settings-leave__lead')`);
  assert.ok(await evaluate(`document.querySelector('.settings-leave__lead').textContent.includes('通用')`));
  await button('继续编辑');
  await until(`!document.querySelector('.dialog') && document.querySelector('[data-reading-state-name="read"]')`);
  assert.equal(await evaluate(`document.querySelector('[data-reading-state-name="read"]').value`), read);
  await evaluate(`Array.from(document.querySelectorAll('.settings-nav__item')).find(n => n.textContent.includes('提醒设置')).click()`);
  await until(`document.querySelector('.settings__title').textContent === '提醒设置'`);
  await evaluate(`document.querySelector('[aria-label="启用定时提醒"]').click()`);
  await evaluate(`Array.from(document.querySelectorAll('.settings-nav__item')).find(n => n.textContent.includes('通用')).click()`);
  assert.equal(await evaluate(`document.querySelector('[data-reading-state-name="read"]').value`), read);
  await button('保存设置');
  await until(`SF.catalog.readingState('archived') === ${JSON.stringify(archived)} && !SF.views.settings.isDirty('general')`);
  assert.equal(await evaluate(`SF.views.settings.isDirty('reminder')`), true, '保存通用不得丢弃其它分区草稿');
  const afterSettings = await saved();
  assert.deepEqual(afterSettings.general.readingStateNames, {read, archived});
  assert.equal((await core.call('content.get', {item_id: legacy[0]})).state.read, true);
  assert.equal((await core.call('content.get', {item_id: legacy[1]})).state.archived, true);
  await evaluate(`SF.app.applyReadingStateNames({read:'过期名称', archived:'旧值'}, ${afterSettings.version - 1})`);
  assert.equal(await evaluate(`SF.catalog.readingState('read')`), read, '迟到的旧设置不能覆盖新名称');
  assert.equal(afterSettings.reminder.enabled, beforeSettings.reminder.enabled);
  assert.equal(afterSettings.tagging.revision, beforeSettings.tagging.revision);
  assert.equal(afterSettings.priority.smart.revision, beforeSettings.priority.smart.revision);
  assert.equal(afterSettings.summarization.revision, beforeSettings.summarization.revision);
  assert.match(resources.notifier.format({pendingCount: 1, highUnarchivedCount: 1}), /不在「已结束」中/);
  if (resources.tray && resources.tray.available()) {
    const menu = resources.tray.refreshMenu();
    assert.ok(menu.items.some(item => item.label.includes('不在「已结束」中')));
  }
  await evaluate(`Array.from(document.querySelectorAll('.settings-nav__item')).find(n => n.textContent.includes('提醒设置')).click()`);
  assert.ok(await evaluate(`document.body.innerText.includes('不在「已结束」中')`));
  await button('取消');
  await evaluate(`document.querySelector('[aria-label="关闭设置"]').click()`);
  await until(`document.querySelector('[data-quick="read"]')?.textContent.includes(${JSON.stringify(read)})`);
  assert.equal(await evaluate(`SF.app.state.selectedId`), selected, '返回相同页面保留所选内容');
  assert.equal(await evaluate(`document.querySelector('.inbox__grid.scroll-y').scrollTop`), scroll);
  assert.equal(await evaluate(`document.querySelectorAll('.content-selection > [role="checkbox"][aria-checked="true"]').length`), 1);
  assert.deepEqual((await core.call('content.get', {item_id: selected})).state, before.state);
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.detail .state-btn')).map(n => n.textContent.trim())`), [read, '稍后阅读', archived]);
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.inbox__toolbar button')).some(n => n.textContent.trim() === ${JSON.stringify(read)})`));
  await evaluate(`document.querySelector('[data-quick="read"]').click()`);
  await until(`document.querySelector('.view__title h1')?.textContent === ${JSON.stringify(read)} && document.querySelectorAll('.content-card').length === 1 && document.querySelector('.content-card')?.dataset.contentId === ${JSON.stringify(legacy[0])}`);
  assert.equal(await evaluate(`document.querySelector('.content-card').dataset.contentId`), legacy[0]);
  await evaluate(`document.querySelector('[data-quick="archived"]').click()`);
  await until(`document.querySelector('.view__title h1')?.textContent === ${JSON.stringify(archived)} && document.querySelectorAll('.content-card').length === 1 && document.querySelector('.content-card')?.dataset.contentId === ${JSON.stringify(legacy[1])}`);
  assert.equal(await evaluate(`document.querySelector('.content-card').dataset.contentId`), legacy[1]);
  await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
  await until(`document.querySelectorAll('.content-card').length === 20`);
  await actions.selectContent(selected);

  // Custom names must still invoke the stable state actions, including undo and batch.
  await actions.contentAction(read, selected);
  await until(`SF.app.state.counts.read === 2`);
  assert.equal((await core.call('content.get', {item_id: selected})).state.read, true);
  await evaluate(`document.querySelector('[data-quick="read"]').click()`);
  await until(`!!document.querySelector(${JSON.stringify('.content-card[data-content-id="' + selected + '"]')})`);
  await actions.selectContent(selected);
  await actions.contentAction(read, selected);
  await until(`SF.app.state.counts.read === 1`);
  await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
  await until(`!!document.querySelector(${JSON.stringify('.content-card[data-content-id="' + selected + '"]')})`);
  await actions.checkContent(selected);
  await button(archived);
  await until(`SF.app.state.counts.archived === 2`);
  assert.equal((await core.call('content.get', {item_id: selected})).state.archived, true);
  await evaluate(`document.querySelector('[data-quick="archived"]').click()`);
  await until(`!!document.querySelector(${JSON.stringify('.content-card[data-content-id="' + selected + '"]')})`);
  await actions.selectContent(selected);
  await actions.contentAction(archived, selected);
  await until(`SF.app.state.counts.archived === 1`);
  await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
  await until(`!!document.querySelector(${JSON.stringify('.content-card[data-content-id="' + selected + '"]')})`);
  await actions.selectContent(selected);

  // An item in the renamed read state remains in the high-priority reminder set,
  // and its linked note uses the same name in the original-content dialog.
  await core.call('note.save', {item_id: selected, template: 'general', summary: '隔离验收笔记'});
  await core.call('content.update', {item_id: selected, patch: {read: true, priority: 'high'}});
  const highItems = await core.call('content.list', {view: 'high_unarchived', limit: 100});
  const pendingItems = await core.call('content.list', {state: 'pending', limit: 100});
  assert.ok(highItems.items.some(item => item.id === selected));
  assert.ok(!pendingItems.items.some(item => item.id === selected));
  await evaluate(`SF.app.navigate('notes')`);
  await until(`document.querySelector('.notes-toc__item')`);
  await until(`Array.from(document.querySelectorAll('button')).some(n => n.textContent.trim() === '查看原内容')`);
  await button('查看原内容');
  await until(`document.querySelector('.notes-modal__state')?.textContent.includes(${JSON.stringify(read)})`);
  await button('返回笔记');
  await core.call('content.update', {item_id: selected, patch: {read: false, priority: null}});

  await evaluate(`document.querySelector('[data-nav="overview"]').click()`);
  await until(`document.querySelector('[aria-label="日历处理状态"]')`);
  // Quick filters are filters in overview, not navigation away from it.
  // Exercise the production sidebar, both modes, real Core queries and the
  // selected calendar date; the earlier inbox assertions cover its behavior.
  await evaluate(`SF.app.state.calendarMonth=${JSON.stringify(day.slice(0,7))}; SF.app.state.selectedDate=${JSON.stringify(day)}; SF.app.renderView('overview'); void 0`);
  await evaluate(`SF.views.overview.whenIdle()`);
  await evaluate(`window.quickQueryLog=[]; window.quickCalendarOriginal=SF.app.state.client.getCalendar; window.quickContentsOriginal=SF.app.state.client.listContents;
    SF.app.state.client.getCalendar=function(q){quickQueryLog.push({kind:'calendar',q:JSON.parse(JSON.stringify(q))});return quickCalendarOriginal.call(this,q)};
    SF.app.state.client.listContents=function(q){quickQueryLog.push({kind:'contents',q:JSON.parse(JSON.stringify(q))});return quickContentsOriginal.call(this,q)}; void 0`);
  const quickIds = ['all', 'unread', 'high', 'medium', 'low', 'deferred', 'read', 'archived'];
  async function checkQuickFilters(mode) {
    const initialHash = await evaluate('location.hash');
    for (const id of quickIds) {
      await evaluate(`quickQueryLog.length=0; document.querySelector('[data-quick="${id}"]').click(); void 0`);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await evaluate(`SF.app.state.route.name`), 'overview', `${mode}/${id} 应停留在内容总览`);
      assert.equal(await evaluate(`location.hash`), initialHash, `${mode}/${id} 应保留当前地址和模式`);
      assert.equal(await evaluate(`document.querySelector('[data-view="overview"]')?.dataset.mode`), mode);
      await evaluate(`SF.views.overview.whenIdle()`);
      const priority = ['high', 'medium', 'low'].includes(id) ? id : null;
      assert.deepEqual(await evaluate(`({quick:SF.app.state.filters.quick,priority:SF.app.state.filters.priority||null})`), {quick: priority ? 'all' : id, priority});
      assert.ok(await evaluate(`document.querySelector('[data-quick="${id}"]').classList.contains('is-active')`), `${mode}/${id} 应显示选中态`);
      if (mode === 'calendar') {
        assert.equal(await evaluate(`SF.app.state.selectedDate`), day, `${id} 不应改变选中日期`);
        const q = await evaluate(`quickQueryLog.filter(x=>x.kind==='calendar').at(-1)?.q`);
        assert.ok(q, `${id} 应重新查询日历`);
        assert.equal(q.month, day.slice(0,7));
        assert.equal(q.state || 'all', priority ? 'all' : id);
        assert.equal(q.priority || null, priority);
        const expectedTotal = await evaluate(`quickCalendarOriginal.call(SF.app.state.client, ${JSON.stringify(q)}).then(r=>r.total)`);
        assert.equal(await evaluate(`Number(document.querySelector('[data-calendar-stats] .stat__num').textContent)`), expectedTotal, `${id} 日历统计应反映筛选结果`);
      } else {
        const columns = await evaluate(`Array.from(document.querySelectorAll('[data-priority-column]')).map(n=>n.dataset.priorityColumn)`);
        assert.deepEqual(columns, priority ? [priority] : ['high', 'medium', 'low']);
        const queries = await evaluate(`quickQueryLog.filter(x=>x.kind==='contents').map(x=>x.q)`);
        if (queries.length) assert.ok(queries.every(q => (q.state || 'all') === (priority ? 'all' : id)), `${id} 看板查询应使用选中的状态`);
      }
    }
  }
  await checkQuickFilters('calendar');
  await evaluate(`SF.app.navigate('overview', {mode:'priority'})`);
  await until(`document.querySelector('[data-view="overview"][data-mode="priority"]')`);
  await evaluate(`SF.views.overview.whenIdle()`);
  await checkQuickFilters('priority');
  await evaluate(`SF.app.navigate('tags',{tab:'list'})`);
  await until(`SF.app.state.route.name==='tags'`);
  await evaluate(`document.querySelector('[data-quick="read"]').click()`);
  await until(`SF.app.state.route.name==='inbox' && SF.app.state.filters.quick==='read'`);
  await evaluate(`SF.app.state.client.getCalendar=quickCalendarOriginal; SF.app.state.client.listContents=quickContentsOriginal; SF.app.navigate('overview',{mode:'calendar'}); void 0`);
  await until(`document.querySelector('[aria-label="日历处理状态"]')`);
  await evaluate(`document.querySelector('[aria-label="日历处理状态"]').click()`);
  await until(`Array.from(document.querySelectorAll('.menu__item')).some(n => n.textContent.includes(${JSON.stringify(read)}))`);
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.menu__item')).some(n => n.textContent.includes(${JSON.stringify(archived)}))`));
  await evaluate(`SF.app.navigate('overview', {mode:'priority'})`);
  await until(`!document.querySelector('.menu') && document.querySelector('[aria-label="看板处理状态"]')`);
  await evaluate(`document.querySelector('[aria-label="看板处理状态"]').click()`);
  await until(`Array.from(document.querySelectorAll('.menu__item')).some(n => n.textContent.includes(${JSON.stringify(read)}))`);
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.menu__item')).some(n => n.textContent.includes(${JSON.stringify(archived)}))`));
  // Keyboard or programmatic navigation may not emit mousedown outside the menu.
  await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
  await until(`!document.querySelector('.menu')`);
  await until(`document.querySelectorAll('.content-card').length > 0`);
  await actions.selectContent(ids[5]);
  await until(`document.querySelectorAll('.detail .state-btn').length === 3`);

  // Narrow window and long labels: visible truncation must retain the full accessible name.
  await evaluate(`SF.app.openSettings('general')`);
  await until(`document.querySelector('[data-reading-state-name="read"]')`);
  const longRead = '值得反复阅读的精彩内容一', longArchive = '已经全部读完的精彩内容一';
  assert.equal(Array.from(longRead).length, 12);
  assert.equal(Array.from(longArchive).length, 12);
  await setName('read', longRead);
  await setName('archived', longArchive);
  await button('保存设置');
  await until(`SF.catalog.readingState('read') === ${JSON.stringify(longRead)}`);
  await evaluate(`document.querySelector('[aria-label="关闭设置"]').click()`);
  await until(`document.querySelector('.detail .state-btn[data-state-field="read"]')?.textContent.includes(${JSON.stringify(longRead)})`);
  for (const theme of ['light', 'dark']) {
    for (const width of [900, 1100]) {
      window.setSize(width, 760);
      await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const layout = await evaluate(`(() => {
        const group = document.querySelector('.state-group');
        const buttons = Array.from(group.querySelectorAll('.state-btn'));
        const head = document.querySelector('.view__head-text');
        const title = document.querySelector('.view__title h1');
        const toolbar = document.querySelector('.inbox__toolbar');
        const segment = toolbar.querySelector('.seg');
        return {page: document.documentElement.scrollWidth <= innerWidth,
          contained: buttons.every(b => b.getBoundingClientRect().left >= group.getBoundingClientRect().left - 1 && b.getBoundingClientRect().right <= group.getBoundingClientRect().right + 1),
          titleWidth: title.getBoundingClientRect().width,
          titleHeight: title.getBoundingClientRect().height,
          textWidth: head.getBoundingClientRect().width,
          segmentContained: segment.getBoundingClientRect().right <= toolbar.getBoundingClientRect().right + 1,
          segmentUnwrapped: Array.from(segment.querySelectorAll('button')).every(b => getComputedStyle(b).whiteSpace === 'nowrap'),
          accessible: buttons[0].getAttribute('aria-label')};
      })()`);
      assert.equal(layout.page && layout.contained, true, `${theme} ${width}px 不能横向溢出`);
      assert.ok(layout.textWidth >= 180 && layout.titleWidth >= 60 && layout.titleHeight < 65, JSON.stringify(layout));
      assert.ok(layout.segmentContained && layout.segmentUnwrapped, JSON.stringify(layout));
      assert.ok(layout.accessible.includes(longRead));
      if (process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT) {
        fs.mkdirSync(process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT, {recursive: true});
        fs.writeFileSync(path.join(process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT, `reading-state-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
    }
  }

  // Treat markup-like input as text throughout the real renderer.
  await evaluate(`SF.app.openSettings('general')`);
  await until(`document.querySelector('[data-reading-state-name="read"]')`);
  const markupName = '<b>重温</b>';
  await setName('read', markupName);
  await button('保存设置');
  await until(`SF.catalog.readingState('read') === ${JSON.stringify(markupName)}`);
  await evaluate(`document.querySelector('[aria-label="关闭设置"]').click()`);
  await until(`document.querySelector('[data-quick="read"]')?.textContent.includes(${JSON.stringify(markupName)})`);
  assert.equal(await evaluate(`document.querySelector('[data-quick="read"] b')`), null);

  // Leave custom names saved for the second, independently launched app process.
  await evaluate(`SF.app.openSettings('general')`);
  await until(`document.querySelector('[data-reading-state-name="read"]')`);
  await setName('read', read);
  await setName('archived', archived);
  // Once Core commits, a display-sync failure must be reported as saved and retried.
  await evaluate(`window.originalReadingNames = SF.app.applyReadingStateNames; SF.app.applyReadingStateNames = function () { throw Error('模拟显示同步失败'); }; void 0`);
  await button('保存设置');
  await until(`document.body.innerText.includes('设置已保存，显示名称暂未同步') && !SF.views.settings.isDirty('general')`);
  assert.deepEqual((await saved()).general.readingStateNames, {read, archived});
  await evaluate(`SF.app.applyReadingStateNames = window.originalReadingNames; delete window.originalReadingNames`);
  await until(`SF.catalog.readingState('archived') === ${JSON.stringify(archived)}`);
  await core.stop();
  await core.start();
  await until(`SF.app.state.coreStatus.state === 'ready'`);
  assert.deepEqual((await saved()).general.readingStateNames, {read, archived});
  console.log(JSON.stringify({readingStateUi: 'passed', drafts: true, labels: true, tray: !!resources.tray,
    layout: 'light/dark 900/1100', coreRestart: true}));
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-renderer-reading-'));
  function run(phase) {
    return new Promise(resolve => {
      const child = spawn(require('electron'), [root], {stdio: 'inherit', env: {...process.env,
        SUBSCRIBE_FLOW_RENDERER_SMOKE: 'reading-state', SUBSCRIBE_FLOW_READING_PHASE: phase,
        SUBSCRIBE_FLOW_DATA_DIR: folder}});
      const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
      child.on('close', code => { clearTimeout(timer); resolve(code ?? 1); });
    });
  }
  (async () => {
    try {
      let code = await run('initial');
      if (!code) code = await run('restart');
      process.exitCode = code;
    } finally { fs.rmSync(folder, {recursive: true, force: true}); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
