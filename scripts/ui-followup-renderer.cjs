const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * UI 追加优化（ui-followup-01）的最小实机验收：
 * 1. AI 总结按钮有可辨识的颜色（内容详情与笔记页两处），并保持可操作状态；
 * 2. 笔记页在常用窗口与较低窗口下都能向下滚到底，底部保存／删除按钮能进入可见区；
 * 3. 弹窗开关、切标题与后台刷新不丢当前草稿。
 *
 * 隔离临时库、离线种子，不触网、不读真实 Key、不碰日常数据。
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
        const diag = await evaluate(`JSON.stringify({route: SF.app.state.route, main: (document.querySelector('.main')||{}).innerText?.slice(0, 300)})`).catch(e => String(e));
        throw new Error('Timed out: ' + expression + '\n' + diag);
      }
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  };
  const pause = ms => new Promise((resolve) => setTimeout(resolve, ms));
  const shotDir = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT ||
    '/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/docs/verification/phase5-minimax/batch-ui-followup-01';
  fs.mkdirSync(shotDir, {recursive: true});
  const shoot = async (name) => {
    await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    fs.writeFileSync(path.join(shotDir, name), (await window.webContents.capturePage()).toPNG());
  };

  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);
  await until(`!!SF.app.state.session && !!SF.app.state.client`);

  /* ---------------- 任务 2：笔记页能向下滚 ---------------- */
  await evaluate(`SF.app.navigate('notes')`);
  await until(`document.querySelectorAll('.notes-toc__item').length >= 2`);
  await evaluate(`document.querySelector('.notes-toc__item').click()`);
  await until(`!!document.querySelector('[data-note-editor]')`);

  const scrollCheck = async (label) => {
    const info = await evaluate(`(() => {
      const reader = document.querySelector('.notes-reader');
      const before = reader.scrollTop;
      reader.scrollTop = before + 400;
      const after = reader.scrollTop;
      const save = Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记');
      const rect = save ? save.getBoundingClientRect() : null;
      const view = reader.getBoundingClientRect();
      return {
        scrollHeight: reader.scrollHeight, clientHeight: reader.clientHeight,
        before: before, after: after, canScroll: after > before,
        saveVisible: !!rect && rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1,
      };
    })()`);
    assert.ok(info.scrollHeight > info.clientHeight, label + '：阅读区内容应当超过可视高度');
    assert.equal(info.canScroll, true, label + '：scrollTop 必须能推进');
    assert.equal(info.saveVisible, true, label + '：底部保存按钮要能进入可见区');
    return info;
  };

  const tall = await scrollCheck('常用窗口');
  await shoot('notes-page-tall.png');

  // 降低窗口高度：内容更容易超出可视区。
  window.setSize(1100, 620);
  await pause(400);
  await until(`document.querySelector('.notes-reader')`);
  const low = await scrollCheck('较低窗口');
  await shoot('notes-page-low.png');
  window.setSize(1440, 1000);
  await pause(300);

  /* 滚到底：保存与删除都要能点到。 */
  await evaluate(`(() => { const r = document.querySelector('.notes-reader'); r.scrollTop = r.scrollHeight; })()`);
  await pause(200);
  const bottomReachable = await evaluate(`(() => {
    const save = Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记');
    const del = Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '删除这条笔记');
    const reader = document.querySelector('.notes-reader').getBoundingClientRect();
    const inside = (el) => { const r = el.getBoundingClientRect(); return r.top >= reader.top - 1 && r.bottom <= reader.bottom + 1; };
    return {save: !!save && inside(save), del: !!del && inside(del)};
  })()`);
  assert.equal(bottomReachable.save, true, '滚到底后保存按钮必须在可视区');
  assert.equal(bottomReachable.del, true, '滚到底后删除按钮必须在可视区');

  /* ---------------- 任务 1：AI 总结按钮有颜色（笔记页） ---------------- */
  const aiInNotes = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === 'AI 总结');
    if (!button) return null;
    const style = getComputedStyle(button);
    return {background: style.backgroundColor, color: style.color, border: style.borderColor, disabled: button.disabled};
  })()`);
  assert.ok(aiInNotes, '笔记页要有「AI 总结」按钮');
  assert.notEqual(aiInNotes.background, 'rgba(0, 0, 0, 0)', 'AI 总结按钮不能是透明底');
  assert.notEqual(aiInNotes.color, aiInNotes.background, '文字与底色要分得开');
  assert.equal(aiInNotes.disabled, false, '按钮应当可点');
  await shoot('notes-page-ai-button.png');

  /* ---------------- 草稿保护：弹窗开关、切标题、后台刷新都不丢 ---------------- */
  await until(`!!document.querySelector('[data-note-editor] textarea')`);
  await evaluate(`(() => {
    const area = document.querySelector('[data-note-editor] textarea');
    area.value = '这条不能丢。';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  // 打开并关闭原内容 modal。
  await evaluate(`Array.from(document.querySelectorAll('.notes-card button')).find(b => b.textContent.trim() === '查看原内容').click()`);
  await until(`!!document.querySelector('.notes-modal')`);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.getAttribute('aria-label') === '关闭对话框').click()`);
  await until(`!document.querySelector('.notes-modal')`);
  const afterModal = await evaluate(`(document.querySelector('[data-note-editor] textarea')||{}).value`);
  assert.equal(afterModal, '这条不能丢。', '开关联结 modal 不能丢草稿');

  // 后台刷新：内容变化事件不该把正在输入的草稿冲掉。
  await evaluate(`SF.app.refreshData ? SF.app.refreshData(true) : null`);
  await pause(400);
  const afterRefresh = await evaluate(`(document.querySelector('[data-note-editor] textarea')||{}).value`);
  assert.equal(afterRefresh, '这条不能丢。', '后台刷新不能丢草稿');

  /* 切标题再回来：草稿仍在自己那条上，不串条。 */
  await evaluate(`document.querySelectorAll('.notes-toc__item')[1].click()`);
  await until(`!!document.querySelector('[data-note-editor]')`);
  const otherText = await evaluate(`(document.querySelector('[data-note-editor] textarea')||{}).value`);
  assert.notEqual(otherText, '这条不能丢。', '切到另一条不能把上一条的草稿带过来');
  await evaluate(`document.querySelectorAll('.notes-toc__item')[0].click()`);
  await until(`!!document.querySelector('[data-note-editor]')`);
  const backText = await evaluate(`(document.querySelector('[data-note-editor] textarea')||{}).value`);
  assert.equal(backText, '这条不能丢。', '切回来草稿还在');

  /* ---------------- 任务 1：内容详情里同一套按钮 ---------------- */
  // 笔记页上还有没保存的草稿：离开前会问一句，这里选「放弃内容」离开。
  await evaluate(`SF.app.navigate('inbox')`);
  for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!document.querySelector('.dialog')`)) break;
    await pause(25);
  }
  if (await evaluate(`!!document.querySelector('.dialog')`)) {
    await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '放弃内容').click()`);
  }
  await until(`SF.app.state.route.name === 'inbox'`);
  await until(`document.querySelector('.content-card')`);
  await evaluate(`document.querySelector('.content-card').click()`);
  await until(`!!document.querySelector('[data-note-editor]')`);
  await evaluate(`(() => {
    const select = document.querySelector('[data-note-editor] select[aria-label="笔记类型"]');
    select.value = 'general';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await until(`Array.from(document.querySelectorAll('[data-note-editor] button')).some(b => b.textContent.trim() === 'AI 总结')`);
  const aiInInbox = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === 'AI 总结');
    const style = getComputedStyle(button);
    const primary = Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记');
    return {
      background: style.backgroundColor, color: style.color,
      primaryBackground: primary ? getComputedStyle(primary).backgroundColor : null,
      disabled: button.disabled,
    };
  })()`);
  assert.notEqual(aiInInbox.background, 'rgba(0, 0, 0, 0)', '内容详情里的 AI 总结按钮也不能透明');
  assert.notEqual(aiInInbox.background, aiInInbox.primaryBackground, 'AI 总结要与「保存笔记」主按钮分得开');
  assert.equal(aiInInbox.disabled, false, '按钮应当可点');
  await shoot('inbox-ai-button.png');

  console.log('[uifu] AI 按钮着色与笔记页滚动验收通过',
    JSON.stringify({tall, low, aiInNotes, aiInInbox}));
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-uifu-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const seed = spawnSync(runtime.python, [path.join(root, 'scripts/seed-ui-followup.py'), folder], {encoding: 'utf8'});
  if (seed.status !== 0) {
    console.error(seed.stderr || seed.stdout);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = 1;
    return;
  }
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'uifu', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', code => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
