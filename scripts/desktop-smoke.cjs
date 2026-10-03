const {spawn} = require('node:child_process');
const {mkdtempSync, rmSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const folder = mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-desktop-'));
const child = spawn(require('electron'), [path.resolve(__dirname, '..')], {
  env: {...process.env, SUBSCRIBE_FLOW_DESKTOP_SMOKE: '1', SUBSCRIBE_FLOW_DATA_DIR: folder},
  stdio: 'inherit',
});
const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
child.on('close', code => {clearTimeout(timer); rmSync(folder, {recursive: true, force: true}); process.exitCode = code ?? 1;});
