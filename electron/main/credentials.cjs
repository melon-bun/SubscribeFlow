'use strict';
/**
 * M15 受保护密钥保管。
 *
 * 密钥与普通设置分开存放：普通配置在 SQLite（Core 管），密钥在这里，用系统
 * 保护能力（safeStorage）加密后写进应用数据目录，只有主进程能读。
 *
 * 三条不能破的边界：
 * 1. 保护能力不可用就拒绝保存，绝不退回明文落盘（Linux 的 basic_text 只算编码）。
 * 2. 任何返回值、日志、异常里都不出现明文密钥；引用无效直接抛错，不做模糊提示。
 * 3. 界面只能拿到「是否已配置」，拿不到密钥本身。
 */
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');

const REFERENCE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

class CredentialService {
  constructor({ dir, storage = safeStorage, platform = process.platform, now = () => new Date().toISOString() } = {}) {
    if (!dir) throw new Error('凭据服务需要应用数据目录');
    this.file = path.join(dir, 'credentials.json');
    this.storage = storage;
    this.platform = platform;
    this.now = now;
    this.cache = null;
  }

  /** 当前系统的保护能力。不满足就明确说清楚，绝不假装可以安全保存。 */
  protection() {
    let backend = null;
    try {
      if (typeof this.storage.getSelectedStorageBackend === 'function') {
        backend = this.storage.getSelectedStorageBackend() || null;
      }
    } catch {
      backend = null;
    }
    if (this.platform === 'linux' && backend === 'basic_text') {
      return {
        available: false,
        backend,
        reason: '当前系统没有可用的系统密钥环，basic_text 只是编码、不提供加密保护，密钥不会保存。',
      };
    }
    let available = false;
    try {
      available = !!this.storage.isEncryptionAvailable();
    } catch {
      available = false;
    }
    return available
      ? { available: true, backend, reason: null }
      : { available: false, backend, reason: '当前系统没有可用的加密保护能力，密钥不会保存。' };
  }

  async load() {
    if (this.cache) return this.cache;
    let entries = {};
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (raw && raw.version === 1 && raw.entries && typeof raw.entries === 'object') {
        for (const [reference, entry] of Object.entries(raw.entries)) {
          if (!REFERENCE.test(reference) || !entry || typeof entry.cipher !== 'string' || !entry.cipher) continue;
          entries[reference] = { cipher: entry.cipher, updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null };
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // 文件损坏时不覆盖它：先让上层看到「读不出来」，避免静默清空已保存的密钥。
        const failure = new Error('已保存的密钥无法读取，请重新输入并保存');
        failure.code = 'CREDENTIAL_STORE_UNREADABLE';
        throw failure;
      }
    }
    this.cache = { version: 1, entries };
    return this.cache;
  }

  async persist(store) {
    const payload = JSON.stringify({ version: 1, entries: store.entries });
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, payload, { mode: 0o600 });
    await fs.rename(temporary, this.file);
    this.cache = store;
  }

  /** 保存一个新引用版本的密钥。保护能力不可用时抛错，不写任何文件。 */
  async put(reference, secret) {
    if (!REFERENCE.test(String(reference || ''))) throw new Error('凭据引用无效');
    if (typeof secret !== 'string' || !secret || secret.length > 4000) throw new Error('密钥内容无效');
    const protection = this.protection();
    if (!protection.available) {
      const error = new Error(protection.reason);
      error.code = 'PROTECTION_UNAVAILABLE';
      throw error;
    }
    const store = await this.load();
    store.entries[reference] = { cipher: this.storage.encryptString(secret).toString('base64'), updatedAt: this.now() };
    await this.persist(store);
  }

  /** 只在主进程内部使用：取回明文。调用点只有模型调用前的凭据桥接。 */
  async get(reference) {
    const store = await this.load();
    const entry = store.entries[reference];
    if (!entry) return null;
    try {
      return this.storage.decryptString(Buffer.from(entry.cipher, 'base64'));
    } catch {
      return null; // 密钥库解锁失败或数据损坏：按「没有可用密钥」处理，不伪造可用。
    }
  }

  async remove(reference) {
    const store = await this.load();
    if (!(reference in store.entries)) return;
    delete store.entries[reference];
    await this.persist(store);
  }

  /** 删除不再被设置引用的版本，避免旧密钥无限堆积在磁盘上。 */
  async prune(keep) {
    const store = await this.load();
    const wanted = new Set([...(keep || [])].filter((reference) => REFERENCE.test(String(reference || ''))));
    let changed = false;
    for (const reference of Object.keys(store.entries)) {
      if (!wanted.has(reference)) {
        delete store.entries[reference];
        changed = true;
      }
    }
    if (changed) await this.persist(store);
  }

  /** 界面可见的状态：只有「配没配」，没有密钥，也没有任何可用于还原的片段。 */
  async status() {
    const store = await this.load();
    const protection = this.protection();
    const entries = [];
    for (const [reference, entry] of Object.entries(store.entries)) {
      entries.push({
        reference,
        updatedAt: entry.updatedAt,
        usable: protection.available && (await this.get(reference)) !== null,
      });
    }
    return { protection, entries };
  }

  references() {
    return this.load().then((store) => Object.keys(store.entries));
  }
}

module.exports = { CredentialService };
