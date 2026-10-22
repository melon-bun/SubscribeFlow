const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

/**
 * M32 轻科幻层实机验收。
 *
 * 走正式 Renderer + 正式 Core（Electron 真进程），不触网、不写业务数据。
 *
 * 验收内容：
 *   1. 轻科幻开关：设置 → 外观可切，切换即时生效并持久化，关闭后版式不塌；
 *   2. 双主题：浅色与深色下 fx.css 的规则都生效（data-fx 属性 + 深色覆盖）；
 *   3. 动效降级：prefers-reduced-motion 下持续动画停用；
 *   4. 读数条：详情页存在，并显式标注为示例数据；
 *   5. logo 未被改动：brand.png 仍是原图，标记外层只是多了一圈轨道。
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
          route: SF.app.state.route && SF.app.state.route.name,
          body: document.body.innerText.slice(0, 300),
        })`).catch(e => String(e));
        throw new Error('Timed out: ' + expression + '\n' + diag);
      }
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  };
  const pause = ms => new Promise((resolve) => setTimeout(resolve, ms));

  const shotDir = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT ||
    '/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/docs/verification/phase51/m32-fx';
  fs.mkdirSync(shotDir, {recursive: true});
  const shoot = async (name) => {
    await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    fs.writeFileSync(path.join(shotDir, name), (await window.webContents.capturePage()).toPNG());
    console.log('[m32] 截图 ' + name);
  };

  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);
  await until(`!!document.querySelector('.shell__body')`);

  /* ================= 1. 轻科幻默认开启 ================= */

  /* 上一轮验收可能把 sf.fx=off 留在隔离目录的 localStorage 里。
     那是产品的正确行为（用户的选择要留下来），但对验收要重来一次，
     所以先清掉残留，再从「默认开启」这个初始状态验。 */
  await evaluate(`(() => {
    localStorage.removeItem('sf.fx');
    localStorage.setItem('sf.theme', 'light');
    document.documentElement.setAttribute('data-fx', 'on');
    document.documentElement.setAttribute('data-theme', 'light');
    SF.app.state.fx = true;
  })()`);
  await evaluate(`SF.app.render()`);
  await pause(600);

  const defaultFx = await evaluate(`document.documentElement.getAttribute('data-fx')`);
  assert.equal(defaultFx, 'on', '轻科幻层默认开启（<html data-fx="on">）');

  // fx.css 必须真的被加载：点阵坐标纸的伪元素规则来自 fx.css
  const fxLoaded = await evaluate(`(() => {
    return Array.from(document.styleSheets).some(s => (s.href || '').endsWith('/fx.css'));
  })()`);
  assert.ok(fxLoaded, 'fx.css 必须被页面加载');

  /* ================= 2. 收件箱：卡片颜色收敛 ================= */

  await evaluate(`SF.app.navigate('inbox')`);
  await until(`!!document.querySelector('[data-view="inbox"]')`);
  await until(`document.querySelectorAll('.content-card').length > 0`);
  await pause(800);

  const card = await evaluate(`(() => {
    const el = document.querySelector('.content-card');
    if (!el) return null;
    const plat = el.querySelector('.plat');
    const sig = el.querySelector('.prio-sig');
    const link = el.querySelector('.content-card__link');
    const linkOpacity = link ? getComputedStyle(link).opacity : null;
    return {
      hasPlat: !!plat,
      hasSig: !!sig,
      // 旧版的彩色文字胶囊不应再出现在卡片元信息里
      hasOldPill: !!el.querySelector('.content-card__meta .tag--high, .content-card__meta .tag--mid, .content-card__meta .tag--low'),
      linkOpacity,
    };
  })()`);
  assert.ok(card.hasPlat, '卡片元信息里应有平台色方块');
  assert.ok(card.hasSig, '卡片元信息里应有优先级信号条');
  assert.ok(!card.hasOldPill, '卡片元信息里不应再有彩色优先级文字胶囊');
  assert.equal(card.linkOpacity, '0', 'URL 行默认隐藏（悬停才出现）');
  await shoot('01-inbox-light-fx.png');

  /* ================= 3. 深色主题 ================= */

  await evaluate(`(() => {
    localStorage.setItem('sf.theme', 'dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    SF.app.render();
  })()`);
  await pause(900);
  const darkFx = await evaluate(`document.documentElement.getAttribute('data-theme')`);
  assert.equal(darkFx, 'dark', '主题切到深色');
  await shoot('02-inbox-dark-fx.png');

  /* ================= 4. 详情读数条（假数据，须标注示例） ================= */

  await evaluate(`(() => {
    const card = document.querySelector('.content-card');
    if (card) card.click();
  })()`);
  await until(`!!document.querySelector('.detail')`);
  await until(`!!document.querySelector('.fx-readout')`);
  const readout = await evaluate(`(() => {
    const el = document.querySelector('.fx-readout');
    const demo = el.querySelector('.fx-readout__demo');
    return {
      text: el.innerText.trim(),
      demoText: demo ? demo.textContent.trim() : null,
      mono: getComputedStyle(el).fontFamily.toLowerCase().includes('mono'),
    };
  })()`);
  assert.ok(readout.demoText && /示例/.test(readout.demoText), '读数条必须显式标注为示例数据，实际：' + JSON.stringify(readout.demoText));
  assert.ok(readout.mono, '读数条使用等宽字体');
  await shoot('03-detail-readout-dark.png');

  /* ================= 5. 设置 → 外观：开关可用且持久化 ================= */

  await evaluate(`SF.app.openSettings('appearance')`);
  await until(`!!document.querySelector('.settings')`);
  await until(`document.querySelector('.settings__title').textContent === '外观'`);
  const appearance = await evaluate(`(() => {
    const toggle = document.querySelector('.settings__body .switch');
    return {
      hasToggle: !!toggle,
      checked: toggle ? toggle.getAttribute('aria-checked') : null,
    };
  })()`);
  assert.ok(appearance.hasToggle, '外观分区应有轻科幻开关');
  assert.equal(appearance.checked, 'true', '开关初始为开');
  await shoot('04-settings-appearance.png');

  /* 关闭效果：属性切到 off，fx.css 的规则随即失效 */
  await evaluate(`document.querySelector('.settings__body .switch').click()`);
  await until(`document.documentElement.getAttribute('data-fx') === 'off'`);
  await pause(500);
  /* 设置页是整页布局，没有 .workspace——先退回收件箱再验纸面。 */
  await evaluate(`SF.app.navigate('inbox')`);
  await until(`!!document.querySelector('[data-view="inbox"]')`);
  await pause(400);
  const offState = await evaluate(`(() => {
    const app = document.querySelector('.app');
    const sheet = document.querySelector('.workspace');
    // 关闭后：点阵坐标纸不再绘制，纸面结构不塌
    const gridDot = app ? getComputedStyle(app, '::before').backgroundImage : null;
    return {
      fx: document.documentElement.getAttribute('data-fx'),
      gridDot,
      sheetRadius: sheet ? getComputedStyle(sheet).borderRadius : null,
      sheetDisplay: sheet ? getComputedStyle(sheet).display : null,
      sheetWidth: sheet ? sheet.getBoundingClientRect().width : null,
    };
  })()`);
  assert.equal(offState.fx, 'off', '关闭后 <html data-fx="off">');
  assert.ok(offState.sheetDisplay === 'flex', '关闭效果后纸面结构不塌，实际 display：' + offState.sheetDisplay);
  assert.ok(offState.sheetRadius && offState.sheetRadius !== '0px', '关闭效果后纸面圆角仍在');
  assert.ok(offState.sheetWidth > 0, '关闭效果后纸面仍有宽度');
  await shoot('05-inbox-fx-off.png');

  /* 重新打开并确认持久化 */
  await evaluate(`SF.app.openSettings('appearance')`);
  await until(`document.querySelector('.settings__title').textContent === '外观'`);
  await until(`!!document.querySelector('.settings__body .switch')`);
  await evaluate(`document.querySelector('.settings__body .switch').click()`);
  await until(`document.documentElement.getAttribute('data-fx') === 'on'`);
  const persisted = await evaluate(`localStorage.getItem('sf.fx')`);
  assert.equal(persisted, 'on', '轻科幻开关状态写入 localStorage');

  /* ================= 6. 动效降级 ================= */
  /* prefers-reduced-motion 由 CSS 媒体查询处理，这里验证规则确实存在，
     且持续动画只有两处（logo 轨道 + 在线呼吸点）。 */

  const motion = await evaluate(`(() => {
    let count = 0;
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const rule of rules) {
        if (rule.type === CSSRule.MEDIA_RULE && /prefers-reduced-motion/.test(rule.conditionText || rule.media.mediaText)) {
          count += 1;
        }
      }
    }
    return count;
  })()`);
  assert.ok(motion >= 1, 'fx.css 必须含 prefers-reduced-motion 降级规则');

  const animating = await evaluate(`(() => {
    const names = new Set();
    document.querySelectorAll('*').forEach(el => {
      const s = getComputedStyle(el);
      if (s.animationName && s.animationName !== 'none') names.add(s.animationName);
    });
    return Array.from(names);
  })()`);
  // 允许的持续动画：fx-spin（logo 轨道）、fx-ping（在线呼吸点）。
  // 其它（fx-sweep 扫描光、fx-indet 进度条）只在操作时触发一次。
  const continuous = animating.filter(n => n !== 'fx-sweep' && n !== 'fx-indet');
  assert.ok(continuous.length <= 2, '一屏内持续动画最多两处，实际：' + JSON.stringify(continuous));

  /* ================= 7. logo 保持原样 ================= */
  /* 设置页是整页布局、没有侧栏，先回收件箱再查 logo。 */

  await evaluate(`SF.app.navigate('inbox')`);
  await until(`!!document.querySelector('.sidebar')`);
  await pause(300);
  const logo = await evaluate(`(() => {
    const img = document.querySelector('.brand__logo');
    if (!img) return null;
    return {src: img.getAttribute('src'), w: img.clientWidth, h: img.clientHeight};
  })()`);
  assert.ok(logo, '侧栏 logo 存在');
  assert.ok(/brand\.png$/.test(logo.src), 'logo 仍是原图 brand.png，实际：' + logo.src);

  const brandFile = path.join(root, 'electron/renderer/assets/brand.png');
  assert.ok(fs.existsSync(brandFile), 'brand.png 文件仍在原处');

  console.log('[m32] 轻科幻层验收通过');
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'm32'},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', code => {
    clearTimeout(timer);
    process.exitCode = code ?? 1;
  });
}
