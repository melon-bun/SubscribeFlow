// Release-only cleanup: never open the application's normal profile.
const {app,shell}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'sf-release-finalize-'));
app.setPath('userData',temporary);
const lsregister='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
function run(command,args) {
  const result=spawnSync(command,args,{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  return result.stdout.trim();
}
function plist(bundle,key) {
  return run('/usr/libexec/PlistBuddy',['-c','Print :'+key,path.join(bundle,'Contents/Info.plist')]);
}
function hash(file) {return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function verifyArchive(version,expected) {
  const archive=path.join(root,'dist',`Subscribe-Flow-${version}-mac-x64.zip`);
  const digest=hash(archive);
  assert.equal(fs.readFileSync(archive+'.sha256','utf8').trim(),digest+'  '+path.basename(archive));
  if(expected)assert.equal(digest,expected);
  return {archive,sha256:digest};
}
function older(left,right) {
  const a=left.split('.').map(Number),b=right.split('.').map(Number);
  for(let i=0;i<Math.max(a.length,b.length);i++) {
    if((a[i]||0)!==(b[i]||0))return (a[i]||0)<(b[i]||0);
  }
  return false;
}
async function finalize() {
  assert.equal(process.platform,'darwin');
  const info=JSON.parse(fs.readFileSync(path.join(root,'dist/build-info.json')));
  const output=path.resolve(process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT||path.join(root,`docs/verification/v${info.version}-local`));
  const audit=JSON.parse(fs.readFileSync(path.join(output,'audit.json')));
  const smoke=JSON.parse(fs.readFileSync(path.join(output,'result.json')));
  assert.equal(audit.status,'passed');assert.equal(smoke.packagedSmoke,'passed');
  assert.equal(audit.version,info.version);assert.equal(smoke.version,info.version);
  assert.equal(audit.sha256,info.sha256);assert.equal(audit.buildRevision,info.baseRevision);
  assert.equal(smoke.sha256,info.sha256);assert.equal(smoke.baseRevision,info.baseRevision);
  const expected=path.join(root,'dist',info.version,'Subscribe Flow-darwin-x64','Subscribe Flow.app');
  assert.equal(info.bundle,expected);assert.equal(fs.realpathSync(info.bundle),expected);
  const identifier='local.subscribeflow.desktop';
  assert.equal(plist(info.bundle,'CFBundleIdentifier'),identifier);
  assert.equal(plist(info.bundle,'CFBundleShortVersionString'),info.version);
  verifyArchive(info.version,info.sha256);
  run('/usr/bin/codesign',['--verify','--deep','--strict',info.bundle]);
  const candidates=[];
  // Validate every candidate before moving anything; leave external installs alone.
  for(const entry of fs.readdirSync(path.join(root,'dist'),{withFileTypes:true})) {
    if(!entry.isDirectory()||!/^\d+(\.\d+){2,3}$/.test(entry.name)||!older(entry.name,info.version))continue;
    const bundle=path.join(root,'dist',entry.name,'Subscribe Flow-darwin-x64','Subscribe Flow.app');
    if(!fs.existsSync(bundle))continue;
    assert.equal(fs.realpathSync(bundle),bundle);
    assert.equal(plist(bundle,'CFBundleIdentifier'),identifier);
    assert.equal(plist(bundle,'CFBundleShortVersionString'),entry.name);
    candidates.push({version:entry.name,bundle,backup:verifyArchive(entry.name)});
  }
  const result={date:new Date().toISOString(),status:'passed',retainedVersion:info.version,
    retainedApp:info.bundle,retired:[],skippedRunning:[],dailyDataTouched:false};
  for(const candidate of candidates) {
    // Recheck immediately before each move. Never quit a user's running version.
    if(run('/bin/ps',['-axo','command=']).split('\n').some(line=>line.includes(candidate.bundle+path.sep))) {
      result.skippedRunning.push(candidate.bundle);continue;
    }
    run(lsregister,['-u',candidate.bundle]);
    try {await shell.trashItem(candidate.bundle);}
    catch(error) {run(lsregister,['-f',candidate.bundle]);throw error;}
    assert.ok(!fs.existsSync(candidate.bundle));
    assert.equal(hash(candidate.backup.archive),candidate.backup.sha256);
    result.retired.push({...candidate,oldWasNotRunning:true,movedToTrash:true,unregistered:true});
  }
  run(lsregister,['-f',info.bundle]);
  result.indexedApps=run('/usr/bin/mdfind',[`kMDItemCFBundleIdentifier == "${identifier}"`]).split('\n').filter(p=>p&&fs.existsSync(p));
  if(result.skippedRunning.length)result.status='deferred';
  fs.writeFileSync(path.join(output,'app-cleanup.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  if(result.status!=='passed')throw new Error('旧应用仍在运行，已保留；退出后重新运行 finalize:mac。');
}
app.whenReady().then(finalize).then(()=>{
  fs.rmSync(temporary,{recursive:true,force:true});app.exit(0);
}).catch(error=>{
  console.error(error.message);fs.rmSync(temporary,{recursive:true,force:true});app.exit(1);
});
