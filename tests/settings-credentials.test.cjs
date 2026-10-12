'use strict';
/**
 * 凭据服务与设置编排的行为测试。
 *
 * 这里的加密实现是替身，目的是在不依赖真实系统密钥环的机器上验证流程与边界：
 * 保护能力判定、不落明文、失败清理未引用版本、Core 重启后重新推送。
 * 真实 safeStorage 的行为另由实机验证记录在 docs/M15_SETTINGS.md。
 */
const test = require('node:test');
const assert = require('node:assert');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CredentialService } = require('../electron/main/credentials.cjs');
const { SettingsBridge } = require('../electron/main/settings-bridge.cjs');

/** 可逆的替身加密：证明「落盘的永远不是明文」，不代表真实保护强度。 */
function fakeStorage({ available = true, backend = 'test', broken = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer) => {
      if (broken) throw new Error('密钥库已解锁失败');
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('invalid blob');
      return text.slice(4);
    },
  };
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sf-credentials-'));
}

test('密钥以密文落盘，重启后可解密', async () => {
  const dir = await tempDir();
  const service = new CredentialService({ dir, storage: fakeStorage() });
  await service.put('jev-abc123', 'apikey_secret_value');
  const raw = await fs.readFile(path.join(dir, 'credentials.json'), 'utf8');
  assert.ok(!raw.includes('apikey_secret_value'), '密钥不得以明文出现在文件里');
  assert.match(raw, /"jev-abc123"/);
  assert.equal(await new CredentialService({ dir, storage: fakeStorage() }).get('jev-abc123'), 'apikey_secret_value');
});

test('保护能力不可用时拒绝保存，不产生任何文件', async () => {
  const dir = await tempDir();
  const service = new CredentialService({ dir, storage: fakeStorage({ available: false }) });
  await assert.rejects(() => service.put('jev-a', 'secret'), (error) => error.code === 'PROTECTION_UNAVAILABLE');
  await assert.rejects(() => fs.stat(path.join(dir, 'credentials.json')), (error) => error.code === 'ENOENT');
});

test('Linux basic_text 不算安全存储', () => {
  const service = new CredentialService({ dir: '/tmp', storage: fakeStorage({ available: true, backend: 'basic_text' }), platform: 'linux' });
  assert.equal(service.protection().available, false);
  const mac = new CredentialService({ dir: '/tmp', storage: fakeStorage({ available: true }), platform: 'darwin' });
  assert.equal(mac.protection().available, true);
});

test('状态只暴露是否可用，不含任何密钥片段', async () => {
  const dir = await tempDir();
  const service = new CredentialService({ dir, storage: fakeStorage() });
  await service.put('llm-xyz', 'sk-very-secret');
  const status = await service.status();
  assert.equal(status.entries.length, 1);
  assert.equal(status.entries[0].usable, true);
  assert.ok(!JSON.stringify(status).includes('very-secret'));
});

/** 记录 Main → Core 的调用，用于断言凭据桥接的顺序与内容。 */
function fakeCore(initial) {
  const calls = [];
  let settings = initial;
  return {
    calls,
    get settings() {
      return settings;
    },
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'settings.get') return settings;
      if (method === 'settings.update') {
        if (params.section === 'tagging') {
          settings = {
            ...settings,
            savedVersion: settings.version + 1,
            tagging: {
              ...settings.tagging,
              ...(params.patch || {}),
              providers: {
                jev: { ...settings.tagging.providers.jev, ...((params.patch || {}).providers || {}).jev,
                  ...(params.credential_refs && 'jev' in params.credential_refs ? { credentialRef: params.credential_refs.jev } : {}) },
                llm: { ...settings.tagging.providers.llm, ...((params.patch || {}).providers || {}).llm,
                  ...(params.credential_refs && 'llm' in params.credential_refs ? { credentialRef: params.credential_refs.llm } : {}) },
              },
            },
          };
        } else {
          settings = { ...settings, savedVersion: settings.version + 1, reminder: { ...settings.reminder, ...params.patch } };
        }
        return settings;
      }
      return null;
    },
  };
}

const BASE_SETTINGS = {
  version: 0,
  updatedAt: null,
  tagging: {
    enabled: false,
    mode: 'llm',
    enabledSince: null,
    providers: {
      jev: { endpoint: '', model: '', credentialRef: null, configured: false, missing: [], officialDefaults: null },
      llm: { endpoint: '', model: '', credentialRef: null, configured: false, missing: [], officialDefaults: null },
    },
  },
  reminder: { enabled: false, intervalMinutes: 60, preset: '60' },
};

test('保存密钥：先落密文再提交引用，并把密钥推进 Core', async () => {
  const dir = await tempDir();
  const credentials = new CredentialService({ dir, storage: fakeStorage() });
  const core = fakeCore(BASE_SETTINGS);
  const bridge = new SettingsBridge({ core, credentials });
  const saved = await bridge.write({
    section: 'tagging',
    patch: { enabled: false, mode: 'jev', providers: { jev: { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' } } },
    credentials: { jev: 'apikey_topsecret' },
  });
  const provide = core.calls.find((call) => call.method === 'credential.provide');
  assert.ok(provide, '保存后应向 Core 推送密钥');
  assert.equal(provide.params.secret, 'apikey_topsecret');
  const update = core.calls.find((call) => call.method === 'settings.update');
  assert.match(update.params.credential_refs.jev, /^jev-[0-9a-f]{24}$/);
  const raw = await fs.readFile(path.join(dir, 'credentials.json'), 'utf8');
  assert.ok(!raw.includes('apikey_topsecret'));
  // 界面只拿得到「配没配」，拿不到引用与密钥
  assert.equal(saved.credentials.providers.jev.configured, true);
  assert.equal(saved.credentials.providers.jev.usable, true);
  assert.ok(!JSON.stringify(saved).includes('apikey_topsecret'));
  assert.ok(!JSON.stringify(saved).includes(update.params.credential_refs.jev), '凭据引用不应进入界面');
});

test('提交失败：保留旧引用，只清理这次刚写入的版本', async () => {
  const dir = await tempDir();
  const credentials = new CredentialService({ dir, storage: fakeStorage() });
  const core = fakeCore(BASE_SETTINGS);
  const bridge = new SettingsBridge({ core, credentials });
  await bridge.write({ section: 'tagging', patch: { mode: 'jev' }, credentials: { jev: 'first_secret' } });
  const oldReference = core.settings.tagging.providers.jev.credentialRef;
  assert.ok(oldReference);

  core.call = async (method, params) => {
    if (method === 'settings.update') throw new Error('Core 拒绝保存');
    return null;
  };
  await assert.rejects(() => bridge.write({ section: 'tagging', patch: { mode: 'llm' }, credentials: { jev: 'second_secret' } }));
  assert.deepEqual(await credentials.references(), [oldReference], '未引用的新版本必须被清理');
  assert.equal(await credentials.get(oldReference), 'first_secret', '旧密钥必须还能取用');
});

test('Core 重启后按当前设置重新推送密钥，并撤销不再引用的版本', async () => {
  const dir = await tempDir();
  const credentials = new CredentialService({ dir, storage: fakeStorage() });
  const core = fakeCore(BASE_SETTINGS);
  const bridge = new SettingsBridge({ core, credentials });
  await bridge.write({ section: 'tagging', patch: { mode: 'jev' }, credentials: { jev: 'key_a' } });
  const referenceA = core.settings.tagging.providers.jev.credentialRef;
  await bridge.write({ section: 'tagging', patch: { mode: 'jev' }, credentials: { jev: 'key_b' } });
  const referenceB = core.settings.tagging.providers.jev.credentialRef;
  assert.notEqual(referenceA, referenceB);
  assert.deepEqual(await credentials.references(), [referenceB], '换密钥后旧版本应被裁剪');

  // 模拟 Core 重启：换成新的调用记录对象
  const restarted = fakeCore(core.settings);
  const revived = new SettingsBridge({ core: restarted, credentials });
  await revived.sync();
  const provide = restarted.calls.find((call) => call.method === 'credential.provide');
  assert.ok(provide, 'Core 就绪后必须重新推送');
  assert.equal(provide.params.reference, referenceB);
  assert.equal(provide.params.secret, 'key_b');

  // 清除 API Key 才是撤销推送的真实路径：切换模式不会丢掉另一种方式的密钥
  await revived.write({ section: 'tagging', patch: {}, credentials: { jev: null } });
  assert.ok(restarted.calls.some((call) => call.method === 'credential.revoke' && call.params.reference === referenceB));
  assert.deepEqual(await credentials.references(), [], '清除后磁盘上不应留下旧版本');
  const status = await revived.read();
  assert.equal(status.credentials.providers.jev.configured, false);
});

test('损坏的凭据文件不静默清空，报告为读不出来', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'credentials.json'), '{ this is not json', 'utf8');
  const service = new CredentialService({ dir, storage: fakeStorage() });
  await assert.rejects(() => service.status(), (error) => error.code === 'CREDENTIAL_STORE_UNREADABLE');
});

test('解不开的密钥按「没有可用密钥」处理，不伪装成可用', async () => {
  const dir = await tempDir();
  const writer = new CredentialService({ dir, storage: fakeStorage() });
  await writer.put('jev-a', 'value_a');
  const reader = new CredentialService({ dir, storage: fakeStorage({ broken: true }) });
  assert.equal(await reader.get('jev-a'), null);
  const status = await reader.status();
  assert.equal(status.entries[0].usable, false);
});
