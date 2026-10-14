const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * BUG-082 顶层启动 catch 的独立进程验证。
 *
 * 这里不调用纯函数，而是用仅开发／测试可用的注入点让真实 Electron 在
 * createWindow 阶段抛出 TypeError，由生产顶层 catch 真正处理：
 * 必须非零退出、stderr 写出真实原因、临时 userData 的诊断文件包含脱敏的
 * 原因与阶段，且文案不得声称「重新解压」。
 *
 * 注入点在 app.isPackaged 时直接抛错，正式包内根本不存在。
 */
function runCase(crash, dir) {
  return new Promise((resolve) => {
    const root = path.resolve(__dirname, '..');
    const child = spawn(require('electron'), [root], {
      env: {
        ...process.env,
        SUBSCRIBE_FLOW_DATA_DIR: dir,
        ...(crash ? {SUBSCRIBE_FLOW_TEST_CRASH: crash} : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({code, output: out});
    });
  });
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const results = {};

  /* ---------- 注入 TypeError：走真实顶层 catch ---------- */
  const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-crash-type-'));
  try {
    const {code, output} = await runCase('type', crashDir);
    assert.notEqual(code, 0, '启动失败必须非零退出，实际 exit=' + code);
    assert.match(output, /startup:code/, 'stderr 必须写明是代码异常');
    assert.match(output, /setWindowOpenHandler/, 'stderr 必须包含真实原因');

    const file = path.join(crashDir, 'diagnostics', 'lifecycle.jsonl');
    assert.ok(fs.existsSync(file), '诊断文件必须真实写入');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const record = JSON.parse(lines[lines.length - 1]);
    assert.equal(record.event, 'app.startup.failed');
    assert.equal(record.kind, 'code', '注入的 TypeError 必须归类为 code');
    assert.equal(record.phase, 'start');
    assert.ok(record.message && record.message.includes('setWindowOpenHandler'), '诊断必须含脱敏后的原因');
    assert.ok(record.stack, '诊断必须含堆栈以便定位');
    assert.ok(!/重新解压/.test(JSON.stringify(record, null, 0)), '代码异常不得提示重新解压');
    assert.ok(!/Bearer\s+\S+/i.test(JSON.stringify(record)), '诊断不得含认证头');
    results.injectedTypeError = {exitCode: code, kind: record.kind, phase: record.phase};
  } finally {
    fs.rmSync(crashDir, {recursive: true, force: true});
  }

  /* ---------- 对照：真实资源缺失的分类 ---------- */
  const {classifyStartupFailure} = require('../electron/main/startup-errors.cjs');
  const missing = new Error('应用文件缺失');
  missing.code = 'ENOENT';
  const classified = classifyStartupFailure(missing);
  assert.equal(classified.kind, 'resource');
  assert.match(classified.detail, /重新解压/, '确实是资源缺失时才提示重新解压');
  const disk = new Error('磁盘满');
  disk.code = 'ENOSPC';
  const envClassified = classifyStartupFailure(disk);
  assert.equal(envClassified.kind, 'environment');
  assert.ok(!/重新解压/.test(envClassified.detail), '磁盘问题不得提示重新解压');
  results.resourceVsEnvironment = {resource: classified.kind, environment: envClassified.kind};

  console.log(JSON.stringify({startupCrashCheck: 'passed', ...results}));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[startup-crash-check] 失败：' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {main};
