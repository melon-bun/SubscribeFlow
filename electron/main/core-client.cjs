const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');

class CoreClient extends EventEmitter {
  constructor({ python, opencli, node, root, dataDir, timeout = 75000 }) {
    super();
    Object.assign(this, { python, opencli, node, root, dataDir, timeout });
    this.pending = new Map();
    this.nextId = 1;
    this.child = null;
    this.ready = false;
    this.starting = null;
  }

  async start() {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this._start();
    try { await this.starting; }
    finally { this.starting = null; }
  }

  async _start() {
    if (!path.isAbsolute(this.python || '')) throw new Error('请运行 npm run configure 配置 Python 路径');
    const args = ['-u', '-m', 'subscribe_flow', '--data-dir', this.dataDir, '--opencli', this.opencli || '/missing/opencli'];
    const env = { ...process.env, PYTHONPATH: path.join(this.root, 'python', 'src'), PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' };
    if (this.node) env.PATH = path.dirname(this.node) + path.delimiter + '/usr/bin:/bin:/usr/sbin:/sbin';
    const child = spawn(this.python, args, { env, cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    // Raw diagnostics stay out of Renderer. Python already redacts tool errors.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.stdin.on('error', () => this._fail(new Error('Core 通信已断开')));
    child.on('error', () => this._fail(new Error('无法启动 Python Core，请检查配置路径')));
    child.on('close', code => {
      if (this.child !== child) return;
      this.child = null;
      this._fail(new Error(`Core 已退出（${code ?? 'signal'}）`));
      this.emit('status', { state: 'stopped', code });
    });
    try {
      const hello = await this._request('core.hello', { protocol_version: '1.0' }, 15000);
      if (hello.protocol_version !== '1.0') throw new Error('Core 协议版本不兼容');
      this.ready = true;
      this.emit('status', { state: 'ready', version: hello.core_version });
    } catch (error) {
      child.kill('SIGTERM');
      await this.exited;
      throw error;
    }
  }

  _message(message) {
    if (!message || message.jsonrpc !== '2.0') throw new Error('Invalid protocol');
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
    for (const { timer, reject } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }

  async stop() {
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
}

module.exports = { CoreClient };
