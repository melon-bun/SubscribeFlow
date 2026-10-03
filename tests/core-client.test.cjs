const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {CoreClient} = require('../electron/main/core-client.cjs');
const {callUI} = require('../electron/main/app-client.cjs');

const root = path.resolve(__dirname, '..');
const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
async function fixture(run) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-test-'));
  const core = new CoreClient({...runtime, opencli: '/missing/opencli', root, dataDir: folder});
  try { await core.start(); await run(core); }
  finally { await core.stop(); fs.rmSync(folder, {recursive: true, force: true}); }
}

test('real sidecar handshake, persistent subscription, UI mapping and controlled restart', async () => {
  await fixture(async core => {
    const channels = await core.call('channel.list');
    assert.equal(channels[0].channel, 'bilibili');
    const sub = await callUI(core, 'createChannel', [{platform: 'bilibili', link:'946974', confirmed:true}]);
    assert.equal(sub.platform, 'bilibili');
    const list = await callUI(core, 'listChannels', []);
    assert.equal(list.total, 1);
    await assert.rejects(callUI(core, 'createRule', [{}]), error => error.code === 'UNSUPPORTED_OPERATION');
    await assert.rejects(core.call('content.list', {limit:true}));
    await assert.rejects(core.call('os.system', {command:'invalid'}));
    const readiness = await core.call('connection.check', {connection_id:'bilibili:default'});
    assert.equal(readiness.state, 'blocked');
    assert.equal((await core.call('content.list')).total, 0);
    await core.restart();
    assert.equal((await core.call('subscription.list'))[0].id, sub.id);
  });
});

test('unexpected sidecar exit rejects pending requests and allows explicit restart', async () => {
  await fixture(async core => {
    const pending = core.call('connection.check', {connection_id:'bilibili:default'});
    core.child.kill('SIGKILL');
    await assert.rejects(pending);
    await core.exited;
    assert.equal(core.ready, false);
    await core.restart();
    assert.equal((await core.call('content.list')).total, 0);
  });
});

test('malformed protocol input does not contaminate subsequent JSON Lines', async () => {
  await fixture(async core => {
    core.child.stdin.write('this is not json\n');
    assert.equal((await core.call('content.list')).total, 0);
  });
});
