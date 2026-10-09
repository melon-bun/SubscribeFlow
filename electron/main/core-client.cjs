const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {coreLaunch, startupHint} = require('./runtime.cjs');

class CoreClient extends EventEmitter {
  constructor({ python, node, coreExecutable, root, dataDir, acquisition, schedulePolicy, autoRestart = false, restartDelays = [5000,15000,45000], timeout = 75000 }) {
    super();
    Object.assign(this, { python, node, coreExecutable, root, dataDir, acquisition, schedulePolicy, autoRestart, restartDelays, timeout });
    this.acquiring = new Map();
    this.pending = new Map();
    this.nextId = 1;
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.stopping = false;
    this.restartAttempts = 0;
  }

  async start() {
    this.stopping = false;
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this._start();
    try { await this.starting; }
    finally { this.starting = null; }
  }

  async _start() {
    const launch = coreLaunch(this);
    const child = spawn(launch.executable, launch.args, launch.options);
    let stderr = '', failureHint = null;
    this.child = child;
    this.exited = new Promise(resolve => child.once('close', resolve));
    this.emit('status', { state: 'starting' });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) {
        this._fail(new Error('Core 输出超过大小限制'));
        child.kill('SIGTERM');
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try { this._message(JSON.parse(line)); }
        catch { this._fail(new Error('Core 返回了无效协议数据')); child.kill('SIGTERM'); }
      }
    });
    // Keep a bounded in-memory buffer solely to recognize fixed startup hints.
    // Raw Python/OS errors can contain paths and are never forwarded or persisted.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); failureHint = startupHint(stderr); });
    child.stdin.on('error', () => this._fail(new Error('Core 通信已断开')));
    child.on('error', () => this._fail(new Error(this.coreExecutable ? '无法启动内置核心服务，请重新解压完整应用。' : '无法启动 Python Core，请检查配置路径')));
    child.on('close', code => {
      if (this.child !== child) return;
      this.child = null;
      this._fail(new Error(failureHint || `Core 已退出（${code ?? 'signal'}）`));
      this.emit('status', { state: 'stopped', code, ...(failureHint ? {message: failureHint} : {}) });
      clearTimeout(this.stableTimer);
      this._scheduleRestart();
    });
    try {
      const hello = await this._request('core.hello', { protocol_version: '1.0' }, 15000);
      if (hello.protocol_version !== '1.0') throw new Error('Core 协议版本不兼容');
      this.ready = true;
      this.emit('status', { state: 'ready', version: hello.core_version });
      this.stableTimer = setTimeout(() => { this.restartAttempts = 0; }, 60000);
      this.stableTimer.unref();
    } catch (error) {
      child.kill('SIGTERM');
      await this.exited;
      throw error;
    }
  }

  _message(message) {
    if (!message || message.jsonrpc !== '2.0') throw new Error('Invalid protocol');
    if (message.method === 'acquisition.request' && typeof message.id === 'string' && /^browser:\d+$/.test(message.id)) {
      if (this.acquiring.size >= 32 || this.acquiring.has(message.id)) throw new Error('Invalid acquisition request');
      void this._acquire(message); return;
    }
    if (message.method === 'acquisition.cancel' && !('id' in message)) {
      this.acquiring.get(message.params?.id)?.abort(); return;
    }
    if ('id' in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'Core 请求失败');
        error.data = message.error.data;
        error.code = message.error.data?.code || message.error.code;
        pending.reject(error);
      } else if ('result' in message) pending.resolve(message.result);
      else pending.reject(new Error('Invalid RPC response'));
    } else if (typeof message.method === 'string') {
      this.emit('notification', message.method, message.params);
    }
  }

  async _acquire(message) {
    const child = this.child;
    const controller = new AbortController(); this.acquiring.set(message.id,controller);
    let response;
    try {
      if (!this.acquisition) { const error = new Error('请从桌面应用打开此渠道连接'); error.code = 'DEPENDENCY_UNAVAILABLE'; throw error; }
      response = {result:await this.acquisition(message.params,controller.signal)};
      if (Buffer.byteLength(JSON.stringify(response)) > 3 * 1024 * 1024) throw new Error('Oversized acquisition response');
    } catch (error) {
      // Channel codes the user can act on must survive the hop. A NOT_FOUND from
      // a platform ("this article was deleted") must not arrive as an anonymous
      // "采集失败" that reads like a bug.
      const known = ['INVALID_INPUT','DEPENDENCY_UNAVAILABLE','AUTH_REQUIRED','INTERACTION_REQUIRED','RATE_LIMITED','SCHEMA_CHANGED','ACCESS_FAILED','NOT_FOUND','UNSUPPORTED_OPERATION','TIMEOUT','CANCELLED'].includes(error.code);
      response = {error:{code:-32000,message:known ? error.message : '应用内采集失败',data:{code:known ? error.code : 'ACCESS_FAILED',retryable:known && !!error.retryable,retry_after:error.retryAfter ?? null}}};
    } finally { if (this.acquiring.get(message.id) === controller) this.acquiring.delete(message.id); }
    if (this.child === child && child && !child.killed && !child.stdin.destroyed) child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:message.id,...response}) + '\n');
  }

  _request(method, params, timeout = this.timeout) {
    if (!this.child || this.child.killed) return Promise.reject(new Error('Core 当前未连接'));
    if (this.pending.size >= 32) return Promise.reject(new Error('请求过多，请稍后重试'));
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (Buffer.byteLength(line) > 65536) return Promise.reject(new Error('请求内容超过 64 KiB'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Core 请求超时，请重新查询状态')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(line, error => {
        if (error && this.pending.has(id)) {
          clearTimeout(timer); this.pending.delete(id); reject(new Error('Core 通信已断开'));
        }
      });
    });
  }

  call(method, params = {}) {
    if (!this.ready) return Promise.reject(new Error('Core 未就绪，请检查状态或重启'));
    return this._request(method, params);
  }

  _fail(error) {
    this.ready = false;
    for (const controller of this.acquiring.values()) controller.abort();
    this.acquiring.clear();
    for (const { timer, reject } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.stableTimer);
    const child = this.child;
    if (!child) return;
    try { if (this.ready) await this._request('core.shutdown', {}, 3000); }
    catch { child.kill('SIGTERM'); }
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await this.exited;
    clearTimeout(killTimer);
    this.ready = false;
  }

  async restart() {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => { await this.stop(); await this.start(); return { state: 'ready' }; })();
    try { return await this.restarting; }
    finally { this.restarting = null; }
  }

  _scheduleRestart() {
    if (!this.autoRestart || this.stopping || this.restartAttempts >= this.restartDelays.length) return;
    const delay = this.restartDelays[this.restartAttempts++];
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (!this.stopping) this.start().catch(() => {}); // close schedules the next bounded attempt.
    }, delay);
    this.restartTimer.unref();
  }
}

module.exports = { CoreClient };
