// Isolated acceptance website. Never enabled in a packaged application.
const UID='123456789012345678901234',OTHER='999999999999999999999999';
const IDS=['111111111111111111111111','222222222222222222222222','333333333333333333333333'];
function install(session) {
  const visits=[];
  session.protocol.handle('https', async request=>{
    const u=new URL(request.url); visits.push(u.origin+u.pathname);
    const authenticated=(await session.cookies.get({url:'https://www.xiaohongshu.com',name:'fixture_session'})).some(c=>c.value==='logged-in');
    const state={user:{loggedIn:authenticated}};
    let body='';
    if(!authenticated)body='<button id="fixture-login" onclick="document.cookie=\'fixture_session=logged-in; Path=/; Max-Age=86400; Secure; SameSite=Lax\'; window.__INITIAL_STATE__.user.loggedIn=true; document.querySelector(\'#login-btn\').remove(); this.remove();">模拟手动登录</button><button id="login-btn">登录</button>';
    else if(u.pathname.replace(/\/$/,'')==='/search_result' && u.searchParams.has('keyword')) {
      body='<main class="search-layout"><span class="channel">用户</span>'+[UID,OTHER].map((id,i)=>`<div class="user-item"><a href="/user/profile/${id}"><span class="name">同名作者</span></a><p>${i ? '另一个账号，请勿选错' : '验收作者，公开简介'}</p></div>`).join('')+'</main>';
    } else if(u.pathname.startsWith('/user/profile/')) {
      state.user.userPageData={basicInfo:{nickname:'同名作者'}};
      state.user.notes=[IDS.map((id,i)=>({id,xsecToken:'fixture-private-token',noteCard:{title:['置顶旧笔记','近期笔记','时间待确认笔记'][i]}}))];
      body='<main><div class="end-container">没有更多了</div></main>';
    } else if(/^\/explore\/[a-f0-9]{24}$/.test(u.pathname)) {
      const id=u.pathname.split('/').pop(),i=IDS.indexOf(id);
      state.note={noteDetailMap:{[id]:{note:{title:['置顶旧笔记','近期笔记','时间待确认笔记'][i],desc:'用于验证正式入库的正文',user:{userId:UID,nickname:'同名作者'},...(i===2 ? {} : {time:Date.now()-(i===0 ? 7*86400000 : 3600000)})}}}};
      const share=`7 【验收笔记】 https://www.xiaohongshu.com/discovery/item/${id}?source=webshare&xhsshare=pc_web&xsec_token=fixture-share-token%3D&xsec_source=pc_share`;
      const copy=i===1 ? `()=>{const t=document.createElement('textarea');t.value=${JSON.stringify(share)};document.body.append(t);t.select();document.execCommand('copy');t.remove();}` : `()=>navigator.clipboard.writeText(${JSON.stringify(share)})`;
      body=`<div id="noteContainer"><div id="detail-title">验收笔记</div><div id="detail-desc">用于验证正式入库的正文</div><div class="date">${i===2 ? '2天前' : ''}</div><button class="share-wrapper" onclick="document.querySelector('#copy-link').hidden=false">分享</button><div class="xhs-note-share-popup" style="visibility:hidden"><button class="xhs-note-share-popup-action-item" id="copy-link" hidden>复制链接</button></div></div><script>window.fixtureClipboardWrites=0;navigator.clipboard.writeText=async()=>{window.fixtureClipboardWrites++};window.fixtureOriginalClipboard=navigator.clipboard.writeText;document.querySelector('#copy-link').onclick=${copy};</script>`;
    } else body='<main><h1>隔离小红书页面</h1></main>';
    return new Response(`<!doctype html><html><head><title>小红书隔离验收</title></head><body>${body}<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script></body></html>`,{headers:{'Content-Type':'text/html; charset=utf-8'}});
  });
  return {UID,OTHER,IDS,visits};
}
module.exports={install,UID,OTHER,IDS};
