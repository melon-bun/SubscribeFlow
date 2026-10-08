import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {scriptFor} from './zhihu-page.mjs';
export class ZhihuError extends Error { constructor(code,message) {super(message);this.code=code;} }
const ID=/^[a-f0-9]{32}$/, PIN=/^\d{1,30}$/, TOKEN=/^[A-Za-z0-9_.~-]{1,100}$/;
const fail=(code,message)=>{throw new ZhihuError(code,message);};
export function parseItemURL(raw) {
  let u;try {u=new URL(raw);}catch {fail('INVALID_INPUT','知乎想法链接无效');}
  if(typeof raw!=='string' || raw.length>2000 || /[\s\x00-\x1f]/.test(raw) || !['https:','http:'].includes(u.protocol) || u.username || u.password || u.port || !['www.zhihu.com','zhihu.com'].includes(u.hostname)) fail('INVALID_INPUT','请粘贴知乎官方想法链接');
  const id=u.pathname.match(/^\/pin\/(\d{1,30})\/?$/)?.[1];
  if(!id)fail('INVALID_INPUT','知乎本期仅支持想法 /pin/ 链接');
  return {id,url:`https://www.zhihu.com/pin/${id}`};
}
export function authorToken(raw) {
  if(typeof raw==='string' && TOKEN.test(raw) && !['.','..'].includes(raw)) return raw;
  let u;try {u=new URL(raw);}catch {fail('INVALID_INPUT','请输入知乎作者 ID、主页或通过昵称搜索');}
  const token=u.pathname.match(/^\/people\/([A-Za-z0-9_.~-]{1,100})\/?$/)?.[1];
  if(u.protocol!=='https:' || u.hostname!=='www.zhihu.com' || u.port || u.username || u.password || !token || ['.','..'].includes(token)) fail('INVALID_INPUT','知乎作者主页无效');
  return token;
}
export function validateRequest(p) {
  const fields={check:['channel','operation'],search:['channel','operation','query','limit'],author:['channel','operation','locator'],
    scan:['channel','operation','uid','url','job_id','cursor','limit','mode','known_ids'],read:['channel','operation','url','id'],detail:['channel','operation','url','id','uid']};
  if(!p || typeof p!=='object' || Array.isArray(p) || p.channel!=='zhihu' || !fields[p.operation] || Object.keys(p).some(k=>!fields[p.operation].includes(k))) fail('INVALID_INPUT','知乎请求无效');
  if(p.operation==='author')authorToken(p.locator);
  if(p.operation==='search' && (typeof p.query!=='string' || !p.query.trim() || p.query.length>100 || !Number.isInteger(p.limit) || p.limit<1 || p.limit>50))fail('INVALID_INPUT','请输入有效昵称及候选条数');
  if(['read','detail'].includes(p.operation) && (!PIN.test(p.id) || parseItemURL(p.url).id!==p.id))fail('INVALID_INPUT','想法读取身份不匹配');
  if('uid' in p && !ID.test(p.uid))fail('INVALID_INPUT','知乎作者稳定 ID 无效');
  if(p.operation==='scan') {
    authorToken(p.url);
    if(!ID.test(p.uid) || !/^[a-f0-9]{32}$/.test(p.job_id) || !['initial','refresh','backfill'].includes(p.mode) || !Number.isInteger(p.limit) || p.limit<1 || p.limit>50)fail('INVALID_INPUT','知乎采集参数无效');
    if(p.cursor!=null && (typeof p.cursor!=='string' || !/^[a-f0-9-]{36}:\d{1,3}$/.test(p.cursor)))fail('INVALID_CURSOR','知乎扫描位置失效');
    if(p.known_ids!=null && (!Array.isArray(p.known_ids) || p.known_ids.length>2000 || p.known_ids.some(id=>!PIN.test(id))))fail('INVALID_INPUT','已收录想法身份无效');
  }
}
function gate(s) {
  if(!s || typeof s!=='object')fail('SCHEMA_CHANGED','知乎页面结构无效');
  if(s.risk)fail('INTERACTION_REQUIRED','知乎要求访问验证，请在应用内完成验证后重试');
  if(s.loginWall)fail('AUTH_REQUIRED','请在应用内登录知乎，关闭窗口后检查连接');
}
function authorRow(raw) {
  if(!raw || typeof raw.id!=='string' || !ID.test(raw.id) || !TOKEN.test(raw.url_token || raw.urlToken || '') || typeof raw.name!=='string' || !raw.name.trim())fail('SCHEMA_CHANGED','知乎响应缺少真实作者稳定身份');
  const token=authorToken(raw.url_token || raw.urlToken);
  return {id:raw.id,token,name:raw.name.replace(/<\/?em>/g,'').trim(),url:`https://www.zhihu.com/people/${token}`,avatar:raw.avatar_url || raw.avatarUrl || '',description:raw.headline || ''};
}
export function publication(d) {
  const seconds=d.created;
  // Never use activity/updated timestamps, relative labels or the current clock.
  if(typeof seconds==='number' && Number.isFinite(seconds) && seconds>0 && seconds<=Date.now()/1000+86400) return {value:new Date(seconds*1000).toISOString(),precision:'second',provenance:'pin.created',raw_label:d.dateText || null};
  const m=typeof d.dateText==='string' && d.dateText.match(/^发布于\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2})(?::(\d{2}))?)?$/);
  if(m) {
    const date=new Date(`${m[1]}T${m[2] || '00:00'}:${m[3] || '00'}+08:00`);
    if(!Number.isNaN(+date) && new Date(+date+8*3600000).toISOString().slice(0,10)===m[1]) return {value:m[2] ? date.toISOString() : m[1],precision:m[2] ? m[3] ? 'second':'minute' : 'date',provenance:'pin.publish_label',raw_label:d.dateText};
  }
  return {value:null,precision:'unknown',provenance:'unavailable',raw_label:d.dateText || null};
}
export class ZhihuAPI {
  constructor(page,{fetch,delay=2500,readTimeout=18000,waitTimeout=15000}={}) {
    Object.assign(this,{page,fetch,delay,readTimeout,waitTimeout});this.scans=new Map();this.lastNavigation=0;
  }
  async bounded(promise,signal,ms=this.readTimeout) {
    signal?.throwIfAborted();let timer,abort;
    try{return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new ZhihuError('TIMEOUT','知乎读取超时，已保存结果保留')),ms);
      abort=()=>reject(new ZhihuError('CANCELLED','采集已取消'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    })]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  async json(path,signal) {
    const url='https://www.zhihu.com/api/v4/'+path;
    if(!this.fetch)fail('DEPENDENCY_UNAVAILABLE','知乎应用内会话不可用');
    const response=await this.bounded(this.fetch(url,{signal,credentials:'include',redirect:'error',headers:{Accept:'application/json'}}),signal);
    if(response.status===429)fail('RATE_LIMITED','知乎请求频繁，请稍后重试');
    if(response.status===401)fail('AUTH_REQUIRED','请在应用内登录知乎');
    if(response.status===403)fail('INTERACTION_REQUIRED','知乎要求登录或访问验证，请打开应用内窗口检查');
    if(response.status===404)fail('NOT_FOUND','知乎作者或内容不存在');
    if(!response.ok)fail('ACCESS_FAILED','知乎读取失败，请稍后重试');
    if(!/application\/json/.test(response.headers.get('content-type') || ''))fail('SCHEMA_CHANGED','知乎未返回有效平台数据');
    let data;try{data=await this.bounded(response.json(),signal);}catch(e){if(e.code || signal?.aborted)throw e;fail('SCHEMA_CHANGED','知乎返回数据无效');}
    signal?.throwIfAborted();return data;
  }
  async read(action,signal) {const s=await this.bounded(this.page.evaluate(scriptFor(action)),signal);signal?.throwIfAborted();gate(s);return s;}
  async goto(url,signal) {
    const u=new URL(url);if(u.origin!=='https://www.zhihu.com' || !/^\/(?:people\/[A-Za-z0-9_.~-]+|pin\/\d{1,30})\/?$/.test(u.pathname))fail('INVALID_INPUT','知乎读取地址无效');
    await sleep(Math.max(0,this.delay-(Date.now()-this.lastNavigation)),undefined,{signal});this.lastNavigation=Date.now();
    await this.bounded(this.page.goto(url),signal);
  }
  async wait(action,ready,signal) {
    const end=Date.now()+this.waitTimeout;
    while(true) {const s=await this.read(action,signal);if(ready(s))return s;if(Date.now()>=end)fail('SCHEMA_CHANGED','知乎页面未完成加载或结构变化，未视为零条内容');await sleep(300,undefined,{signal});}
  }
  async request(p,signal) {
    validateRequest(p);
    for(const [key,scan] of this.scans)if(Date.now()-scan.started>600000)this.scans.delete(key);
    if(p.operation==='check') {
      try {const user=authorRow(await this.json('me',signal));return {authenticated:true,account:user.name};}
      catch(e){if(e.code==='AUTH_REQUIRED')return {authenticated:false};throw e;}
    }
    if(p.operation==='author')return {author:authorRow(await this.json('members/'+encodeURIComponent(authorToken(p.locator)),signal))};
    if(p.operation==='search') {
      const d=await this.json('search_v3?t=people&q='+encodeURIComponent(p.query.trim())+'&correction=1&offset=0&limit='+p.limit,signal);
      if(!Array.isArray(d?.data))fail('SCHEMA_CHANGED','知乎搜索缺少候选列表');
      const users=d.data.filter(v=>v.type==='search_result' || v.object?.type==='people').map(v=>authorRow(v.object)).slice(0,p.limit);
      if(d.data.length && !users.length)fail('SCHEMA_CHANGED','知乎搜索没有可确认的作者');
      return {users,empty:d.data.length===0};
    }
    if(p.operation==='read' || p.operation==='detail') return {pin:await this.detail(p.id,p.uid,signal)};
    return this.scan(p,signal);
  }
  async detail(id,uid,signal) {
    await this.goto(`https://www.zhihu.com/pin/${id}`,signal);
    const d=await this.wait('detail',v=>v.unavailable || v.ready && v.contentPresent,signal);
    if(d.unavailable)fail('NOT_FOUND','知乎想法已删除或不可访问');
    if(d.id!==id || typeof d.content!=='string' || !Array.isArray(d.images) || !d.content.trim() && !d.images.length)fail('SCHEMA_CHANGED','知乎想法身份或正文无效');
    let a=d.author;
    if(!ID.test(a?.id || ''))a=(await this.json('members/'+encodeURIComponent(authorToken(a?.urlToken)),signal));
    else a={...a,url_token:a.urlToken};
    const author=authorRow(a);
    if(uid && uid!==author.id)fail('SCHEMA_CHANGED','想法不属于所订阅的作者');
    return {id,author,title:Array.from(d.content.trim().replace(/\s+/g,' ')).slice(0,80).join('') || '图片想法',content:d.content,url:`https://www.zhihu.com/pin/${id}`,images:d.images.slice(0,30),published:publication(d),acquisition_complete:true};
  }
  async scan(p,signal) {
    let scan;
    if(!p.cursor) {
      if(this.scans.size>=32)fail('ACCESS_FAILED','知乎扫描任务过多，请稍后重试');
      // Confirm the locator still belongs to the same stable ID (renamed tokens).
      const author=authorRow(await this.json('members/'+encodeURIComponent(authorToken(p.url)),signal));
      if(author.id!==p.uid)fail('SCHEMA_CHANGED','作者主页与已确认的稳定身份不一致');
      await this.goto(author.url,signal);
      scan={token:randomUUID(),started:Date.now(),job:p.job_id,uid:p.uid,url:author.url,limit:p.limit,mode:p.mode,step:0,rounds:0,idle:0,seen:new Set(),known:new Set(p.known_ids || []),queue:[],phase:'profile',reason:''};this.scans.set(scan.token,scan);
    } else {
      const [token,step]=p.cursor.split(':');scan=this.scans.get(token);
      if(!scan || scan.step!==Number(step) || scan.job!==p.job_id || scan.uid!==p.uid || scan.limit!==p.limit || scan.mode!==p.mode)fail('INVALID_CURSOR','知乎扫描已中断，请重新刷新');
    }
    const items=[],errors=[],metrics={profile_reads:0,discovered:0,skipped:0,detail_requests:0};
    if(scan.phase==='profile') {
      if(scan.rounds) {
        if(this.page.url().split('?')[0].replace(/\/$/,'')!==scan.url)fail('INVALID_CURSOR','知乎主页扫描被其他操作中断，请重新刷新');
        await this.read('scroll',signal);await sleep(this.delay,undefined,{signal});
      }
      const s=await this.wait('profile',v=>v.ready,signal);
      if(s.token!==authorToken(scan.url) || !Array.isArray(s.pins) || !Array.isArray(s.invalid))fail('SCHEMA_CHANGED','知乎动态列表身份或想法 ID 无法确认');
      metrics.profile_reads++;
      for(const pin of s.pins) {
        if(scan.seen.size>=scan.limit)break;
        if(!PIN.test(pin.id))fail('SCHEMA_CHANGED','知乎动态缺少稳定想法身份');
        if(scan.seen.has(pin.id))continue;
        scan.seen.add(pin.id);metrics.discovered++;
        if(scan.known.has(pin.id))metrics.skipped++;else scan.queue.push(pin.id);
      }
      scan.idle=metrics.discovered ? 0 : scan.idle+1;scan.rounds++;
      if(scan.seen.size>=scan.limit || s.end || scan.rounds>=13 || scan.idle>=3) {
        scan.phase='detail';scan.reason=scan.seen.size>=scan.limit ? 'item_limit' : s.end ? 'profile_end' : 'scan_bound';
      }
    } else {
      const id=scan.queue.shift();metrics.detail_requests++;
      try {items.push(await this.detail(id,scan.uid,signal));}
      catch(e){if(signal?.aborted || ['AUTH_REQUIRED','INTERACTION_REQUIRED','CANCELLED','TIMEOUT','RATE_LIMITED'].includes(e.code))throw e;errors.push({index:scan.step,code:e.code || 'ACCESS_FAILED',message:e instanceof ZhihuError ? e.message : '想法读取失败，保留待重试'});}
    }
    scan.step++;const terminal=scan.phase==='detail' && !scan.queue.length;
    if(terminal)this.scans.delete(scan.token);
    return {items,errors,metrics,terminal,cursor:terminal ? null : `${scan.token}:${scan.step}`,end_evidence:terminal ? scan.reason : null};
  }
  abortScan(jobId) {for(const [key,scan] of this.scans)if(scan.job===jobId)this.scans.delete(key);}
  reset() {this.scans.clear();}
}
