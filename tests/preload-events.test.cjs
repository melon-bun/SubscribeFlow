const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('typed events and aliases share one IPC listener and unsubscribe independently', () => {
  const ipcRenderer = new EventEmitter();
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload/index.cjs'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return {ipcRenderer, contextBridge: {exposeInMainWorld: (_name, value) => {bridge = value;}}};
    },
  });
  const calls = [];
  const names = ['sync.changed','content.changed','subscription.changed','scheduler.changed','tags.changed','tagging.changed','content','run','channels','reminder.navigate','core.status'];
  const releases = names.map(name => bridge.on(name, data => calls.push([name, data])));
  assert.equal(ipcRenderer.listenerCount('subscribe-flow:event'), 1);
  ipcRenderer.emit('subscribe-flow:event', {}, 'scheduler.changed', {subscription_id:'source'});
  assert.deepEqual(calls, [['scheduler.changed', {subscription_id:'source'}]]);
  const second = bridge.on('scheduler.changed', data => calls.push(['second',data]));
  releases[3]();
  ipcRenderer.emit('subscribe-flow:event', {}, 'scheduler.changed', 2);
  assert.deepEqual(calls.at(-1), ['second',2]);
  second(); releases.forEach(release => release());
  const size = calls.length;
  names.forEach(name => ipcRenderer.emit('subscribe-flow:event', {}, name, null));
  assert.equal(calls.length, size);
  const fresh = bridge.on('scheduler.changed', data => calls.push(['fresh',data]));
  releases[3](); // Releasing an old subscription twice cannot remove a newer set.
  ipcRenderer.emit('subscribe-flow:event', {}, 'scheduler.changed', 3);
  assert.deepEqual(calls.at(-1), ['fresh',3]);
  fresh();
  assert.throws(() => bridge.on('arbitrary.event', () => {}), /事件订阅无效/);
});
