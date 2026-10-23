const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 多页实机截图：笔记 / 内容总览 / 渠道管理 / 标签。
 *
 * 走正式 Renderer + 正式 Core（Electron 真进程），只导航与截图，
 * 不写业务数据、不触网（rendererSmoke 下所有渠道都是离线态）。
 *
 * 数据目录由 SUBSCRIBE_FLOW_DATA_DIR 指定：可以指向真实库的副本，
 * 也可以指向隔离的临时库；截图内容取决于该目录里的数据。
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
    '/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/docs/verification/phase5-minimax/ui-shot';
  fs.mkdirSync(shotDir, {recursive: true});
  const shoot = async (name) => {
    // 等两帧再截：否则拍到的是上一帧。
    await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    fs.writeFileSync(path.join(shotDir, name), (await window.webContents.capturePage()).toPNG());
    console.log('[uishot] ' + name);
  };

  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);
  await until(`!!SF.app.state.client && typeof SF.app.state.client.listNotes === 'function'`);
  await until(`!!document.querySelector('.shell__body')`);

  /* 每一页：路由名对上 → 视图挂上 → 内容真的出来，才拍。 */
  const goto = async (route, params, ready) => {
    const args = params ? `, ${JSON.stringify(params)}` : '';
    await evaluate(`SF.app.navigate('${route}'${args})`);
    await until(`SF.app.state.route.name === '${route}'`);
    await until(`!!document.querySelector('[data-view="${route}"]')`);
    if (ready) await until(ready);
    // 让异步数据落完，再多等一拍，避免拍到骨架屏。
    await pause(1200);
  };

  /* 0. 收件箱：主页面，带详情面板与底部操作条。 */
  await goto('inbox', null, `document.querySelectorAll('.content-card').length > 0`);
  await evaluate(`(() => {
    const first = document.querySelector('.content-card');
    if (first) first.click();
  })()`);
  await until(`!!document.querySelector('.detail .action-bar')`);
  await pause(600);
  await shoot('00-inbox.png');

  /* 1. 笔记页：选中第一条，阅读区才有内容。 */
  await goto('notes', null, `document.querySelectorAll('.notes-toc__item').length > 0`);
  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.notes-toc__item'));
    if (items.length) items[0].click();
  })()`);
  await until(`!!document.querySelector('.notes-reader')`);
  await pause(600);
  await shoot('01-notes.png');

  /* 2. 内容总览：日历模式 + 优先级模式 + 两个筛选下拉展开。 */
  await goto('overview', null, `!!document.querySelector('.calendar-grid')`);
  await shoot('02-overview-calendar.png');
  /* 月份筛选是无框下拉（参考页 .select 形态）：展开菜单也要看一眼，
     选项文案与浮层位置是「照抄参考页」的一部分。 */
  await evaluate(`document.querySelector('[aria-label="日历月份"]').click()`);
  await until(`!!document.querySelector('.menu__item')`);
  await pause(300);
  await shoot('02b-overview-month-menu.png');
  await evaluate(`SF.ui.closeMenu()`);
  await pause(200);
  await goto('overview', {mode: 'priority'}, `!!document.querySelector('[data-view="overview"][data-mode="priority"]')`);
  await shoot('03-overview-priority.png');
  await evaluate(`document.querySelector('[aria-label="看板日期"]').click()`);
  await until(`!!document.querySelector('.menu__item')`);
  await pause(300);
  await shoot('03b-overview-date-menu.png');
  await evaluate(`SF.ui.closeMenu()`);
  await pause(200);

  /* 3. 渠道管理：渠道列表 + 优先级设置。 */
  await goto('channels', null, `!!document.querySelector('[data-view="channels"] .channels__table-wrap')`);
  await shoot('04-channels-list.png');
  await goto('channels', {tab: 'priorities'}, `!!document.querySelector('.source-priorities')`);
  await shoot('05-channels-priorities.png');

  /* 4. 标签：标签列表 + AI 自动识别。 */
  await goto('tags', null, `!!document.querySelector('[data-view="tags"] .tags-list')`);
  await shoot('06-tags-list.png');
  await goto('tags', {tab: 'ai'}, `!!document.querySelector('[data-view="tags"]')`);
  await pause(800);
  await shoot('07-tags-ai.png');

  console.log('[uishot] 截图完成：' + shotDir);
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'uishot'},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', code => {
    clearTimeout(timer);
    process.exitCode = code ?? 1;
  });
}
