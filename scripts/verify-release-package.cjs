// Match the exact shipped runtime to the build commit; no user profile is opened.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
async function main(){
  const root=path.resolve(__dirname,'..'),info=JSON.parse(fs.readFileSync(path.join(root,'dist/build-info.json')));
  const output=process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT||path.join(root,'docs/verification/v'+info.version+'-local');
  const asar=await import('@electron/asar'),resources=path.join(info.bundle,'Contents/Resources'),archive=path.join(resources,'app.asar');
  let matched=0;
  function verify(dir){for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
    const file=path.join(dir,entry.name);if(entry.isDirectory())verify(file);
    else {assert.ok(fs.readFileSync(path.join(root,file)).equals(asar.extractFile(archive,file.replaceAll(path.sep,'/'))),file);matched++;}
  }}
  for(const part of ['main','preload','renderer'])verify('electron/'+part);
  for(const name of ['assets/logo.png'])assert.ok(fs.readFileSync(path.join(root,name)).equals(asar.extractFile(archive,name)));
  assert.ok(fs.readFileSync(path.join(root,'build/macos/SubscribeFlow.icns')).equals(fs.readFileSync(path.join(resources,'electron.icns'))));
  assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,info.version);
  assert.equal(JSON.parse(asar.extractFile(archive,'build-info.json')).baseRevision,info.baseRevision);
  assert.ok(!asar.listPackage(archive).some(e=>/runtime-paths|\.sqlite|^\/tests\/|^\/scripts\/|^\/docs\/|^\/electron\/diagnostics\//.test(e)));
  const result={status:'passed',version:info.version,baseRevision:info.baseRevision,sourceFilesMatched:matched,originalLogoMatched:true,appIconMatched:true,packageAllowlist:true};
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'package-content.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
  const links=[];
  function walk(folder){for(const e of fs.readdirSync(folder,{withFileTypes:true})){
    const file=path.join(folder,e.name);
    if(e.isSymbolicLink()){
      assert.ok(!path.isAbsolute(fs.readlinkSync(file)));
      assert.ok(fs.realpathSync(file).startsWith(info.bundle+path.sep));links.push(path.relative(info.bundle,file));
    }else if(e.isDirectory())walk(file);
  }}walk(info.bundle);
  const sha256=crypto.createHash('sha256').update(fs.readFileSync(info.archive)).digest('hex');
  assert.equal(sha256,info.sha256);
  assert.equal(fs.readFileSync(info.archive+'.sha256','utf8').trim(),sha256+'  '+path.basename(info.archive));
  function run(command,args){const r=spawnSync(command,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.error?.message);return r.stdout;}
  assert.match(run('/usr/bin/file',[path.join(resources,'core/subscribe-flow-core')]),/x86_64/);
  run('/usr/bin/codesign',['--verify','--deep','--strict',info.bundle]);
  run('/usr/bin/unzip',['-tq',info.archive]);
  const audit={status:'passed',version:info.version,buildRevision:info.baseRevision,sourceFilesMatched:matched,
    logoMatched:true,archiveAllowlist:true,size:fs.statSync(info.archive).size,sha256,hashSidecarMatched:true,
    relativeLinks:links.length,coreRelativeLinks:links.filter(p=>p.startsWith('Contents/Resources/core/')).length,
    coreArchitecture:'x86_64',iconPresent:fs.existsSync(path.join(resources,'electron.icns')),
    signatureVerified:true,zipVerified:true,bundle:info.bundle,archive:info.archive};
  fs.writeFileSync(path.join(output,'audit.json'),JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify(audit));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
