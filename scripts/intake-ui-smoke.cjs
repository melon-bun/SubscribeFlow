// M13 自主添加对话框的界面路径验收。
//
// 边界说明：这里用 scripts/intake-ui-stub.cjs 桩桥启动正式 Renderer，验证的是
// 对话框自身的界面行为——两步流转、预览呈现、优先级与标签、已收录分支、保存。
// 平台真实读取、稳定身份与事务内去重由 M11 的 Python 契约测试负责，
// 本脚本不冒充那部分结论。
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root, 'docs/verification');

const scenario = { mode: 'preview' };

async function run() {
  fs.mkdirSync(output, {recursive: true});
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: {
      preload: path.join(__dirname, 'intake-ui-stub.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    throw new Error('渲染进程退出：' + JSON.stringify(details));
  });

  await win.loadFile(path.join(root, 'electron/renderer/index.html'));

  const evaluate = async (code) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\n断言：' + code); }
  };
  const until = async (expression, timeout = 10000) => {
    const start = Date.now();
    while (!(await evaluate(expression))) {
      if (Date.now() - start > timeout) {
        throw new Error('等待超时：' + expression + '\n当前界面：\n' + await evaluate('document.body.innerText'));
      }
      await new Promise(r => setTimeout(r, 60));
    }
  };
  const click = async (label) => evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!b) throw new Error('找不到按钮：' + ${JSON.stringify(label)});
    if (b.disabled) throw new Error('按钮不可用：' + ${JSON.stringify(label)});
    b.click();
  })()`);
  const shot = async (name) => {
    await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await evaluate('Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');
    fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());
  };
  const setMode = async (mode) => evaluate(`IntakeStub.setMode(${JSON.stringify(mode)})`);

  // 收件箱渲染完成，且入口按能力可用。
  await until(`!!SF.app.state.session && !!document.querySelector('[data-view="inbox"]')`);
  assert.equal(await evaluate('SF.app.state.source'), 'real', '必须走真实桥接路径，而不是 demo 回退');
  await until(`!!document.querySelector('.view__actions [aria-label], .view__actions button')`);
  assert.equal(await evaluate(`!!window.SF.intakeDialog`), true, 'intake-dialog.js 必须已加载');

  const intakeBtn = `Array.from(document.querySelectorAll('.view__actions button')).find(b => b.textContent.trim() === '添加内容')`;
  assert.ok(await evaluate(`${intakeBtn} !== undefined`), '收件箱必须有「添加内容」入口');
  assert.equal(await evaluate(`${intakeBtn}.disabled`), false, '桩会话声明 canIntake，入口不应禁用');

  /* ---- 能力门禁：渠道未声明链接读取时，入口必须禁用并说明原因 ----
     这是当前 main 的真实状态（B站与小红书都还没实现 match_item_url /
     resolve_item / read_item）。界面不能因为「对话框已经写好了」就放行。 */
  await evaluate(`IntakeStub.setIntakeCapability(false)`);
  await evaluate(`SF.app.refreshData(true)`);
  await until(`${intakeBtn} && ${intakeBtn}.disabled === true`);
  assert.ok(
    (await evaluate(`${intakeBtn}.getAttribute('title') || ''`)).includes('尚未支持'),
    '入口禁用时必须说明原因，不能只是一个点不动的按钮'
  );
  // 即便绕过禁用直接调用，也不能打开一个注定失败的对话框。
  assert.equal(await evaluate(`SF.intakeDialog.open(SF.app.state)`), null, '无渠道支持时不得打开对话框');
  assert.equal(await evaluate(`!!document.querySelector('.dialog--intake')`), false, '无渠道支持时不得出现对话框');
  await evaluate(`IntakeStub.setIntakeCapability(true)`);
  await evaluate(`SF.app.refreshData(true)`);
  await until(`${intakeBtn}.disabled === false`);

  /* ---- 第一步：粘贴链接 ---- */
  await click('添加内容');
  await until(`!!document.querySelector('.dialog--intake')`);
  assert.equal(await evaluate(`document.querySelector('.dialog').getAttribute('aria-label')`), '添加内容');
  assert.equal(await evaluate(`document.querySelectorAll('.steps__item').length`), 2, '步骤条必须有两步');
  assert.equal(await evaluate(`document.querySelector('.steps__item.is-active').textContent.trim()`), '1粘贴链接');
  assert.equal(await evaluate(`!!document.querySelector('#intake-url')`), true, '第一步必须有链接输入框');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '识别内容').disabled`), true,
    '未输入链接时不应允许识别');
  await shot('m13-intake-step1-empty.png');

  // 输入后主按钮可用；分享文案不在本期范围，只接受链接本身。
  await evaluate(`(() => { const i = document.querySelector('#intake-url'); i.value = ${JSON.stringify(PREVIEW_URL)}; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '识别内容').disabled`), false);
  await shot('m13-intake-step1-filled.png');

  /* ---- 识别中：真实等待，不用假动画 ---- */
  await click('识别内容');
  await until(`!!document.querySelector('.intake-status')`);
  assert.equal(await evaluate(`!!document.querySelector('.intake-status .progress')`), true, '识别中必须显示进度');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '识别中…').disabled`), true,
    '识别中主按钮必须锁定，避免重复提交');
  assert.equal(await evaluate(`!!document.querySelector('#intake-url').disabled`), true, '识别中链接输入应锁定');
  await shot('m13-intake-recognizing.png');

  /* ---- 第二步：确认内容 ---- */
  await until(`!!document.querySelector('.intake-preview')`, 12000);
  assert.equal(await evaluate(`document.querySelector('.steps__item.is-active').textContent.trim()`), '2确认内容');
  assert.equal(await evaluate(`document.querySelector('.intake-preview__title').textContent`), '把普通的一天，拍成值得留下的片段');
  assert.equal(await evaluate(`document.querySelector('.intake-preview__author').textContent.includes('影像笔记')`), true);
  assert.equal(await evaluate(`document.querySelector('.intake-preview__author').textContent.includes('B站')`), true,
    '预览必须显示平台归属');
  assert.equal(await evaluate(`!!document.querySelector('.intake-preview__unsubscribed')`), true,
    '未订阅作者要显式标出，不能让用户以为已订阅');
  assert.equal(await evaluate(`document.querySelector('.intake-preview__published').textContent.includes('2025-09-16')`), true,
    '预览必须显示平台原始发布时间');
  assert.equal(await evaluate(`document.querySelector('.intake-preview__published').textContent.includes('仅日期')`), true,
    '日期精度必须如实标注，不能补出精确时刻');
  assert.equal(await evaluate(`document.querySelector('.intake-preview__calendar').textContent.includes('按保存成功的时间归档')`), true,
    '手动收录按添加时间进日历，必须在保存前说明');
  assert.equal(await evaluate(`!!document.querySelector('.intake__url.is-locked')`), true, '识别后链接应只读');
  assert.equal(await evaluate(`!!Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '更换链接')`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.intake-priority__opt').length`), 4, '优先级应为四档，含未设置');
  assert.equal(await evaluate(`document.querySelector('.intake-priority__opt.is-active').dataset.intakePriority`), 'none',
    '新内容默认不猜优先级');
  await shot('m13-intake-step2-preview.png');
  const settledPolls = (await evaluate('IntakeStub.metrics()')).polls;
  await new Promise(r => setTimeout(r, 1000));
  assert.equal((await evaluate('IntakeStub.metrics()')).polls, settledPolls, '预览后停止识别轮询');

  /* ---- 优先级：显式选择，未设置保持可回退 ---- */
  await evaluate(`document.querySelector('[data-intake-priority="high"]').click()`);
  await until(`document.querySelector('.intake-priority__opt.is-active').dataset.intakePriority === 'high'`);
  assert.equal(await evaluate(`document.querySelectorAll('.intake-priority__opt.is-active').length`), 1, '优先级只能单选');
  await shot('m13-intake-priority.png');

  /* ---- 标签：对话框内选中的标签只作用于本次保存 ----
     注意作用域：收件箱详情面板也有 [data-tag-add]，必须限定在对话框内，
     否则点到的是详情面板的标签编辑器，对话框其实没被验证。 */
  assert.equal(await evaluate(`!!document.querySelector('.dialog [data-tag-add]')`), true, '必须能从对话框里加标签');
  await evaluate(`document.querySelector('.dialog [data-tag-add]').click()`);
  await until(`!!document.querySelector('.tag-pool')`);
  await evaluate(`Array.from(document.querySelectorAll('.tag-pool__chip')).find(c => c.textContent.includes('摄影')).click()`);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '确认挂载').click()`);
  await until(`!document.querySelector('.tag-pool') && !!document.querySelector('.dialog .intake-tags .tag-chip')`);
  assert.equal(await evaluate(`document.querySelector('.dialog .intake-tags .tag-chip__text').textContent`), '摄影');
  // 详情面板的标签不能被这次选择影响：对话框的选择只进 saveIntake。
  await shot('m13-intake-tagged.png');

  /* ---- 保存：只提交预览标识与整理字段 ---- */
  await click('保存内容');
  await until(`!document.querySelector('.dialog')`, 12000);
  const saved = await evaluate(`IntakeStub.saved()`);
  assert.equal(saved.length, 1, '保存必须恰好调用一次 intake.save');
  assert.equal(saved[0].previewId, 'preview-1', '只能提交 Core 的预览标识');
  assert.deepEqual(saved[0].options.tagIds, ['tag-photo'], '标签只提交 ID');
  assert.equal(saved[0].options.priority, 'high', '优先级按当前选择提交');
  await until(`document.body.innerText.includes('已收录')`);

  /* ---- 已订阅的作者不该再挂「未订阅」徽标 ----
     徽标必须跟着真实订阅数据走，不能写死成「永远未订阅」。 */
  await evaluate(`IntakeStub.setSubscribed(true)`);
  await click('添加内容');
  await until(`!!document.querySelector('#intake-url')`);
  await evaluate(`(() => { const i = document.querySelector('#intake-url'); i.value = ${JSON.stringify(PREVIEW_URL)}; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await click('识别内容');
  await until(`!!document.querySelector('.intake-preview') && !!document.querySelector('.dialog [data-intake-priority]')`, 12000);
  await until(`!!document.querySelector('.dialog .intake-preview__author')`, 12000);
  assert.equal(await evaluate(`!!document.querySelector('.dialog .intake-preview__unsubscribed')`), false,
    '作者已订阅时不得显示「未订阅」');
  await shot('m13-intake-subscribed.png');
  await click('取消');
  await until(`!document.querySelector('.dialog')`);

  /* ---- 订阅目录读不到时：照常渲染，但不得谎称「未订阅」 ---- */
  await evaluate(`IntakeStub.setSubscribed(false); IntakeStub.failChannels(true)`);
  await click('添加内容');
  await until(`!!document.querySelector('#intake-url')`);
  await evaluate(`(() => { const i = document.querySelector('#intake-url'); i.value = ${JSON.stringify(PREVIEW_URL)}; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await click('识别内容');
  await until(`!!document.querySelector('.dialog .intake-preview')`, 12000);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await evaluate(`!!document.querySelector('.dialog .intake-preview__title')`), true, '目录失败也不该影响预览渲染');
  assert.equal(await evaluate(`!!document.querySelector('.dialog .intake-preview__unsubscribed')`), false,
    '订阅状态未知时不得显示「未订阅」——不知道不等于没有');
  assert.equal(await evaluate(`!!document.querySelector('.dialog [data-intake-priority]')`), true, '目录失败后仍可继续确认');
  await click('取消');
  await until(`!document.querySelector('.dialog')`);
  await evaluate(`IntakeStub.failChannels(false)`);
  await evaluate(`IntakeStub.setSubscribed(false)`);

  /* ---- 已收录分支：不覆盖原记录，也不能带上预览里的整理设置 ---- */
  await setMode('exists');
  await click('添加内容');
  await until(`!!document.querySelector('.dialog--intake')`);
  await evaluate(`(() => { const i = document.querySelector('#intake-url'); i.value = ${JSON.stringify(PREVIEW_URL)}; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await click('识别内容');
  await until(`!!document.querySelector('.intake-exists')`, 12000);
  assert.ok(await evaluate(`document.querySelector('.intake-exists').textContent.includes('已经收录')`), '必须明确告知已收录');
  assert.equal(await evaluate(`!!document.querySelector('.intake-priority')`), false, '已收录时不该再让用户改优先级');
  assert.equal(await evaluate(`!!document.querySelector('.intake-tags')`), false, '已收录时不该再让用户选标签');
  assert.equal(await evaluate(`IntakeStub.saved().length`), 1, '已收录分支不得触发保存');
  assert.equal(await evaluate(`!!Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '查看已有记录')`), true,
    '已收录必须提供打开原记录的入口');
  await shot('m13-intake-exists.png');
  await click('完成');
  await until(`!document.querySelector('.dialog')`);

  /* ---- 失败分支：给出原因和可行的下一步 ---- */
  await setMode('failed');
  await click('添加内容');
  await until(`!!document.querySelector('.dialog--intake')`);
  await evaluate(`(() => { const i = document.querySelector('#intake-url'); i.value = ${JSON.stringify(PREVIEW_URL)}; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await click('识别内容');
  await until(`!!document.querySelector('.dialog .notice')`, 12000);
  assert.ok(await evaluate(`document.querySelector('.dialog .notice').textContent.includes('过于频繁')`), '失败必须说明真实原因');
  // 平台的 reason 自带建议时，不能再拼一句重复文案
  const failureCopy = await evaluate(`document.querySelector('.dialog .notice__text').textContent`);
  assert.equal(/重试\s*稍等|重试\s*稍后/.test(failureCopy), false, '失败文案不得重复建议：' + failureCopy);
  assert.equal(await evaluate(`!!Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '重新识别')`), true,
    '失败后必须能重试，而不是留一个死按钮');
  await shot('m13-intake-failed.png');
  await click('取消');
  await until(`!document.querySelector('.dialog')`);

  /* ---- 登录类错误：引导到应用内登录 ---- */
  await setMode('start-error');
  await click('添加内容');
  await until(`!!document.querySelector('.dialog--intake')`);
  await evaluate(`(() => { const i = document.querySelector('#intake-url'); i.value = ${JSON.stringify(PREVIEW_URL)}; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await click('识别内容');
  await until(`!!document.querySelector('.dialog .notice')`, 12000);
  assert.ok(await evaluate(`document.querySelector('.dialog .notice').textContent.includes('登录')`), '登录失效必须说清怎么恢复');
  await shot('m13-intake-auth.png');
  await click('应用内登录');
  await until(`IntakeStub.metrics().logins.length === 1`);
  assert.deepEqual((await evaluate('IntakeStub.metrics()')).logins, ['conn-bili']);
  await click('取消');
  await until(`!document.querySelector('.dialog')`);

  /* ---- 取消识别：释放平台资源，不留下后台任务 ---- */
  await setMode('preview');
  await click('添加内容');
  await until(`!!document.querySelector('.dialog--intake')`);
  await evaluate(`(() => { const i = document.querySelector('#intake-url'); i.value = ${JSON.stringify(PREVIEW_URL)}; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await click('识别内容');
  await until(`!!document.querySelector('.intake-status')`);
  await click('取消识别');
  await until(`!document.querySelector('.intake-status') && !!document.querySelector('#intake-url')`);
  assert.equal(await evaluate(`!!document.querySelector('.intake-preview')`), false, '取消后不得留下预览');

  /* ---- 关闭对话框必须取消未完成的识别 ---- */
  await click('识别内容');
  await until(`!!document.querySelector('.intake-status')`);
  await evaluate(`document.querySelector('.dialog [aria-label="关闭对话框"]').click()`);
  await until(`!document.querySelector('.dialog')`);

  /* ---- 迟到的结果不得覆盖新界面 ---- */
  await until(`!document.querySelector('.dialog')`);
  assert.equal(await evaluate(`!!document.querySelector('.intake-preview')`), false, '关闭后不得残留预览');

  // 启动请求尚未返回就关闭时，也必须取消随后创建的任务。
  await setMode('late-start');
  const priorCancels = (await evaluate('IntakeStub.metrics()')).cancelled.length;
  await click('添加内容');
  await evaluate(`(() => {const i=document.querySelector('#intake-url');i.value=${JSON.stringify(PREVIEW_URL)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('识别内容');
  await click('取消');
  await until(`!document.querySelector('.dialog')`);
  await until(`IntakeStub.metrics().cancelled.length > ${priorCancels}`);

  assert.deepEqual(errors, [], '渲染层不应有控制台错误：' + errors.join(' | '));
  console.log(JSON.stringify({
    intakeUiSmoke: 'passed',
    twoStepFlow: true,
    previewShowsPlatformAndOriginalDate: true,
    manualCalendarRuleExplained: true,
    priorityFourOptions: true,
    tagsScopedToSave: true,
    duplicateNoOp: true,
    failureAndRetry: true,
    authRecovery: true,
    cancelReleasesPlatform: true,
    realPlatform: false,
    backend: 'stubbed-by-design',
  }));
  win.destroy();
}

const PREVIEW_URL = 'https://www.bilibili.com/video/BV1demo0001';

app.whenReady().then(async () => {
  try {
    await run();
    app.exit(0);
  } catch (error) {
    console.error('\n自主添加界面验收失败：' + error.message);
    try {
      fs.mkdirSync(output, {recursive: true});
      const win = BrowserWindow.getAllWindows()[0];
      if (win) fs.writeFileSync(path.join(output, 'm13-intake-FAILURE.png'), (await win.webContents.capturePage()).toPNG());
    } catch (_) {}
    app.exit(1);
  }
});
