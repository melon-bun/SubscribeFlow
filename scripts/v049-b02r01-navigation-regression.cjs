// 0.4.9 batch-02-r01：BUG-105 导航冻结的最小回归。
//
// 复用的是同一套正式 Main + Renderer + 隔离旧配置种子（scripts/seed-v049-batch02.py），
// 与 Codex 的复现探针同一场景。区别在于这里验证的是「修复后的完整流程」：
//
//   1. 通用关闭（Escape／右上角关闭／点遮罩）必须结算确认框，
//      等同「继续编辑」：草稿保留、路由恢复、导航锁释放。
//   2. 导航锁释放的判据：下一次导航必须得到回应（确认框再次出现）。
//      BUG-105 时锁不释放，后续 hashchange 被直接忽略，界面毫无反应。
//   3. 关闭不等于自动放弃或自动保存：草稿还在，Core 里的配置没被改动。
//   4. 随后仍可正常导航：再走一次确认，选「放弃修改」后到达目标路由；
//      选「保存并离开」则先保存再到达目标。
//
// 全程不触网、不读真实 Key、不调用付费业务模型。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const OUTPUT = path.join(root, 'docs/verification/v0.4.9-minimax/batch-02-r01');

if (!process.versions.electron) {
  const {spawn, spawnSync} = require('node:child_process');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-v049b2-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const seed = spawnSync(runtime.python, [path.join(root, 'scripts/seed-v049-batch02.py'), folder], {encoding: 'utf8'});
  if (seed.status !== 0) throw new Error(seed.stderr || seed.stdout);
  const child = spawn(require('electron'), [__filename], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'v049b2', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  child.on('close', code => {
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
} else {
  const target = path.join(root, 'scripts/v049-batch02-renderer.cjs');
  const replacement = new (require('node:module').Module)(target, module);
  replacement.loaded = true;
  replacement.exports = {verify: async ({window, core}) => {
    const evaluate = code => window.webContents.executeJavaScript(code);
    const waitFor = async (code, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(code)) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Regression timed out: ' + code);
    };
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const clickDialogButton = label => evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === ${JSON.stringify(label)});
      if (!b) throw new Error('Missing dialog button: ' + ${JSON.stringify(label)});
      b.click();
    })()`);
    const closeDialogByIcon = () => evaluate(`(() => {
      const b = document.querySelector('.dialog__head .icon-btn');
      if (!b) throw new Error('Missing dialog close button');
      b.click();
    })()`);
    const closeDialogByMask = () => evaluate(`(() => {
      const mask = document.querySelector('.dialog-mask');
      if (!mask) throw new Error('Missing dialog mask');
      mask.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
    })()`);
    const state = () => evaluate(`({
      hash: location.hash,
      route: SF.app.state.route.name,
      visible: document.querySelector('[data-view]')?.dataset.view,
      dialogOpen: !!document.querySelector('[role="dialog"]'),
      draftRetained: SF.views.tags.hasRecognitionDraft(),
    })`);

    await waitFor('!!window.SF?.app.state.session');

    /** 造一个未保存的草稿，并确认 Core 里的配置还没被改动。 */
    async function makeDraft() {
      await evaluate("location.hash='#/tags?tab=ai'");
      await waitFor("!!document.querySelector('[aria-label=\"识别设置\"] [role=\"switch\"]')");
      // 草稿在多次访问之间是留着的：点一下开关后如果没变成"未保存"，
      // 说明刚好点回与已保存值相同的状态，再点一次即可。
      for (let i = 0; i < 2; i++) {
        await evaluate("document.querySelector('[aria-label=\"识别设置\"] [role=\"switch\"]').click()");
        await pause(120);
        if (await evaluate('SF.views.tags.hasRecognitionDraft()')) break;
      }
      await waitFor('SF.views.tags.hasRecognitionDraft()');
    }
    const savedBefore = (await core.call('settings.get')).tagging;

    /* ---------- 1. Escape：等同继续编辑，保留草稿、恢复路由、释放导航锁 ---------- */
    await makeDraft();
    await evaluate("location.hash='#/overview'");
    await waitFor("!!document.querySelector('[role=\"dialog\"]') && document.body.innerText.includes('识别设置还有未保存的修改')");
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await waitFor("!document.querySelector('[role=\"dialog\"]')");
    await pause(200);
    const afterEscape = await state();
    assert.equal(afterEscape.dialogOpen, false, 'Escape 后确认框必须关闭');
    assert.equal(afterEscape.route, 'tags', 'Escape 后要恢复原来的标签路由');
    assert.equal(afterEscape.draftRetained, true, 'Escape 不等于放弃：草稿必须保留');
    assert.deepEqual((await core.call('settings.get')).tagging, savedBefore, 'Escape 不等于自动保存：Core 配置不能被改动');

    // 导航锁是否释放：下一次导航必须得到回应。
    // BUG-105 时锁不释放，hashchange 被直接忽略，界面毫无反应。
    await evaluate("location.hash='#/channels'");
    await waitFor("!!document.querySelector('[role=\"dialog\"]')", 5000);
    const answered = await state();
    assert.equal(answered.dialogOpen, true, '关闭后必须还能再次导航并得到确认（导航锁已释放）');
    assert.equal(answered.route, 'tags', '未选择前不应跳走');

    // 选「放弃修改」→ 到达目标路由。
    await clickDialogButton('放弃修改');
    await waitFor("SF.app.state.route.name==='channels'");
    await pause(200);
    const afterDiscard = await state();
    assert.equal(afterDiscard.route, 'channels', '放弃修改后必须到达目标路由');
    assert.equal(afterDiscard.draftRetained, false, '放弃修改后草稿应当被丢弃');
    assert.deepEqual((await core.call('settings.get')).tagging, savedBefore, '放弃修改不改变 Core 配置');

    /* ---------- 2. 右上角关闭按钮：同一条结算路径 ---------- */
    await makeDraft();
    await evaluate("location.hash='#/overview'");
    await waitFor("!!document.querySelector('[role=\"dialog\"]')");
    await closeDialogByIcon();
    await waitFor("!document.querySelector('[role=\"dialog\"]')");
    await pause(200);
    const afterIcon = await state();
    assert.equal(afterIcon.route, 'tags', '关闭按钮后要恢复原来的标签路由');
    assert.equal(afterIcon.draftRetained, true, '关闭按钮不等于放弃：草稿必须保留');
    await evaluate("location.hash='#/channels'");
    await waitFor("!!document.querySelector('[role=\"dialog\"]')", 5000);
    await clickDialogButton('继续编辑');
    await waitFor("!document.querySelector('[role=\"dialog\"]')");
    await pause(200);
    assert.equal((await state()).route, 'tags', '继续编辑后留在标签页');

    /* ---------- 3. 点遮罩关闭：同一条结算路径 ---------- */
    await makeDraft();
    await evaluate("location.hash='#/overview'");
    await waitFor("!!document.querySelector('[role=\"dialog\"]')");
    await closeDialogByMask();
    await waitFor("!document.querySelector('[role=\"dialog\"]')");
    await pause(200);
    const afterMask = await state();
    assert.equal(afterMask.route, 'tags', '遮罩关闭后要恢复原来的标签路由');
    assert.equal(afterMask.draftRetained, true, '遮罩关闭不等于放弃：草稿必须保留');
    await evaluate("location.hash='#/channels'");
    await waitFor("!!document.querySelector('[role=\"dialog\"]')", 5000);
    await clickDialogButton('继续编辑');
    await waitFor("!document.querySelector('[role=\"dialog\"]')");

    /* ---------- 4. 保存并离开：先保存再到达目标 ---------- */
    await makeDraft();
    await evaluate("location.hash='#/overview'");
    await waitFor("!!document.querySelector('[role=\"dialog\"]')");
    await clickDialogButton('保存并离开');
    await waitFor("SF.app.state.route.name==='overview'", 10000);
    await pause(200);
    const afterSave = await state();
    assert.equal(afterSave.route, 'overview', '保存并离开后必须到达目标路由');
    assert.equal(afterSave.draftRetained, false, '保存成功后草稿应当被清空');
    const savedAfter = (await core.call('settings.get')).tagging;
    assert.notDeepEqual(savedAfter, savedBefore, '保存并离开必须真的把策略写进 Core');
    // 不还原：种子本身就是「已启用但 API 不完整」的旧状态，
    // 那条状态过不了 Core 的校验（本来就该被拦住），脚本到此结束。

    /* ---------- 5. 对照：设置页的同类确认框走的是同一条结算路径 ---------- */
    // 设置页的确认框本来就带 onClose 结算（见 views/settings.js），
    // 它的行为就是本批修复要对齐的既有先例：关闭后路由恢复、导航锁释放，
    // 下一次离开仍会再问一次——草稿在设置页是真的会丢，所以必须每次都问。
    await evaluate("location.hash='#/settings?section=reminder'");
    await waitFor("!!document.querySelector('.setting-inline select')");
    await evaluate(`(() => {
      const select = document.querySelector('.setting-inline select');
      select.value = '30';
      select.dispatchEvent(new Event('change', {bubbles: true}));
    })()`);
    await waitFor('SF.views.settings.dirtySections().length > 0');
    await evaluate("location.hash='#/inbox'");
    await waitFor("!!document.querySelector('[role=\"dialog\"]') && document.body.innerText.includes('还有未保存的修改')");
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await waitFor("!document.querySelector('[role=\"dialog\"]')");
    await pause(200);
    const settingsAfterEscape = await state();
    assert.equal(settingsAfterEscape.route, 'settings', '设置页 Escape 后同样恢复原路由');
    await evaluate("location.hash='#/channels'");
    await waitFor("!!document.querySelector('[role=\"dialog\"]')", 5000);
    assert.equal((await state()).dialogOpen, true, '设置页关闭后导航锁同样释放：下次导航会再次询问');
    await clickDialogButton('继续编辑');
    await waitFor("!document.querySelector('[role=\"dialog\"]')");

    fs.mkdirSync(OUTPUT, {recursive: true});
    const summary = {
      escape: afterEscape,
      escapeThenNavigate: answered,
      escapeThenDiscard: afterDiscard,
      closeButton: afterIcon,
      maskClose: afterMask,
      saveAndLeave: afterSave,
      settingsPageAfterEscape: settingsAfterEscape,
    };
    fs.writeFileSync(path.join(OUTPUT, 'navigation-escape-regression.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log('[b02r01-navigation-regression]', JSON.stringify(summary));
  }};
  require.cache[target] = replacement;
  require(path.join(root, 'electron/main/index.cjs'));
}
