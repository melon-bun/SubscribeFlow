const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * M28 笔记页的实机验收。
 *
 * 跑的是正式 Renderer + 正式 Core（Electron 真进程、隔离临时库、离线种子）。
 * 笔记列表、筛选、facets 与读写都走真实 IPC 通道；外部打开被测试替身拦下，
 * 全程不触网。
 */
async function verify({window, core, root}) {
  const evaluate = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\nRenderer assertion: ' + code); }
  };
  const until = async (expression, timeout = 30000) => {
    const start = Date.now();
    while (true) {
      let value;
      try { value = await evaluate(expression); }
      catch (error) {
        if (Date.now() - start > timeout) throw error;
        await new Promise((resolve) => setTimeout(resolve, 120));
        continue;
      }
      if (value) return true;
      if (Date.now() - start > timeout) {
        const diag = await evaluate(`JSON.stringify({
          route: SF.app.state.route,
          body: document.body.innerText.slice(0, 300),
        })`).catch(e => String(e));
        const calls = await evaluate(`JSON.stringify(window.__listCalls || [])`).catch(e => String(e));
        throw new Error('Timed out: ' + expression + '\n' + diag + '\nlist calls: ' + calls);
      }
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  };
  const pause = ms => new Promise((resolve) => setTimeout(resolve, ms));

  window.webContents.on('console-message', (event) => {
    const level = typeof event.level === 'string' ? event.level : 'info';
    if (level === 'error' || level === 'warning') console.error('[渲染进程]', event.message);
  });
  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);
  await until(`!!SF.app.state.client && typeof SF.app.state.client.listNotes === 'function'`);

  /* 外壳渲染完再开始断言。 */
  await until(`!!document.querySelector('.sidebar') && !!document.querySelector('.shell__body')`);

  /* 0. 侧栏入口：始终可达，不看有没有笔记。 */
  const nav = await evaluate(`Array.from(document.querySelectorAll('[data-nav]')).map(b => b.getAttribute('aria-label'))`);
  assert.ok(nav.includes('笔记'), '侧栏要有「笔记」入口');
  assert.ok(!nav.includes('沉淀库'), '不能出现「沉淀库」');

  /* 记录列表请求的参数：筛选与总数必须同源。 */
  await evaluate(`(() => {
    const client = SF.app.state.client;
    window.__listCalls = [];
    window.__originalList = client.listNotes;
    client.listNotes = function (params) {
      window.__listCalls.push(JSON.parse(JSON.stringify(params || {})));
      return window.__originalList.call(client, params);
    };
  })()`);

  /* 外部打开由替身拦下：绝不能真的触网。 */
  await evaluate(`(() => {
    const client = SF.app.state.client;
    window.__opened = [];
    window.__originalOpen = client.openContent;
    client.openContent = function (id) { window.__opened.push(id); return Promise.resolve({opened: false}); };
  })()`);

  /* 1. 进入笔记页：左列是原标题目录。 */
  await evaluate(`SF.app.navigate('notes')`);
  await until(`SF.app.state.route.name === 'notes'`);
  await until(`document.querySelectorAll('.notes-toc__item').length > 0`);
  const toc = await evaluate(`Array.from(document.querySelectorAll('.notes-toc__item')).map(b => b.textContent.trim())`);
  assert.ok(toc.includes('local-rag / desktop-kit'), '目录里要有那两条笔记的原标题');
  assert.ok(toc.includes('一篇讲检索设计的文章'), '目录里要有那两条笔记的原标题');
  assert.ok(!toc.includes('没有写笔记的一条内容'), '没有笔记的内容不出现');
  assert.ok(toc.every(t => !t.includes('本地文档检索加桌面壳')), '目录里不出现笔记正文');
  const tocShape = await evaluate(`(() => {
    const list = document.querySelector('.notes-toc__list');
    return {
      summaries: Array.from(list.querySelectorAll('.content-card__summary')).length,
      tags: list.querySelectorAll('.tag-chip, .tag').length,
      covers: list.querySelectorAll('img').length,
    };
  })()`);
  assert.equal(tocShape.summaries, 0, '目录里不出现简介');
  assert.equal(tocShape.tags, 0, '目录里不出现标签');
  assert.equal(tocShape.covers, 0, '目录里不出现封面');

  /* 2. 选中标题只在本页切换：不跳收件箱，主路由仍是 notes。 */
  await evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('.notes-toc__item'))
      .find(b => b.textContent.trim() === 'local-rag / desktop-kit');
    item.click();
  })()`);
  await until(`!!document.querySelector('.notes-reader__title')`);
  const reader = await evaluate(`({
    route: SF.app.state.route.name,
    title: document.querySelector('.notes-reader__title').textContent,
    card: (document.querySelector('.notes-card__title') || {}).textContent,
    type: document.querySelector('select[aria-label="笔记类型"]').value,
  })`);
  assert.equal(reader.route, 'notes', '选中标题不能跳收件箱');
  assert.equal(reader.title, 'local-rag / desktop-kit');
  assert.equal(reader.card, 'local-rag / desktop-kit', '原内容卡片显示原标题');
  assert.equal(reader.type, 'project', '阅读区回显已保存的模板');

  /* 2b. 留一张笔记页的截图：隔离假数据，存 canonical 验证目录。 */
  const shotDir = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT ||
    '/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/docs/verification/phase5-minimax/batch-04';
  fs.mkdirSync(shotDir, {recursive: true});
  // 等两帧再截：否则拍到的是上一帧（刚重画完时的旧画面）。
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  fs.writeFileSync(path.join(shotDir, 'notes-page.png'), (await window.webContents.capturePage()).toPNG());

  /* 3. 编辑区回显已保存的笔记（BUG-109 的修复不能回归）。 */
  const noteFields = await evaluate(`({
    summary: document.querySelector('textarea[aria-label="这个项目解决什么问题"]').value,
    takeaway: document.querySelector('textarea[aria-label="我的判断／使用心得"]').value,
    verdict: document.querySelector('select[aria-label="项目结论"]').value,
  })`);
  assert.equal(noteFields.summary, '本地文档检索加桌面壳。');
  assert.equal(noteFields.takeaway, '先做索引，再谈接入。');
  assert.equal(noteFields.verdict, 'using');

  /* 4. 搜索：覆盖标题与笔记文字。 */
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="搜索笔记"]');
    input.value = '倒排索引';
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await until(`document.querySelectorAll('.notes-toc__item').length === 1`);
  const searched = await evaluate(`Array.from(document.querySelectorAll('.notes-toc__item')).map(b => b.textContent.trim())`);
  assert.deepEqual(searched, ['一篇讲检索设计的文章'], '搜索要搜得到笔记正文');
  /* 全局数与范围数分开：页内是当前范围，侧栏是全体笔记数（BUG-112）。 */
  const counts = await evaluate(`({
    badge: (document.querySelector('[data-nav="notes"] .count-pill') || {}).textContent,
    page: (document.querySelector('.notes-toc__foot') || {}).textContent,
  })`);
  assert.equal(counts.badge, '23', '侧栏那枚是全体笔记数，不随筛选变');
  assert.ok(counts.page.includes('共 1 篇'), '页内是当前范围的总数：' + counts.page);
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="搜索笔记"]');
    input.value = '';
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await until(`document.querySelectorAll('.notes-toc__item').length > 1`);

  /* 5. 平台筛选：facets 只给笔记范围内的平台。 */
  const platformOptions = await evaluate(`Array.from(document.querySelectorAll('select[aria-label="按平台筛选"] option')).map(o => o.textContent)`);
  assert.ok(platformOptions.includes('知乎'), 'facets 要给出笔记范围内的平台');
  assert.ok(platformOptions.includes('GitHub'), 'facets 要给出笔记范围内的平台');
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="按平台筛选"]');
    const option = Array.from(select.options).find(o => o.textContent === '知乎');
    if (!option) throw new Error('facets 里没有知乎');
    select.value = option.value;
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`document.querySelectorAll('.notes-toc__item').length === 1`);
  const filtered = await evaluate(`Array.from(document.querySelectorAll('.notes-toc__item')).map(b => b.textContent.trim())`);
  assert.deepEqual(filtered, ['一篇讲检索设计的文章'], '平台筛选要生效');
  // 换回全部平台。
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="按平台筛选"]');
    select.value = '';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`document.querySelectorAll('.notes-toc__item').length > 1`);

  /* 5b. 分页：总数与列表同源，「更多」翻页后总数不变。 */
  const paging = await evaluate(`({
    total: (document.querySelector('.notes-toc__foot') || {}).textContent,
    items: document.querySelectorAll('.notes-toc__item').length,
    more: !!document.querySelector('.notes-toc__pager button'),
  })`);
  assert.ok(paging.more, '超过一页时要有翻页入口');
  assert.ok(paging.total.includes('共'), '目录底部要显示总数');
  const firstPage = paging.items;
  await evaluate(`document.querySelector('.notes-toc__pager button').click()`);
  await until(`document.querySelectorAll('.notes-toc__item').length !== ${firstPage}`);
  const secondPage = await evaluate(`({
    total: (document.querySelector('.notes-toc__foot') || {}).textContent,
    items: document.querySelectorAll('.notes-toc__item').length,
  })`);
  assert.equal(secondPage.total, paging.total, '翻页后总数不变');
  assert.ok(secondPage.items > 0, '下一页要有内容');
  // 回到第一页，后面的场景都在第一页上做。
  await evaluate(`Array.from(document.querySelectorAll('.notes-toc__pager button')).find(b => b.textContent.trim() === '上一页').click()`);
  await until(`document.querySelectorAll('.notes-toc__item').length === ${firstPage}`);

  /* 5c. 快速连改条件：最后一次的条件一定要真的下发，旧结果不冒充当前。 */
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="按平台筛选"]');
    const options = Array.from(select.options);
    select.value = options[1].value;
    select.dispatchEvent(new Event('change', {bubbles: true}));
    select.value = options[2].value;
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`document.querySelectorAll('.notes-toc__item').length === 1`);
  const lastCall = JSON.parse(await evaluate(`JSON.stringify(window.__listCalls)`)).pop();
  assert.ok(lastCall.platform, '最后下发的请求要带最后的平台条件');
  const quickTitles = await evaluate(`Array.from(document.querySelectorAll('.notes-toc__item')).map(b => b.textContent.trim())`);
  assert.deepEqual(quickTitles, ['local-rag / desktop-kit'], '结果要对得上最后的条件');
  // 换回全部平台。
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="按平台筛选"]');
    select.value = '';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`document.querySelectorAll('.notes-toc__item').length > 1`);

  /* 6. 标签筛选：选项来自笔记范围内的标签。 */
  const tagNames = await evaluate(`Array.from(document.querySelectorAll('.notes-toc__tag span:first-child')).map(s => s.textContent)`);
  assert.ok(tagNames.includes('检索'), '标签筛选要用笔记范围内的标签');
  assert.ok(!tagNames.includes('没有笔记的标签'), '不是笔记的标签不当作笔记标签');

  /* 7. 打开原内容 modal：只读本地数据，不改路由、不自动开网页。 */
  await evaluate(`document.querySelector('.notes-card button').click()`);
  await until(`!!document.querySelector('.notes-modal')`);
  await until(`!!document.querySelector('.notes-modal__title')`);
  const modal = await evaluate(`({
    route: SF.app.state.route.name,
    title: (document.querySelector('.notes-modal__title') || {}).textContent,
    text: (document.querySelector('.notes-modal__text') || {}).textContent,
    opened: window.__opened.length,
  })`);
  assert.equal(modal.route, 'notes', '打开 modal 不能改主路由');
  assert.equal(modal.title, 'local-rag / desktop-kit');
  assert.ok(modal.text && modal.text.includes('已保存的简介'), 'modal 要展示已保存的简介');
  assert.equal(modal.opened, 0, '打开 modal 不能自动打开原网页');
  /* 焦点限制在 modal：Tab 不会跑到外面去。 */
  const focusInside = await evaluate(`(() => {
    const dialog = document.querySelector('.dialog');
    return !!dialog && dialog.contains(document.activeElement);
  })()`);
  assert.equal(focusInside, true, '打开后焦点在 modal 里');

  /* 8. 明确点「打开原网页」才请求外开。 */
  await evaluate(`Array.from(document.querySelectorAll('.notes-modal button')).find(b => b.textContent.trim() === '打开原网页').click()`);
  await until(`window.__opened.length === 1`);
  const opened = await evaluate(`JSON.stringify(window.__opened)`);
  assert.ok(opened.includes('desktop-kit') || opened.length > 2, '明确点击才请求外开');

  /* 9. 三种关闭方式都能关。 */
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.getAttribute('aria-label') === '关闭对话框').click()`);
  await until(`!document.querySelector('.notes-modal')`);
  await evaluate(`document.querySelector('.notes-card button').click()`);
  await until(`!!document.querySelector('.notes-modal')`);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
  await until(`!document.querySelector('.notes-modal')`);
  await evaluate(`document.querySelector('.notes-card button').click()`);
  await until(`!!document.querySelector('.notes-modal')`);
  await evaluate(`(() => {
    const mask = document.querySelector('.dialog-mask');
    mask.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
  })()`);
  await until(`!document.querySelector('.notes-modal')`);

  /* 10. 选中仍然在笔记页，草稿与路由都没丢。 */
  const afterClose = await evaluate(`({
    route: SF.app.state.route.name,
    selected: (document.querySelector('.notes-reader__title') || {}).textContent,
  })`);
  assert.equal(afterClose.route, 'notes');
  assert.equal(afterClose.selected, 'local-rag / desktop-kit', '关闭 modal 不该丢掉当前选中');

  /* 11. A／B 切换：草稿按内容 ID 分开，不串条。 */
  await evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('.notes-toc__item'))
      .find(b => b.textContent.trim() === '一篇讲检索设计的文章');
    item.click();
  })()`);
  await until(`document.querySelector('select[aria-label="笔记类型"]').value === 'general'`);
  await evaluate(`(() => {
    const area = document.querySelector('textarea[aria-label="总结"]');
    area.value = 'A 的草稿';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('.notes-toc__item'))
      .find(b => b.textContent.trim() === 'local-rag / desktop-kit');
    item.click();
  })()`);
  await until(`document.querySelector('select[aria-label="笔记类型"]').value === 'project'`);
  const bValue = await evaluate(`document.querySelector('textarea[aria-label="这个项目解决什么问题"]').value`);
  assert.equal(bValue, '本地文档检索加桌面壳。', 'B 的内容不能被 A 的草稿顶掉');
  await evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('.notes-toc__item'))
      .find(b => b.textContent.trim() === '一篇讲检索设计的文章');
    item.click();
  })()`);
  await until(`document.querySelector('select[aria-label="笔记类型"]').value === 'general'`);
  const aValue = await evaluate(`document.querySelector('textarea[aria-label="总结"]').value`);
  assert.equal(aValue, 'A 的草稿', 'A 的草稿还在');

  /* 12. 保存：目录与数量同步，原内容状态不变。 */
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记').click()`);
  await until(`SF.app.state.client.getNote('zhihu:feed:m28-1').then(n => n && n.summary === 'A 的草稿')`);
  const contentState = await evaluate(`SF.app.state.client.getContent('zhihu:feed:m28-1').then(c => ({
    read: c.state.read, deferred: c.state.deferred, archived: c.state.archived, hasNote: c.hasNote,
  }))`);
  assert.equal(contentState.read, false, '写笔记不改已读状态');
  assert.equal(contentState.deferred, false, '写笔记不改稍后处理');
  assert.equal(contentState.archived, false, '写笔记不改归档');
  assert.equal(contentState.hasNote, true, '内容上要能看到有笔记');
  const stillSelected = await evaluate(`(document.querySelector('.notes-reader__title') || {}).textContent`);
  assert.equal(stillSelected, '一篇讲检索设计的文章', '保存后要保留当前选中的笔记');

  /* 13. 删除笔记：目录少一条，选中相邻的一条。 */
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '删除这条笔记').click()`);
  await until(`!!document.querySelector('.dialog')`);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '删除').click()`);
  await until(`!Array.from(document.querySelectorAll('.notes-toc__item')).some(b => b.textContent.trim() === '一篇讲检索设计的文章')`);
  const afterDelete = await evaluate(`({
    items: Array.from(document.querySelectorAll('.notes-toc__item')).map(b => b.textContent.trim()),
    selected: (document.querySelector('.notes-reader__title') || {}).textContent,
    total: (document.querySelector('.notes-toc__foot') || {}).textContent,
  })`);
  assert.ok(!afterDelete.items.includes('一篇讲检索设计的文章'), '目录里不能再有删掉的那条');
  assert.ok(afterDelete.total.includes('共 22 篇'), '总数要跟着少一条：' + afterDelete.total);
  const badgeAfterDelete = await evaluate(`(document.querySelector('[data-nav="notes"] .count-pill') || {}).textContent`);
  assert.equal(badgeAfterDelete, '22', '全局笔记数也要跟着少一条');
  assert.ok(afterDelete.selected && afterDelete.selected !== '一篇讲检索设计的文章', '删除后要选相邻的一条');

  /* 13b. 筛选与分页确实下发到 Core，不是界面里自己滤的。 */
  const calls = JSON.parse(await evaluate(`JSON.stringify(window.__listCalls)`));
  assert.ok(calls.some(c => c.keyword === '倒排索引'), '关键词要下发到 Core');
  assert.ok(calls.some(c => c.platform === 'zhihu'), '平台筛选要下发到 Core');
  assert.ok(calls.some(c => c.offset === 20), '翻页要下发 offset');
  const listCalls = calls.filter(c => c.offset !== undefined);
  assert.ok(listCalls.length && listCalls.every(c => c.limit === 20), '列表每页条数固定');
  assert.ok(calls.some(c => c.limit === 1 && c.offset === undefined),
    '全局笔记数要走不带筛选的单独一次查询');

  /* 14. 离开页面前有草稿要问一句；继续编辑就留在原地。 */
  await evaluate(`(() => {
    const area = document.querySelector('textarea[aria-label="这个项目解决什么问题"]');
    area.value = '离开前写的字';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await evaluate(`SF.app.navigate('inbox')`);
  await until(`!!document.querySelector('.dialog')`);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '继续编辑').click()`);
  await until(`!document.querySelector('.dialog')`);
  const stayed = await evaluate(`SF.app.state.route.name`);
  assert.equal(stayed, 'notes', '选择继续编辑就留在笔记页');
  const kept = await evaluate(`document.querySelector('textarea[aria-label="这个项目解决什么问题"]').value`);
  assert.equal(kept, '离开前写的字', '留在原地时草稿不能丢');

  console.log('[m28] 笔记页实机验收通过');
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-m28-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const seed = spawnSync(runtime.python, [path.join(root, 'scripts/seed-m28-notes.py'), folder], {encoding: 'utf8'});
  if (seed.status !== 0) {
    console.error(seed.stderr || seed.stdout);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = 1;
    return;
  }
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'm28', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', code => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
