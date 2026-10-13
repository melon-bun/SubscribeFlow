'use strict';
/**
 * M15 设置与凭据桥接。
 *
 * 主进程在这里做两件 Renderer 和 Core 都不该单独承担的事：
 *
 * 1. 编排保存顺序——先把新密钥用系统保护能力加密存好，再把「引用」提交给 Core。
 *    提交失败就只清理这次刚写入、无人引用的版本，Core 仍指向的旧密钥原样保留，
 *    已提交后的清理/同步失败仅报告警告，不能回滚已生效的凭据。
 * 2. 保管密钥——主进程解密后只经私有桥推送到 Core 内存，普通设置只保存引用。
 *    Renderer 拿到的永远是「配没配」，不是密钥。
 */
const crypto = require('node:crypto');

const PROVIDERS = ['jev', 'llm'];

class SettingsBridge {
  constructor({ core, credentials }) {
    this.core = core;
    this.credentials = credentials;
    this.pushed = new Set();
    this.pending = Promise.resolve();
  }

  _enqueue(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  read() {
    return this._enqueue(async () => {
      const settings = await this.core.call('settings.get');
      return this._decorate(settings, await this._reconcile(settings));
    });
  }

  /** 合并 Core 的非敏感设置与主进程侧的密钥状态；引用不出现在给界面的结果里。 */
  async _decorate(settings, warnings = []) {
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
      warnings,
    };
  }

  write(params) {
    return this._enqueue(() => this._write(params));
  }

  async _write(params) {
    const { section, patch } = params;
    const secrets = params.credentials;
    if (secrets !== undefined && (secrets === null || typeof secrets !== 'object' || Array.isArray(secrets))) {
      throw new Error('密钥参数无效');
    }
    if (secrets && (Object.keys(secrets).some((mode) => !PROVIDERS.includes(mode)) || section !== 'tagging')) {
      throw new Error('当前分区不接受这些密钥参数');
    }
    const staged = [];
    const refs = {};
    let saved;
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
      saved = await this.core.call('settings.update', {
        section,
        patch,
        ...(Object.keys(refs).length ? { credential_refs: refs } : {}),
      });
    } catch (error) {
      // RPC 报错也可能已经提交（响应丢失）。只有重新读到权威引用后才允许清理。
      // Core 离线时保留加密孤儿，下一次读取/重启同步再清理，不能猜测提交是否成功。
      const current = await this.core.call('settings.get').catch(() => null);
      const referenced = current ? new Set(this._references(current)) : null;
      for (const reference of staged) {
        if (referenced && !referenced.has(reference)) await this.credentials.remove(reference).catch(() => {});
      }
      throw error;
    }
    // 提交边界之后不可再删除本次的新凭据。重试同步不需要用户重复输入密钥。
    return this._decorate(saved, await this._reconcile(saved));
  }

  async _reconcile(settings) {
    const warnings = [];
    try {
      await this._sync(settings);
    } catch {
      warnings.push('配置已保存，运行时密钥尚未同步。重新打开设置或重启核心服务后会重试。');
    }
    try {
      await this.credentials.prune(this._references(settings));
    } catch {
      warnings.push('配置已保存，旧密钥暂未清理。重新打开设置后会重试。');
    }
    return warnings;
  }

  _references(settings) {
    return PROVIDERS.map((mode) => settings.tagging.providers[mode].credentialRef).filter(Boolean);
  }

  /**
   * 把当前设置引用的密钥推进 Core 内存。Core 重启后内存是空的，
   * 因此每次 Core 重新就绪都要再推一次，否则运行时会认为「没有密钥」。
   */
  sync() {
    return this._enqueue(async () => {
      const current = await this.core.call('settings.get');
      return this._reconcile(current);
    });
  }

  async _sync(current) {
    const wanted = new Set();
    for (const mode of PROVIDERS) {
      const reference = current.tagging.providers[mode].credentialRef;
      if (!reference) continue;
      const secret = await this.credentials.get(reference);
      if (!secret) continue;
      wanted.add(reference);
      await this.core.call('credential.provide', { reference, secret });
      this.pushed.add(reference);
    }
    for (const reference of [...this.pushed]) {
      if (wanted.has(reference)) continue;
      await this.core.call('credential.revoke', { reference });
      this.pushed.delete(reference);
    }
  }
}

module.exports = { SettingsBridge, PROVIDERS };
