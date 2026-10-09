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
// Official pin payloads use "/pins/<id>" internally; identity is always normalised to "/pin/<id>".
// Text blocks arrive as Zhihu rich-text HTML; they must reach Core as plain text with paragraphs kept.
const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
export function pinText(html) {
  if(typeof html!=='string')return '';
  return html
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi,'\n\n')
    .replace(/<[^>]*>/g,'')                                  // no markup may survive into the body
    .replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCodePoint(parseInt(h,16)))
    .replace(/&#(\d+);/g,(_,d)=>String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi,(m,n)=>ENTITIES[n.toLowerCase()]??m)
    .replace(/[ \t ]+/g,' ')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}
const pinContent = blocks => {
  if(!Array.isArray(blocks)) return {content:'',images:[]};
  return {
    content:blocks.filter(b=>b?.type==='text').map(b=>pinText(b.content)).filter(Boolean).join('\n\n'),
    images:blocks.filter(b=>b?.type==='image').map(b=>b.url||b.originalUrl||b.original_url).filter(u=>typeof u==='string'&&u.length>0),
  };
};
const pinDeleted = row => !row || row.is_deleted===true || row.state==='deleted' || !/^\d{1,30}$/.test(String(row.id||''));
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
    return this.get(path.startsWith('https://')?path:'https://www.zhihu.com/api/v4/'+path,signal);
  }
  async get(url,signal) {
    if(!this.fetch)fail('DEPENDENCY_UNAVAILABLE','知乎应用内会话不可用');
    let response;try{response=await this.bounded(this.fetch(url,{signal,credentials:'include',redirect:'error',headers:{Accept:'application/json'}}),signal);}catch(e){if(e.code||signal?.aborted)throw e;fail('ACCESS_FAILED','知乎读取失败，请稍后重试');}
    if(response.status===429)fail('RATE_LIMITED','知乎请求频繁，请稍后重试');
    if(response.status===401)fail('AUTH_REQUIRED','请在应用内登录知乎');
    if(response.status===403)fail('INTERACTION_REQUIRED','知乎要求登录或访问验证，请打开应用内窗口检查');
    if(response.status===404)fail('NOT_FOUND','知乎作者或内容不存在');
    if(!response.ok)fail('ACCESS_FAILED','知乎读取失败，请稍后重试');
    if(!/application\/json/.test(response.headers.get('content-type') || ''))fail('SCHEMA_CHANGED','知乎未返回有效平台数据');
    let data;try{data=await this.bounded(response.json(),signal);}catch(e){if(e.code || signal?.aborted)throw e;fail('SCHEMA_CHANGED','知乎返回数据无效');}
    signal?.throwIfAborted();return data;
  }
  // Members/<token> and www search_v3 now answer 403 "请求参数异常"; the pins feed carries the
  // same stable author identity and api.zhihu.com still serves people search.
  async authorRow(token,signal) {
    const data=await this.json(`members/${encodeURIComponent(token)}/pins?limit=1&offset=0`,signal);
    if(!Array.isArray(data?.data) || typeof data?.paging?.totals!=='number')fail('SCHEMA_CHANGED','知乎作者主页返回无效');
    const row=data.data.find(v=>!pinDeleted(v) && v.author);
    if(row)return authorRow(row.author);
    // A real profile answers 404/403 when the token is unknown; an empty feed with totals 0 is a
    // genuine author who has published nothing, which is a valid zero-result scan, not a failure.
    if(data.paging.totals>0)fail('SCHEMA_CHANGED','知乎作者主页缺少稳定身份');
    return {id:'',token,name:'',url:`https://www.zhihu.com/people/${token}`,avatar:'',description:'',empty:true};
  }
  // Kept for the visible login window: navigating the shared session surfaces the real
  // risk / login-wall state that the hidden reader must never pass off as an empty result.
  async read(action,signal) {const s=await this.bounded(this.page.evaluate(scriptFor(action)),signal);signal?.throwIfAborted();gate(s);return s;}
  async goto(url,signal) {
    const u=new URL(url);if(u.origin!=='https://www.zhihu.com' || !/^\/(?:people\/[A-Za-z0-9_.~-]+|pin\/\d{1,30})\/?$/.test(u.pathname))fail('INVALID_INPUT','知乎读取地址无效');
    await sleep(Math.max(0,this.delay-(Date.now()-this.lastNavigation)),undefined,{signal});this.lastNavigation=Date.now();
    await this.bounded(this.page.goto(url),signal);
  }
  async request(p,signal) {
    validateRequest(p);
    for(const [key,scan] of this.scans)if(Date.now()-scan.started>600000)this.scans.delete(key);
    if(p.operation==='check') {
      try {const user=authorRow(await this.json('me',signal));return {authenticated:true,account:user.name};}
      catch(e){if(e.code==='AUTH_REQUIRED')return {authenticated:false};throw e;}
    }
    if(p.operation==='author')return {author:await this.authorRow(authorToken(p.locator),signal)};
    if(p.operation==='search') {
      const d=await this.get('https://api.zhihu.com/search_v3?t=people&q='+encodeURIComponent(p.query.trim())+'&correction=1&offset=0&limit='+p.limit,signal);
      if(!Array.isArray(d?.data))fail('SCHEMA_CHANGED','知乎搜索缺少候选列表');
      const users=[];
      for(const v of d.data) {
        if(v.type!=='search_result' && v.object?.type!=='people')continue;
        try{users.push(authorRow(v.object));}catch{} // Skip candidates without a confirmable stable ID.
        if(users.length>=p.limit)break;
      }
      if(d.data.length && !users.length)fail('SCHEMA_CHANGED','知乎搜索没有可确认的作者');
      return {users,empty:d.data.length===0};
    }
    if(p.operation==='read' || p.operation==='detail') return {pin:await this.detail(p.id,p.uid,signal)};
    return this.scan(p,signal);
  }
  async detail(id,uid,signal) {
    // The official pin endpoint returns the full body, author and created time in one request.
    const d=await this.json(`pins/${encodeURIComponent(id)}`,signal);
    if(!d || typeof d!=='object')fail('SCHEMA_CHANGED','知乎想法返回无效');
    if(pinDeleted(d))fail('NOT_FOUND','知乎想法已删除或不可访问');
    if(String(d.id)!==id)fail('SCHEMA_CHANGED','知乎想法身份不匹配');
    const {content,images}=pinContent(d.content);
    if(typeof d.author!=='object' || !d.author)fail('SCHEMA_CHANGED','知乎想法缺少作者身份');
    const author=authorRow(d.author);
    if(uid && uid!==author.id)fail('SCHEMA_CHANGED','想法不属于所订阅的作者');
    const text=content.trim();
    if(!text && !images.length)fail('SCHEMA_CHANGED','知乎想法正文无效');
    return {id,author,title:Array.from(text.replace(/\s+/g,' ')).slice(0,80).join('') || '图片想法',content,url:`https://www.zhihu.com/pin/${id}`,images:images.slice(0,30),published:publication(d),acquisition_complete:true};
  }
  async scan(p,signal) {
    let scan;
    if(!p.cursor) {
      if(this.scans.size>=32)fail('ACCESS_FAILED','知乎扫描任务过多，请稍后重试');
      // Confirm the locator still belongs to the same stable ID (renamed tokens).
      const author=await this.authorRow(authorToken(p.url),signal);
      // A confirmed subscription always has a stable ID; an author who published nothing cannot
      // match it, and an empty feed is a real zero-result window rather than a structure change.
      if(author.empty)return {items:[],errors:[],metrics:{profile_reads:1,discovered:0,skipped:0,detail_requests:0},terminal:true,cursor:null,end_evidence:'profile_end'};
      if(author.id!==p.uid)fail('SCHEMA_CHANGED','作者主页与已确认的稳定身份不一致');
      scan={token:randomUUID(),started:Date.now(),job:p.job_id,uid:p.uid,url:author.url,limit:p.limit,mode:p.mode,step:0,rounds:0,idle:0,seen:new Set(),known:new Set(p.known_ids || []),queue:[],offset:0,phase:'profile',reason:''};this.scans.set(scan.token,scan);
    } else {
      const [token,step]=p.cursor.split(':');scan=this.scans.get(token);
      if(!scan || scan.step!==Number(step) || scan.job!==p.job_id || scan.uid!==p.uid || scan.limit!==p.limit || scan.mode!==p.mode)fail('INVALID_CURSOR','知乎扫描已中断，请重新刷新');
    }
    const items=[],errors=[],metrics={profile_reads:0,discovered:0,skipped:0,detail_requests:0};
    if(scan.phase==='profile') {
      // Official pins feed, newest first. One page per request keeps the scan bounded.
      const token=authorToken(scan.url);
      const size=Math.max(scan.limit,20);
      const d=await this.json(`members/${encodeURIComponent(token)}/pins?limit=${size}&offset=${scan.offset}`,signal);
      if(!Array.isArray(d?.data) || !d.paging || typeof d.paging.is_end!=='boolean')fail('SCHEMA_CHANGED','知乎想法列表结构无法确认');
      metrics.profile_reads++;
      for(const pin of d.data) {
        if(scan.seen.size>=scan.limit)break;
        if(pinDeleted(pin))continue; // Deleted rows never consume a window slot.
        if(pin.author?.id && pin.author.id!==scan.uid)fail('SCHEMA_CHANGED','想法列表包含其他作者的内容');
        const id=String(pin.id);
        if(scan.seen.has(id))continue;
        scan.seen.add(id);metrics.discovered++;
        if(scan.known.has(id))metrics.skipped++;else scan.queue.push(id);
      }
      scan.offset+=d.data.length;
      scan.idle=metrics.discovered ? 0 : scan.idle+1;scan.rounds++;
      // Only the platform's own is_end proves the end of the profile history. An empty page while
      // is_end is false means the window stopped early, which stays a bounded scan with gaps.
      const exhausted=d.paging.is_end;
      if(scan.seen.size>=scan.limit || exhausted || d.data.length===0 || scan.rounds>=13 || scan.idle>=3) {
        scan.phase='detail';
        scan.reason=scan.seen.size>=scan.limit ? 'item_limit' : exhausted ? 'profile_end' : 'scan_bound';
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
