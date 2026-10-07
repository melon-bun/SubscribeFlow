import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {scriptFor} from './xiaohongshu-page.mjs';
import {publicationRange} from './xiaohongshu-time.mjs';

export class XHSError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const ID = /^[a-f0-9]{24}$/;
export function trustedURL(value, kind = 'page') {
  let u; try { u = new URL(value); } catch { throw new XHSError('INVALID_INPUT', '小红书地址无效'); }
  if (u.protocol !== 'https:' || u.hostname !== 'www.xiaohongshu.com' || u.username || u.password || u.port || value.length > 4096)
    throw new XHSError('INVALID_INPUT', '只允许小红书官方 HTTPS 页面');
  if (kind === 'note' && !/^\/(explore|search_result)\/[a-f0-9]{24}\/?$/.test(u.pathname) && !/^\/user\/profile\/[a-f0-9]{24}\/[a-f0-9]{24}\/?$/.test(u.pathname))
    throw new XHSError('INVALID_INPUT', '笔记地址无效');
  return u.href;
}
export function validateRequest(p) {
  const fields = {check:['channel','operation'], search:['channel','operation','query','limit'],
    scan:['channel','operation','uid','job_id','cursor','limit','mode','known_ids'], detail:['channel','operation','uid','id']};
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.channel !== 'xiaohongshu' || !fields[p.operation] || Object.keys(p).some(k => !fields[p.operation].includes(k)))
    throw new XHSError('INVALID_INPUT', '小红书请求无效');
  if ('uid' in p && !ID.test(p.uid)) throw new XHSError('INVALID_INPUT', '作者 ID 无效');
  if ('id' in p && !ID.test(p.id)) throw new XHSError('INVALID_INPUT', '笔记 ID 无效');
  if ('limit' in p && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 50)) throw new XHSError('INVALID_INPUT', '读取条数需为 1 到 50');
  if (p.operation === 'search' && (typeof p.query !== 'string' || !p.query.trim() || p.query.length > 100 || !Number.isInteger(p.limit))) throw new XHSError('INVALID_INPUT', '请输入 1 到 100 字的昵称和有效候选条数');
  if (p.operation === 'detail' && (!ID.test(p.uid) || !ID.test(p.id))) throw new XHSError('INVALID_INPUT', '详情需要作者和笔记 ID');
  if (p.operation === 'scan' && (!ID.test(p.uid) || !/^[a-f0-9]{32}$/.test(p.job_id) || !['initial','refresh','backfill'].includes(p.mode) || !Number.isInteger(p.limit)))
    throw new XHSError('INVALID_INPUT', '扫描请求无效');
  if (p.cursor != null && (typeof p.cursor !== 'string' || !/^[a-f0-9-]{36}:\d{1,3}$/.test(p.cursor))) throw new XHSError('INVALID_INPUT', '扫描位置无效，请重新刷新');
  if (p.known_ids != null && (!Array.isArray(p.known_ids) || p.known_ids.length > 2000 || p.known_ids.some(id => !ID.test(id)))) throw new XHSError('INVALID_INPUT', '已收录笔记列表无效');
}
function gate(s, login = false) {
  if (!s || typeof s !== 'object') throw new XHSError('SCHEMA_CHANGED', '小红书页面结构已变化，请重试或更新');
  if (s.risk) throw new XHSError('INTERACTION_REQUIRED', '小红书要求访问验证，请打开应用内登录窗口检查，勿连续重试');
  if (s.loginWall || s.loggedIn === false || (login && s.loggedIn !== true)) throw new XHSError('AUTH_REQUIRED', '请在应用内登录小红书，关闭登录窗口后检查连接并重试');
}

// Each scan call discovers one profile batch OR reads one detail. Core persists
// that result before asking for the next one, so cancellation never drops a batch.
export class XiaohongshuAPI {
  constructor(page, {delay = 9000, jitter = 4000, readTimeout = 20000, waitTimeout = 18000} = {}) {
    Object.assign(this, {page, delay, jitter, readTimeout, waitTimeout});
    this.scans = new Map(); this.authors = new Map(); this.lastNavigation = 0;
  }
  async bounded(promise, signal, ms = this.readTimeout) {
    signal?.throwIfAborted();
    let timer, abort;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new XHSError('TIMEOUT', '小红书页面读取超时，已停止本轮，请稍后重试')), ms);
        abort = () => reject(new XHSError('CANCELLED', '采集已取消'));
        signal?.addEventListener('abort', abort, {once:true});
        if (signal?.aborted) abort();
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async read(action, signal, login = false) {
    const s = await this.bounded(this.page.evaluate(scriptFor(action)), signal);
    signal?.throwIfAborted(); gate(s, login); return s;
  }
  async pause(signal) { await sleep(this.delay + Math.random()*this.jitter, undefined, {signal}); }
  async goto(url, signal) {
    trustedURL(url); signal?.throwIfAborted();
    await sleep(Math.max(0, this.delay + Math.random()*this.jitter - (Date.now()-this.lastNavigation)), undefined, {signal});
    this.lastNavigation = Date.now(); await this.bounded(this.page.goto(url), signal);
  }
  async wait(action, ready, signal) {
    const end = Date.now()+this.waitTimeout;
    while (true) {
      const s = await this.read(action,signal); if (ready(s)) return s;
      if (Date.now() >= end) throw new XHSError('SCHEMA_CHANGED', '小红书页面未加载完成或结构已变化，未将本次结果视为空列表');
      await sleep(500, undefined, {signal});
    }
  }
  async status(signal) {
    if (!this.page.url() || this.page.url() === 'about:blank') await this.goto('https://www.xiaohongshu.com/explore',signal);
    return this.read('status',signal);
  }
  async request(p, signal) {
    validateRequest(p);
    // Bound cache lifetime; signed URLs never cross the private acquisition boundary.
    for (const [key, scan] of this.scans) if (Date.now()-scan.started > 600000) {
      this.scans.delete(key);
      if (p.operation === 'scan' && p.cursor?.startsWith(key+':')) throw new XHSError('TIMEOUT','本轮达到 10 分钟上限，已保存结果保留');
    }
    const s = await this.status(signal);
    if (p.operation === 'check') return {authenticated:s.loggedIn === true};
    gate(s,true);
    if (p.operation === 'search') {
      await this.goto(`https://www.xiaohongshu.com/search_result/?keyword=${encodeURIComponent(p.query.trim())}&source=web_search_result_notes&type=51`,signal);
      await this.pause(signal); await this.read('user-tab',signal); await this.pause(signal);
      const data = await this.wait('users',s => s.users?.length || s.empty,signal);
      const users = data.users.filter(u => ID.test(u.id) && u.name && new URL(trustedURL(u.url)).pathname.replace(/\/$/,'') === `/user/profile/${u.id}`).slice(0,p.limit).map(u => {
        if(this.authors.size>=200)this.authors.delete(this.authors.keys().next().value);
        this.authors.set(u.id,u.url);
        return {...u,url:`https://www.xiaohongshu.com/user/profile/${u.id}`};
      });
      if (data.users.length && !users.length) throw new XHSError('SCHEMA_CHANGED','作者搜索未返回有效身份');
      return {users,empty:!!data.empty};
    }
    if (p.operation === 'detail') {
      await this.goto(this.authorURL(p.uid),signal);
      let profile = await this.wait('profile',s => s.notes?.length || s.end,signal);
      for (let round=0; round<=12; round++) {
        this.assertProfile(profile,p.uid);
        const note = profile.notes.find(n => n.id.toLowerCase() === p.id);
        if (note) return {note:await this.detail(note,p.uid,signal)};
        if (profile.end || round === 12) break;
        await this.read('scroll',signal); await this.pause(signal); profile = await this.read('profile',signal);
      }
      throw new XHSError('SCHEMA_CHANGED','本次主页扫描未找到这条笔记的可访问链接，请稍后重试或回溯');
    }
    return this.scan(p,signal);
  }
  assertProfile(s,uid) {
    if (s.authorId !== uid || !Array.isArray(s.notes)) throw new XHSError('SCHEMA_CHANGED','作者主页身份或笔记列表不匹配');
  }
  async detail(n,uid,signal) {
    if (!n.url || !new URL(trustedURL(n.url,'note')).searchParams.get('xsec_token')) throw new XHSError('SCHEMA_CHANGED','主页未提供完整的笔记访问链接，保留待重试');
    await this.goto(n.url,signal);
    const d = await this.wait('detail',s => s.unavailable || (s.ready && s.contentPresent !== false),signal);
    if (d.unavailable) throw new XHSError('SCHEMA_CHANGED','笔记已删除、私密或不可访问');
    if (d.id?.toLowerCase() !== n.id.toLowerCase() || d.authorId?.toLowerCase() !== uid) throw new XHSError('SCHEMA_CHANGED','无法确认笔记身份与作者归属');
    const range = publicationRange(d);
    const date = range?.exact ? new Date(range.start).toISOString() : range?.source === 'date-label' ? new Date(range.start+8*3600000).toISOString().slice(0,10) : null;
    return {id:n.id.toLowerCase(),authorId:uid,author:d.author || '',title:d.title || n.title || d.content?.slice(0,80) || '无标题笔记',
      content:d.content || '',url:`https://www.xiaohongshu.com/explore/${n.id.toLowerCase()}`,type:d.type || 'normal',
      images:(d.images || []).slice(0,30),tags:(d.tags || []).slice(0,100),
      published:{value:date,precision:range?.exact ? 'second' : date ? 'date' : 'unknown',provenance:range?.source || 'unavailable',timezone:'Asia/Shanghai',raw_label:d.dateText || null},
      acquisition_complete:true};
  }
  async scan(p,signal) {
    let scan;
    if (!p.cursor) {
      if (this.scans.size >= 32) throw new XHSError('ACCESS_FAILED','扫描任务过多，请稍后重试');
      await this.goto(this.authorURL(p.uid),signal);
      scan = {token:randomUUID(),started:Date.now(),uid:p.uid,job:p.job_id,limit:p.limit,mode:p.mode,step:0,rounds:0,idle:0,notes:new Map(),known:new Set(p.known_ids || []),queue:[],phase:'profile',end:false,reason:''};
      this.scans.set(scan.token,scan);
    } else {
      const [token,step] = p.cursor.split(':'); scan = this.scans.get(token);
      if (!scan || scan.step !== Number(step) || scan.uid !== p.uid || scan.job !== p.job_id || scan.limit !== p.limit || scan.mode !== p.mode)
        throw new XHSError('SCHEMA_CHANGED','扫描位置已失效，请重新刷新');
      if (Date.now()-scan.started > 600000) throw new XHSError('TIMEOUT','本轮达到 10 分钟上限，已保存结果保留');
    }
    const metrics = {profile_reads:0,discovered:0,skipped:0,detail_requests:0};
    const items=[],errors=[];
    if (scan.phase === 'profile') {
      if (scan.rounds) {
        // Never mistake another search/author's viewport for a continuation.
        if (this.page.url().split('?')[0].replace(/\/$/,'') !== `https://www.xiaohongshu.com/user/profile/${p.uid}`) {
          throw new XHSError('SCHEMA_CHANGED','主页扫描被其他页面操作中断，已保存结果保留，请重新刷新');
        }
        await this.read('scroll',signal); await this.pause(signal);
      }
      const profile = await this.wait('profile',s => s.notes?.length || s.end,signal);
      this.assertProfile(profile,p.uid); metrics.profile_reads++;
      for (const n of profile.notes) {
        const id=String(n.id).toLowerCase(); if (!ID.test(id) || scan.notes.has(id)) continue;
        scan.notes.set(id,{...n,id}); metrics.discovered++;
        if (scan.known.has(id)) metrics.skipped++; else scan.queue.push({...n,id});
      }
      scan.idle = metrics.discovered ? 0 : scan.idle+1; scan.rounds++; scan.end = !!profile.end;
      const bound = scan.rounds >= 13 || scan.idle >= 3 || scan.notes.size >= 500;
      if (scan.end || scan.queue.length >= scan.limit || bound) {
        scan.phase='detail'; scan.reason=scan.end ? 'profile_end' : bound ? 'scan_bound' : 'item_limit';
        scan.queue=scan.queue.slice(0,scan.limit);
      }
    } else {
      const n=scan.queue.shift();
      if (n) {
        metrics.detail_requests++;
        try { items.push(await this.detail(n,scan.uid,signal)); }
        catch (e) {
          if (['AUTH_REQUIRED','INTERACTION_REQUIRED','CANCELLED','TIMEOUT'].includes(e.code) || signal?.aborted) throw e;
          errors.push({index:scan.step,code:'SCHEMA_CHANGED',message:e instanceof XHSError ? e.message : '笔记读取失败，保留待重试'});
        }
      }
    }
    scan.step++;
    const terminal=scan.phase==='detail' && !scan.queue.length;
    const cursor=terminal ? null : `${scan.token}:${scan.step}`;
    if (terminal) this.scans.delete(scan.token);
    return {items,errors,metrics,cursor,terminal,end_evidence:terminal ? scan.reason : null};
  }
  authorURL(uid) { return this.authors.get(uid) || `https://www.xiaohongshu.com/user/profile/${uid}`; }
  abortScan(jobId) { for(const [key,scan] of this.scans)if(scan.job===jobId)this.scans.delete(key); }
  reset() { this.scans.clear(); this.authors.clear(); }
}
