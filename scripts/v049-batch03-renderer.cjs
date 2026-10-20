const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * 0.4.9 batch-03 实机验收（M22 标签点击跳顶 + M23 使用次数排序）。
 *
 * 跑的是正式 Renderer + 正式 Core（Electron 真进程、隔离临时库、离线种子）。
 * 种子造了 60 个标签与 6 条内容，足够把列表撑到需要滚动；使用次数刻意做成
 * 「有并列、有零次」：标签-00 与 标签-01 各 4 次，标签-02 两次，其余 0 次。
 *
 * 全程不触网、不登录、不读真实 Key、不调用付费业务模型。
 */
async function verify({window, core, root}) {
  const evaluate = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\nRenderer assertion: ' + code); }
  };
  const until = async (expression, timeout = 20000) => {
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
      if (Date.now() - start > timeout) throw new Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText'));
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  };
  const pause = ms => new Promise((resolve) => setTimeout(resolve, ms));
  const screenshot = async name => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root, 'docs/verification/v0.4.9-minimax/batch-03');
    fs.mkdirSync(output, {recursive: true});
    fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage()).toPNG());
  };
  const scrollTop = () => evaluate(`document.querySelector('.tags-table-wrap').scrollTop`);
  const rowNames = () => evaluate(`Array.from(document.querySelectorAll('.tags-table-wrap tbody tr')).map(r => r.querySelector('.tag-row')?.textContent || '')`);
  const selectedName = () => evaluate(`(() => {
    const row = document.querySelector('.tags-table-wrap tbody tr.is-selected');
    return row ? row.querySelector('.tag-row').textContent : '';
  })()`);
  const editorName = () => evaluate(`(document.querySelector('#tag-name') || {}).value || ''`);
  const clickRow = index => evaluate(`(() => {
    const row = document.querySelectorAll('.tags-table-wrap tbody tr')[${index}];
    if (!row) throw new Error('Missing row ' + ${index});
    row.click();
  })()`);
  const setSort = value => evaluate(`(() => {
    const select = document.querySelector('select[aria-label="标签排序"]');
    if (!select) throw new Error('Missing sort select');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  const setStatus = value => evaluate(`(() => {
    const select = document.querySelector('select[aria-label="状态筛选"]');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);

  await until(`!!window.SF?.app.state.session`);
  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);
  await evaluate(`location.hash = '#/tags?tab=list'`);
  await until(`document.querySelectorAll('.tags-table-wrap tbody tr').length === 60`);

  /* ================= M22：滚动容器的身份 ================= */

  const container = await evaluate(`(() => {
    const wrap = document.querySelector('.tags-table-wrap');
    return { scrollY: wrap.classList.contains('scroll-y'), key: wrap.getAttribute('data-scroll-key') };
  })()`);
  assert.equal(container.scrollY, true, '标签列表的滚动容器必须被滚动保全机制认到');
  assert.equal(container.key, 'tags-table', '滚动容器要有稳定的身份');
  const rowTagId = await evaluate(`document.querySelector('.tags-table-wrap tbody tr').getAttribute('data-tag-id')`);
  assert.ok(rowTagId, '行上要有稳定标签 ID，可见行锚点靠它认出同一条标签');

  /* ================= M22：中部与底部点击不跳顶 ================= */

  // 滚到中部点一行：滚动位置不变，选中换到那一行，右侧详情跟着换。
  await evaluate(`document.querySelector('.tags-table-wrap').scrollTop = 400`);
  await pause(120);
  const beforeMiddle = await scrollTop();
  assert.ok(beforeMiddle > 100, '列表应当能滚到中部，实际 ' + beforeMiddle);
  await clickRow(30);
  await until(`document.querySelector('.tags-table-wrap tbody tr.is-selected')`);
  const afterMiddle = await scrollTop();
  assert.ok(Math.abs(afterMiddle - beforeMiddle) <= 2, '中部点击后不能跳回顶部，实际 ' + afterMiddle);
  const middleName = await selectedName();
  assert.equal(middleName, '标签-30', '点击应当切换选中行');
  assert.equal(await editorName(), '标签-30', '右侧详情应当跟着换成新标签');

  // 连续点几行：位置仍然不动。
  for (const index of [31, 32, 33]) {
    await clickRow(index);
    await pause(120);
    const now = await scrollTop();
    assert.ok(Math.abs(now - beforeMiddle) <= 2, '连续点击后位置仍然要保持，实际 ' + now);
    assert.equal(await selectedName(), '标签-' + index, '连续点击应当依次切换选中');
  }
  await screenshot('v049-b03-scroll-middle.png');

  // 滚到底部再点：同样不跳顶。
  await evaluate(`(() => { const wrap = document.querySelector('.tags-table-wrap'); wrap.scrollTop = wrap.scrollHeight; })()`);
  await pause(120);
  const beforeBottom = await scrollTop();
  assert.ok(beforeBottom > 200, '列表应当能滚到底部，实际 ' + beforeBottom);
  await clickRow(55);
  await until(`document.querySelector('.tags-table-wrap tbody tr.is-selected')`);
  const afterBottom = await scrollTop();
  assert.ok(Math.abs(afterBottom - beforeBottom) <= 2, '底部点击后不能跳回顶部，实际 ' + afterBottom);
  assert.equal(await selectedName(), '标签-55', '底部点击应当切换选中行');

  // 键盘选中同样不跳顶。先聚焦再量位置：浏览器把行滚进视口是聚焦本身的行为，
  // 断言要盯的是「选中不要再动一次位置」。
  await evaluate(`(() => {
    document.querySelectorAll('.tags-table-wrap tbody tr')[50].focus();
  })()`);
  await pause(150);
  const beforeKey = await scrollTop();
  await evaluate(`(() => {
    const row = document.querySelectorAll('.tags-table-wrap tbody tr')[50];
    row.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
  })()`);
  await until(`document.querySelector('.tags-table-wrap tbody tr.is-selected')`);
  const afterKeyboard = await scrollTop();
  assert.ok(Math.abs(afterKeyboard - beforeKey) <= 2, '键盘选中后位置要保持，实际 ' + afterKeyboard);
  await screenshot('v049-b03-scroll-bottom.png');

  /* ================= M22：详情迟到不能覆盖新标签 ================= */

  await evaluate(`(() => {
    const client = SF.app.state.client;
    const original = client.listTagContents;
    window.__delayed = '标签-30';
    client.listTagContents = async function (id, query) {
      if (id === window.__delayed) await new Promise(resolve => setTimeout(resolve, 900));
      return original.call(client, id, query);
    };
  })()`);
  await clickRow(30);           // 慢的那一次
  await pause(60);
  await clickRow(32);           // 用户已经换到别的标签了
  await until(`document.querySelector('.tags-table-wrap tbody tr.is-selected .tag-row')?.textContent === '标签-32'`);
  await pause(1200);            // 等慢的那次回包
  assert.equal(await selectedName(), '标签-32', '迟到的详情不能把选中改回去');
  assert.equal(await editorName(), '标签-32', '迟到的详情不能覆盖新标签的详情');

  /* ================= M22：保存与后台刷新保持位置 ================= */

  await evaluate(`document.querySelector('.tags-table-wrap').scrollTop = 300`);
  await pause(120);
  const beforeSave = await scrollTop();
  await evaluate(`(() => {
    const input = document.querySelector('#tag-desc');
    input.value = '改过的说明';
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('[data-tag-editor] button')).find(b => b.textContent.trim() === '保存修改');
    if (!button) throw new Error('Missing save button');
    button.click();
  })()`);
  await pause(600);
  const afterSave = await scrollTop();
  assert.ok(Math.abs(afterSave - beforeSave) <= 2, '保存后位置要保持，实际 ' + afterSave);

  // 后台目录刷新：位置与选中都不动。
  await evaluate(`SF.views.tags.invalidate(new Set(['tags'])); SF.app.renderView('tags'); void 0`);
  await pause(400);
  const afterRefresh = await scrollTop();
  assert.ok(Math.abs(afterRefresh - beforeSave) <= 2, '后台刷新后位置要保持，实际 ' + afterRefresh);
  assert.equal(await selectedName(), '标签-32', '后台刷新不能改掉选中标签');

  /* ================= M23：三种排序 ================= */

  // 名称序是 00、01、02、03…；次数序（从多到少）是 03、00、01、02…。
  // 两种顺序一眼能分开，等待条件也据此选可区分的那一行。
  await setSort('usage_desc');
  await until(`document.querySelectorAll('.tags-table-wrap tbody tr')[0]?.textContent.includes('标签-03')`);
  let names = await rowNames();
  assert.deepEqual(names.slice(0, 5), ['标签-03', '标签-00', '标签-01', '标签-02', '标签-04'],
    '从多到少：6、3、3、1、0，并列按名称打破平局，实际 ' + JSON.stringify(names.slice(0, 5)));
  const descCounts = await evaluate(`Array.from(document.querySelectorAll('.tags-table-wrap tbody tr')).slice(0, 5).map(r => r.querySelector('.usage-cell__num').textContent)`);
  assert.deepEqual(descCounts, ['6', '3', '3', '1', '0'], '次数要按挂载内容条数排');
  const afterSort = await scrollTop();
  assert.ok(afterSort <= 2, '主动换排序要回到结果顶部，实际 ' + afterSort);
  await screenshot('v049-b03-sort-usage-desc.png');

  await setSort('usage_asc');
  await until(`document.querySelectorAll('.tags-table-wrap tbody tr')[0]?.textContent.includes('标签-04')`);
  names = await rowNames();
  assert.equal(names[0], '标签-04', '从少到多：零次排最前');
  assert.deepEqual(names.slice(-4), ['标签-02', '标签-00', '标签-01', '标签-03'],
    '从少到多：结尾是 1、3、3、6，并列按名称打破平局，实际 ' + JSON.stringify(names.slice(-4)));
  await screenshot('v049-b03-sort-usage-asc.png');

  await setSort('name');
  await until(`document.querySelectorAll('.tags-table-wrap tbody tr')[0]?.textContent.includes('标签-00')`);
  names = await rowNames();
  assert.deepEqual(names.slice(0, 3), ['标签-00', '标签-01', '标签-02'], '默认仍按名称排');

  // 排序与状态筛选组合生效。
  await evaluate(`(() => {
    const client = SF.app.state.client;
    const original = client.setTagEnabled;
    client.setTagEnabled = async function (id, on) { return original.call(client, id, on); };
  })()`);
  await setStatus('disabled');
  await pause(400);
  await setSort('usage_desc');
  await pause(400);
  names = await rowNames();
  assert.deepEqual(names, [], '没有停用标签时筛选结果为空');
  await setStatus('all');
  await pause(400);
  names = await rowNames();
  assert.equal(names.length, 60, '切回全部状态后标签都回来');

  /* ================= M23：打标移除后的计数与重排 ================= */

  await setSort('usage_desc');
  await until(`document.querySelectorAll('.tags-table-wrap tbody tr')[0]?.textContent.includes('标签-03')`);
  // 滚到能看到前几行的地方，摘掉标签-00 的一条关联：次数下降，00 与 01 交换位置。
  await evaluate(`document.querySelector('.tags-table-wrap').scrollTop = 120`);
  await pause(150);
  const anchorBefore = await evaluate(`(() => {
    const wrap = document.querySelector('.tags-table-wrap');
    const top = wrap.getBoundingClientRect().top;
    for (const row of wrap.querySelectorAll('tbody tr[data-tag-id]')) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top) return row.getAttribute('data-tag-id');
    }
    return '';
  })()`);
  assert.ok(anchorBefore, '应当能取到当前可见行锚点');
  // 直接从 Core 摘掉一条关联，模拟别处打标变化带来的用量变化。
  const before = await core.call('content.list', {limit: 50, tag_mode: 'any', tags: ['tag-00']});
  assert.ok(before.items.length >= 1, '种子里应当有挂着标签-00 的内容');
  const target = before.items[0].id;
  const keep = (before.items[0].tags || []).map(t => t.id).filter(id => id !== 'tag-00');
  await core.call('content.set_tags', {item_id: target, tag_ids: keep});
  await evaluate(`SF.views.tags.invalidate(new Set(['tags','content'])); SF.app.renderView('tags'); void 0`);
  await pause(500);
  const afterCounts = await evaluate(`Array.from(document.querySelectorAll('.tags-table-wrap tbody tr')).slice(0, 4).map(r => r.querySelector('.usage-cell__num').textContent)`);
  assert.deepEqual(afterCounts, ['6', '3', '2', '1'], '摘掉一条关联后次数要跟着降，实际 ' + JSON.stringify(afterCounts));
  const afterOrder = (await rowNames()).slice(0, 4);
  assert.deepEqual(afterOrder, ['标签-03', '标签-01', '标签-00', '标签-02'],
    '次数变化后要重新排序，实际 ' + JSON.stringify(afterOrder));
  const anchorAfter = await evaluate(`(() => {
    const wrap = document.querySelector('.tags-table-wrap');
    const top = wrap.getBoundingClientRect().top;
    for (const row of wrap.querySelectorAll('tbody tr[data-tag-id]')) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top) return row.getAttribute('data-tag-id');
    }
    return '';
  })()`);
  assert.equal(anchorAfter, anchorBefore, '用量变化引起的重排要保住当前可见行');

  console.log('[v049-batch03] M22/M23 Renderer 验收通过');
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-v049b3-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const seed = spawnSync(runtime.python, [path.join(root, 'scripts/seed-v049-batch03.py'), folder], {encoding: 'utf8'});
  if (seed.status !== 0) {
    console.error(seed.stderr || seed.stdout);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = 1;
    return;
  }
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'v049b3', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
  child.on('close', code => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
