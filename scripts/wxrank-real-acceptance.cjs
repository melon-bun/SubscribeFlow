/**
 * M45 付费渠道：正式界面链路的真实传输层验收。
 *
 * 启动本机上游（响应形状照真实上游契约复刻），再用正式 Electron 应用
 * 跑一遍：Renderer → Preload → Main → Core → 真实传输层 → 真实 HTTP。
 *
 * 这不是真实付费上游：本机没有授权的 wxrank 密钥，整个过程不产生任何
 * 真实扣费。证据文件里会写清楚这一点。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'docs', 'verification', 'm45-minimax', 'batch-03');
const screenshotDir = path.join(outputDir, 'screenshots');
const evidencePath = path.join(outputDir, 'real-wxrank-ui-evidence.json');

async function main() {
  const {startUpstream} = require('./wxrank-mock-upstream.cjs');
  const upstream = await startUpstream();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-wxrank-real-'));
  fs.mkdirSync(screenshotDir, {recursive: true});
  const summaryPath = path.join(folder, 'summary.json');
  console.log('[wxrank-real] 上游:', upstream.base);

  const env = {
    ...process.env,
    SUBSCRIBE_FLOW_RENDERER_SMOKE: 'wxrankreal',
    SUBSCRIBE_FLOW_LIVE_SKIP_SEARCH: '0',
    SUBSCRIBE_FLOW_DATA_DIR: folder,
    // 真实传输层 + 本机上游：不是仓库里的脱敏样本传输。
    SUBSCRIBE_FLOW_WXRANK_FIXTURE: 'http',
    SUBSCRIBE_FLOW_WXRANK_HTTP_BASE: upstream.base,
    SUBSCRIBE_FLOW_VERIFY_OUTPUT: screenshotDir,
    SUBSCRIBE_FLOW_WXRANK_EVIDENCE: summaryPath,
  };

  const code = await new Promise((resolve) => {
    const child = spawn(require('electron'), [root], {env, stdio: 'inherit'});
    const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.on('close', (status) => { clearTimeout(timer); resolve(status ?? 1); });
  });

  let summary = {};
  if (fs.existsSync(summaryPath)) {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  }
  const evidence = {
    generatedAt: new Date().toISOString(),
    mode: '正式界面／Preload／Main／Core + 真实传输层 + 本机真实 HTTP 上游',
    notVerified: '真实付费上游 data.wxrank.com：本机没有授权的 wxrank 密钥，未产生任何真实扣费。',
    upstream: upstream.base,
    electronExitCode: code,
    summary,
    requestLog: upstream.requests,
  };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  upstream.close();
  fs.rmSync(folder, {recursive: true, force: true});

  assert.equal(code, 0, '正式界面验收必须以 0 退出');
  assert.ok(summary.wxrankUi === 'passed', '界面验收没有通过');
  console.log('[wxrank-real] 证据:', evidencePath);
  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  console.error('[wxrank-real] 失败:', error && error.message ? error.message : error);
  process.exitCode = 1;
});
