// Fixed read-only actions inside the application's isolated Zhihu page.
// The activity list is no longer read from the DOM: Zhihu renders "他的动态" asynchronously
// and server-side output is empty, so discovery uses the official /pins endpoints instead.
// Only the page-state guards below still need the real page.
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
  if (action === 'detail') {
    // Body fallback only; the official pin endpoint is the primary source.
    const id=location.pathname.match(/^\/pin\/(\d{1,30})\/?$/)?.[1] || '';
    let initial = window.__INITIAL_STATE__;
    if (!initial) { try { initial = JSON.parse(document.querySelector('#js-initialData')?.textContent || '{}').initialState; } catch {} }
    const pin=initial?.entities?.pins?.[id];
    const scope=document.querySelector('main .PinItem, .PinMain .PinItem, .PinItem');
    const body=scope?.querySelector('.RichText.ztext, .RichText');
    let content='',images=[];
    if (typeof pin?.content==='string') content=pin.content;
    else if (Array.isArray(pin?.content)) {
      content=pin.content.filter(c=>c.type==='text').map(c=>String(c.content||'').replace(/<[^>]*>/g,'')).filter(Boolean).join('\n\n');
      images=pin.content.filter(c=>c.type==='image').map(c=>c.url||c.originalUrl||c.original_url).filter(Boolean);
    }
    if (body) {
      if (!content.trim()) content=body.innerText.trim();
      images.push(...[...body.querySelectorAll('img')].map(i=>i.getAttribute('data-original')||i.src));
    }
    const author=typeof pin?.author==='string'?initial?.entities?.users?.[pin.author]:pin?.author;
    const link=scope?.querySelector('.AuthorInfo a[href*="/people/"], .ContentItem-author a[href*="/people/"]');
    const token=author?.urlToken||author?.url_token||link?.getAttribute('href')?.match(/\/people\/([A-Za-z0-9_.~-]+)/)?.[1]||'';
    const name=author?.name||clean(scope?.querySelector('.AuthorInfo-name, .UserLink-link'));
    return {...base,id,author:{id:author?.id||'',urlToken:token,name},
      content,images:[...images],
      unavailable:/想法不存在|内容已删除|该内容无法查看|页面不存在/.test(text)};
  }
  if (action === 'scroll') { window.scrollBy(0, Math.max(700, innerHeight * .85)); return base; }
  throw new Error('Unknown Zhihu page action');
}
export const scriptFor = action => `(${pageAction.toString()})(${JSON.stringify(action)})`;
