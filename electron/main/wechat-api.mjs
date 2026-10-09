// Read-only WeChat Official Account article reader.
//
// The article body is server-rendered inside #js_content, so the page is
// fetched as data and parsed here. Nothing from the platform page is ever
// handed to a Renderer or executed as script, and this module only accepts
// declared official article URLs — it is not a general fetch/script entry.
//
// Blocked pages are classified by body evidence, never by HTTP status: a
// verification page and a full article both answer 200.
import {setTimeout as sleep} from 'node:timers/promises';

export class WechatError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}
const fail = (code, message, extra) => { throw new WechatError(code, message, extra); };

const HOST = 'mp.weixin.qq.com';
const ARTICLE_ID = /^[A-Za-z0-9+/_=-]{1,120}$/;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CACHE_TTL = 120000;
const CACHE_MAX = 8;
// The default Electron/curl agent is recognised by the platform: it receives a
// small verification page instead of the article. Verified 2026-10-09.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const RISK_MESSAGE = '微信要求人工验证，本次已停止采集且未保存任何内容。可能原因：出口 IP 被判为异常、User-Agent 被识别、请求过于频繁，或文章本身受限。可尝试更换网络或代理节点后重试，或稍后再试。';
const GENERIC_MESSAGE = '微信返回的不是文章正文页，本次已停止采集且未保存任何内容。可能是出口 IP 被判为异常、User-Agent 被识别、请求过于频繁或文章本身受限，可更换网络或稍后重试。';

/** Normalise an official article link; reject anything else. */
export function parseArticleURL(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2000 || /[\s\x00-\x1f]/.test(raw)) fail('INVALID_INPUT', '微信文章链接无效');
  let url;
  try { url = new URL(raw); } catch { fail('INVALID_INPUT', '微信文章链接无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== HOST || url.username || url.password ||
      (url.port && url.port !== (url.protocol === 'http:' ? '80' : '443'))) fail('INVALID_INPUT', '只接受 mp.weixin.qq.com 的官方文章链接');
  if (url.pathname === '/s') {
    const params = url.searchParams;
    if (!/^[A-Za-z0-9+/=_-]{4,64}$/.test(params.get('__biz') || '') || !/^\d{1,30}$/.test(params.get('mid') || '') ||
        !/^\d{1,30}$/.test(params.get('idx') || '')) fail('INVALID_INPUT', '微信文章参数式链接缺少 __biz、mid 或 idx');
    // 分享参数（scene/chksm/…）参与平台签名，不能在请求前删除。
    return {form: 'params', url};
  }
  const short = /^\/s\/([A-Za-z0-9_-]{16,64})\/?$/.exec(url.pathname);
  if (!short) fail('INVALID_INPUT', '微信公众号本期仅支持 /s/ 文章链接');
  return {form: 'short', url: new URL(`/s/${short[1]}`, `https://${HOST}/`)};
}

function scriptVar(html, name) {
  const match = new RegExp(`var\\s+${name}\\s*=\\s*([^;\\n]{0,300})`).exec(html);
  if (!match) return null;
  const literal = /"([^"]*)"|'([^']*)'/.exec(match[1]);
  if (!literal) return null;
  const value = literal[1] !== undefined ? literal[1] : literal[2];
  return value.trim() || null;
}

function metaContent(html, names) {
  for (const name of names) {
    const match = new RegExp(`<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]*>`).exec(html);
    if (!match) continue;
    const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/.exec(match[0]);
    if (content) {
      const value = (content[1] !== undefined ? content[1] : content[2]).trim();
      if (value) return value;
    }
  }
  return null;
}

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', hellip: '…', mdash: '—', ndash: '–'};
function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

const VOID_TAGS = new Set(['AREA','BASE','BR','COL','EMBED','HR','IMG','INPUT','LINK','META','PARAM','SOURCE','TRACK','WBR']);
const BLOCK_TAGS = new Set(['P','DIV','SECTION','ARTICLE','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','LI','TR','TD','BR','FIGURE','FIGCAPTION']);
const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG']);

/**
 * The #js_content region, from its opening tag to the matching close.
 * Depth counting keeps the article body free of the page's menus, counters and
 * recommended links that follow it.
 */
function contentRegion(html) {
  const open = /<div[^>]*\bid\s*=\s*["']js_content["'][^>]*>/i.exec(html);
  if (!open) return null;
  let depth = 1;
  let position = open.index + open[0].length;
  while (position < html.length) {
    const start = html.indexOf('<', position);
    if (start < 0) break;
    const end = html.indexOf('>', start);
    if (end < 0) break;
    const token = html.slice(start + 1, end);
    const name = /^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(token);
    if (name) {
      const tag = name[1].toUpperCase();
      if (token.startsWith('/')) {
        depth -= 1;
        if (depth === 0) return html.slice(open.index + open[0].length, start);
      } else if (!VOID_TAGS.has(tag) && !token.endsWith('/')) depth += 1;
    }
    position = end + 1;
  }
  return null;
}

/** Plain article text plus its inline images. No markup survives into the body. */
export function extractBody(html) {
  const region = contentRegion(html);
  if (region === null) return null;
  const images = [];
  let text = '';
  let position = 0;
  let skipUntil = 0;
  let skipTag = '';
  while (position < region.length) {
    const next = region.indexOf('<', position);
    if (next < 0) break;
    if (next > skipUntil) text += region.slice(position, next);
    const end = region.indexOf('>', next);
    if (end < 0) break;
    const token = region.slice(next + 1, end);
    const name = /^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(token);
    const tag = name ? name[1].toUpperCase() : '';
    const closing = token.startsWith('/');
    if (SKIP_TAGS.has(tag)) {
      if (closing && tag === skipTag) { skipUntil = 0; skipTag = ''; }
      else if (!closing) { skipTag = tag; skipUntil = end + 1; }
    } else if (!skipTag) {
      if (tag === 'IMG' && !closing) {
        const source = /\bdata-src\s*=\s*"([^"]*)"|\bdata-src\s*=\s*'([^']*)'|\bsrc\s*=\s*"([^"]*)"/.exec(token);
        const value = source && (source[1] || source[2] || source[3]);
        if (value && !images.includes(value)) images.push(value);
      }
      if (BLOCK_TAGS.has(tag)) text += '\n';
    }
    position = end + 1;
    if (position < skipUntil) position = skipUntil;
  }
  if (!skipTag && position < region.length) text += region.slice(position);
  const normalized = decodeEntities(text.replace(/[﻿]/g, ''))
    .split('\n')
    .map(line => line.replace(/[\t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return {text: normalized, images};
}

function imageUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return null;
  let url;
  try { url = new URL(value.startsWith('//') ? `https:${value}` : value); } catch { return null; }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const allowed = ['mmbiz.qpic.cn', 'wx.qlogo.cn', 'mmbiz.qlogo.cn'];
  if (!allowed.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
  return url.href;
}

/**
 * Page-confirmed identity. The article key is __biz + mid + idx so that both
 * link forms, and any share parameters, resolve to exactly one record while a
 * multi-article push still keeps every article apart.
 */
export function articleIdentity(html) {
  const biz = scriptVar(html, 'biz');
  const mid = scriptVar(html, 'mid');
  const idx = scriptVar(html, 'idx');
  if (!/^[A-Za-z0-9+/=_-]{4,64}$/.test(biz || '') || !/^\d{1,30}$/.test(mid || '') || !/^\d{1,30}$/.test(idx || '')) {
    fail('SCHEMA_CHANGED', '微信页面未提供可确认的稳定文章身份');
  }
  const account = /^[A-Za-z0-9+/=_-]{4,64}$/.test(biz) ? biz : scriptVar(html, 'user_name');
  const name = scriptVar(html, 'nickname');
  if (!account || !ARTICLE_ID.test(account) || !name) {
    fail('SCHEMA_CHANGED', '微信页面未提供可确认的公众号身份');
  }
  return {id: `${biz}_${mid}_${idx}`, account, name, byline: scriptVar(html, 'author') || null};
}

function publishedFrom(raw) {
  const seconds = Number(raw);
  // Never fall back to the current clock, a share label or the add time.
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds * 1000 > Date.now() + 86400000) {
    return {value: null, precision: 'unknown', provenance: 'unavailable', raw_label: null};
  }
  // WeChat publishes in China Standard Time, which has had no DST since 1991.
  const shifted = new Date(seconds * 1000 + 8 * 3600000).toISOString().slice(0, 19);
  return {value: `${shifted}+08:00`, precision: 'second', provenance: 'wechat-page:ct', raw_label: null};
}

/** A full article page, or the classified reason it is not one. */
export function parseArticle(html, requested) {
  const body = extractBody(html);
  if (!body || !body.text) {
    if (/该内容已被发布者删除|此内容因违规无法查看|该内容已被删除|此账号已被屏蔽|该内容已被投诉|该内容无法查看/.test(html)) {
      fail('NOT_FOUND', '该文章已被发布者删除、屏蔽或限制，无法读取');
    }
    if (/参数错误/.test(html)) {
      fail('NOT_FOUND', '微信返回「参数错误」，文章链接无效或文章不存在，请确认链接完整');
    }
    if (/环境异常|去验证|完成验证|安全验证/.test(html)) fail('INTERACTION_REQUIRED', RISK_MESSAGE);
    fail('ACCESS_FAILED', GENERIC_MESSAGE);
  }
  const identity = articleIdentity(html);
  const canonical = scriptVar(html, 'msg_link');
  let url = requested;
  if (canonical) {
    try { const parsed = parseArticleURL(canonical); url = parsed.form === 'short' ? parsed.url : requested; } catch { /* keep the requested official URL */ }
  }
  const avatar = imageUrl(scriptVar(html, 'round_head_img'));
  return {
    id: identity.id,
    url: url.href,
    title: scriptVar(html, 'msg_title') || metaContent(html, ['og:title', 'twitter:title']) || '',
    content: body.text,
    images: body.images.slice(0, 50).map(imageUrl).filter(Boolean),
    cover: [scriptVar(html, 'msg_cdn_url'), avatar].map(imageUrl).filter(Boolean),
    account: {id: identity.account, name: identity.name, url: url.href, avatar: avatar || ''},
    published: publishedFrom(scriptVar(html, 'ct') || scriptVar(html, 'create_time')),
    acquisition_complete: true,
  };
}

export function validateRequest(p) {
  const fields = {resolve: ['channel', 'operation', 'url'], read: ['channel', 'operation', 'url', 'id']};
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.channel !== 'wechat' || !fields[p.operation] ||
      Object.keys(p).some(key => !fields[p.operation].includes(key))) fail('INVALID_INPUT', '微信请求无效');
  const link = parseArticleURL(p.url);
  if (p.operation === 'read' && !ARTICLE_ID.test(p.id || '')) fail('INVALID_INPUT', '微信文章稳定身份无效');
  return link;
}

export class WechatAPI {
  constructor({fetch}, {readTimeout = 25000, minGap = 1200} = {}) {
    this.fetch = fetch;
    this.readTimeout = readTimeout;
    this.minGap = minGap;
    this.lastRequest = 0;
    this.recent = new Map();
  }
  async bounded(promise, signal, ms = this.readTimeout) {
    signal?.throwIfAborted();
    let timer, abort;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new WechatError('TIMEOUT', '微信文章读取超时，本次已停止且未保存内容')), ms);
        abort = () => reject(new WechatError('CANCELLED', '采集已取消'));
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) abort();
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async download(url, signal) {
    if (!this.fetch) fail('DEPENDENCY_UNAVAILABLE', '微信应用内会话不可用，请从桌面应用打开此渠道连接');
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // 识别间隔：连续密集请求本身就会触发验证页。
      await sleep(Math.max(0, this.minGap - (Date.now() - this.lastRequest)), undefined, {signal});
      this.lastRequest = Date.now();
      let response;
      try {
        response = await this.bounded(this.fetch(current.href, {
          signal, credentials: 'omit', redirect: 'manual', headers: {
            'User-Agent': USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        }), signal);
      } catch (error) {
        if (error instanceof WechatError || signal?.aborted) throw error;
        fail('ACCESS_FAILED', '微信文章读取失败，请稍后重试');
      }
      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers.get('location');
        if (!location) fail('ACCESS_FAILED', '微信返回了无法跟进的跳转，已停止采集');
        let next;
        try { next = new URL(location, current); } catch { fail('INVALID_INPUT', '微信文章跳转地址无效，已停止采集'); }
        if (next.protocol !== 'https:' || next.hostname !== HOST) fail('INVALID_INPUT', '微信文章跳转到了非官方地址，已停止采集');
        if (/captcha|verify|wappoc/i.test(`${next.pathname}${next.search}`)) fail('INTERACTION_REQUIRED', RISK_MESSAGE);
        current = next;
        continue;
      }
      // 403 with an empty body is how the platform answers a blocked source IP;
      // it is the same answer for the site root and for unknown article IDs.
      if (status === 403) fail('INTERACTION_REQUIRED', RISK_MESSAGE);
      if (status === 404) fail('NOT_FOUND', '文章不存在或已无法访问');
      if (status === 429) fail('RATE_LIMITED', '微信访问过于频繁，请稍后重试');
      if (!response.ok) fail('ACCESS_FAILED', '微信读取失败，请稍后重试');
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX_BYTES) fail('SCHEMA_CHANGED', '微信页面超出读取上限，本次未读取也未保存截断结果');
      let html;
      try { html = await this.bounded(response.text(), signal); } catch (error) {
        if (error instanceof WechatError || signal?.aborted) throw error;
        fail('ACCESS_FAILED', '微信文章正文读取失败，请稍后重试');
      }
      if (Buffer.byteLength(html, 'utf8') > MAX_BYTES) fail('SCHEMA_CHANGED', '微信页面超出读取上限，本次未读取也未保存截断结果');
      return {html, url: current};
    }
    fail('ACCESS_FAILED', '微信文章跳转次数过多，已停止采集');
  }
  remember(row) {
    this.recent.delete(row.id);
    this.recent.set(row.id, {at: Date.now(), row});
    while (this.recent.size > CACHE_MAX) this.recent.delete(this.recent.keys().next().value);
  }
  async article(url, signal) {
    const {html, url: finalUrl} = await this.download(url, signal);
    const row = parseArticle(html, finalUrl);
    this.remember(row);
    return row;
  }
  async request(p, signal) {
    const link = validateRequest(p);
    if (p.operation === 'read') {
      // resolve_item already read this exact page for this preview; reuse it
      // instead of asking the platform for the same article twice.
      const cached = this.recent.get(p.id);
      if (cached && Date.now() - cached.at < CACHE_TTL && cached.row.id === p.id) return {article: cached.row};
      const row = await this.article(link.url, signal);
      // The page must still be the article the caller asked for. A mismatch is
      // refused here rather than quietly returned for Core to mismatch later.
      if (row.id !== p.id) fail('SCHEMA_CHANGED', '读取到的文章与预览身份不一致');
      return {article: row};
    }
    return {article: await this.article(link.url, signal)};
  }
  reset() { this.recent.clear(); }
}