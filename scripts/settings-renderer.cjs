const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * M15 设置界面实机验收。
 *
 * 覆盖验收矩阵里的 S01（入口与两项导航）、S02（保存／取消／错误）、S03（凭据）：
 * 真的点开设置、真的改表单、真的保存、真的重启核心服务，再确认
 * 密钥在磁盘上是密文、界面读不到明文、重启后配置仍在。
 */
async function verify({window, core, root}) {
  const evaluate = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\nRenderer assertion: ' + code); }
  };
  const until = async (expression, timeout = 15000) => {
    const start = Date.now();
    while (!(await evaluate(expression))) {
      if (Date.now() - start > timeout) throw new Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 70));
    }
  };
  const click = async label => evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!b) throw new Error('Missing button: ' + ${JSON.stringify(label)});
    if (b.disabled) throw new Error('Disabled button: ' + ${JSON.stringify(label)});
    b.click();
  })()`);
  const screenshot = async name => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root, 'docs/verification');
    fs.mkdirSync(output, {recursive: true});
    fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage()).toPNG());
  };
  const dataDir = process.env.SUBSCRIBE_FLOW_DATA_DIR;

  /* ---------- S01 用户图标进入设置 ---------- */
  await until(`!!window.SF?.app.state.session`);
  assert.equal(await evaluate(`document.querySelector('.user-chip').tagName`), 'BUTTON');
  await evaluate(`document.querySelector('.user-chip').click()`);
  await until(`!!document.querySelector('.settings')`);
  await until(`!!document.querySelector('.setting-block input')`);
  assert.equal(await evaluate(`!!document.querySelector('.sidebar')`), false, '设置是整页大面板，不套侧栏');
  const navLabels = await evaluate(`Array.from(document.querySelectorAll('.settings-nav__label')).map(n => n.textContent)`);
  assert.deepEqual(navLabels, ['AI 模型配置', '提醒设置']);
  assert.equal(await evaluate(`!!document.querySelector('.settings__foot')`), true, '底部操作区必须存在');
  assert.ok(await evaluate(`document.querySelector('[aria-label="关闭设置"]')`), '必须有可聚焦的关闭入口');
  await screenshot('m15-settings-tagging.png');

  /* ---------- S02 编辑草稿：先不保存，重启也不该生效 ---------- */
  await evaluate(`(() => {
    const input = Array.from(document.querySelectorAll('.setting-block input'))[0];
    input.value = 'https://example.com/draft-only';
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  assert.equal(await evaluate(`document.querySelector('.settings__foot-hint').textContent`), '有未保存的修改');
  assert.equal(await evaluate(`document.querySelector('.settings-nav__dot') !== null`), true, '左栏要标出未保存');
  const disabledBeforeSave = await evaluate(`document.body.innerText.includes('测试连接') && !!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '测试连接' && b.disabled)`);
  assert.equal(disabledBeforeSave, true, 'M15 没有真实 Provider，连接测试必须明确不可用');

  /* ---------- 切到提醒分区：草稿留在原页，不丢也不弹窗 ---------- */
  await evaluate(`Array.from(document.querySelectorAll('.settings-nav__item')).find(b => b.textContent.includes('提醒设置')).click()`);
  await until(`document.querySelector('.settings__title').textContent === '提醒设置'`);
  assert.equal(await evaluate(`!!document.querySelector('.dialog')`), false, '页内切换分区不该拦用户');
  assert.equal(await evaluate(`document.querySelector('.settings-nav__dot') !== null`), true, '未保存提示应跟着草稿留在左栏');
  const keptDraft = await evaluate(`(() => {
    Array.from(document.querySelectorAll('.settings-nav__item')).find(b => b.textContent.includes('AI 模型配置')).click();
    return Array.from(document.querySelectorAll('.setting-block input'))[0].value;
  })()`);
  assert.equal(keptDraft, 'https://example.com/draft-only', '切回原分区草稿还在');
  await evaluate(`Array.from(document.querySelectorAll('.settings-nav__item')).find(b => b.textContent.includes('提醒设置')).click()`);
  await until(`document.querySelector('.settings__title').textContent === '提醒设置'`);

  /* ---------- 离开设置页时提示保存或放弃 ---------- */
  await evaluate(`location.hash = '#/inbox'`);
  await until(`!!document.querySelector('.dialog')`);
  const leaveText = await evaluate(`document.querySelector('.settings-leave__lead').textContent`);
  assert.ok(leaveText.includes('AI 模型配置'), '弹窗要点名还有未保存的分区');
  // 草稿在另一页、当前页干净：说清保存写不进任何东西，且保存按钮不可点
  assert.ok((await evaluate(`document.querySelector('.settings-leave__note').textContent`)).includes('没有未保存的修改'));
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '保存并离开').disabled`), true);
  await click('继续编辑');
  await until(`!document.querySelector('.dialog')`);
  await until(`location.hash.startsWith('#/settings')`);
  assert.equal(await evaluate(`document.querySelector('.settings__title').textContent`), '提醒设置', '继续编辑要停在原分区');
  assert.equal(await evaluate(`document.querySelector('.setting-inline select') !== null`), true);

  /* ---------- 提醒设置：保存、取消、无效间隔 ---------- */
  await evaluate(`(() => {
    const t = Array.from(document.querySelectorAll('.switch')).find(s => s.getAttribute('aria-label') === '启用定时提醒');
    t.click();
  })()`);
  await evaluate(`(() => {
    const select = document.querySelector('.setting-inline select');
    select.value = '15';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await click('保存设置');
  await until(`document.querySelector('.settings__foot-hint')?.textContent !== '正在保存…'`);
  await until(`document.querySelector('.settings__foot-hint')?.textContent !== '有未保存的修改'`);
  let settings = await core.call('settings.get');
  assert.equal(settings.reminder.enabled, true);
  assert.equal(settings.reminder.intervalMinutes, 15);

  // 取消不应写入
  await evaluate(`(() => {
    const t = Array.from(document.querySelectorAll('.switch')).find(s => s.getAttribute('aria-label') === '启用定时提醒');
    t.click();
  })()`);
  await click('取消');
  assert.equal((await core.call('settings.get')).reminder.enabled, true, '取消不能写入');

  // 无效间隔：前端允许填，后端拒绝，错误要落到输入框下方且草稿保留
  await evaluate(`(() => {
    const select = document.querySelector('.setting-inline select');
    select.value = 'custom';
    select.dispatchEvent(new Event('change', {bubbles: true}));
    const input = document.querySelector('.setting-inline__custom input');
    input.value = '2';
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await click('保存设置');
  await until(`document.querySelector('.settings__foot-hint')?.textContent !== '正在保存…'`);
  await until(`!!document.querySelector('.field__error')`);
  assert.ok((await evaluate(`document.querySelector('.field__error').textContent`)).includes('5–1440'));
  assert.equal(await evaluate(`document.querySelector('.setting-inline__custom input').value`), '2', '保存失败必须保留输入');
  assert.equal((await core.call('settings.get')).reminder.intervalMinutes, 15, '保存失败不得改变已保存值');
  await evaluate(`(() => {
    const input = document.querySelector('.setting-inline__custom input');
    input.value = '45';
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await click('保存设置');
  await until(`document.querySelector('.settings__foot-hint')?.textContent !== '正在保存…'`);
  await until(`document.querySelector('.setting-inline__custom input').value === '45'`);
  await until(`!document.querySelector('.field__error')`);
  settings = await core.call('settings.get');
  assert.equal(settings.reminder.intervalMinutes, 45, '合法自定义间隔应保存成功');
  await screenshot('m15-settings-reminder.png');

  /* ---------- 两页都有草稿时，弹窗要说清只保存当前页 ---------- */
  await evaluate(`(() => {
    const select = document.querySelector('.setting-inline select');
    select.value = '90';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  assert.equal(await evaluate(`document.querySelector('.settings-nav__dot') !== null`), true);
  // 当前页（提醒）有草稿、AI 页也有草稿：弹窗要说明只会保存当前页
  await evaluate(`location.hash = '#/inbox'`);
  await until(`!!document.querySelector('.settings-leave__note')`);
  assert.ok((await evaluate(`document.querySelector('.settings-leave__note').textContent`)).includes('只会保存'));
  assert.ok((await evaluate(`document.querySelector('.settings-leave__note').textContent`)).includes('AI 模型配置'));
  await click('放弃修改');
  await until(`!!document.querySelector('.sidebar')`);
  assert.equal((await core.call('settings.get')).reminder.intervalMinutes, 45, '放弃修改不得写入未保存的值');

  // 另一页有草稿、当前页干净：保存按钮必须不可点，并说清保存写不进东西
  await evaluate(`location.hash = '#/settings?section=tagging'`);
  await until(`!!document.querySelector('.settings') && document.querySelector('.settings__title').textContent === 'AI 模型配置'`);
  await evaluate(`(() => {
    const input = Array.from(document.querySelectorAll('.setting-block input'))[0];
    input.value = 'https://example.com/second-draft';
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await evaluate(`Array.from(document.querySelectorAll('.settings-nav__item')).find(b => b.textContent.includes('提醒设置')).click()`);
  await until(`document.querySelector('.settings__title').textContent === '提醒设置'`);
  await evaluate(`location.hash = '#/inbox'`);
  await until(`!!document.querySelector('.dialog')`);
  assert.ok((await evaluate(`document.querySelector('.settings-leave__note').textContent`)).includes('没有未保存的修改'));
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '保存并离开').disabled`), true);
  await click('放弃修改');
  await until(`!!document.querySelector('.sidebar')`);
  await evaluate(`location.hash = '#/settings?section=tagging'`);
  await until(`!!document.querySelector('.setting-block input')`);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.setting-block input'))[0].value`), 'https://api.typesafe.ai/v1/systemone', '放弃后应回到已保存的值');

  /* ---------- S03 凭据 ---------- */
  await evaluate(`Array.from(document.querySelectorAll('.settings-nav__item')).find(b => b.textContent.includes('AI 模型配置')).click()`);
  await until(`document.querySelector('.settings__title').textContent === 'AI 模型配置'`);
  const secret = 'apikey_smoke_value_do_not_leak';
  await evaluate(`(() => {
    const fill = (index, value) => {
      const input = Array.from(document.querySelectorAll('.setting-block input'))[index];
      input.value = value;
      input.dispatchEvent(new Event('input', {bubbles: true}));
    };
    fill(0, 'https://api.typesafe.ai/v1/systemone');
    fill(1, 'jev-latest');
    const key = Array.from(document.querySelectorAll('input[type="password"]'))[0];
    key.value = ${JSON.stringify(secret)};
    key.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await click('保存设置');
  await until(`document.querySelector('.settings__foot-hint')?.textContent !== '正在保存…'`);
  await until(`document.body.innerText.includes('已保存（不回显）')`);
  settings = await core.call('settings.get');
  assert.equal(settings.tagging.providers.jev.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.ok(settings.tagging.providers.jev.credentialRef, 'Core 只保存引用');

  // 磁盘上是密文，不是明文
  const file = path.join(dataDir, 'credentials.json');
  assert.ok(fs.existsSync(file), '凭据文件应当存在');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(secret), '密钥不得以明文落盘');
  assert.ok(!raw.includes(Buffer.from(secret, 'utf8').toString('base64')), '密钥不得以可还原的编码落盘');
  assert.equal(Object.keys(JSON.parse(raw).entries).length, 1);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600, '凭据文件权限应收紧到仅当前用户');

  // 界面读不到明文，也读不到引用
  const exposed = await evaluate(`SF.app.state.client.getSettings().then(s => JSON.stringify(s))`);
  assert.ok(!exposed.includes(secret), '设置读取结果不得包含密钥');
  assert.ok(!/credentialRef/.test(exposed), '凭据引用不应进入界面');
  assert.ok(await evaluate(`document.body.innerText.includes('已保存（不回显）')`), '界面只显示已保存，不回显');
  // 已保存的那种方式不再留密钥输入框；没配的那种方式仍要能输入
  const jevBlock = await evaluate(`(() => {
    const block = Array.from(document.querySelectorAll('.setting-block')).find(b => b.textContent.includes('Jev 已有标签分类'));
    return {hasPassword: !!block.querySelector('input[type=\"password\"]'), filled: Array.from(document.querySelectorAll('input')).some(i => i.value === ${JSON.stringify(secret)})};
  })()`);
  assert.equal(jevBlock.hasPassword, false, '已保存的方式不该再有密钥输入框');
  assert.equal(jevBlock.filled, false, '页面上任何输入框都不得回填密钥明文');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('input[type=\"password\"]')).length`), 1, '未配置的方式仍要能输入密钥');
  await screenshot('m15-settings-credentials.png');

  /* ---------- 重启后配置与凭据仍在 ---------- */
  await evaluate(`Array.from(document.querySelectorAll('.settings-nav__item')).find(b => b.textContent.includes('提醒设置')).click()`);
  await core.restart();
  await until(`SF.app.state.coreStatus.state === 'ready'`);
  await evaluate(`location.hash = '#/settings?section=reminder'`);
  await until(`!!document.querySelector('.settings') && document.querySelector('.settings__title').textContent === '提醒设置'`);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(await evaluate(`document.querySelector('.setting-inline select').value === 'custom'`), '自定义间隔应重启后仍在');
  await evaluate(`location.hash = '#/settings?section=tagging'`);
  await until(`document.querySelector('.settings__title').textContent === 'AI 模型配置'`);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(await evaluate(`document.body.innerText.includes('已保存（不回显）')`), '重启后仍应显示密钥已保存');

  /* ---------- 深色主题 ---------- */
  await evaluate(`SF.app.state.theme = 'dark'; document.documentElement.setAttribute('data-theme','dark'); SF.app.renderContent()`);
  await screenshot('m15-settings-dark.png');
  await evaluate(`SF.app.state.theme = 'light'; document.documentElement.setAttribute('data-theme','light'); SF.app.renderContent()`);

  /* ---------- 离开设置 ---------- */
  await evaluate(`location.hash = '#/inbox'`);
  await until(`!!document.querySelector('.sidebar')`);
  console.log(JSON.stringify({
    settingsSmoke: 'passed',
    sections: navLabels,
    reminder: (await core.call('settings.get')).reminder,
    credentialEncrypted: true,
    keyHiddenInUi: true,
    survivesRestart: true,
    connectionTestDisabled: true,
  }));
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-settings-'));
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'settings', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', code => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
