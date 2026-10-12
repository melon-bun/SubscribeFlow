'use strict';
/**
 * M15 设置与凭据桥接。
 *
 * 主进程在这里做两件 Renderer 和 Core 都不该单独承担的事：
 *
 * 1. 编排保存顺序——先把新密钥用系统保护能力加密存好，再把「引用」提交给 Core。
 *    提交失败就只清理这次刚写入、无人引用的版本，Core 仍指向的旧密钥原样保留，
 *    不会出现「页面显示已保存、实际运行还是旧配置」的状态。
 * 2. 保管密钥——密钥只存在主进程，取用只发生在向 Core 推送的那一次调用里。
 *    Renderer 拿到的永远是「配没配」，不是密钥。
 */
const crypto = require('node:crypto');

const PROVIDERS = ['jev', 'llm'];

class SettingsBridge {
  constructor({ core, credentials }) {
    this.core = core;
    this.credentials = credentials;
    this.pushed = new Set();
  }

  async read() {
    return this._decorate(await this.core.call('settings.get'));
  }

  /** 合并 Core 的非敏感设置与主进程侧的密钥状态；引用不出现在给界面的结果里。 */
  async _decorate(settings) {
    const { protection, entries } = await this.credentials.status();
    const known = new Map(entries.map((entry) => [entry.reference, entry]));
    const providers = {};
    for (const mode of PROVIDERS) {
      const reference = settings.tagging.providers[mode].credentialRef;
      const entry = reference ? known.get(reference) : null;
      providers[mode] = {
        configured: !!entry,
        // 保存成功但解不开（例如换了系统账户）：必须显示为不可用，不能当成已配置。
        usable: !!(entry && entry.usable),
        updatedAt: entry ? entry.updatedAt : null,
        // 设置指向的版本在磁盘上找不到：配置与密钥对不上，需要用户重新输入。
        unresolved: !!reference && !entry,
      };
    }
    const tagging = {
      enabled: settings.tagging.enabled,
      mode: settings.tagging.mode,
      enabledSince: settings.tagging.enabledSince,
      providers: Object.fromEntries(
        PROVIDERS.map((mode) => {
          // 引用不进界面：它只是主进程与凭据文件之间的内部句柄。
          const { credentialRef, ...visible } = settings.tagging.providers[mode];
          return [mode, visible];
        })
      ),
    };
    return {
      version: settings.version,
      savedVersion: settings.savedVersion,
      updatedAt: settings.updatedAt,
      tagging,
      reminder: settings.reminder,
      credentials: { protection, providers },
    };
  }

  async write(params) {
    const { section, patch } = params;
    const secrets = params.credentials;
    if (secrets !== undefined && (secrets === null || typeof secrets !== 'object' || Array.isArray(secrets))) {
      throw new Error('密钥参数无效');
    }
    const staged = [];
    const refs = {};
    try {
      for (const mode of PROVIDERS) {
        const value = secrets ? secrets[mode] : undefined;
        if (value === undefined) continue; // 没提交新密钥：沿用已有引用
        if (value === null || value === '') {
          refs[mode] = null; // 明确清除该方式的密钥
          continue;
        }
        const reference = `${mode}-${crypto.randomBytes(12).toString('hex')}`;
        await this.credentials.put(reference, value);
        staged.push(reference);
        refs[mode] = reference;
      }
      const saved = await this.core.call('settings.update', {
        section,
        patch,
        ...(Object.keys(refs).length ? { credential_refs: refs } : {}),
      });
      // 提交成功后才裁剪：此时新引用一定已被设置指向，删掉的只有真正的孤儿版本。
      await this.credentials.prune(this._references(saved));
      await this.sync(saved);
      return this._decorate(saved);
    } catch (error) {
      for (const reference of staged) {
        await this.credentials.remove(reference).catch(() => {});
      }
      throw error;
    }
  }

  _references(settings) {
    return PROVIDERS.map((mode) => settings.tagging.providers[mode].credentialRef).filter(Boolean);
  }

  /**
   * 把当前设置引用的密钥推进 Core 内存。Core 重启后内存是空的，
   * 因此每次 Core 重新就绪都要再推一次，否则运行时会认为「没有密钥」。
   */
  async sync(settings) {
    let current = settings;
    if (!current) current = await this.core.call('settings.get').catch(() => null);
    if (!current) return;
    const wanted = new Set(this._references(current));
    for (const mode of PROVIDERS) {
      const reference = current.tagging.providers[mode].credentialRef;
      if (!reference) continue;
      const secret = await this.credentials.get(reference);
      if (!secret) continue;
      await this.core.call('credential.provide', { reference, secret });
      this.pushed.add(reference);
    }
    for (const reference of [...this.pushed]) {
      if (wanted.has(reference)) continue;
      await this.core.call('credential.revoke', { reference }).catch(() => {});
      this.pushed.delete(reference);
    }
  }
}

module.exports = { SettingsBridge, PROVIDERS };
