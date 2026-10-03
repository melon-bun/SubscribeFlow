const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

function find(name) {
  try { return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}
const config = {
  python: find('python3'),
  node: process.execPath,
  opencli: find('opencli'),
};
if (!config.python) throw new Error('需要 Python 3.12+，安装后重新配置');
writeFileSync(path.join(__dirname, '..', '.runtime-paths.json'), JSON.stringify(config, null, 2) + '\n');
console.log('已保存本机 Python、Node 与 OpenCLI 路径；桌面启动使用这些绝对路径。');
