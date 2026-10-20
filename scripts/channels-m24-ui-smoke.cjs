// 0.4.9 M24 实机验收：渠道与连接折叠列表。
//
// 跑的是正式 Renderer，配离线假桥接（scripts/channels-m24-ui-stub.cjs）：
// 六个渠道覆盖 readiness 的全部语义分支，不启动 Core、不发任何真实请求。
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-channels-m24-'));
const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root, 'docs/verification/v0.4.9-minimax/batch-04');
app.setPath('userData', path.join(temporary, 'profile'));

async function run() {
  fs.mkdirSync(output, {recursive: true});
  const win = new BrowserWindow({
    show: false, width: 1200, height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'channels-m24-ui-stub.cjs'),
      contextIsolation: true, sandbox: false, nodeIntegration: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  const evaluate = async code => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\n' + code); }
  };
  const until = async (expression, timeout = 10000) => {
    const start = Date.now();
    while (!(await evaluate(expression))) {
      if (Date.now() - start > timeout) throw new Error('等待超时：' + expression + '\n' + await evaluate('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const screenshot = async name => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const rows = () => evaluate(`Array.from(document.querySelectorAll('.connection-row')).map(r => ({
    id: r.dataset.connectionId,
    name: r.querySelector('.connection-row__name').textContent,
    status: r.querySelector('.badge').textContent,
    expanded: r.getAttribute('class').includes('is-open'),
    ariaExpanded: r.querySelector('.connection-row__head').getAttribute('aria-expanded'),
    controls: r.querySelector('.connection-row__head').getAttribute('aria-controls'),
    detailId: r.querySelector('.connection-row__detail').id,
    visible: !!r.querySelector('.connection-row__detail').offsetParent,
    hasCheck: Array.from(r.querySelectorAll('.connection-row__detail button')).some(b => b.textContent.trim() === '检查连接'),
    hasLogin: Array.from(r.querySelectorAll('.connection-row__detail button')).some(b => b.textContent.includes('应用内登录')),
  }))`);

  await win.loadFile(path.join(root, 'electron/renderer/index.html'), {hash: '/channels'});
  await until(`document.querySelectorAll('.connection-row').length === 6`);

  /* ---------- 1. 默认全部收起，收起行只有名称、状态与展开指示 ---------- */
  let list = await rows();
  assert.equal(list.length, 6, '六个渠道都要有行');
  for (const row of list) {
    assert.equal(row.expanded, false, row.name + ' 默认应当收起');
    assert.equal(row.ariaExpanded, 'false', row.name + ' 的 aria-expanded 应当是 false');
    assert.equal(row.visible, false, row.name + ' 的详情默认不可见');
    assert.equal(row.controls, row.detailId, row.name + ' 的行头要关联详情区域');
  }
  assert.deepEqual(list.map(r => r.status), ['可用', '需登录', '需处理访问验证', '待检查', '仅自主添加', '连接异常'],
    '状态文字要按 readiness 的真实语义映射，实际：' + JSON.stringify(list.map(r => r.status)));
  await screenshot('m24-collapsed');

  /* ---------- 2. 行头展开与收起，允许多个同时展开 ---------- */
  await evaluate(`document.querySelector('.connection-row[data-connection-id="zhihu:default"] .connection-row__head').click()`);
  await until(`document.querySelector('.connection-row[data-connection-id="zhihu:default"]').classList.contains('is-open')`);
  list = await rows();
  assert.equal(list.find(r => r.id === 'zhihu:default').ariaExpanded, 'true', '展开后 aria-expanded 要是 true');
  assert.equal(list.find(r => r.id === 'zhihu:default').visible, true, '展开后详情要可见');
  assert.equal(list.find(r => r.id === 'zhihu:default').hasCheck, true, '展开后要保留「检查连接」');

  await evaluate(`document.querySelector('.connection-row[data-connection-id="bilibili:default"] .connection-row__head').click()`);
  await until(`document.querySelector('.connection-row[data-connection-id="bilibili:default"]').classList.contains('is-open')`);
  list = await rows();
  const open = list.filter(r => r.expanded).map(r => r.id).sort();
  assert.deepEqual(open, ['bilibili:default', 'zhihu:default'], '允许多个连接同时展开');

  /* ---------- 3. 展开后能看到原有说明、认证、检查时间与登录入口 ---------- */
  const detail = await evaluate(`(() => {
    const row = document.querySelector('.connection-row[data-connection-id="bilibili:default"]');
    return {
      text: row.querySelector('.connection-row__detail').textContent,
      hasLogin: Array.from(row.querySelectorAll('button')).some(b => b.textContent.includes('应用内登录')),
    };
  })()`);
  assert.ok(detail.text.includes('应用内独立会话'), '展开后要保留原来的说明，实际：' + detail.text.slice(0, 80));
  assert.ok(detail.text.includes('认证：'), '展开后要显示认证情况');
  assert.ok(detail.text.includes('检查时间：'), '展开后要显示检查时间');
  assert.ok(detail.text.includes('请在应用内登录B站'), '展开后要显示详细状态原因');
  assert.equal(detail.hasLogin, true, '展开后要保留「应用内登录」入口');
  await screenshot('m24-expanded');

  /* ---------- 4. 内部操作不意外收起行 ---------- */
  await evaluate(`(() => {
    const row = document.querySelector('.connection-row[data-connection-id="bilibili:default"]');
    row.querySelector('.connection-row__detail button').click();
  })()`);
  await new Promise(resolve => setTimeout(resolve, 300));
  list = await rows();
  assert.equal(list.find(r => r.id === 'bilibili:default').expanded, true, '点内部按钮不能顺手收起行');

  /* ---------- 5. 键盘展开与收起 ---------- */
  await evaluate(`(() => {
    const head = document.querySelector('.connection-row[data-connection-id="github:default"] .connection-row__head');
    head.focus();
  })()`);
  const focused = await evaluate(`document.activeElement.getAttribute('aria-controls')`);
  assert.equal(focused, 'connection-detail-github:default', '行头要能用键盘聚焦');
  await evaluate(`document.activeElement.click()`);
  await until(`document.querySelector('.connection-row[data-connection-id="github:default"]').classList.contains('is-open')`);
  list = await rows();
  assert.equal(list.find(r => r.id === 'github:default').ariaExpanded, 'true', '键盘也要能展开');
  await evaluate(`document.activeElement.click()`);
  await until(`!document.querySelector('.connection-row[data-connection-id="github:default"]').classList.contains('is-open')`);

  /* ---------- 6. 离页返回保留展开选择 ---------- */
  await evaluate(`location.hash = '#/inbox'`);
  await until(`!!document.querySelector('[data-view="inbox"]')`);
  await evaluate(`location.hash = '#/channels'`);
  await until(`document.querySelectorAll('.connection-row').length === 6`);
  list = await rows();
  const stillOpen = list.filter(r => r.expanded).map(r => r.id).sort();
  assert.deepEqual(stillOpen, ['bilibili:default', 'zhihu:default'], '离开再回来要保留展开选择');

  /* ---------- 7. 检查中 → 结果状态更新，但不收起 ---------- */
  await evaluate(`ChannelsM24Stub.configure({checkDelay: 900, checkResult: {
    state: 'ready', operation: 'list_items', reason: '检查通过：已登录',
    scope: 'connection', scope_key: 'github:default', checked_at: '2026-10-20T04:00:00+00:00',
    actions: [], dependency: 'available', authentication: 'available'}});`);
  await evaluate(`document.querySelector('.connection-row[data-connection-id="github:default"] .connection-row__head').click()`);
  await until(`document.querySelector('.connection-row[data-connection-id="github:default"]').classList.contains('is-open')`);
  await evaluate(`(() => {
    const row = document.querySelector('.connection-row[data-connection-id="github:default"]');
    Array.from(row.querySelectorAll('button')).find(b => b.textContent.trim() === '检查连接').click();
  })()`);
  await until(`(() => {
    const row = document.querySelector('.connection-row[data-connection-id="github:default"]');
    return row && row.querySelector('.badge').textContent === '检查中';
  })()`, 5000);
  list = await rows();
  assert.equal(list.find(r => r.id === 'github:default').status, '检查中', '检查过程中要显示检查中');
  assert.equal(list.find(r => r.id === 'github:default').expanded, true, '检查中不能收起行');
  await until(`(() => {
    const row = document.querySelector('.connection-row[data-connection-id="github:default"]');
    return row && row.querySelector('.badge').textContent === '可用';
  })()`, 8000);
  list = await rows();
  assert.equal(list.find(r => r.id === 'github:default').status, '可用', '检查结果要更新状态文字');
  assert.equal(list.find(r => r.id === 'github:default').expanded, true, '检查完成后不能收起行');
  await evaluate(`ChannelsM24Stub.configure({checkDelay: 0});`);

  /* ---------- 8. 收起时异常状态也看得见 ---------- */
  list = await rows();
  const weibo = list.find(r => r.id === 'weibo:default');
  assert.equal(weibo.status, '连接异常', '收起行也要显示异常状态');
  assert.equal(weibo.expanded, false, '异常不能自动展开');
  assert.equal(weibo.visible, false, '异常不自动展开时详情不可见');

  /* ---------- 9. 后台刷新不改变展开选择 ---------- */
  await evaluate(`SF.app.refreshData(true)`);
  await new Promise(resolve => setTimeout(resolve, 500));
  list = await rows();
  const afterRefresh = list.filter(r => r.expanded).map(r => r.id).sort();
  assert.deepEqual(afterRefresh, ['bilibili:default', 'github:default', 'zhihu:default'],
    '后台刷新不能改变展开选择，实际：' + JSON.stringify(afterRefresh));

  /* ---------- 10. 小窗口下详情与操作仍可访问 ---------- */
  win.setSize(760, 620);
  await new Promise(resolve => setTimeout(resolve, 400));
  await evaluate('SF.app.renderView("channels")');
  await new Promise(resolve => setTimeout(resolve, 200));
  const narrow = await evaluate(`(() => {
    const row = document.querySelector('.connection-row[data-connection-id="zhihu:default"]');
    const detail = row.querySelector('.connection-row__detail');
    return {
      visible: !!detail.offsetParent,
      checkReachable: Array.from(detail.querySelectorAll('button')).some(b => b.textContent.trim() === '检查连接' && b.offsetParent !== null),
    };
  })()`);
  assert.equal(narrow.visible, true, '小窗口下展开的详情仍要可见');
  assert.equal(narrow.checkReachable, true, '小窗口下详情里的操作仍要能点到');
  await screenshot('m24-narrow-window');

  assert.deepEqual(errors, [], 'Renderer 不应出现异常');
  fs.writeFileSync(path.join(output, 'channels-m24-result.json'), JSON.stringify({rows: await rows()}, null, 2));
  console.log('渠道折叠列表验收通过：' + output);
}

app.whenReady().then(run).then(() => app.quit()).catch((error) => {
  console.error(error);
  app.exit(1);
});
