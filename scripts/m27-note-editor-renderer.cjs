const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * M27「留下点什么」的实机验收。
 *
 * 跑的是正式 Renderer + 正式 Core（Electron 真进程、隔离临时库、离线种子）。
 * 每一次保存、删除、冲突都走真实 IPC 通道，因此白名单、参数校验、
 * DTO 透传与界面状态都在验收范围内。
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
      if (Date.now() - start > timeout) {
        const diag = await evaluate(`JSON.stringify({
          route: SF.app.state.route,
          cards: Array.from(document.querySelectorAll('.content-card')).map(c => c.dataset.contentId),
          list: SF.app.state.client.listContents({limit: 10}).then(r => r.items.map(i => i.id)),
          body: document.body.innerText.slice(0, 300),
        })`).catch(e => String(e));
        throw new Error('Timed out: ' + expression + '\n' + diag);
      }
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  };
  const pause = ms => new Promise((resolve) => setTimeout(resolve, ms));

  // 组件源码：重新载入它＝模拟页面重载（模块里的草稿状态归零，
  // 只剩库里那份已保存的笔记）。
  const noteEditorSource = fs.readFileSync(path.join(root, 'electron/renderer/scripts/ui/note-editor.js'), 'utf8');

  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);
  await until(`!!SF.app.state.client && typeof SF.app.state.client.saveNote === 'function'`);

  // 打开第一条内容：详情里要有「留下点什么」。
  const itemId = await evaluate(`SF.app.state.client.listContents({limit: 10}).then(r => r.items[0].id)`);
  assert.ok(itemId, '需要至少一条内容');
  await until(`!!document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(itemId))} + ']')`);
  await evaluate(`document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(itemId))} + ']').click()`);
  await until(`!!document.querySelector('[data-note-editor]')`);

  /* 1. 没有已保存笔记：默认「不写笔记」，不展开字段，也没有保存按钮。 */
  const initial = await evaluate(`(() => ({
    type: document.querySelector('select[aria-label="笔记类型"]').value,
    fields: document.querySelectorAll('[data-note-editor] textarea').length,
    save: Array.from(document.querySelectorAll('[data-note-editor] button')).some(b => b.textContent.trim() === '保存笔记'),
    badge: !!document.querySelector('.content-card__note'),
  }))()`);
  assert.equal(initial.type, 'none', '默认不写笔记');
  assert.equal(initial.fields, 0, '不写笔记时不展开编辑字段');
  assert.equal(initial.save, false, '不写笔记时不显示保存按钮');
  assert.equal(initial.badge, false, '没有笔记就不显示「有笔记」');

  /* 2. 只选模板不落库。 */
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="笔记类型"]');
    select.value = 'general';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`document.querySelectorAll('[data-note-editor] textarea').length === 2`);
  const afterPick = await evaluate(`SF.app.state.client.listNotes({}).then(r => r.total)`);
  assert.equal(afterPick, 0, '只选模板不能落库');

  /* 3. 写总结并保存：笔记建起来，卡片出现「有笔记」。 */
  await evaluate(`(() => {
    const area = document.querySelector('textarea[aria-label="总结"]');
    area.value = '这篇讲清楚了异步的边界。';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记').click()`);
  await until(`SF.app.state.client.listNotes({}).then(r => r.total === 1)`);
  await until(`!!document.querySelector('.content-card__note')`);
  const saved = await evaluate(`SF.app.state.client.getNote(${JSON.stringify(itemId)})`);
  assert.equal(saved.summary, '这篇讲清楚了异步的边界。');
  assert.equal(saved.template, 'general');
  assert.equal(saved.summary_origin, 'manual', '手写总结的来路是 manual');

  /* 4. 换成项目笔记：多出结论字段，保存后结论也在。 */
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="笔记类型"]');
    select.value = 'project';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`!!document.querySelector('.note-editor__verdict')`);
  await evaluate(`(() => {
    const area = document.querySelector('textarea[aria-label="这个项目解决什么问题"]');
    area.value = '让本地文档能被检索。';
    area.dispatchEvent(new Event('input', {bubbles: true}));
    // 结论是分段按钮：点「在用」。
    Array.from(document.querySelectorAll('.note-editor__verdict-btn'))
      .find(b => b.textContent.trim() === '在用').click();
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记').click()`);
  await until(`SF.app.state.client.getNote(${JSON.stringify(itemId)}).then(n => n && n.verdict === 'using')`);
  const project = await evaluate(`SF.app.state.client.getNote(${JSON.stringify(itemId)})`);
  assert.equal(project.template, 'project');
  assert.equal(project.summary, '让本地文档能被检索。');

  /* 4b. 重新载入（模拟页面重载）：模板、总结、心得、结论都要正确回显。 */
  await evaluate(noteEditorSource);
  await evaluate(`document.querySelector('button[aria-label="关闭详情"]').click()`);
  await until(`!document.querySelector('[data-note-editor]')`);
  await until(`!!document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(itemId))} + ']')`);
  await evaluate(`document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(itemId))} + ']').click()`);
  await until(`!!document.querySelector('[data-note-editor]')`);
  await until(`document.querySelector('select[aria-label="笔记类型"]').value === 'project'`);
  const reloaded = await evaluate(`(() => ({
    type: document.querySelector('select[aria-label="笔记类型"]').value,
    summary: document.querySelector('textarea[aria-label="这个项目解决什么问题"]').value,
    takeaway: document.querySelector('textarea[aria-label="我的判断／使用心得"]').value,
    verdict: (document.querySelector('.note-editor__verdict-btn.is-active') || {}).textContent,
  }))()`);
  assert.equal(reloaded.type, 'project', '重载后模板要回显');
  assert.equal(reloaded.summary, '让本地文档能被检索。', '重载后总结要回显');
  assert.equal(reloaded.takeaway, '', '重载后心得要回显');
  assert.equal(reloaded.verdict, '在用', '重载后结论要回显');

  /* 5. 项目切回通用：结论要确认后清除，总结与心得保留；未保存前不改库。 */
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="笔记类型"]');
    select.value = 'general';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`!!document.querySelector('.dialog')`);
  const confirmText = await evaluate(`document.querySelector('.dialog').textContent`);
  assert.ok(confirmText.includes('结论'), '切模板要问一句结论怎么处理');
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '清掉结论').click()`);
  await until(`!document.querySelector('.dialog')`);
  const stillProject = await evaluate(`SF.app.state.client.getNote(${JSON.stringify(itemId)})`);
  assert.equal(stillProject.verdict, 'using', '没点保存前不能动已经存好的笔记');
  const draftVerdict = await evaluate(`document.querySelector('.note-editor__verdict') ? 'has' : 'none'`);
  assert.equal(draftVerdict, 'none', '草稿里已经没有结论这一栏了');

  /* 6. 冲突：草稿保留，并说清有更新的版本。 */
  await evaluate(`(() => {
    const area = document.querySelector('textarea[aria-label="总结"]');
    area.value = '我的草稿文字';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await evaluate(`(() => {
    const client = SF.app.state.client;
    window.__originalSave = client.saveNote;
    client.saveNote = function (id, note) {
      // 模拟：库里那条已经被别处改过。
      return client.getNote(id).then(function (current) {
        return Promise.reject({code: 'CONFLICT', message: '笔记已经被改过，请刷新后再保存'});
      });
    };
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记').click()`);
  await until(`(document.querySelector('.note-editor__status') || {}).textContent && document.querySelector('.note-editor__status').textContent.includes('已经有更新的版本')`);
  const conflictDraft = await evaluate(`document.querySelector('textarea[aria-label="总结"]').value`);
  assert.equal(conflictDraft, '我的草稿文字', '冲突不能把用户的文字冲掉');
  await evaluate(`(() => { SF.app.state.client.saveNote = window.__originalSave; delete window.__originalSave; })()`);

  /* 7. 保存失败：草稿保留，状态说清失败。 */
  await evaluate(`(() => {
    const client = SF.app.state.client;
    window.__originalSave = client.saveNote;
    client.saveNote = function () { return Promise.reject(new Error('模拟的保存失败')); };
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记').click()`);
  await until(`(document.querySelector('.note-editor__status') || {}).textContent && document.querySelector('.note-editor__status').textContent.includes('模拟的保存失败')`);
  const failedDraft = await evaluate(`document.querySelector('textarea[aria-label="总结"]').value`);
  assert.equal(failedDraft, '我的草稿文字', '保存失败不能清空输入');
  await evaluate(`(() => { SF.app.state.client.saveNote = window.__originalSave; delete window.__originalSave; })()`);

  /* 8. 已有笔记改成「不写笔记」：要确认；取消恢复模板与文字。 */
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="笔记类型"]');
    select.value = 'none';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`!!document.querySelector('.dialog')`);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '取消').click()`);
  await until(`!document.querySelector('.dialog')`);
  const afterCancel = await evaluate(`(() => ({
    type: document.querySelector('select[aria-label="笔记类型"]').value,
    text: (document.querySelector('textarea[aria-label="总结"]') || {}).value,
    notes: 0,
  }))()`);
  assert.notEqual(afterCancel.type, 'none', '取消后要恢复原来的模板');
  assert.equal(afterCancel.text, '我的草稿文字', '取消后文字不能丢');
  const stillThere = await evaluate(`SF.app.state.client.listNotes({}).then(r => r.total)`);
  assert.equal(stillThere, 1, '取消不能删笔记');

  /* 9. 确认删除：笔记删掉，「有笔记」消失，内容还在。 */
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="笔记类型"]');
    select.value = 'none';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`!!document.querySelector('.dialog')`);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '删除').click()`);
  await until(`SF.app.state.client.listNotes({}).then(r => r.total === 0)`);
  await until(`!document.querySelector('.content-card__note')`);
  const contentStill = await evaluate(`SF.app.state.client.getContent(${JSON.stringify(itemId)})`);
  assert.equal(contentStill.id, itemId, '删笔记不删内容');
  assert.equal(contentStill.hasNote, false);

  /* 10. 换条目再回来：草稿按内容 ID 各自保存，不串内容。 */
  const secondId = await evaluate(`SF.app.state.client.listContents({limit: 10}).then(r => r.items[1] && r.items[1].id)`);
  assert.ok(secondId, '需要第二条内容');
  await until(`!!document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(secondId))} + ']')`);
  await evaluate(`document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(secondId))} + ']').click()`);
  await until(`document.querySelector('[data-note-editor]').getAttribute('data-note-editor') === ${JSON.stringify(secondId)}`);
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="笔记类型"]');
    select.value = 'general';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`document.querySelectorAll('[data-note-editor] textarea').length === 2`);
  await evaluate(`(() => {
    const area = document.querySelector('textarea[aria-label="总结"]');
    area.value = '第二条的草稿';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await until(`!!document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(itemId))} + ']')`);
  await evaluate(`document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(itemId))} + ']').click()`);
  await until(`document.querySelector('[data-note-editor]').getAttribute('data-note-editor') === ${JSON.stringify(itemId)}`);
  const firstDraft = await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="笔记类型"]');
    const area = document.querySelector('textarea[aria-label="总结"]');
    return {type: select.value, text: area ? area.value : null};
  })()`);
  assert.equal(firstDraft.type, 'none', '第一条没有草稿，不该被第二条的带过来');
  await until(`!!document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(secondId))} + ']')`);
  await evaluate(`document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(secondId))} + ']').click()`);
  await until(`document.querySelector('[data-note-editor]').getAttribute('data-note-editor') === ${JSON.stringify(secondId)}`);
  const secondDraft = await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="笔记类型"]');
    const area = document.querySelector('textarea[aria-label="总结"]');
    return {type: select.value, text: area ? area.value : null};
  })()`);
  assert.equal(secondDraft.type, 'general', '第二条的草稿还在');
  assert.equal(secondDraft.text, '第二条的草稿', '第二条的草稿文字还在');

  /* 11. 关闭详情：草稿没保存时要问一句；放弃后关闭。 */
  await evaluate(`(() => {
    // 5.1 期（M33）后详情头有上一条／下一条／关闭三个图标键，
    // 不能再用「详情头里任意 .icon-btn」定位——那样点到的是上一条。
    const button = document.querySelector('.detail__head button[aria-label="关闭详情"]');
    if (!button) throw new Error('找不到关闭详情的按钮');
    button.click();
  })()`);
  await until(`!!document.querySelector('.dialog')`);
  const leaveText = await evaluate(`document.querySelector('.dialog').textContent`);
  assert.ok(leaveText.includes('未保存'), '关闭详情前要问一句');
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '放弃内容').click()`);
  await until(`!document.querySelector('.dialog')`);
  await until(`!document.querySelector('[data-note-editor]')`);

  /* 12. 离开页面：草稿没保存时同样要问；继续编辑就留在原地。 */
  await until(`!!document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(secondId))} + ']')`);
  await evaluate(`document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(secondId))} + ']').click()`);
  await until(`!!document.querySelector('[data-note-editor]')`);
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="笔记类型"]');
    select.value = 'general';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`document.querySelectorAll('[data-note-editor] textarea').length === 2`);
  await evaluate(`(() => {
    const area = document.querySelector('textarea[aria-label="总结"]');
    area.value = '离开前写的字';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await evaluate(`SF.app.navigate('channels')`);
  await until(`!!document.querySelector('.dialog')`);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '继续编辑').click()`);
  await until(`!document.querySelector('.dialog')`);
  const stayed = await evaluate(`SF.app.state.route.name`);
  assert.equal(stayed, 'inbox', '选择继续编辑就留在原地');
  const keptText = await evaluate(`(document.querySelector('textarea[aria-label="总结"]') || {}).value`);
  assert.equal(keptText, '离开前写的字', '留在原地时草稿不能丢');

  /* 13. 延迟保存：请求在途时继续输入，输入不能消失；
         回执只确认提交快照，下一次保存要用更新后的版本。 */
  const thirdId = await evaluate(`SF.app.state.client.listContents({limit: 10}).then(r => r.items[2].id)`);
  assert.ok(thirdId, '需要第三条内容');
  await until(`!!document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(thirdId))} + ']')`);
  await evaluate(`document.querySelector('.content-card[data-content-id=' + ${JSON.stringify(JSON.stringify(thirdId))} + ']').click()`);
  await until(`!!document.querySelector('[data-note-editor]')`);
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="笔记类型"]');
    select.value = 'general';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`document.querySelectorAll('[data-note-editor] textarea').length === 2`);
  await evaluate(`(() => {
    const area = document.querySelector('textarea[aria-label="总结"]');
    area.value = '提交时的文字';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  // 假客户端：保存请求挂起，由测试决定什么时候回。
  await evaluate(`(() => {
    const client = SF.app.state.client;
    window.__sent = [];
    window.__pending = null;
    client.saveNote = function (id, payload) {
      window.__sent.push(payload);
      return new Promise((resolve, reject) => { window.__pending = {resolve: resolve, reject: reject}; });
    };
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记').click()`);
  await until(`!!window.__pending`);
  // 请求还在路上，继续写。
  await evaluate(`(() => {
    const area = document.querySelector('textarea[aria-label="总结"]');
    window.__inputEnabled = !area.disabled;
    area.value = '等待期间继续写的字';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  const during = await evaluate(`({enabled: window.__inputEnabled, value: document.querySelector('textarea[aria-label="总结"]').value})`);
  assert.equal(during.enabled, true, '保存期间允许继续写');
  assert.equal(during.value, '等待期间继续写的字', '请求在途时输入不能消失');
  // 回执到了：只确认提交快照，新输入留着。
  await evaluate(`window.__pending.resolve({
    content_id: ${JSON.stringify(thirdId)}, template: 'general', summary: '提交时的文字',
    takeaway: '', verdict: null, summary_origin: 'manual', version: 'v-next',
    created_at: '2026-10-22', updated_at: '2026-10-22'})`);
  await until(`(document.querySelector('.note-editor__status') || {}).textContent && document.querySelector('.note-editor__status').textContent.includes('还没保存')`);
  const afterAck = await evaluate(`({
    value: document.querySelector('textarea[aria-label="总结"]').value,
    dirty: SF.noteUi.hasDirty(${JSON.stringify(thirdId)}),
  })`);
  assert.equal(afterAck.value, '等待期间继续写的字', '回执不能把请求之后的输入冲掉');
  assert.equal(afterAck.dirty, true, '请求之后的输入仍然是未保存的');
  // 下一次保存要用更新后的版本令牌。
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记').click()`);
  await until(`window.__sent.length === 2`);
  const sent = await evaluate(`JSON.stringify(window.__sent)`);
  const payloads = JSON.parse(sent);
  assert.equal(payloads[0].expectedVersion, null, '第一次是新建');
  assert.equal(payloads[1].expectedVersion, 'v-next', '下一次保存要用回执带来的新版本');
  assert.equal(payloads[1].summary, '等待期间继续写的字', '下一次保存提交的是最新的输入');
  // 延迟失败：输入同样不能消失。
  await evaluate(`window.__pending.reject(new Error('模拟的延迟失败'))`);
  await until(`(document.querySelector('.note-editor__status') || {}).textContent && document.querySelector('.note-editor__status').textContent.includes('模拟的延迟失败')`);
  const afterFail = await evaluate(`document.querySelector('textarea[aria-label="总结"]').value`);
  assert.equal(afterFail, '等待期间继续写的字', '延迟失败也不能清空输入');

  console.log('[m27] 留下点什么实机验收通过');
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-m27-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const seed = spawnSync(runtime.python, [path.join(root, 'scripts/seed-m26-notes.py'), folder], {encoding: 'utf8'});
  if (seed.status !== 0) {
    console.error(seed.stderr || seed.stdout);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = 1;
    return;
  }
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'm27', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', code => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
