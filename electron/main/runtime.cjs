const fs = require('node:fs');
const path = require('node:path');

function resolveRuntime({packaged, resourcesPath, root, env = process.env}) {
  // A release must never execute a developer's local configuration or environment override.
  if (packaged) return {coreExecutable: path.join(resourcesPath, 'core', 'subscribe-flow-core')};
  let local = {};
  try { local = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8')); }
  catch { /* start() presents the actionable configuration error. */ }
  return {python: env.SUBSCRIBE_FLOW_PYTHON || local.python, node: local.node};
}

function coreLaunch({coreExecutable, python, node, root, dataDir, schedulePolicy}, inherited = process.env) {
  const bundled = !!coreExecutable;
  const executable = coreExecutable || python;
  const help = bundled ? '内置核心服务缺失或不可执行，请重新解压完整应用；本地数据会保留。' : '请运行 npm run configure 配置 Python 3.12+ 路径';
  if (!path.isAbsolute(executable || '')) throw new Error(help);
  try { fs.accessSync(executable, fs.constants.X_OK); }
  catch { throw new Error(help); }
  const args = bundled ? [] : ['-u', '-m', 'subscribe_flow'];
  args.push('--data-dir', dataDir, '--backend', 'electron-session');
  if (schedulePolicy) args.push('--schedule-policy', JSON.stringify(schedulePolicy));
  const env = {...inherited};
  for (const name of Object.keys(env)) {
    if (name.startsWith('PYTHON') || name.startsWith('DYLD_') || name.startsWith('_PYI') || name.startsWith('PYINSTALLER_')) delete env[name];
  }
  env.PYTHONUTF8 = '1'; env.PYTHONNOUSERSITE = '1';
  if (!bundled) env.PYTHONPATH = path.join(root, 'python', 'src');
  env.PATH = (!bundled && node ? path.dirname(node) + path.delimiter : '') + '/usr/bin:/bin:/usr/sbin:/sbin';
  // app.asar is a file; it cannot be the working directory of a child process.
  return {executable, args, options: {env, cwd: bundled ? path.dirname(executable) : root,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true}};
}

function startupHint(stderr) {
  if (/schema is newer/.test(stderr)) return '数据由较新版本创建，请使用相同或更新版本的应用打开。';
  if (/数据目录已被占用/.test(stderr)) return '数据目录正在使用中，请关闭另一个知流实例后重试。';
  if (/database disk image is malformed|file is not a database/.test(stderr)) return '本地数据库无法读取，请退出应用并按使用说明从备份恢复。';
  if (/readonly database|Permission denied|unable to open database/.test(stderr)) return '无法读写应用数据目录，请检查磁盘空间和目录权限。';
  if (/sqlite3\..*Error/.test(stderr)) return '数据库升级或读取失败，原数据与升级前备份已保留，请按使用说明恢复。';
  return null;
}

module.exports = {resolveRuntime, coreLaunch, startupHint};
