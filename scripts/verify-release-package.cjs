// Match the exact shipped runtime to the build commit; no user profile is opened.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
async function main(){
  const root=path.resolve(__dirname,'..'),info=JSON.parse(fs.readFileSync(path.join(root,'dist/build-info.json')));
  const output=process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT||path.join(root,'docs/verification/v'+info.version+'-release');
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
}
main().catch(error=>{console.error(error);process.exitCode=1;});
