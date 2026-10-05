const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {resolveRuntime, coreLaunch, startupHint} = require('../electron/main/runtime.cjs');
const {diagnosticRecord, createDiagnostics} = require('../electron/main/diagnostics.cjs');

test('release ignores developer paths and Python injection; child cwd is outside asar', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'sf-runtime-'));
  try {
    const resources = path.join(root,'Application with spaces.app','Contents','Resources');
    const executable = path.join(resources,'core','subscribe-flow-core');
    fs.mkdirSync(path.dirname(executable),{recursive:true}); fs.writeFileSync(executable,'fixture',{mode:0o700});
    fs.writeFileSync(path.join(root,'.runtime-paths.json'),JSON.stringify({python:'/not-used/python',node:'/not-used/node'}));
    const runtime = resolveRuntime({packaged:true,resourcesPath:resources,root,env:{SUBSCRIBE_FLOW_PYTHON:'/not-used/override'}});
    assert.deepEqual(runtime,{coreExecutable:executable});
    const launch = coreLaunch({...runtime,root:path.join(resources,'app.asar'),dataDir:root},{PYTHONHOME:'/injected',PYTHONPATH:'/injected',DYLD_LIBRARY_PATH:'/injected',_PYI_PARENT_PROCESS_LEVEL:'1',PATH:'/developer'});
    assert.equal(launch.options.cwd,path.dirname(executable));
    assert.deepEqual(launch.args,['--data-dir',root,'--backend','electron-session']);
    assert.equal(launch.options.env.PATH,'/usr/bin:/bin:/usr/sbin:/sbin');
    for (const key of ['PYTHONHOME','PYTHONPATH','DYLD_LIBRARY_PATH','_PYI_PARENT_PROCESS_LEVEL']) assert.equal(launch.options.env[key],undefined);
    fs.unlinkSync(executable);
    assert.throws(()=>coreLaunch({...runtime,root,dataDir:root}),/重新解压完整应用/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('startup hints and bounded diagnostics never expose raw errors or personal data', () => {
  assert.match(startupHint('Database schema is newer than this application'),/较新版本/);
  assert.match(startupHint('sqlite3.DatabaseError: database disk image is malformed'),/备份恢复/);
  assert.equal(startupHint('secret session cookie /Users/person/file'),null);
  const record = diagnosticRecord('core.status',{state:'error',code:1,message:'cookie=secret',url:'https://private',path:'/Users/person',payload:{secret:true}});
  assert.deepEqual(Object.keys(record).sort(),['code','event','state','time']);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-log-'));
  try {
    const log=createDiagnostics(root);log('core.status',{state:'ready'});
    const file=path.join(root,'diagnostics','lifecycle.jsonl');
    fs.writeFileSync(file,'x'.repeat(1024*1024+1));log('app.quit');
    assert.ok(fs.existsSync(file+'.previous'));assert.ok(fs.statSync(file).size<1024);
    assert.equal(diagnosticRecord('unrecognized-event',{cookie:'secret'}),null);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
