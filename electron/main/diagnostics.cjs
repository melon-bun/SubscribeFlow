const fs = require('node:fs');
const path = require('node:path');

// Only allowlisted lifecycle fields are written. Never log RPC payloads, raw stderr,
// URLs, titles, account identifiers, cookies, request headers or user paths.
const DIAGNOSTIC_EVENTS = ['app.start', 'app.quit', 'app.error', 'core.status', 'app.startup.failed', 'app.quit.failed'];
const SAFE_FIELDS = ['version', 'electron', 'platform', 'arch', 'state'];
// 启动失败需要留下可定位的信息，但只放脱敏后的文本字段，且有长度上限。
const FAILURE_FIELDS = ['phase', 'kind', 'code', 'name', 'message', 'stack'];

/** 与 startup-errors 的脱敏口径保持一致，诊断文件里不得出现密钥或请求头。 */
function redact(value) {
  return String(value || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|secret|password)[\s:=]+\S+/gi, '$1=[redacted]')
    .slice(0, 800);
}

function diagnosticRecord(event, data = {}) {
  const result = {time: new Date().toISOString(), event};
  // 未知事件一律不记录：这是白名单，不是"记什么都可以"。
  if (!DIAGNOSTIC_EVENTS.includes(event)) return null;
  for (const field of SAFE_FIELDS) {
    if (typeof data[field] === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(data[field])) result[field] = data[field];
  }
  if (typeof data.packaged === 'boolean') result.packaged = data.packaged;
  if (Number.isInteger(data.code)) result.code = data.code;
  if (event === 'app.startup.failed' || event === 'app.quit.failed') {
    // 失败原因与阶段是定位问题的最小必要信息；其余字段一律丢弃。
    for (const field of FAILURE_FIELDS) {
      if (field === 'code') {
        if (typeof data.code === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(data.code)) result.code = data.code;
        else if (Number.isInteger(data.code)) result.code = data.code;
        continue;
      }
      if (typeof data[field] === 'string' && data[field]) result[field] = redact(data[field]);
    }
    if (!result.kind && typeof data.kind === 'string' && /^[a-z_]{1,32}$/.test(data.kind)) result.kind = data.kind;
  }
  return result;
}

function createDiagnostics(dataDir) {
  const directory = path.join(dataDir, 'diagnostics');
  const file = path.join(directory, 'lifecycle.jsonl');
  return (event, data) => {
    const record = diagnosticRecord(event, data);
    if (!record) return;
    try {
      fs.mkdirSync(directory, {recursive: true, mode: 0o700});
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.previous');
      fs.appendFileSync(file, JSON.stringify(record) + '\n', {mode: 0o600});
    } catch { /* Diagnostic failure must not interrupt local reading. */ }
  };
}
module.exports = {diagnosticRecord, createDiagnostics};
