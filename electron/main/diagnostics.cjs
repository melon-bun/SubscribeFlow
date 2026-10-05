const fs = require('node:fs');
const path = require('node:path');

// Only allowlisted lifecycle fields are written. Never log RPC payloads, raw stderr,
// URLs, titles, account identifiers, cookies, request headers or user paths.
function diagnosticRecord(event, data = {}) {
  const result = {time: new Date().toISOString(), event};
  if (!['app.start', 'app.quit', 'app.error', 'core.status'].includes(event)) return null;
  for (const field of ['version', 'electron', 'platform', 'arch', 'state']) {
    if (typeof data[field] === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(data[field])) result[field] = data[field];
  }
  if (typeof data.packaged === 'boolean') result.packaged = data.packaged;
  if (Number.isInteger(data.code)) result.code = data.code;
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
