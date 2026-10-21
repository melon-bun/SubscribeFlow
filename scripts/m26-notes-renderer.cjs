const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * M26 笔记存储与查询的实机验收。
 *
 * 跑的是正式 Renderer + 正式 Core（Electron 真进程、隔离临时库、离线种子）。
 * 笔记的每一次读写都从渲染层发起，走 Preload 白名单 → 主进程 → Core RPC，
 * 因此白名单、参数校验与 DTO 透传都在验收范围内。
 *
 * 全程不触网、不登录、不读真实 Key、不调用付费业务模型。
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
      if (Date.now() - start > timeout) throw new Error('Timed out: ' + expression);
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  };

  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);
  await until(`!!SF.app.state.client && typeof SF.app.state.client.saveNote === 'function'`);

  /* 1. 目录列表：只有 ID、原标题与笔记更新时间。 */
  const before = await evaluate(`SF.app.state.client.listNotes({limit: 10}).then(r => ({total: r.total, items: r.items}))`);
  assert.equal(before.total, 0, '种子库里没有笔记');

  /* 2. 写一条笔记：走真实 IPC 通道。 */
  const itemId = await evaluate(`SF.app.state.client.listContents({limit: 10}).then(r => r.items[0].id)`);
  assert.ok(itemId, '需要至少一条内容');
  const saved = await evaluate(`SF.app.state.client.saveNote(${JSON.stringify(itemId)}, {
    template: 'general', summary: '这篇讲清楚了异步的边界。',
    summaryOrigin: 'manual', takeaway: '先画时序图再写代码。'})`);
  assert.equal(saved.content_id, itemId);
  assert.equal(saved.summary, '这篇讲清楚了异步的边界。');
  assert.ok(saved.version, '每次写入都要有版本令牌');

  /* 3. 读回来：同一份内容、同一枚令牌。 */
  const got = await evaluate(`SF.app.state.client.getNote(${JSON.stringify(itemId)})`);
  assert.equal(got.version, saved.version);
  assert.equal(got.takeaway, '先画时序图再写代码。');

  /* 4. 目录：形状与计数。 */
  const listing = await evaluate(`SF.app.state.client.listNotes({limit: 10}).then(r => ({total: r.total, items: r.items, next_offset: r.next_offset}))`);
  assert.equal(listing.total, 1);
  assert.deepEqual(Object.keys(listing.items[0]).sort(), ['id', 'note_updated_at', 'title']);
  assert.equal(listing.items[0].id, itemId);
  const titleOf = await evaluate(`SF.app.state.client.getContent(${JSON.stringify(itemId)}).then(c => c.title)`);
  assert.equal(listing.items[0].title, titleOf, '目录里用的是原标题');

  /* 5. 范围筛选：关键词搜得到笔记正文。 */
  const searched = await evaluate(`SF.app.state.client.listNotes({keyword: '时序图'}).then(r => r.total)`);
  assert.equal(searched, 1, '关键词要能搜到笔记正文');

  /* 6. facets：笔记范围内的平台、来源、标签。 */
  const facets = await evaluate(`SF.app.state.client.noteFacets({}).then(r => r)`);
  assert.ok(facets.channels.length >= 1, '平台要有使用量');
  assert.ok(facets.sources.length >= 1, '来源要有使用量');
  assert.ok(facets.tags.length >= 1, '标签要有使用量');
  assert.equal(facets.channels.reduce((sum, row) => sum + row.count, 0), 1,
    'facets 只统计有笔记的内容');

  /* 7. 内容列表与详情带上 has_note。 */
  const listed = await evaluate(`SF.app.state.client.listContents({limit: 10}).then(r => r.items.find(i => i.id === ${JSON.stringify(itemId)}))`);
  assert.equal(listed.hasNote, true, '内容列表要透传 has_note');
  const detail = await evaluate(`SF.app.state.client.getContent(${JSON.stringify(itemId)})`);
  assert.equal(detail.hasNote, true, '内容详情要透传 has_note');

  /* 8. 冲突：旧令牌不写入，并带回当前这一份。 */
  const conflict = await evaluate(`SF.app.state.client.saveNote(${JSON.stringify(itemId)}, {
    expectedVersion: 'stale-token', template: 'general', summary: '抢写',
    summaryOrigin: 'manual', takeaway: ''}).then(() => null).catch(e => ({code: e.code, message: e.message, details: e.details}))`);
  assert.equal(conflict.code, 'CONFLICT', '旧令牌要报冲突');
  assert.equal(conflict.details.current.summary, '这篇讲清楚了异步的边界。', '冲突要带回当前笔记');
  const unchanged = await evaluate(`SF.app.state.client.getNote(${JSON.stringify(itemId)})`);
  assert.equal(unchanged.summary, '这篇讲清楚了异步的边界。', '冲突不能写入');

  /* 9. 整体替换：没写的字段不留旧值。 */
  const replaced = await evaluate(`SF.app.state.client.saveNote(${JSON.stringify(itemId)}, {
    expectedVersion: ${JSON.stringify(saved.version)}, template: 'general', summary: '改写后的总结',
    summaryOrigin: 'manual', takeaway: ''})`);
  assert.equal(replaced.summary, '改写后的总结');
  assert.equal(replaced.takeaway, '', '整体替换：没写的字段不留旧值');
  assert.notEqual(replaced.version, saved.version, '每次真正写入换一个令牌');

  /* 10. 清空即没有笔记：删行，不留空行。 */
  const cleared = await evaluate(`SF.app.state.client.saveNote(${JSON.stringify(itemId)}, {
    expectedVersion: ${JSON.stringify(replaced.version)}, template: 'general', summary: '  ',
    summaryOrigin: 'manual', takeaway: ''})`);
  assert.equal(cleared, null, '空笔记就是没有笔记');
  const afterClear = await evaluate(`SF.app.state.client.getNote(${JSON.stringify(itemId)})`);
  assert.equal(afterClear, null);

  /* 11. 显式删除：只删笔记，不删内容。 */
  const again = await evaluate(`SF.app.state.client.saveNote(${JSON.stringify(itemId)}, {
    template: 'general', summary: '再来一次', summaryOrigin: 'manual', takeaway: ''})`);
  const deleted = await evaluate(`SF.app.state.client.deleteNote(${JSON.stringify(itemId)}, ${JSON.stringify(again.version)})`);
  assert.equal(deleted.ok, true);
  const stillThere = await evaluate(`SF.app.state.client.getContent(${JSON.stringify(itemId)})`);
  assert.equal(stillThere.id, itemId, '删笔记不删内容');
  assert.equal(stillThere.hasNote, false);

  console.log('[m26] 笔记存储与查询实机验收通过');
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-m26-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const seed = spawnSync(runtime.python, [path.join(root, 'scripts/seed-m26-notes.py'), folder], {encoding: 'utf8'});
  if (seed.status !== 0) {
    console.error(seed.stderr || seed.stdout);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = 1;
    return;
  }
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'm26', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', code => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
