const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const build = path.join(root, 'build', 'macos');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {cwd:root, stdio:'inherit', ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})`);
  return result.stdout;
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'x64') throw new Error('本轮仅支持在 macOS Intel 上构建；其他架构需单独验收。');
  const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json'),'utf8'));
  fs.mkdirSync(build, {recursive:true});
  const venv = path.join(root,'build','packaging-venv');
  const python = path.join(venv,'bin','python');
  if (!fs.existsSync(python)) run('uv',['venv','--python',runtime.python,venv]);
  run('uv',['pip','sync','--python',python,'--require-hashes',path.join(root,'packaging','requirements.txt')]);
  run(python,['-c', 'import platform,sys; assert sys.version_info >= (3,12); assert platform.machine() == "x86_64"']);
  run(python,['-m','PyInstaller','--noconfirm','--clean','--onedir','--noupx','--name','subscribe-flow-core',
    '--target-arch','x86_64','--distpath',path.join(build,'sidecar'),'--workpath',path.join(build,'pyinstaller'),
    '--specpath',build,'--paths',path.join(root,'python','src'),
    '--add-data',path.join(root,'python/src/subscribe_flow/storage/migrations') + ':subscribe_flow/storage/migrations',
    path.join(root,'packaging/core-entry.py')]);

  // Copy an explicit allowlist into staging; never package the workspace wholesale.
  const stage = path.join(build,'app');
  fs.rmSync(stage,{recursive:true,force:true}); fs.mkdirSync(stage,{recursive:true});
  for (const folder of ['main','preload','renderer']) fs.cpSync(path.join(root,'electron',folder),path.join(stage,'electron',folder),{recursive:true});
  // M17 托盘按 __dirname/../../assets/logo.png 解析，落在 app.asar 内的 assets/ 下。
  // 只放这一个运行期真正需要的公开静态资源：整个 assets/ 里还有开发用截图，
  // 不应进包。这里仍走显式白名单，不复制工作区。
  fs.mkdirSync(path.join(stage,'assets'),{recursive:true});
  fs.copyFileSync(path.join(root,'assets','logo.png'),path.join(stage,'assets','logo.png'));
  fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({name:pkg.name,productName:'Subscribe Flow',version:pkg.version,description:pkg.description,main:pkg.main},null,2));
  const core = path.join(build,'core');
  fs.rmSync(core,{recursive:true,force:true});
  fs.cpSync(path.join(build,'sidecar','subscribe-flow-core'),core,{recursive:true,verbatimSymlinks:true});
  const license = run(python,['-c','import pathlib,sysconfig; print(pathlib.Path(sysconfig.get_path("stdlib"))/"LICENSE.txt")'],{encoding:'utf8',stdio:'pipe'}).trim();
  fs.copyFileSync(license,path.join(core,'PYTHON-LICENSE.txt'));
  const pyinstallerLicense = run(python,['-c','import importlib.metadata as m; d=m.distribution("pyinstaller"); print(d.locate_file(next(f for f in d.files if str(f).endswith("licenses/COPYING.txt"))))'],{encoding:'utf8',stdio:'pipe'}).trim();
  fs.copyFileSync(pyinstallerLicense,path.join(core,'PYINSTALLER-COPYING.txt'));
  const icons = path.join(build,'SubscribeFlow.iconset');
  run(require('electron'),[path.join(root,'scripts/package-icon.cjs'),icons]);
  const icon = path.join(build,'SubscribeFlow.icns');
  run('/usr/bin/iconutil',['-c','icns','-o',icon,icons]);
  const revision = run('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:'pipe'}).trim();
  const metadata = {version:pkg.version,platform:'darwin',arch:'x64',electron:pkg.devDependencies.electron,
    python:run(python,['--version'],{encoding:'utf8',stdio:'pipe'}).trim(),pyinstaller:'6.22.3',baseRevision:revision,builtAt:new Date().toISOString(),signing:'local-ad-hoc'};
  fs.writeFileSync(path.join(stage,'build-info.json'),JSON.stringify(metadata,null,2)+'\n');
  const {packager} = await import('@electron/packager');
  const [output] = await packager({dir:stage,name:'Subscribe Flow',platform:'darwin',arch:'x64',
    appBundleId:'local.subscribeflow.desktop',appVersion:pkg.version,buildVersion:pkg.version,icon,
    electronVersion:pkg.devDependencies.electron,out:path.join(root,'dist'),overwrite:true,prune:false,
    asar:true,osxSign:false,osxNotarize:false});
  const bundle = path.join(output,'Subscribe Flow.app');
  // Packager's extraResource copy resolves these links to absolute staging paths.
  // Preserve PyInstaller's relative framework links so the .app can be moved.
  fs.cpSync(core,path.join(bundle,'Contents','Resources','core'),{recursive:true,verbatimSymlinks:true});
  // Local-only signing preserves executable integrity; no developer identity is used.
  run('/usr/bin/codesign',['--force','--deep','--sign','-',bundle]);
  run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
  const archive = path.join(root,'dist',`Subscribe-Flow-${pkg.version}-mac-x64.zip`);
  fs.rmSync(archive,{force:true});
  run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',bundle,archive]);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(archive+'.sha256',`${sha256}  ${path.basename(archive)}\n`);
  fs.writeFileSync(path.join(root,'dist','build-info.json'),JSON.stringify({...metadata,bundle,archive,sha256},null,2)+'\n');
  console.log(JSON.stringify({bundle,archive,sha256}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
