'use strict';
/**
 * BUG-082 回归：启动失败的错误对象不得被丢弃，内部代码异常不得说成资源损坏。
 *
 * 除纯函数外，这里还静态校验主入口确实接入了分类器——否则又会出现
 * 「模块写好了但顶层 catch 仍然吞掉错误」的情况。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {classifyStartupFailure, startupFailureRecord, redact} = require('../electron/main/startup-errors.cjs');
const {diagnosticRecord, createDiagnostics} = require('../electron/main/diagnostics.cjs');
const {WindowLifecycle} = require('../electron/main/lifecycle.cjs');

const ROOT = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(ROOT, 'electron/main/index.cjs'), 'utf8');

test('BUG-082：TypeError 归为代码异常，不再建议重新解压', () => {
  // 曾经真实发生过的那个错误
  const error = new TypeError('window.webContents.session.setWindowOpenHandler is not a function');
  const result = classifyStartupFailure(error);
  assert.equal(result.kind, 'code');
  assert.equal(result.name, 'TypeError');
  assert.ok(!/重新解压/.test(result.detail), '代码异常不得提示重新解压');
  assert.ok(/程序错误/.test(result.detail));
  assert.match(result.message, /setWindowOpenHandler/);
});

test('BUG-082：资源读取故障才提示重新解压', () => {
  const error = new Error('unpack failed');
  error.code = 'ENOENT';
  const result = classifyStartupFailure(error);
  assert.equal(result.kind, 'resource');
  assert.ok(/重新解压/.test(result.detail));
});

test('BUG-082：未知错误既不甩锅资源也不假装已定位', () => {
  const result = classifyStartupFailure(new Error('something odd'));
  assert.equal(result.kind, 'unknown');
  assert.ok(!/重新解压/.test(result.detail));
  assert.match(result.detail, /诊断/);
});

test('BUG-082：诊断记录脱敏，不含密钥与请求头', () => {
  const error = new TypeError('failed with Bearer sk-secret-token and api_key=abcd1234 at /Users/x/app.js:12');
  const record = startupFailureRecord(error, 'createWindow');
  const text = JSON.stringify(record);
  assert.ok(!text.includes('sk-secret-token'), '密钥不得进诊断');
  assert.ok(!text.includes('abcd1234'), 'api_key 值不得进诊断');
  assert.match(text, /\[redacted\]/);
  assert.equal(record.phase, 'createWindow');
});

test('BUG-082：空错误对象也不会崩溃', () => {
  assert.equal(classifyStartupFailure(undefined).kind, 'unknown');
  assert.equal(classifyStartupFailure(null).kind, 'unknown');
});

test('BUG-082：主入口必须接收并分类真实错误，不得吞掉', () => {
  const catchClause = mainSource.match(/app\.whenReady\(\)\.then\(start\)\.catch\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n\}\);/);
  assert.ok(catchClause, '找不到顶层启动 catch');
  const [, param, body] = catchClause;
  assert.ok(param.trim().length > 0, 'catch 必须接收错误对象，不能是空参 () =>');
  assert.ok(/classifyStartupFailure|startupFailureRecord/.test(body), '顶层 catch 必须调用分类器');
  assert.ok(/diagnostic\(/.test(body), '顶层 catch 必须写入诊断');
  // 只约束启动路径：代码里确实存在合法的 catch {}（连接检查等可重试路径）。
  assert.ok(!/whenReady\(\)\.then\(start\)\.catch\(\(\)\s*=>/.test(mainSource),
    '启动 catch 不得丢弃错误对象');
});

test('BUG-082：smoke 模式下启动失败必须非零退出并把真实原因写到 stderr', () => {
  const catchClause = mainSource.match(/app\.whenReady\(\)\.then\(start\)\.catch\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\}\);/);
  assert.ok(catchClause, '找不到顶层启动 catch');
  const body = catchClause[1];
  assert.match(body, /console\.error|process\.stderr/, 'smoke 失败要把真实原因写到 stderr');
  assert.match(body, /exit\(1\)|process\.exitCode/, '必须非零退出');
});

test('BUG-080：最终 HEAD 的 send 每次只投递一次', () => {
  const sendFn = mainSource.match(/function send\(([^)]*)\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(sendFn, '找不到 send 实现');
  const body = sendFn[2];
  const deliveries = (body.match(/\.webContents\.send\(/g) || []).length;
  assert.equal(deliveries, 1, `send 内出现了 ${deliveries} 次投递，必须只有一次`);
  assert.match(sendFn[1], /target/, 'send 必须支持指定投递目标');
});

test('BUG-075：主窗口工厂必须存在且调用正确的安全 API', () => {
  assert.match(mainSource, /async function createWindow\(/, '缺少真实 createWindow 工厂');
  const factory = mainSource.match(/async function createWindow\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  const body = factory[1];
  assert.ok(/webContents\.setWindowOpenHandler\s*\(/.test(body), 'setWindowOpenHandler 必须挂在 webContents 上');
  // 只匹配真实调用形式：注入点的错误文案里刻意复现了历史报错文本，不能算命中。
  assert.ok(!/session\.setWindowOpenHandler\s*\(/.test(body), 'session 上没有 setWindowOpenHandler（这正是 BUG-082 根因）');
  assert.ok(body.includes('setPermissionRequestHandler'), '必须拒绝权限请求');
  assert.ok(body.includes('setPermissionCheckHandler'), '必须拒绝权限检查');
  assert.ok(body.includes('sandbox: true'), '必须保留 sandbox');
  assert.ok(body.includes('contextIsolation: true'), '必须保留 contextIsolation');
  assert.ok(body.includes('nodeIntegration: false'), '必须禁用 nodeIntegration');
  assert.ok(body.includes("will-navigate"), '必须阻止外部导航');
  assert.ok(body.includes('will-attach-webview'), '必须阻止 webview 挂载');
  assert.ok(body.includes('loadURL'), '必须加载应用 URL');
});

test('BUG-075：Core 就绪判断不得依赖不存在的 status 属性', () => {
  assert.ok(!/resources\.core\.status\?\.state/.test(mainSource),
    'CoreClient 没有 status 属性，resources.ready 才是事件驱动的真实来源');
  assert.match(mainSource, /resources\.ready/);
});

test('脱敏不会误伤普通诊断信息', () => {
  assert.equal(redact('normal message'), 'normal message');
  assert.match(redact('Authorization: Bearer abc.def'), /\[redacted\]/);
});


test('BUG-082：诊断白名单必须真的放行启动失败并写入文件', async () => {
  const record = diagnosticRecord('app.startup.failed', {
    phase: 'createWindow', kind: 'code', code: 'ERR_INTERNAL', name: 'TypeError',
    message: 'boom Bearer sk-should-not-persist', stack: 'TypeError: boom\n  at createWindow',
  });
  assert.ok(record, '启动失败必须被诊断记录接受，否则错误根本不落盘');
  assert.equal(record.phase, 'createWindow');
  assert.equal(record.kind, 'code');
  assert.match(record.message, /createWindow|boom/);
  assert.ok(!record.message.includes('sk-should-not-persist'), '诊断不得写入密钥');

  const os = require('node:os');
  const fsx = require('node:fs');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'sf-diag-'));
  try {
    const diagnostic = createDiagnostics(dir);
    diagnostic('app.startup.failed', record);
    const file = path.join(dir, 'diagnostics', 'lifecycle.jsonl');
    assert.ok(fsx.existsSync(file), '诊断文件必须真实写入');
    const lines = fsx.readFileSync(file, 'utf8').trim().split('\n');
    const written = JSON.parse(lines[lines.length - 1]);
    assert.equal(written.event, 'app.startup.failed');
    assert.equal(written.phase, 'createWindow');
    assert.ok(written.message && written.stack, '原因与阶段必须落盘');
  } finally {
    fsx.rmSync(dir, {recursive: true, force: true});
  }
});

test('BUG-082：未知事件仍然不记录（白名单不是"什么都记"）', () => {
  assert.equal(diagnosticRecord('totally.unlisted', {a: 1}), null);
  assert.equal(diagnosticRecord('core.status', {state: 'ready'}).state, 'ready');
});

test('BUG-082：磁盘与权限问题不得提示重新解压', () => {
  for (const code of ['ENOSPC', 'EACCES', 'EPERM', 'EMFILE', 'EROFS']) {
    const error = new Error('io');
    error.code = code;
    const result = classifyStartupFailure(error);
    assert.equal(result.kind, 'environment', code + ' 应归为环境问题');
    assert.ok(!/重新解压/.test(result.detail), code + ' 不得建议重新解压');
  }
  const missing = new Error('app file missing');
  missing.code = 'ENOENT';
  assert.equal(classifyStartupFailure(missing).kind, 'resource');
});

test('BUG-075：工厂同步抛错后仍可重试', async () => {
  let attempts = 0;
  const win = {destroyed: false, isDestroyed() { return this.destroyed; }, isMinimized: () => false,
               show() {}, focus() {}, destroy() { this.destroyed = true; }};
  const lifecycle = new WindowLifecycle({
    getWindow: () => (attempts >= 2 ? win : null),
    createWindow: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('工厂同步失败'); // 同步抛错
      return win;
    },
    hardQuit: () => {},
  });
  await assert.rejects(() => lifecycle.restore(), /工厂同步失败/);
  // 关键：第二次必须真的再调一次工厂，而不是重复抛出上一个已拒绝的 Promise。
  const restored = await lifecycle.restore();
  assert.equal(attempts, 2, '失败后必须能重试');
  assert.equal(restored, win);
});

test('BUG-075：工厂异步拒绝后仍可重试', async () => {
  let attempts = 0;
  const win = {destroyed: false, isDestroyed() { return this.destroyed; }, isMinimized: () => false,
               show() {}, focus() {}, destroy() { this.destroyed = true; }};
  const lifecycle = new WindowLifecycle({
    getWindow: () => (attempts >= 2 ? win : null),
    createWindow: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('加载失败');
      return win;
    },
    hardQuit: () => {},
  });
  await assert.rejects(() => lifecycle.restore(), /加载失败/);
  await lifecycle.restore();
  assert.equal(attempts, 2);
});

test('BUG-075：退出后不再创建窗口', async () => {
  let created = 0;
  const win = {destroyed: false, isDestroyed() { return this.destroyed; }, isMinimized: () => false,
               show() {}, focus() {}, destroy() { this.destroyed = true; }};
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const lifecycle = new WindowLifecycle({
    getWindow: () => null,
    createWindow: async () => { created += 1; await gate; return win; },
    hardQuit: () => {},
  });
  const pending = lifecycle.restore();
  const quitting = lifecycle.quit();
  release();
  await Promise.all([pending, quitting]);
  assert.equal(created, 1);
  assert.equal(win.destroyed, true, '退出期间建出的窗口必须关闭');
  assert.equal(await lifecycle.restore(), null, '退出后不再新建');
});
