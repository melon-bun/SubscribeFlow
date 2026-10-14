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
  assert.ok(body.includes('webContents.setWindowOpenHandler'), 'setWindowOpenHandler 必须挂在 webContents 上');
  assert.ok(!body.includes('session.setWindowOpenHandler'), 'session 上没有 setWindowOpenHandler（这正是 BUG-082 根因）');
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
