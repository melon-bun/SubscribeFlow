// Runs inside the app-owned Xiaohongshu page. Reads public DOM/state only.
export function pageAction(action) {
  const unwrap = v => v && typeof v === 'object' && '_value' in v ? v._value : v;
  const clean = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = document.body?.innerText || '';
  const state = window.__INITIAL_STATE__ || {};
  const user = state.user || {};
  const loggedIn = unwrap(user.loggedIn);
  const risk = /website-login\/error|error_code=300017|error_code=300031/.test(location.href) ||
    [...document.querySelectorAll('[class*="captcha"], [class*="verify"], [class*="error"], [role="dialog"]')].some(el => visible(el) && /验证码|安全验证|安全限制|访问频次异常|请求太频繁|访问链接异常/.test(clean(el))) ||
    (text.length < 1500 && /访问频次异常|请求太频繁|安全限制|访问链接异常/.test(text));
  const loginWall = location.pathname.startsWith('/login') || visible(document.querySelector('#login-btn')) ||
    [...document.querySelectorAll('[class*="login-container"], [class*="login-modal"], [class*="login-mask"]')].some(visible);
  const base = { url: location.origin + location.pathname, risk, loginWall, loggedIn: loggedIn === true ? true : loggedIn === false ? false : null };
  if (action === 'status') return { ...base, title: document.title, hasState: !!window.__INITIAL_STATE__ };
  if (risk || loginWall) return base;
  const absolute = href => { try { const u = new URL(href, location.origin); return u.protocol === 'https:' && !u.username && !u.password && !u.port ? u.href : ''; } catch { return ''; } };
  const profileId = href => { try { return new URL(href, location.origin).pathname.match(/^\/user\/profile\/([\da-f]{24})\/?$/i)?.[1] || ''; } catch { return ''; } };
  if (action === 'user-tab') {
    const tabs = [...document.querySelectorAll('[role="tab"], .channel, .channel-item, .tab, .tab-item, .tabs-item, button, a, span')];
    const tab = tabs.find(el => visible(el) && clean(el) === '用户');
    if (tab) { tab.click(); return { ...base, clicked: true }; }
    return { ...base, clicked: false };
  }
  if (action === 'users') {
    const users = new Map();
    // Never turn note authors / sidebar account links into user-search matches.
    const scope = document.querySelector('.search-layout__main, .search-layout, .search-container, main') || document.body;
    for (const a of scope.querySelectorAll('a[href*="/user/profile/"]')) {
      if (!visible(a) || a.closest('section.note-item, .note-item, .feeds-container, header, aside, nav')) continue;
      const url = absolute(a.getAttribute('href')); const id = profileId(url);
      const card = a.closest('[class*="user-item"], [class*="user-card"], [class*="user-info"], [class*="user-list"]');
      if (!id || !card) continue;
      const name = clean(card.querySelector('.user-name, .username, .name, .nickname, .nick-name')) || clean(a);
      if (!name) continue;
      users.set(id.toLowerCase(), { id: id.toLowerCase(), name, url, description: clean(card).slice(0, 350), avatar: absolute(card.querySelector('img')?.getAttribute('src') || '') });
    }
    const empty = /未找到相关用户|没有找到相关用户|暂无相关用户|没有搜索结果/.test(text);
    return { ...base, users: [...users.values()], empty, userTabPresent: [...document.querySelectorAll('[role="tab"], .channel, .tab, span')].some(el => visible(el) && clean(el) === '用户') };
  }
  if (action === 'profile') {
    const notes = new Map();
    const raw = unwrap(user.notes);
    const pageData = unwrap(user.userPageData);
    // notes[0] is the authored-notes tab. Never read saved/liked tab arrays.
    const first = Array.isArray(raw?.[0]) ? raw[0] : Array.isArray(raw) ? raw : [];
    for (const item of first) {
      const c = item.noteCard || item.note_card || item;
      const id = item.id || item.noteId || c.noteId || c.note_id;
      if (!/^[\da-f]{24}$/i.test(id || '')) continue;
      const token = item.xsecToken || item.xsec_token || c.xsecToken || c.xsec_token;
      const url = token ? `https://www.xiaohongshu.com/explore/${id}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_user` : '';
      notes.set(id, { id, title: c.displayTitle || c.display_title || c.title || '', url });
    }
    for (const section of document.querySelectorAll('section.note-item, .feeds-container section')) {
      const a = section.querySelector('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/user/profile/"]');
      const url = absolute(a?.getAttribute('href') || '');
      const id = url.match(/\/(?:explore|search_result)\/([\da-f]{24})/i)?.[1] || url.match(/\/user\/profile\/[\da-f]{24}\/([\da-f]{24})/i)?.[1];
      if (!id) continue;
      const old = notes.get(id);
      notes.set(id, { id, title: clean(section.querySelector('.title')) || old?.title || '', url: url.includes('xsec_token=') ? url : old?.url || '' });
    }
    const end = [...document.querySelectorAll('.end-container, .end-tip, .no-more, [class*="bottom"], [class*="empty"]')].some(el => visible(el) && /没有更多|到底了|暂未发布|还没有发布|还没有笔记/.test(clean(el)));
    return { ...base, authorId: location.pathname.match(/^\/user\/profile\/([\da-f]{24})\/?$/i)?.[1]?.toLowerCase(), notes: [...notes.values()], ready: !!pageData && Array.isArray(raw), end, name: pageData?.basicInfo?.nickname || '' };
  }
  if (action === 'detail') {
    const id = location.pathname.match(/\/(?:explore|search_result)\/([\da-f]{24})/i)?.[1] || location.pathname.match(/\/user\/profile\/[\da-f]{24}\/([\da-f]{24})/i)?.[1];
    const map = unwrap(state.note?.noteDetailMap);
    const entry = unwrap(map?.[id]);
    const note = unwrap(entry?.note);
    const scope = document.querySelector('#noteContainer');
    const authorLink = scope?.querySelector('.author-wrapper a[href*="/user/profile/"], a.username[href*="/user/profile/"]');
    // time is original publish time; lastUpdateTime is deliberately excluded.
    const rawTime = note?.time ?? note?.publishTime ?? note?.publish_time ?? null;
    const dateText = clean(scope?.querySelector('.date, .bottom-container .date, .note-date'));
    const unavailable = !note && /笔记不存在|页面不见了|无法浏览|内容已删除/.test(text);
    return { ...base, unavailable, ready: !!note || !!scope?.querySelector('#detail-desc, #detail-title'), id,
      title: note?.title || clean(scope?.querySelector('#detail-title')),
      content: note?.desc || clean(scope?.querySelector('#detail-desc')),
      contentPresent: typeof note?.desc === 'string' || !!scope?.querySelector('#detail-desc'),
      author: note?.user?.nickname || clean(scope?.querySelector('.username')),
      authorId: note?.user?.userId || note?.user?.user_id || profileId(authorLink?.getAttribute('href') || ''),
      rawTime, timeSource: rawTime != null ? 'note.publishTime' : dateText ? 'page.date' : 'unknown', dateText,
      tags: Array.isArray(note?.tagList) ? note.tagList.map(t => t.name).filter(Boolean) : [],
      images: Array.isArray(note?.imageList) ? note.imageList.map(i => i.urlDefault || i.url || '').filter(Boolean) : [],
      type: note?.type || '', likes: note?.interactInfo?.likedCount || '',
    };
  }
  if (action === 'scroll') {
    const candidates = [...document.querySelectorAll('.scroll-container, .user-page, .search-layout__main, main, #app, .main-content')];
    const scroller = candidates.find(el => el.scrollHeight > el.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(el).overflowY)) || document.scrollingElement;
    if (scroller) scroller.scrollBy(0, Math.max(700, scroller.clientHeight * 0.85));
    return base;
  }
  throw new Error('Unknown page action');
}
export const scriptFor = action => `(${pageAction.toString()})(${JSON.stringify(action)})`;
