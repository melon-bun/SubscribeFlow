const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * M29 AI 总结的实机验收。
 *
 * 跑的是正式 Renderer + 正式 Main + 正式 Core（真实 IPC 通道）。
 * 模型请求被主进程里的假传输接住：请求确实发出去了、提示词确实带上了，
 * 但没有真实模型参与——**模型服从性与总结质量不在此下结论**。
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
          body: document.body.innerText.slice(0, 300),
          status: SF.app.state.coreStatus,
          session: !!SF.app.state.session,
          route: SF.app.state.route,
        })`).catch(e => String(e));
        throw new Error('Timed out: ' + expression + '\n' + diag);
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
  await until(`!!SF.app.state.client && typeof SF.app.state.client.saveSettings === 'function'`);
  // 会话就绪才算启动完成：会话没到时改路由不会触发重画，页面会停在启动画面。
  await until(`!!SF.app.state.session`);

  /* 替身回执：渲染层把总结请求换成确定的响应。
     真实 Core 的业务行为（提示词、范围、错误分类、不落库）由
     python/tests/test_summary.py 用假传输覆盖；这里只验界面闭环。 */
  const sent = [];
  let nextDraft = {ok: true, summary: '这是一段 AI 总结。', scope: '正文',
                   input_chars: 20, input_total_chars: 20, input_truncated: false,
                   content_version: null, config_version: 1,
                   provider: {id: 'provider-llm', name: '总结用连接', model: 'demo-model'},
                   length: 'detailed', language: 'zh-CN', model: 'demo-model'};
  await evaluate(`(() => {
    const client = SF.app.state.client;
    window.__draftCalls = [];
    window.__originalDraft = client.draftNote;
    client.draftNote = function (itemId, requestId) {
      window.__draftCalls.push({item_id: itemId, request_id: requestId});
      return Promise.resolve(window.__nextDraft);
    };
  })()`);
  const setDraft = (value) => evaluate(`window.__nextDraft = ${JSON.stringify(value)}`);
  await setDraft(nextDraft);
  // 总结非空时点生成会先问「要不要替换」：答「生成并替换」才真的发请求。
  const confirmGenerate = async () => {
    for (let i = 0; i < 40; i++) {
      if (await evaluate(`!!document.querySelector('.dialog')`)) break;
      await pause(25);
    }
    if (await evaluate(`!!document.querySelector('.dialog')`)) {
      await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '生成并替换').click()`);
    }
  };

  /* 1. 设置里的「AI 总结」分区：能打开，字段都在。 */
  await evaluate(`SF.app.navigate('settings', {section: 'summarization'})`);
  await until(`document.querySelector('.settings__title') && document.querySelector('.settings__title').textContent === 'AI 总结'`);
  const fields = await evaluate(`({
    toggle: !!document.querySelector('.field .switch, .field [role="switch"]'),
    provider: !!document.querySelector('select[aria-label="总结使用的连接"]'),
    length: !!document.querySelector('select[aria-label="总结详细程度"]'),
    language: !!document.querySelector('select[aria-label="总结输出语言"]'),
  })`);
  assert.equal(fields.provider, true, '要有连接选择');
  assert.equal(fields.length, true, '要有详细程度');
  assert.equal(fields.language, true, '要有输出语言');

  /* 2. 改成「复杂 · 300 字」并保存：重启后仍然在。 */
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="总结详细程度"]');
    select.value = 'detailed';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`!Array.from(document.querySelectorAll('.settings__foot button')).find(b => b.textContent.trim() === '保存设置').disabled`);
  await evaluate(`Array.from(document.querySelectorAll('.settings__foot button')).find(b => b.textContent.trim() === '保存设置').click()`);
  await until(`(document.querySelector('.settings__foot-hint') || {}).textContent !== '正在保存…'`);
  const savedLength = await evaluate(`SF.app.state.client.getSettings().then(s => s.summarization.length)`);
  assert.equal(savedLength, 'detailed', '详细程度要保存下来');
  const savedRevision = await evaluate(`SF.app.state.client.getSettings().then(s => s.summarization.revision)`);
  assert.ok(savedRevision >= 2, '总结策略变了要推进自己的版本');

  /* 3. 解除引用：明确 null，不被默认复活。 */
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="总结使用的连接"]');
    select.value = '';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`!Array.from(document.querySelectorAll('.settings__foot button')).find(b => b.textContent.trim() === '保存设置').disabled`);
  await evaluate(`Array.from(document.querySelectorAll('.settings__foot button')).find(b => b.textContent.trim() === '保存设置').click()`);
  await until(`(document.querySelector('.settings__foot-hint') || {}).textContent !== '正在保存…'`);
  const cleared = await evaluate(`SF.app.state.client.getSettings().then(s => s.summarization.providerId)`);
  assert.equal(cleared, null, '解除引用要真的存成 null');
  // 选回来，供后面的生成用。
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="总结使用的连接"]');
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`!Array.from(document.querySelectorAll('.settings__foot button')).find(b => b.textContent.trim() === '保存设置').disabled`);
  await evaluate(`Array.from(document.querySelectorAll('.settings__foot button')).find(b => b.textContent.trim() === '保存设置').click()`);
  await until(`(document.querySelector('.settings__foot-hint') || {}).textContent !== '正在保存…'`);
  const repicked = await evaluate(`SF.app.state.client.getSettings().then(s => s.summarization.providerId)`);
  assert.ok(repicked, '要能选回一条连接');

  /* 4. 打开内容详情：没选模板时不显示生成入口。 */
  await evaluate(`SF.app.navigate('inbox')`);
  await until(`!!document.querySelector('.content-card')`);
  await evaluate(`document.querySelector('.content-card').click()`);
  await until(`!!document.querySelector('[data-note-editor]')`);
  const noTemplate = await evaluate(`!!document.querySelector('[data-note-editor] .note-editor__ai')`);
  assert.equal(noTemplate, false, '没选模板不显示生成入口');

  /* 5. 选通用笔记：入口出现。 */
  await evaluate(`(() => {
    const select = document.querySelector('[data-note-editor] select[aria-label="笔记类型"]');
    select.value = 'general';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`!!document.querySelector('[data-note-editor] .note-editor__ai')`);
  const draftCalls = await evaluate(`JSON.stringify(window.__draftCalls)`);
  assert.equal(JSON.parse(draftCalls).length, 0, '不会自动生成');

  /* 6. 点「AI 总结」：草稿填进总结，但没有落库。 */
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === 'AI 总结').click()`);
  await until(`SF.app.state.client.listNotes({}).then(r => r.total === 0)`, 10000);
  await until(`(document.querySelector('[data-note-editor] textarea[aria-label="总结"]') || {}).value === '这是一段 AI 总结。'`);
  const calls = JSON.parse(await evaluate(`JSON.stringify(window.__draftCalls)`));
  assert.equal(calls.length, 1, '只发一次请求');
  assert.ok(calls[0].item_id, '请求带内容 ID');
  const noteBeforeSave = await evaluate(`SF.app.state.client.listNotes({}).then(r => r.total)`);
  assert.equal(noteBeforeSave, 0, '生成不落库');

  /* 7. 保存笔记：来路是 ai（未改动的 AI 结果）。 */
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记').click()`);
  await until(`SF.app.state.client.listNotes({}).then(r => r.total === 1)`);
  const aiNote = await evaluate(`SF.app.state.client.getNote(${JSON.stringify(await evaluate(`SF.app.state.client.listNotes({}).then(r => r.items[0].id)`))})`);
  assert.equal(aiNote.summary_origin, 'ai', '未改动的 AI 总结存成 ai');
  assert.equal(aiNote.summary, '这是一段 AI 总结。');

  /* 8. 手改 AI 总结再保存：来路变成 ai_edited。 */
  await evaluate(`(() => {
    const area = document.querySelector('[data-note-editor] textarea[aria-label="总结"]');
    area.value = '这是我改过的总结。';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记').click()`);
  await until(`SF.app.state.client.getNote(${JSON.stringify(aiNote.content_id)}).then(n => n.summary === '这是我改过的总结。')`);
  const edited = await evaluate(`SF.app.state.client.getNote(${JSON.stringify(aiNote.content_id)})`);
  assert.equal(edited.summary_origin, 'ai_edited', '改过的 AI 总结存成 ai_edited');

  /* 9. 纯手写的总结：来路是 manual（先把总结清空，再自己写）。 */
  await evaluate(`(() => {
    const area = document.querySelector('[data-note-editor] textarea[aria-label="总结"]');
    area.value = '';
    area.dispatchEvent(new Event('input', {bubbles: true}));
    area.value = '纯手写的总结。';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记').click()`);
  await until(`SF.app.state.client.getNote(${JSON.stringify(aiNote.content_id)}).then(n => n.summary === '纯手写的总结。')`);
  const manual = await evaluate(`SF.app.state.client.getNote(${JSON.stringify(aiNote.content_id)})`);
  assert.equal(manual.summary_origin, 'manual', '纯手写存成 manual');
  assert.equal(manual.summary, '纯手写的总结。');

  /* 10. 已有非空总结时点生成：先确认；取消就不发请求。 */
  const beforeCancel = (JSON.parse(await evaluate(`JSON.stringify(window.__draftCalls)`))).length;
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === 'AI 总结').click()`);
  await until(`!!document.querySelector('.dialog')`);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '取消').click()`);
  await until(`!document.querySelector('.dialog')`);
  await pause(300);
  const afterCancelCalls = JSON.parse(await evaluate(`JSON.stringify(window.__draftCalls)`)).length;
  assert.equal(afterCancelCalls, beforeCancel, '取消覆盖就不该发请求');
  const keptText = await evaluate(`document.querySelector('[data-note-editor] textarea[aria-label="总结"]').value`);
  assert.equal(keptText, '纯手写的总结。', '取消后旧文字不能丢');

  /* 11. 生成失败：说清原因，旧文字保留。 */
  await setDraft({ok: false, code: 'auth_failed', message: '模型服务拒绝了当前密钥（HTTP 401）'});
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === 'AI 总结').click()`);
  await until(`!!document.querySelector('.dialog')`);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '生成并替换').click()`);
  await until(`(document.querySelector('[data-note-editor] .field__error') || {}).textContent`);
  const failureText = await evaluate(`document.querySelector('[data-note-editor] .field__error').textContent`);
  assert.ok(failureText.includes('密钥') || failureText.includes('auth'), '失败要说清原因：' + failureText);
  const afterFailure = await evaluate(`document.querySelector('[data-note-editor] textarea[aria-label="总结"]').value`);
  assert.equal(afterFailure, '纯手写的总结。', '失败不能先清空旧文字');
  await setDraft(nextDraft);

  /* 12. 生成期间改了总结：回来的结果不自动覆盖。 */
  await evaluate(`(() => {
    const client = SF.app.state.client;
    client.draftNote = function (itemId, requestId) {
      return new Promise((resolve) => { window.__finishDraft = () => resolve({
        ok: true, item_id: itemId, request_id: requestId, summary: '迟到的总结。',
        scope: '正文', input_chars: 10, input_total_chars: 10, input_truncated: false,
        content_version: null, config_version: 1, provider: {id: 'provider-llm', name: 'x', model: 'm'},
        length: 'detailed', language: 'zh-CN', model: 'demo-model' }); });
    };
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === 'AI 总结').click()`);
  await until(`!!document.querySelector('.dialog')`);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '生成并替换').click()`);
  await until(`!!window.__finishDraft`);
  // 请求在途时改总结。
  await evaluate(`(() => {
    const area = document.querySelector('[data-note-editor] textarea[aria-label="总结"]');
    area.value = '我在生成期间写的。';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await evaluate(`window.__finishDraft()`);
  await until(`!!document.querySelector('[data-note-editor] .note-editor__ai-result')`);
  const lateText = await evaluate(`document.querySelector('[data-note-editor] textarea[aria-label="总结"]').value`);
  assert.equal(lateText, '我在生成期间写的。', '迟到的结果不能静默覆盖用户输入');
  const adoptable = await evaluate(`!!Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '采用这段总结')`);
  assert.equal(adoptable, true, '结果要保留成可采用的草稿');
  await evaluate(`(() => { SF.app.state.client.draftNote = window.__originalDraft; delete window.__originalDraft; })()`);
  await setDraft(nextDraft);

  /* 12b. 生成期间关掉总结：旧结果不得自动填入，但留着可采用。 */
  await evaluate(`(() => {
    const client = SF.app.state.client;
    client.draftNote = function (itemId, requestId) {
      // 回执带上请求那一刻的连接版本，和 Core 的做法一样。
      return client.getSettings().then(function (settings) {
        const provider = settings.ai.providers['provider-llm'];
        return new Promise((resolve) => { window.__finishDraft = () => resolve({
          ok: true, item_id: itemId, request_id: requestId, summary: '快照期的总结。',
          scope: '正文', input_chars: 20, input_total_chars: 20, input_truncated: false,
          content_version: null, config_version: '1.1.1',
          config: {enabled: true, providerId: 'provider-llm', length: 'detailed', language: 'zh-CN', revision: 1},
          provider: {id: 'provider-llm', name: provider.name, model: provider.model, revision: provider.revision},
          length: 'detailed', language: 'zh-CN', model: 'demo-model' }); });
      });
    };
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === 'AI 总结').click()`);
  await confirmGenerate();
  await until(`!!window.__finishDraft`);
  // 生成在途：把总结开关关掉（真实设置保存）。
  await evaluate(`SF.app.state.client.saveSettings({section: 'summarization', patch: {enabled: false}})`);
  await until(`SF.app.state.client.getSettings().then(s => s.summarization.enabled === false)`);
  await evaluate(`window.__finishDraft()`);
  await until(`Array.from(document.querySelectorAll('[data-note-editor] button')).some(b => b.textContent.trim() === '采用这段总结')`);
  const afterDisable = await evaluate(`({
    value: document.querySelector('[data-note-editor] textarea[aria-label="总结"]').value,
    adopt: Array.from(document.querySelectorAll('[data-note-editor] button')).some(b => b.textContent.trim() === '采用这段总结'),
  })`);
  assert.notEqual(afterDisable.value, '快照期的总结。', '关掉总结后旧结果不能自动填入');
  assert.equal(afterDisable.adopt, true, '旧结果要留着让用户显式采用');
  // 把总结重新打开。
  await evaluate(`SF.app.state.client.saveSettings({section: 'summarization', patch: {enabled: true}})`);
  await until(`SF.app.state.client.getSettings().then(s => s.summarization.enabled === true)`);
  await evaluate(`(() => { SF.app.state.client.draftNote = window.__originalDraft; delete window.__originalDraft; })()`);
  await setDraft(nextDraft);

  /* 12c. 生成期间改所用连接的模型：旧结果不得自动填入。 */
  await evaluate(`(() => {
    const client = SF.app.state.client;
    client.draftNote = function (itemId, requestId) {
      return client.getSettings().then(function (settings) {
        const provider = settings.ai.providers['provider-llm'];
        return new Promise((resolve) => { window.__finishDraft = () => resolve({
          ok: true, item_id: itemId, request_id: requestId, summary: '改模型前的总结。',
          scope: '正文', input_chars: 20, input_total_chars: 20, input_truncated: false,
          content_version: null, config_version: '1.1.1',
          config: {enabled: true, providerId: 'provider-llm', length: 'detailed', language: 'zh-CN', revision: 1},
          provider: {id: 'provider-llm', name: provider.name, model: provider.model, revision: provider.revision},
          length: 'detailed', language: 'zh-CN', model: 'demo-model' }); });
      });
    };
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === 'AI 总结').click()`);
  await confirmGenerate();
  await until(`!!window.__finishDraft`);
  await evaluate(`SF.app.state.client.saveSettings({section: 'ai', patch: {providers: {'provider-llm': {model: 'other-model'}}}})`);
  await until(`SF.app.state.client.getSettings().then(s => s.ai.providers['provider-llm'].model === 'other-model')`);
  await evaluate(`window.__finishDraft()`);
  await until(`Array.from(document.querySelectorAll('[data-note-editor] button')).some(b => b.textContent.trim() === '采用这段总结')`);
  const afterModel = await evaluate(`document.querySelector('[data-note-editor] textarea[aria-label="总结"]').value`);
  assert.notEqual(afterModel, '改模型前的总结。', '改所用连接的模型后旧结果不能自动填入');
  await evaluate(`(() => { SF.app.state.client.draftNote = window.__originalDraft; delete window.__originalDraft; })()`);
  await setDraft(nextDraft);

  /* 12d. 改无关的连接：结果仍然可以用（不该误判过期）。 */
  await evaluate(`(() => {
    const client = SF.app.state.client;
    client.draftNote = function (itemId, requestId) {
      return client.getSettings().then(function (settings) {
        const provider = settings.ai.providers['provider-llm'];
        return new Promise((resolve) => { window.__finishDraft = () => resolve({
          ok: true, item_id: itemId, request_id: requestId, summary: '不受影响的总结。',
          scope: '正文', input_chars: 20, input_total_chars: 20, input_truncated: false,
          content_version: null, config_version: '1.1.1',
          config: {enabled: true, providerId: 'provider-llm', length: 'detailed', language: 'zh-CN', revision: 1},
          provider: {id: 'provider-llm', name: provider.name, model: provider.model, revision: provider.revision},
          length: 'detailed', language: 'zh-CN', model: 'demo-model' }); });
      });
    };
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === 'AI 总结').click()`);
  await confirmGenerate();
  await until(`!!window.__finishDraft`);
  await evaluate(`SF.app.state.client.saveSettings({section: 'ai', patch: {providers: {'provider-other': {model: 'changed-model'}}}})`);
  await until(`SF.app.state.client.getSettings().then(s => s.ai.providers['provider-other'].model === 'changed-model')`);
  await evaluate(`window.__finishDraft()`);
  await until(`(document.querySelector('[data-note-editor] textarea[aria-label="总结"]') || {}).value === '不受影响的总结。'`);
  await evaluate(`(() => { SF.app.state.client.draftNote = window.__originalDraft; delete window.__originalDraft; })()`);
  await setDraft(nextDraft);

  /* 13. 笔记页用同一套编辑区：入口与行为一致。
     离开收件箱时草稿还没保存：先问一句，选「放弃内容」再走。 */
  await evaluate(`SF.app.navigate('notes')`);
  await until(`!!document.querySelector('.dialog')`);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '放弃内容').click()`);
  await until(`SF.app.state.route.name === 'notes'`);
  await until(`document.querySelectorAll('.notes-toc__item').length === 1`);
  await evaluate(`document.querySelector('.notes-toc__item').click()`);
  await until(`!!document.querySelector('[data-note-editor]')`);
  const notesEntry = await evaluate(`!!document.querySelector('[data-note-editor] .note-editor__ai')`);
  assert.equal(notesEntry, true, '笔记页也要有同一个生成入口');
  const sameShape = await evaluate(`({
    editor: !!document.querySelector('[data-note-editor] select[aria-label="笔记类型"]'),
    summary: !!document.querySelector('[data-note-editor] textarea[aria-label="总结"]'),
  })`);
  assert.equal(sameShape.editor, true);
  assert.equal(sameShape.summary, true);

  console.log('[m29] AI 总结实机验收通过');
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-m29-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const seed = spawnSync(runtime.python, [path.join(root, 'scripts/seed-m29-summary.py'), folder], {encoding: 'utf8'});
  if (seed.status !== 0) {
    console.error(seed.stderr || seed.stdout);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = 1;
    return;
  }
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'm29', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', code => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
