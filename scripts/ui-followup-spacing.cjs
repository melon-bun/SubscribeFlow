/* 两处垂直间距的实机测量：优先级设置页的分区之间、渠道管理的工具栏与表格之间。
 *
 * 走正式 Renderer + 正式 Core（Electron 真进程），只导航、测量、截图，
 * 不保存设置、不改业务数据、不触网。
 *
 * 数据目录：把真实库的 sqlite3 复制到临时目录再用（只读来源），
 * 日常数据库、凭据与登录态都不碰。
 *
 * 用法：node scripts/ui-followup-spacing.cjs
 * 产物：$SUBSCRIBE_FLOW_VERIFY_OUTPUT 目录下的 spacing.json 与 PNG。
 */
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT
  || path.join(root, 'docs/verification/priority-minimax/ui-followup-01');

if (!process.versions.electron) {
  /* 父进程：备好隔离数据目录，再拉起 Electron。 */
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-spacing-'));
  const source = path.join(os.homedir(), 'Library/Application Support/Subscribe Flow/subscribe-flow.sqlite3');
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, path.join(folder, 'subscribe-flow.sqlite3'));
  }
  const child = spawn(require('electron'), [__filename], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'uishot',
      SUBSCRIBE_FLOW_DATA_DIR: folder, SUBSCRIBE_FLOW_VERIFY_OUTPUT: outDir},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
  child.on('close', (code) => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
  return;
}

/* ---- 以下在 Electron 主进程里执行 ---- */
process.env.SUBSCRIBE_FLOW_RENDERER_SMOKE = 'uishot';

const measure = require(path.join(root, 'scripts/ui-shot-renderer.cjs'));
measure.verify = async ({window}) => {
  const evaluate = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\nSOURCE: ' + code); }
  };
  const pause = ms => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (expression, timeout = 30000) => {
    const start = Date.now();
    while (true) {
      let value;
      try { value = await evaluate(expression); }
      catch (error) {
        if (Date.now() - start > timeout) throw error;
        await pause(120);
        continue;
      }
      if (value) return true;
      if (Date.now() - start > timeout) {
        throw new Error('Timed out: ' + expression);
      }
      await pause(70);
    }
  };

  fs.mkdirSync(outDir, {recursive: true});
  const shoot = async (name) => {
    await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    fs.writeFileSync(path.join(outDir, name), (await window.webContents.capturePage()).toPNG());
    console.log('[spacing] ' + name);
  };

  /* 设置页：量「智能判断 / 来源默认优先级 / 三个优先级的名称」三块之间的垂直间距。 */
  const measureSettings = async () => evaluate(`(() => {
    const body = document.querySelector('.settings__body');
    if (!body) return null;
    const blocks = Array.from(body.querySelectorAll('.setting-block'));
    const pairs = [];
    for (let i = 1; i < blocks.length; i++) {
      const prev = blocks[i - 1];
      const next = blocks[i];
      const a = prev.getBoundingClientRect();
      const b = next.getBoundingClientRect();
      const prevStyle = getComputedStyle(prev);
      const nextStyle = getComputedStyle(next);
      const parent = next.parentElement;
      const parentStyle = getComputedStyle(parent);
      pairs.push({
        from: (prev.querySelector('.setting-block__title') || {}).textContent || prev.className,
        to: (next.querySelector('.setting-block__title') || {}).textContent || next.className,
        prevBottom: Math.round(a.bottom),
        nextTop: Math.round(b.top),
        distance: Math.round(b.top - a.bottom),
        prevMarginBottom: prevStyle.marginBottom,
        nextMarginTop: nextStyle.marginTop,
        parentTag: parent.tagName + '.' + (parent.className || ''),
        parentDisplay: parentStyle.display,
        parentGap: parentStyle.gap,
      });
    }
    return {
      blockCount: blocks.length,
      titles: blocks.map(b => (b.querySelector('.setting-block__title') || {}).textContent || ''),
      pairs,
    };
  })()`);

  /* 渠道管理：量工具栏与下方表格之间的垂直间距。 */
  const measureChannels = async () => evaluate(`(() => {
    const toolbar = document.querySelector('.channels__toolbar');
    const table = document.querySelector('.channels__table-wrap');
    if (!toolbar || !table) return null;
    const t = toolbar.getBoundingClientRect();
    const b = table.getBoundingClientRect();
    const container = table.parentElement;
    const containerStyle = getComputedStyle(container);
    const tableStyle = getComputedStyle(table);
    const outer = container.parentElement;
    const outerStyle = getComputedStyle(outer);
    return {
      toolbarBottom: Math.round(t.bottom),
      tableTop: Math.round(b.top),
      distance: Math.round(b.top - t.bottom),
      tableMarginTop: tableStyle.marginTop,
      containerTag: container.tagName + '.' + (container.className || ''),
      containerDisplay: containerStyle.display,
      containerGap: containerStyle.gap,
      outerTag: outer.tagName + '.' + (outer.className || ''),
      outerDisplay: outerStyle.display,
      outerGap: outerStyle.gap,
      outerChildMarginTop: getComputedStyle(container).marginTop,
    };
  })()`);

  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);
  await until(`!!SF.app.state.client && typeof SF.app.state.client.listNotes === 'function'`);
  await until(`!!document.querySelector('.shell__body')`);

  const originalTheme = await evaluate(`document.documentElement.getAttribute('data-theme') || 'light'`);
  /* 换主题后要等重绘真正结束：capturePage 可能抓到只刷了一层的中间帧
     （按钮还是浅色、标题发灰）。强制 invalidate 再多等一拍。 */
  const setTheme = async (theme) => {
    await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
    window.webContents.invalidate();
    await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    await pause(1400);
    window.webContents.invalidate();
    await pause(400);
  };

  const report = {generatedAt: new Date().toISOString(), window: '1440x1000'};

  /* 1. 设置页 · 优先级设置：浅色 → 深色 → 紧凑窗口。 */
  await evaluate(`SF.app.navigate('settings',{section:'priority'})`);
  await until(`SF.app.state.route.name === 'settings'`);
  await until(`!!document.querySelector('.settings')`);
  await until(`document.querySelector('.settings__title')?.textContent === '优先级设置'`);
  await until(`document.querySelectorAll('.settings__body .setting-block').length >= 3`);
  await pause(1200);

  report.settings = await measureSettings();
  await shoot('01-settings-priority-light.png');

  await setTheme('dark');
  report.settingsDark = await measureSettings();
  await shoot('02-settings-priority-dark.png');
  await setTheme(originalTheme);

  window.setSize(900, 620);
  await pause(900);
  report.settingsCompact = await measureSettings();
  await shoot('03-settings-priority-compact.png');
  window.setSize(1440, 1000);
  await pause(600);

  /* 2. 渠道管理：浅色 → 深色 → 紧凑窗口。 */
  await evaluate(`SF.app.navigate('channels')`);
  await until(`SF.app.state.route.name === 'channels'`);
  await until(`!!document.querySelector('[data-view="channels"] .channels__table-wrap')`);
  await pause(1200);

  report.channels = await measureChannels();
  await shoot('04-channels-toolbar-light.png');

  await setTheme('dark');
  report.channelsDark = await measureChannels();
  await shoot('05-channels-toolbar-dark.png');
  await setTheme(originalTheme);

  window.setSize(900, 620);
  await pause(900);
  report.channelsCompact = await measureChannels();
  await shoot('06-channels-toolbar-compact.png');
  window.setSize(1440, 1000);
  await pause(600);

  fs.writeFileSync(path.join(outDir, 'spacing.json'), JSON.stringify(report, null, 2));
  console.log('[spacing] ' + JSON.stringify({
    settings: report.settings && report.settings.pairs,
    channels: report.channels,
  }, null, 2));
};

require(path.join(root, 'electron/main/index.cjs'));
