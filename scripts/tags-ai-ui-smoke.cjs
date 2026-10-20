// Exercise the production renderer in Electron with an isolated offline bridge.
// Run: node_modules/.bin/electron scripts/tags-ai-ui-smoke.cjs
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-tags-ai-'));
const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(data, 'screenshots');
app.setPath('userData', path.join(data, 'user-data'));

async function run() {
  fs.mkdirSync(output, {recursive: true});
  const win = new BrowserWindow({
    show: false, width: 1440, height: 1000, minWidth: 800, minHeight: 600,
    webPreferences: {preload: path.join(__dirname, 'tags-ai-ui-stub.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false},
  });
  const errors = [];
  const layoutReport = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  const evaluate = async code => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\nRenderer assertion: ' + code); }
  };
  const until = async expression => {
    const start = Date.now();
    while (!(await evaluate(expression))) {
      if (Date.now() - start > 10000) throw new Error('等待超时：' + expression + '\n' + await evaluate('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 60));
    }
  };
  const settled = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const screenshot = async name => {
    await settled();
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  const click = async label => {
    assert.ok(await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('[data-view="tags"] button')).find(b => b.textContent.trim() === ${JSON.stringify(label)});
      if (!button || button.disabled) return false;
      button.scrollIntoView({block:'nearest'});
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.left < 0 || rect.right > innerWidth) return false;
      button.click(); return true;
    })()`), '按钮必须可见且可用：' + label);
  };
  const checkLayout = async () => {
    await settled();
    const result = await evaluate(`(() => {
      const panel = document.querySelector('.tags-ai');
      if (!panel) return {missing: true};
      const bounds = panel.getBoundingClientRect();
      const children = Array.from(panel.querySelectorAll('*')).filter(el => el.getBoundingClientRect().width);
      const blocks = Array.from(panel.children).map(el => el.getBoundingClientRect());
      return {
        theme: document.documentElement.dataset.theme, viewport: innerWidth,
        panelWidth: panel.clientWidth, contentWidth: panel.scrollWidth,
        horizontalOverflow: panel.scrollWidth > panel.clientWidth + 1,
        outside: children.filter(el => {
          const r = el.getBoundingClientRect();
          return r.left < bounds.left - 1 || r.right > bounds.right + 1;
        }).map(el => el.className),
        scrollable: getComputedStyle(panel).overflowY === 'auto',
        overlappingBlocks: blocks.some((rect, i) => i && rect.top < blocks[i - 1].bottom - 1),
        overflowingTaskText: Array.from(panel.querySelectorAll('.ai-task__name, .ai-task__note'))
          .some(el => el.scrollWidth > el.clientWidth + 1),
      };
    })()`);
    assert.equal(result.missing, undefined, 'AI 页面必须使用独立的纵向面板');
    assert.equal(result.horizontalOverflow, false, 'AI 面板不得横向溢出');
    assert.deepEqual(result.outside, [], '长内容和按钮必须留在面板内');
    assert.equal(result.scrollable, true, '超过窗口高度的内容必须可滚动');
    assert.equal(result.overlappingBlocks, false, '状态、按钮、补打和任务区域不得重叠');
    assert.equal(result.overflowingTaskText, false, '任务 ID、模型名与错误必须换行显示');
    layoutReport.push(result);
  };

  await win.loadFile(path.join(root, 'electron/renderer/index.html'), {hash: '/tags?tab=ai'});
  await until(`!!document.querySelector('[data-view="tags"]') && document.body.innerText.includes('还没有自动打标任务')`);
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    for (const width of [1440, 900, 800]) {
      win.setSize(width, 900);
      await checkLayout();
      await screenshot('tags-ai-empty-' + theme + '-' + width);
    }
  }
  await click('查看可补打范围');
  await until(`document.body.innerText.includes('7 条可补打')`);
  await checkLayout();
  await screenshot('tags-ai-backfill-preview');
  await click('取消');
  await until(`document.body.innerText.includes('查看可补打范围')`);
  await click('查看可补打范围');
  await until(`document.body.innerText.includes('立即补打 7 条')`);
  await click('立即补打 7 条');
  await until(`TaggingStub.calls().some(call => call.name === 'tagging.backfill' && call.args.limit === 7)`);

  const states = ['running', 'queued', 'retry_wait', 'blocked', 'succeeded', 'skipped', 'failed', 'cancelled'];
  const recent = states.map((state, index) => ({
    id: 'task-' + index, content_id: index ? 'bilibili:video:BV' + String(index).repeat(10) : 'bilibili:video:' + 'LongContentIdentifier'.repeat(10),
    state, provider: 'openai-compatible', model: 'organization/model-with-a-long-name-and-version'.repeat(index ? 1 : 4),
    error_message: ['blocked', 'failed'].includes(state) ? '连接失败：' + 'upstream_gateway_timeout_without_separators'.repeat(7) : null,
    applied_count: state === 'succeeded' ? 2 : 0,
  }));
  await evaluate(`TaggingStub.setStatus(${JSON.stringify({summary: {total: 28, active: 3, needsAttention: 2}, recent})}); SF.views.tags.invalidate(new Set(['tagging'])); SF.views.tags.updateTagging(SF.app.state); void 0`);
  await until(`document.querySelectorAll('.ai-task').length === 8`);
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    for (const width of [1440, 900, 800]) {
      win.setSize(width, 900);
      await evaluate(`document.querySelector('.tags-ai').scrollTop = 0`);
      await checkLayout();
      await screenshot('tags-ai-tasks-' + theme + '-' + width);
      assert.ok(await evaluate(`(() => {
        const panel = document.querySelector('.tags-ai');
        const last = panel.querySelector('.ai-task:last-child');
        last.scrollIntoView({block:'end'});
        return last.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1 && panel.scrollTop > 0;
      })()`), '应能滚动到最后一个任务和操作按钮');
      await screenshot('tags-ai-tasks-end-' + theme + '-' + width);
    }
  }
  assert.equal(await evaluate(`document.querySelectorAll('.ai-task button').length`), 7, '已完成任务不显示重试，其余任务保留重试入口');
  await click('重试');
  await until(`TaggingStub.calls().some(call => call.name === 'tagging.retry' && call.args.task_id === 'task-0')`);
  await evaluate(`window.openedSettings = null; SF.app.openSettings = section => { window.openedSettings = section; }; void 0`);
  // M21 起入口文案是「去设置 AI API 配置」（AI API 与识别策略分家了）。
  await click('去设置 AI API 配置');
  // M21 起 AI API 配置在独立的 'ai' 分区，识别策略搬到了标签页。
  assert.equal(await evaluate('window.openedSettings'), 'ai');
  await click('刷新状态');
  await until(`document.querySelectorAll('.ai-task').length === 8`);
  await evaluate(`TaggingStub.setError('读取失败：' + 'long_error_without_separators'.repeat(20)); SF.views.tags.invalidate(new Set(['tagging'])); SF.views.tags.updateTagging(SF.app.state); void 0`);
  await until(`document.body.innerText.includes('读取失败：')`);
  await checkLayout();
  await screenshot('tags-ai-load-error');
  assert.deepEqual(errors, [], 'Renderer 不应出现异常');
  fs.writeFileSync(path.join(output, 'layout-report.json'), JSON.stringify(layoutReport, null, 2));
  console.log('AI 标签页面验收通过；截图：' + output);
  win.destroy();
}

app.whenReady().then(run).then(() => app.exit(0)).catch(error => {console.error(error); app.exit(1);});
