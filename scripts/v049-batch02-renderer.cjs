const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * 0.4.9 batch-02 实机验收（M21：AI API 与识别策略分离）。
 *
 * 跑的是正式 Renderer + 正式 Core（Electron 真进程、隔离临时库、离线种子）。
 * 种子写的是 M21 之前的旧结构，因此同时验证旧配置升级。
 *
 * 全程不触网、不登录、不读真实 Key、不调用付费业务模型：
 * 种子里的端点是不可解析的假地址，库里没有内容，不会产生自动打标任务；
 * 连接测试按钮只确认在位，不点击（那会发出真实模型请求）。
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
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      if (value) return true;
      if (Date.now() - start > 3000) console.log('[probe-until] still false:', expression, 'value=', JSON.stringify(value), 'elapsed=', Date.now() - start);
      if (Date.now() - start > timeout) throw new Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText'));
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  };
  const screenshot = async name => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root, 'docs/verification/v0.4.9-minimax/batch-02');
    fs.mkdirSync(output, {recursive: true});
    fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage()).toPNG());
  };
  const clickByText = async (text, selector = 'button') => evaluate(`(() => {
    const b = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(b => b.textContent.trim() === ${JSON.stringify(text)});
    if (!b) throw new Error('Missing button: ' + ${JSON.stringify(text)});
    if (b.disabled) throw new Error('Disabled button: ' + ${JSON.stringify(text)});
    b.click();
  })()`);

  /** 连接卡片按名称与字段标签定位：卡片有几条、字段顺序如何都会变。 */
  const setCardField = (cardTitle, label, value) => evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.setting-stack .setting-block')).find(c => { const t = c.querySelector('.setting-block__title'); return t && t.textContent.trim() === ${JSON.stringify(cardTitle)}; });
    if (!card) return false;
    const field = Array.from(card.querySelectorAll('.field')).find(f => { const l = f.querySelector('.field__label'); return l && l.textContent.trim() === ${JSON.stringify(label)}; });
    const input = field && field.querySelector('input');
    if (!input) return false;
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', {bubbles: true}));
    return true;
  })()`);

  await until(`!!window.SF?.app.state.session`);
  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);

  /* ================= 旧配置升级 ================= */

  const upgraded = await core.call('settings.get');
  assert.equal(upgraded.version, 3, '旧配置的版本号应当保留');
  assert.equal(upgraded.ai.providers['provider-jev'].endpoint, 'https://api.example.invalid/v1',
    '旧结构里的接口地址必须搬到新的 ai.providers');
  assert.equal(upgraded.ai.providers['provider-jev'].model, 'jev-legacy', '旧结构里的模型标识必须保留');
  assert.equal(upgraded.tagging.enabled, true, '升级不能重置自动打标开关');
  assert.equal(upgraded.tagging.mode, 'jev', '升级不能重置识别方式');
  assert.equal(upgraded.tagging.enabledSince, '2026-10-01T00:00:00+00:00', '升级不能重置原启用时间');
  assert.equal(upgraded.ai.providers['provider-llm'].endpoint, '', '另一种方式不能被旧数据污染');
  // 旧配置没有打标版本：以当前保存版本起头，升级前在跑的任务因此不会被作废。
  assert.equal(upgraded.tagging.revision, 3, '旧配置的打标版本应当从保存版本起头');

  /* ================= 设置页：只有连接参数 ================= */

  await evaluate(`location.hash = '#/settings?section=ai'`);
  await until(`!!document.querySelector('.settings') && document.querySelector('.settings__title').textContent === 'AI API 配置'`);
  const navLabels = await evaluate(`Array.from(document.querySelectorAll('.settings-nav__label')).map(n => n.textContent)`);
  // 5.1 期之后设置页多了两个分区：M25 的「AI 总结」与 M32 的「外观」。
  // 这条断言原来锁的是三个分区，是过期断言（见 BUG-120，
  // 在 a2505fe 上已可复现，与 5.1 期样式改造无关）。
  // 下面两条「自动打标开关／识别方式不在设置页」才是本段真正的意图，未改。
  assert.deepEqual(navLabels, ['AI API 配置', '提醒设置', '优先级名称', 'AI 总结', '外观']);
  assert.equal(await evaluate(`!!document.querySelector('.switch[aria-label="启用自动打标"]')`), false,
    '自动打标开关不在设置页');
  assert.equal(await evaluate(`!!document.querySelector('.mode-picker')`), false, '识别方式不在设置页');
  // 连接卡片是异步读回设置后才渲染的：先等卡片出现，再断言内容。
  await until(`!!document.querySelector('.setting-stack .setting-block__title')`);
  const apiTitles = await evaluate(`Array.from(document.querySelectorAll('.setting-stack .setting-block__title')).map(n => n.textContent)`);
  assert.deepEqual(apiTitles, ['Jev', 'LLM'], '设置页按连接 ID 列出已有连接');
  const jevEndpoint = await evaluate(`(() => {
    const block = Array.from(document.querySelectorAll('.setting-stack .setting-block')).find(b => b.querySelector('.setting-block__title').textContent.trim() === 'Jev');
    const field = Array.from(block.querySelectorAll('.field')).find(f => { const l = f.querySelector('.field__label'); return l && l.textContent.trim() === '接口地址'; });
    return field.querySelector('input').value;
  })()`);
  assert.equal(jevEndpoint, 'https://api.example.invalid/v1', '旧配置读进界面后仍是原值');
  const testButtons = await evaluate(`Array.from(document.querySelectorAll('.setting-stack button')).filter(b => b.textContent.trim() === '测试连接').length`);
  assert.equal(testButtons, 2, '每条连接各自有一个测试连接按钮');
  await screenshot('v049-b02-api-settings.png');

  /* ================= 只保存一类 API ================= */

  // 给 LLM 填一份假配置并保存：Jev 的参数与识别策略都不能被牵动。
  assert.equal(await setCardField('LLM', '接口地址', 'https://llm.example.invalid/v1'), true);
  assert.equal(await setCardField('LLM', '模型', 'llm-model'), true);
  await clickByText('保存设置');
  await until(`document.querySelector('.settings__foot-hint')?.textContent !== '正在保存…'`);
  await until(`!document.querySelector('.settings__foot-hint.is-dirty')`);
  const afterApiSave = await core.call('settings.get');
  assert.equal(afterApiSave.ai.providers['provider-llm'].endpoint, 'https://llm.example.invalid/v1', 'LLM 的接口地址应当保存成功');
  assert.equal(afterApiSave.ai.providers['provider-llm'].model, 'llm-model', 'LLM 的模型标识应当保存成功');
  assert.equal(afterApiSave.ai.providers['provider-jev'].endpoint, 'https://api.example.invalid/v1', '保存一类 API 不能动另一类');
  assert.equal(afterApiSave.tagging.enabled, true, '保存 API 不能动识别策略');
  assert.equal(afterApiSave.tagging.mode, 'jev', '保存 API 不能动识别方式');
  assert.equal(afterApiSave.tagging.enabledSince, '2026-10-01T00:00:00+00:00', '保存 API 不能动启用时间');

  // 允许保存不完整的参数：LLM 缺 API Key，状态要如实标出。
  const llmState = await evaluate(`(() => {
    const block = Array.from(document.querySelectorAll('.setting-stack .setting-block')).find(b => b.querySelector('.setting-block__title').textContent.trim() === 'LLM');
    return block.textContent;
  })()`);
  assert.ok(llmState.includes('未配置'), '缺 API Key 时要标出未配置，实际：' + llmState.slice(0, 120));

  /* ================= 标签页：识别设置 ================= */

  await evaluate(`location.hash = '#/tags?tab=ai'`);
  await until(`!!document.querySelector('[data-ai-slot="recognition"]')`);
  await until(`!!document.querySelector('[data-ai-slot="recognition"] .mode-picker')`);
  const recognitionText = await evaluate(`document.querySelector('[data-ai-slot="recognition"]').textContent`);
  assert.ok(recognitionText.includes('自动打标'), '识别设置要有自动打标开关');
  assert.ok(recognitionText.includes('Jev 已有标签分类'), '识别设置要有两种识别方式');
  assert.ok(recognitionText.includes('当前方式的 API'), '识别设置要显示当前方式的 API 摘要');
  assert.ok(recognitionText.includes('前往 AI API 配置'), '识别设置要有前往 API 配置的入口');
  assert.ok(recognitionText.includes('缺：API Key'), '缺项要直接写出来，实际：' + recognitionText.slice(0, 200));
  const switchOn = await evaluate(`document.querySelector('[data-ai-slot="recognition"] .switch').getAttribute('aria-checked')`);
  assert.equal(switchOn, 'true', '旧配置里的开关状态要带过来');
  const picked = await evaluate(`document.querySelector('[data-ai-slot="recognition"] .mode-card.is-active .mode-card__title').textContent`);
  assert.equal(picked, 'Jev 已有标签分类', '旧配置里的识别方式要带过来');
  await screenshot('v049-b02-recognition.png');

  /* ================= 不可运行的方式不能启用 / 不能切过去 ================= */

  // 切到 LLM（缺 API Key）并保存：必须被拦住，草稿保留。
  await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('[data-ai-slot="recognition"] .mode-card')).find(c => c.textContent.includes('LLM'));
    card.click();
  })()`);
  await clickByText('保存识别设置');
  await until(`!!document.querySelector('[data-ai-slot="recognition"] .field__hint--danger')`);
  const blocked = await evaluate(`document.querySelector('[data-ai-slot="recognition"] .field__hint--danger').textContent`);
  assert.ok(blocked.includes('API Key'), '缺项要说清缺什么，实际：' + blocked);
  assert.equal((await core.call('settings.get')).tagging.mode, 'jev', '被拦下的切换不能写进配置');
  const draftKept = await evaluate(`!!document.querySelector('[data-ai-slot="recognition"] .mode-card.is-active .mode-card__title') &&
    document.querySelector('[data-ai-slot="recognition"] .mode-card.is-active .mode-card__title').textContent === 'LLM 自由生成标签'`);
  assert.equal(draftKept, true, '被拦下的草稿要保留，用户改了再试');

  /* ================= 后台刷新不能覆盖草稿 ================= */

  await evaluate(`SF.app.refreshData(true)`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const afterRefresh = await evaluate(`(() => {
    const active = document.querySelector('[data-ai-slot="recognition"] .mode-card.is-active .mode-card__title');
    return active ? active.textContent : '';
  })()`);
  assert.equal(afterRefresh, 'LLM 自由生成标签', '后台刷新不能把用户正在改的方式冲掉');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '刷新状态').click()`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const afterStatusRefresh = await evaluate(`(() => {
    const active = document.querySelector('[data-ai-slot="recognition"] .mode-card.is-active .mode-card__title');
    return active ? active.textContent : '';
  })()`);
  assert.equal(afterStatusRefresh, 'LLM 自由生成标签', '刷新任务状态不能把草稿冲掉');

  /* ================= 离页保护 ================= */

  await evaluate(`location.hash = '#/inbox'`);
  await until(`!!document.querySelector('.dialog')`);
  const leaveText = await evaluate(`document.querySelector('.dialog').textContent`);
  assert.ok(leaveText.includes('识别设置'), '带着草稿离开要提示，实际：' + leaveText.slice(0, 120));
  await clickByText('继续编辑');
  await until(`!document.querySelector('.dialog')`);
  await until(`location.hash.startsWith('#/tags')`);
  // 应用把哈希拉回标签页是异步的：等它落定再改哈希，否则会被它覆盖。
  await new Promise((resolve) => setTimeout(resolve, 400));

  /* ================= 补齐 LLM 的密钥后再保存策略 ================= */

  // 回到设置页给 LLM 补一个假密钥（隔离环境，写的是临时凭据文件）。
  await evaluate(`location.hash = '#/settings?section=ai'`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await until(`!!document.querySelector('.setting-stack')`);
  await evaluate(`(() => {
    const block = Array.from(document.querySelectorAll('.setting-stack .setting-block')).find(b => b.querySelector('.setting-block__title').textContent.trim() === 'LLM');
    const key = block.querySelector('input[type="password"]');
    key.value = 'fake-key-for-isolated-verification';
    key.dispatchEvent(new Event('input', {bubbles: true}));
    window.__probe = JSON.stringify({
      dirty: SF.views.settings.dirtySections(),
      foot: document.querySelector('.settings__foot-hint')?.textContent,
      disabled: !!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '保存设置' && b.disabled),
    });
    SF.app.renderContent();
    window.__probe2 = JSON.stringify({
      foot: document.querySelector('.settings__foot-hint')?.textContent,
      disabled: !!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '保存设置' && b.disabled),
    });
  })()`);
  await clickByText('保存设置');
  await until(`document.querySelector('.settings__foot-hint')?.textContent !== '正在保存…'`);
  await until(`!document.querySelector('.settings__foot-hint.is-dirty')`);
  const withKey = await core.call('settings.get');
  assert.ok(withKey.ai.providers['provider-llm'].credentialRef, '保存后 Core 只保存凭据引用');
  assert.ok(!JSON.stringify(withKey).includes('fake-key-for-isolated-verification'), '密钥明文不得出现在设置快照里');
  assert.equal(withKey.tagging.mode, 'jev', '补密钥不能动识别方式');

  // 现在 LLM 配齐了，可以切过去并保存。
  await evaluate(`location.hash = '#/tags?tab=ai'`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await until(`!!document.querySelector('[data-ai-slot="recognition"] .mode-picker')`);
  await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('[data-ai-slot="recognition"] .mode-card')).find(c => c.textContent.includes('LLM'));
    card.click();
  })()`);
  await clickByText('保存识别设置');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await until(`document.querySelector('[data-ai-slot="recognition"]').textContent.includes('识别设置已保存')`);
  const afterStrategySave = await core.call('settings.get');
  assert.equal(afterStrategySave.tagging.mode, 'llm', '识别方式应当保存成功');
  assert.equal(afterStrategySave.ai.providers['provider-jev'].endpoint, 'https://api.example.invalid/v1',
    '保存策略不能动连接参数');
  assert.equal(afterStrategySave.ai.providers['provider-llm'].endpoint, 'https://llm.example.invalid/v1',
    '保存策略不能动连接参数');
  assert.ok(afterStrategySave.ai.providers['provider-llm'].credentialRef, '保存策略不能动凭据引用');
  await screenshot('v049-b02-recognition-saved.png');

  // 识别设置里的 API 摘要要跟着新方式走。
  const summary = await evaluate(`document.querySelector('[data-ai-slot="recognition"]').textContent`);
  assert.ok(summary.includes('https://llm.example.invalid/v1'), '摘要要显示当前方式的 API，实际：' + summary.slice(0, 200));

  /* ================= 版本语义：无关保存不动识别版本 ================= */

  // 两个版本各管一件事：settings.version 是保存计数（每次保存前进），
  // tagging.revision 是打标的有效配置版本，只在识别配置真的变了时前进。
  const before = await core.call('settings.get');
  const revisionBefore = before.tagging.revision;
  await evaluate(`location.hash = '#/settings?section=reminder'`);
  await until(`document.querySelector('.settings__title').textContent === '提醒设置'`);
  // 设置页可能还在读取中：等表单真的出现再动。
  await until(`!!document.querySelector('.setting-inline select')`);
  await evaluate(`(() => {
    const select = document.querySelector('.setting-inline select');
    select.value = '30';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await clickByText('保存设置');
  await until(`document.querySelector('.settings__foot-hint')?.textContent !== '正在保存…'`);
  const after = await core.call('settings.get');
  assert.equal(after.tagging.revision, revisionBefore, '改提醒参数不该让在途的识别任务失效');
  assert.ok(after.version > before.version, '保存计数应当前进');

  /* ================= 分区深链 ================= */

  await evaluate(`location.hash = '#/settings?section=priority'`);
  await until(`document.querySelector('.settings__title').textContent === '优先级名称'`);
  assert.equal(await evaluate(`SF.views.settings.currentSection()`), 'priority', '分区深链要落到对应分区');

  console.log('[v049-batch02] M21 Renderer 验收通过');
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-v049b2-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const seed = spawnSync(runtime.python, [path.join(root, 'scripts/seed-v049-batch02.py'), folder], {encoding: 'utf8'});
  if (seed.status !== 0) {
    console.error(seed.stderr || seed.stdout);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = 1;
    return;
  }
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'v049b2', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', code => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
