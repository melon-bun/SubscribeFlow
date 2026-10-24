const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {CORE_METHODS} = require('../electron/main/methods.cjs');

test('AI connection tests pass through the actual Renderer and restricted preload', async () => {
  const calls = [];
  let bridge;
  const electron = {
    contextBridge: {exposeInMainWorld(_name, value) { bridge = value; }},
    ipcRenderer: {
      on() {},
      async invoke(channel, name, params) {
        assert.equal(channel, 'subscribe-flow:call');
        assert.ok(CORE_METHODS.has(name), 'Main must accept the same AI method');
        calls.push([name, JSON.parse(JSON.stringify(params))]);
        return {ok: true, value: name === 'ai.provider.list' ? [] : {ok: true, model: 'test-model'}};
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload/index.cjs'), 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return electron; },
  });
  const window = {SubscribeFlow: bridge};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/renderer/scripts/core/app-client.js'), 'utf8'), {window});
  const client = window.SF.AppClient.createClient({mode: 'real'}).client;

  assert.equal((await client.testAiProvider('provider-llm')).ok, true);
  assert.deepEqual(await client.listAiProviders(), []);
  assert.deepEqual(calls, [
    ['ai.provider.test', {provider_id: 'provider-llm'}],
    ['ai.provider.list', {}],
  ]);
  assert.equal((await bridge.request('settings.update', {})).error.code, 'FORBIDDEN_METHOD');
  assert.equal((await bridge.request('arbitrary.method', {})).error.code, 'FORBIDDEN_METHOD');
  assert.equal(calls.length, 2, 'unapproved calls must stop before IPC');
});
