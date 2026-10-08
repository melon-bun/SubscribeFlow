// Fixed read-only actions inside the application's isolated Zhihu page.
export function pageAction(action) {
  const text = document.body?.innerText || '';
  const visible = el => !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
  const clean = el => (el?.textContent || '').trim();
  const risk = /\/account\/unhuman|\/captcha|security-verification/.test(location.pathname) ||
    [...document.querySelectorAll('[class*="Captcha"], [class*="Unhuman"], [class*="Verify"], [role="dialog"]')].some(el => visible(el) && /安全验证|验证码|访问异常|请求频繁/.test(clean(el))) ||
    (text.length < 1200 && /安全验证|访问异常|请求过于频繁/.test(text));
  const loginWall = /^\/(signin|signup)/.test(location.pathname) ||
    [...document.querySelectorAll('.SignFlow, .SignFlowModal')].some(visible);
  const base = {url:location.origin + location.pathname, risk, loginWall};
  if (action === 'status' || risk || loginWall) return base;
  let initial = window.__INITIAL_STATE__;
  if (!initial) { try { initial = JSON.parse(document.querySelector('#js-initialData')?.textContent || '{}').initialState; } catch {} }
  const entities = initial?.entities || {};
  const plain = html => { const el = document.createElement('div'); el.innerHTML = typeof html === 'string' ? html : ''; el.querySelectorAll('script,style').forEach(n=>n.remove()); el.querySelectorAll('br').forEach(n=>n.replaceWith('\n')); el.querySelectorAll('p,div,li').forEach(n=>n.append('\n')); return el.textContent.trim(); };
  const idOf = el => {
    for (const raw of [el?.getAttribute('data-zop'), el?.getAttribute('data-za-extra-module')]) {
      try { const v=JSON.parse(raw || '{}'); const c=v.card?.content || v; if (/^pin$/i.test(c.type || '') && /^\d{1,30}$/.test(String(c.token || c.itemId || c.id || ''))) return String(c.token || c.itemId || c.id); } catch {}
    }
    const a=[...(el?.querySelectorAll('a[href*="/pin/"]') || [])].find(a=>!a.closest('.RichText, .ztext'));
    try {const u=new URL(a?.getAttribute('href') || '', location.origin);return u.origin==='https://www.zhihu.com' ? u.pathname.match(/^\/pin\/(\d{1,30})\/?$/)?.[1] || '' : '';}catch{return '';}
  };
  if (action === 'profile') {
    const pins=[], invalid=[];
    for (const activity of document.querySelectorAll('div.Profile-main div.List-item')) {
      const meta=activity.querySelector('.ActivityItem-meta');
      const spans=[...(meta?.querySelectorAll('span') || [])].map(clean);
      if (spans[0] !== '发布了想法') continue; // Likes/reposts/answers never consume a pin slot.
      const content=activity.querySelector('.ContentItem, .PinItem');
      const id=idOf(content);
      if (!id) invalid.push('发布想法动态缺少稳定 ID');
      pins.push({id,rawLabel:spans[1] || '',pinned:!!activity.querySelector('.ActivityItem-StickyMark')});
    }
    const end=[...document.querySelectorAll('.List-end, .Profile-main .EmptyState, .Profile-main .List-footer')].some(el=>visible(el) && /没有更多|暂无动态|还没有动态|还没有发布/.test(clean(el)));
    return {...base,token:location.pathname.match(/^\/people\/([A-Za-z0-9_.~-]+)\/?$/)?.[1] || '',pins,invalid,end,ready:!!document.querySelector('.Profile-main .List, .Profile-main .EmptyState')};
  }
  if (action === 'detail') {
    const id=location.pathname.match(/^\/pin\/(\d{1,30})\/?$/)?.[1] || '';
    const pin=entities.pins?.[id];
    const scope=[...document.querySelectorAll('.PinItem')].find(el=>idOf(el)===id) || document.querySelector('main .PinItem, .PinMain .PinItem');
    const body=scope?.querySelector('.RichText.ztext, .RichText');
    let content='',images=[];
    const html=pin?.contentHtml ?? pin?.content_html;
    if (typeof html==='string') {
      content=plain(html);
      const parsed=document.createElement('div');parsed.innerHTML=html;
      images.push(...[...parsed.querySelectorAll('img')].map(i=>i.getAttribute('data-original') || i.src));
    }
    else if (typeof pin?.content==='string') content=plain(pin.content);
    else if (Array.isArray(pin?.content)) {
      content=pin.content.filter(c=>c.type==='text').map(c=>plain(c.content)).join('\n\n');
      images=pin.content.filter(c=>c.type==='image').map(c=>c.url || c.originalUrl || c.original_url).filter(Boolean);
    } else if (body) content=body.innerText.trim();
    if (body) images.push(...[...body.querySelectorAll('img')].map(i=>i.getAttribute('data-original') || i.src));
    let author=pin?.author;
    if (typeof author==='string') author=entities.users?.[author];
    const link=scope?.querySelector('.AuthorInfo a[href*="/people/"], .ContentItem-author a[href*="/people/"]');
    const token=author?.urlToken || author?.url_token || link?.getAttribute('href')?.match(/\/people\/([A-Za-z0-9_.~-]+)/)?.[1] || '';
    const name=author?.name || clean(scope?.querySelector('.AuthorInfo-name, .UserLink-link'));
    const dateText=clean(scope?.querySelector('.ContentItem-time, .PinItem-time'));
    return {...base,id:pin?.id != null ? String(pin.id) : id,author:{id:author?.id || '',urlToken:token,name},content,images,
      contentPresent:!!pin && (typeof pin.content==='string' || Array.isArray(pin.content) || typeof pin.contentHtml==='string' || typeof pin.content_html==='string') || !!body,
      created:pin?.created ?? pin?.createdTime ?? pin?.created_time ?? null,dateText,
      unavailable:!pin && /想法不存在|内容已删除|该内容无法查看|页面不存在/.test(text),ready:!!pin || !!body};
  }
  if (action === 'scroll') { window.scrollBy(0, Math.max(700, innerHeight * .85)); return base; }
  throw new Error('Unknown Zhihu page action');
}
export const scriptFor = action => `(${pageAction.toString()})(${JSON.stringify(action)})`;
