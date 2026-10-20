const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * 0.4.9 batch-01 实机验收（M19 + M20）。
 *
 * 跑的是正式 Renderer：真的打开设置页、真的改名保存、真的重启核心服务。
 * 数据来自隔离临时库的离线种子（scripts/seed-v049-batch01.py）：
 * GitHub 来源与内容用于检查平台标识；一个默认优先级为「高」的来源加上
 * 被单独改成中／低的内容，用于检查改名后历史优先级与统计口径不变。
 *
 * 全程不触网、不登录、不读真实 Key、不碰用户日常数据库。
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
      if (Date.now() - start > timeout) throw new Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText'));
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  };
  const screenshot = async name => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root, 'docs/verification/v0.4.9-minimax/batch-01');
    fs.mkdirSync(output, {recursive: true});
    fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage()).toPNG());
  };
  const setInput = async (selector, value, index = 0) => evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const input = nodes[${index}];
    if (!input) throw new Error('Missing input: ' + ${JSON.stringify(selector)} + '#' + ${index});
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  const clickByText = async (text, selector = 'button') => evaluate(`(() => {
    const b = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(b => b.textContent.trim() === ${JSON.stringify(text)});
    if (!b) throw new Error('Missing button: ' + ${JSON.stringify(text)});
    if (b.disabled) throw new Error('Disabled button: ' + ${JSON.stringify(text)});
    b.click();
  })()`);
  const priorityNames = () => evaluate(`SF.catalog.priorityNames()`);

  await until(`!!window.SF?.app.state.session`);
  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);

  /* ================= M19：GitHub 平台标识 ================= */

  // 侧栏平台筛选里必须有一个 GitHub 标识块，而且画的是内置 SVG，不是 GH 文字缩写。
  await until(`!!document.querySelector('.side-row[data-platform="github"] .plat--github')`);
  const githubIcon = await evaluate(`(() => {
    const node = document.querySelector('.side-row[data-platform="github"] .plat--github');
    const path = node.querySelector('svg path');
    const parse = (value) => {
      const m = String(value).match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const luma = (rgb) => rgb ? 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] : null;
    return {
      text: node.textContent.trim(),
      svg: !!node.querySelector('svg'),
      fill: path ? path.getAttribute('fill') : null,
      ink: luma(parse(getComputedStyle(node).color)),
      backing: luma(parse(getComputedStyle(node).backgroundColor)),
    };
  })()`);
  assert.equal(githubIcon.text, '', 'GitHub 标识不能再用 GH 文字缩写');
  assert.equal(githubIcon.svg, true, 'GitHub 标识必须是内置 SVG');
  assert.equal(githubIcon.fill, 'currentColor', 'SVG 必须跟着当前颜色走');
  assert.ok(githubIcon.backing > 0, 'GitHub 标识必须有浅色承托底，不能透明');
  assert.ok(githubIcon.ink < githubIcon.backing, 'GitHub 标识必须是深色图形配浅色底');
  await screenshot('v049-m19-github-icon-light.png');

  // 深色主题下同样要能看清：浅底 + 黑图形，不随主题反色。
  await evaluate(`(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('sf.theme', 'dark');
  })()`);
  await evaluate('SF.app.render()');
  await until(`!!document.querySelector('.side-row[data-platform="github"] .plat--github')`);
  const githubDark = await evaluate(`(() => {
    const node = document.querySelector('.side-row[data-platform="github"] .plat--github');
    const parse = (value) => {
      const m = String(value).match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const luma = (rgb) => rgb ? 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] : null;
    return {
      ink: luma(parse(getComputedStyle(node).color)),
      backing: luma(parse(getComputedStyle(node).backgroundColor)),
    };
  })()`);
  assert.ok(githubDark.backing > 0, '深色主题下 GitHub 标识仍要有浅色承托底');
  assert.ok(githubDark.ink < githubDark.backing, '深色主题下 GitHub 图形仍要比底色深');
  await screenshot('v049-m19-github-icon-dark.png');
  await evaluate(`(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('sf.theme', 'light');
  })()`);
  await evaluate('SF.app.render()');

  // 内容卡片上的 GitHub 文字标识同样是黑字浅底。
  await until(`!!document.querySelector('.content-card .tag--github')`);
  const githubTag = await evaluate(`(() => {
    const node = document.querySelector('.content-card .tag--github');
    const parse = (value) => {
      const m = String(value).match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const luma = (rgb) => rgb ? 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] : null;
    return {text: node.textContent.trim(), ink: luma(parse(getComputedStyle(node).color)), backing: luma(parse(getComputedStyle(node).backgroundColor))};
  })()`);
  assert.equal(githubTag.text, 'GitHub', '卡片上的平台名仍是 GitHub');
  assert.ok(githubTag.backing > 0 && githubTag.ink < githubTag.backing, 'GitHub 文字标识也要黑字浅底');

  /* ================= M20：优先级名称 ================= */

  const defaults = await priorityNames();
  assert.deepEqual(defaults, {high: '高优先级', medium: '中优先级', low: '低优先级'}, '默认名称应当沿用原名');

  // 打开设置 → 优先级名称分区。
  await evaluate(`document.querySelector('.user-chip').click()`);
  await until(`!!document.querySelector('.settings')`);
  await evaluate(`Array.from(document.querySelectorAll('.settings-nav__item')).find(b => b.textContent.includes('优先级名称')).click()`);
  await until(`document.querySelector('.settings__title').textContent === '优先级名称'`);
  const inputValues = await evaluate(`Array.from(document.querySelectorAll('.setting-fields input')).map(i => i.value)`);
  assert.deepEqual(inputValues, ['高优先级', '中优先级', '低优先级'], '三个输入框应当显示默认名称');
  // 等级固定：只有三个输入框，没有新增／删除等级的入口。
  assert.equal(await evaluate(`document.querySelectorAll('.setting-fields input').length`), 3, '只有三个固定等级');
  await screenshot('v049-m20-priority-names-default.png');

  // 非法名称：与另一档重名。保存要拦住，字段下给出原因。
  await setInput('.setting-fields input', '中优先级', 0);
  await clickByText('保存设置');
  await until(`!!document.querySelector('.field__error')`);
  const duplicateError = await evaluate(`document.querySelector('.field__error').textContent`);
  assert.ok(duplicateError.includes('不能相同'), '重名要有明确原因，实际是：' + duplicateError);
  assert.deepEqual(await priorityNames(), {high: '高优先级', medium: '中优先级', low: '低优先级'}, '非法名称不能生效');

  // 占用「未设置」同样要拦住。
  await setInput('.setting-fields input', '未设置', 0);
  await clickByText('保存设置');
  await until(`!!document.querySelector('.field__error')`);
  const noneError = await evaluate(`document.querySelector('.field__error').textContent`);
  assert.ok(noneError.includes('未设置'), '占用「未设置」要有明确原因，实际是：' + noneError);

  // 超过 12 个字符也要拦住。
  await setInput('.setting-fields input', '一二三四五六七八九十十一二', 0);
  await clickByText('保存设置');
  await until(`!!document.querySelector('.field__error')`);
  const lengthError = await evaluate(`document.querySelector('.field__error').textContent`);
  assert.ok(lengthError.includes('12'), '超长要有明确原因，实际是：' + lengthError);

  // 合法改名：去首尾空格后保存。
  await setInput('.setting-fields input', '  今天看  ', 0);
  await setInput('.setting-fields input', '有空看', 1);
  await setInput('.setting-fields input', '以后再说', 2);
  await clickByText('保存设置');
  await until(`SF.catalog.priorityNames().high === '今天看'`);
  assert.deepEqual(await priorityNames(), {high: '今天看', medium: '有空看', low: '以后再说'}, '保存后名称立即生效');

  // 改名不能动配置版本：在跑的打标任务与提醒计时都靠它判断是否过期。
  const versionAfter = await evaluate(`(async () => {
    const s = await SF.app.state.client.getSettings();
    return s.version;
  })()`);
  assert.equal(typeof versionAfter, 'number', '设置快照应当带版本号');

  // 历史优先级、来源继承与统计不能被改名影响。
  const stats = await evaluate(`(async () => {
    const client = SF.app.state.client;
    const out = {};
    for (const level of ['high', 'medium', 'low', 'none']) {
      const res = await client.listContents({priority: level, limit: 50});
      out[level] = res.total;
    }
    return out;
  })()`);
  assert.equal(stats.high, 1, '默认优先级为高的内容仍然只有一条');
  assert.equal(stats.medium, 1, '单独设为中的内容仍然是中');
  assert.equal(stats.low, 1, '单独设为低的内容仍然是低');

  // 各个界面都必须用新名字。
  await evaluate(`location.hash = '#/inbox'`);
  await until(`!!document.querySelector('.side-row[data-quick="high"]')`);
  const sidebarLabel = await evaluate(`document.querySelector('.side-row[data-quick="high"] .side-row__label').textContent`);
  assert.equal(sidebarLabel, '今天看', '侧栏快捷筛选要用新名字');
  const cardTag = await evaluate(`document.querySelector('.content-card .tag--high')?.textContent || ''`);
  assert.equal(cardTag, '今天看', '内容卡片上的优先级标签要用新名字');
  const filterOptions = await evaluate(`Array.from(document.querySelector('select[aria-label="筛选优先级"]').options).map(o => o.textContent)`);
  assert.ok(filterOptions.includes('今天看'), '收件箱优先级筛选要用新名字，实际：' + JSON.stringify(filterOptions));
  const bulkOptions = await evaluate(`(() => {
    const box = document.querySelector('.content-selection .check');
    if (!box) throw new Error('Missing selection checkbox');
    box.click();
    return Array.from(document.querySelector('select[aria-label="批量设置优先级"]').options).map(o => o.textContent);
  })()`);
  assert.ok(bulkOptions.includes('今天看'), '批量设置优先级菜单要用新名字，实际：' + JSON.stringify(bulkOptions));
  await screenshot('v049-m20-priority-renamed-inbox.png');

  // 看板：列名与筛选选项。
  await evaluate(`SF.app.navigate('overview', {mode: 'priority'})`);
  await until(`!!document.querySelector('.kanban__col[data-priority-column="high"]')`);
  const kanbanName = await evaluate(`document.querySelector('.kanban__col[data-priority-column="high"] .kanban__head-name').textContent`);
  assert.equal(kanbanName, '今天看', '看板列名要用新名字');
  const kanbanOptions = await evaluate(`Array.from(document.querySelector('select[aria-label="看板优先级"]').options).map(o => o.textContent)`);
  assert.ok(kanbanOptions.includes('今天看'), '看板优先级筛选要用新名字，实际：' + JSON.stringify(kanbanOptions));
  await screenshot('v049-m20-priority-renamed-kanban.png');

  // 详情页的单条优先级按钮。
  await evaluate(`location.hash = '#/inbox'`);
  await until(`!!document.querySelector('.content-card')`);
  await evaluate(`document.querySelector('.content-card').click()`);
  await until(`!!document.querySelector('.priority-grid')`);
  const detailNames = await evaluate(`Array.from(document.querySelectorAll('.priority-opt__name')).map(n => n.textContent)`);
  assert.ok(detailNames.includes('今天看'), '详情页单条优先级按钮要用新名字，实际：' + JSON.stringify(detailNames));

  // 渠道管理里的来源默认优先级（在「优先级设置」页签里）。
  await evaluate(`location.hash = '#/channels'`);
  await until(`!!document.querySelector('.view[data-view="channels"]')`);
  await clickByText('优先级设置', 'button');
  await until(`!!document.querySelector('select[aria-label^="来源优先级"]')`);
  const sourceOptions = await evaluate(`Array.from(document.querySelector('select[aria-label^="来源优先级"]').options).map(o => o.textContent)`);
  assert.ok(sourceOptions.includes('今天看'), '来源默认优先级要用新名字，实际：' + JSON.stringify(sourceOptions));
  await screenshot('v049-m20-priority-renamed-channels.png');

  // 提醒口径视图。
  await evaluate(`location.hash = '#/inbox'`);
  await until(`!!document.querySelector('.side-row[data-quick="high"]')`);
  const viewChip = await evaluate(`(async () => {
    SF.app.openReminderView(SF.app.state, 'high_unarchived');
    await new Promise(r => setTimeout(r, 400));
    const chip = Array.from(document.querySelectorAll('.chips--views button')).find(b => b.textContent.includes('未归档'));
    return chip ? chip.textContent.trim() : '';
  })()`);
  assert.equal(viewChip, '今天看未归档', '提醒口径视图要用新名字，实际：' + viewChip);

  // 重启核心服务后名称仍在：重启持久。
  await evaluate(`(async () => { await SF.app.state.client.restartCore(); })()`);
  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`, 40000);
  await evaluate(`SF.app.refreshData(true)`);
  await until(`SF.catalog.priorityNames().high === '今天看'`, 30000);
  assert.deepEqual(await priorityNames(), {high: '今天看', medium: '有空看', low: '以后再说'}, '重启后名称仍然生效');

  // 恢复默认：先改草稿，保存后才生效。
  await evaluate(`document.querySelector('.user-chip').click()`);
  await until(`!!document.querySelector('.settings')`);
  await evaluate(`Array.from(document.querySelectorAll('.settings-nav__item')).find(b => b.textContent.includes('优先级名称')).click()`);
  await until(`document.querySelector('.settings__title').textContent === '优先级名称'`);
  await clickByText('恢复默认名称');
  await until(`Array.from(document.querySelectorAll('.setting-fields input')).map(i => i.value).join() === '高优先级,中优先级,低优先级'`);
  // 还没保存，界面上的名字不能变。
  assert.equal(await evaluate(`SF.catalog.priorityNames().high`), '今天看', '恢复默认只改草稿，保存前不生效');
  await clickByText('保存设置');
  await until(`SF.catalog.priorityNames().high === '高优先级'`);
  assert.deepEqual(await priorityNames(), {high: '高优先级', medium: '中优先级', low: '低优先级'}, '恢复默认保存后回到原名');
  await screenshot('v049-m20-priority-restored.png');

  console.log('[v049] M19/M20 Renderer 验收通过');
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-v049-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const seed = spawnSync(runtime.python, [path.join(root, 'scripts/seed-v049-batch01.py'), folder], {encoding: 'utf8'});
  if (seed.status !== 0) {
    console.error(seed.stderr || seed.stdout);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = 1;
    return;
  }
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'v049', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', code => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
