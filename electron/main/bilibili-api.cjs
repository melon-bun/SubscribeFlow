const {createHash} = require('node:crypto');

const API = 'https://api.bilibili.com';
// WBI's public permutation, used by Bilibili's web client.
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
class AcquisitionError extends Error {
  constructor(code, message, retryable = false, retryAfter = null) {
    super(message); Object.assign(this, {code, retryable, retryAfter});
  }
}
function validateRequest(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new AcquisitionError('INVALID_INPUT', '采集参数无效');
  const fields = {check: [], list: ['uid','page','limit'], search: ['query','limit'], detail: ['bvid']}[p.operation];
  if (!fields || Object.keys(p).some(k => !['operation', ...fields].includes(k)) || fields.some(k => !(k in p))) throw new AcquisitionError('INVALID_INPUT', '采集操作或参数无效');
  if (p.operation === 'list' && (typeof p.uid !== 'string' || !/^[1-9]\d{0,19}$/.test(p.uid) || !Number.isInteger(p.page) || p.page < 1 || p.page > 100000)) throw new AcquisitionError('INVALID_INPUT', '作者或页码无效');
  if ('limit' in p && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 50)) throw new AcquisitionError('INVALID_INPUT', '采集页大小无效');
  if (p.operation === 'search' && (typeof p.query !== 'string' || !p.query.trim() || p.query.length > 200)) throw new AcquisitionError('INVALID_INPUT', '搜索词无效');
  if (p.operation === 'detail' && (typeof p.bvid !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(p.bvid))) throw new AcquisitionError('INVALID_INPUT', '视频编号无效');
  return p;
}
function signedQuery(params, nav, now = Date.now()) {
  const urls = nav?.data?.wbi_img;
  const keys = [urls?.img_url, urls?.sub_url].map(value => typeof value === 'string' ? value.split('/').pop().split('.')[0] : '');
  if (keys.some(k => !/^[a-f0-9]{32}$/i.test(k))) throw new AcquisitionError(nav?.code === -101 ? 'AUTH_REQUIRED' : 'SCHEMA_CHANGED', '无法获取 B站请求签名，请检查应用内登录状态');
  const raw = keys.join(''), salt = MIXIN.map(i => raw[i]).join('').slice(0,32);
  const values = {...params, wts: Math.floor(now / 1000)};
  const query = Object.keys(values).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]).replace(/[!'()*]/g,''))}`).join('&');
  return `${query}&w_rid=${createHash('md5').update(query + salt).digest('hex')}`;
}
async function readJSON(response) {
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) throw new AcquisitionError('RATE_LIMITED', 'B站请求过于频繁，请稍后重试', true, 300);
    if ([401,403,412].includes(response.status)) throw new AcquisitionError('INTERACTION_REQUIRED', 'B站要求访问验证，请打开应用内登录窗口检查');
    if (response.status >= 500) throw new AcquisitionError('ACCESS_FAILED', 'B站暂时不可用，请稍后重试', true);
    throw new AcquisitionError('ACCESS_FAILED', `B站请求失败（HTTP ${response.status}）`);
  }
  if (!response.body) throw new AcquisitionError('SCHEMA_CHANGED', 'B站返回了空响应');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new AcquisitionError('SCHEMA_CHANGED', 'B站响应超过大小限制');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AcquisitionError('SCHEMA_CHANGED', 'B站未返回有效数据；请检查应用内页面是否需要验证'); }
}

class BilibiliAPI {
  constructor(fetch) { this.fetch = fetch; }
  async request(input, signal) {
    const p = validateRequest(input);
    const get = async (pathname, query = '') => {
      signal.throwIfAborted();
      try {
        return await readJSON(await this.fetch(API + pathname + (query ? '?' + query : ''), {
          method:'GET', credentials:'include', redirect:'error', signal,
          headers:{Referer:'https://www.bilibili.com/', Accept:'application/json'},
        }));
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof AcquisitionError) throw error;
        throw new AcquisitionError('ACCESS_FAILED', '应用内 B站网络连接失败，请稍后重试', true);
      }
    };
    if (p.operation === 'detail') return get('/x/web-interface/view', new URLSearchParams({bvid:p.bvid}).toString());
    const nav = await get('/x/web-interface/nav');
    if (p.operation === 'check') {
      if (!nav || !Number.isInteger(nav.code) || ![0,-101].includes(nav.code) || (nav.code === 0 && typeof nav.data?.isLogin !== 'boolean')) return {code:nav?.code ?? null, data:null};
      // No account identity or raw nav response crosses the Core boundary.
      return {code:0, data:{authenticated:nav.code === 0 && nav.data.isLogin === true}};
    }
    if (!nav || ![0,-101].includes(nav.code)) return nav;
    const params = p.operation === 'list' ? {mid:p.uid,pn:p.page,ps:p.limit,order:'pubdate'} : {search_type:'bili_user',keyword:p.query.trim(),page:1};
    return get(p.operation === 'list' ? '/x/space/wbi/arc/search' : '/x/web-interface/wbi/search/type', signedQuery(params,nav));
  }
}
module.exports = {BilibiliAPI, AcquisitionError, validateRequest, signedQuery, readJSON};
