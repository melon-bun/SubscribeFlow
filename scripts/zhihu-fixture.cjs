// Fixed, isolated website for M12 acceptance. Enabled only in source smoke mode.
const UID='a'.repeat(32),OTHER='b'.repeat(32),TOKEN='m12-author';
const IDS=['1234567890123456789','1234567890123456790','1234567890123456791','1234567890123456792','1234567890123456793'];
async function install(session) {
  const visits=[],control={mode:'normal',missingId:false};
  const author=(id=UID)=>({id,type:'people',url_token:id===UID ? TOKEN : 'other-author',name:'同名知乎作者',headline:id===UID ? 'M12 隔离验收作者' : '另一个账号，请勿选错',avatar_url:'https://pic1.zhimg.com/fixture.jpg'});
  await session.cookies.set({url:'https://www.zhihu.com',name:'m12_fixture_session',value:'logged-in',secure:true,expirationDate:Date.now()/1000+86400});
  session.protocol.handle('https',async request=>{
    const u=new URL(request.url);visits.push(u.origin+u.pathname);
    if(u.hostname!=='www.zhihu.com')return new Response('Blocked fixture host',{status:403});
    const authenticated=(await session.cookies.get({url:'https://www.zhihu.com',name:'m12_fixture_session'})).some(c=>c.value==='logged-in');
    const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
    if(u.pathname.startsWith('/api/v4/')) {
      if(control.mode==='risk')return json({error:{}},403);
      if(control.mode==='rate')return json({error:{}},429);
      if(!authenticated)return json({error:{}},401);
      if(u.pathname==='/api/v4/me')return json(author());
      if(u.pathname==='/api/v4/search_v3')return json({data:u.searchParams.get('q')==='无人' ? [] : [UID,OTHER].map(id=>({type:'search_result',object:author(id)}))});
      if(u.pathname.startsWith('/api/v4/members/')) {
        const token=u.pathname.split('/').pop();return [TOKEN,UID].includes(token) ? json(author()) : ['other-author',OTHER].includes(token) ? json(author(OTHER)) : json({},404);
      }
      return json({},404);
    }
    let body='',state={entities:{users:{[UID]:author()},pins:{}}};
    if(control.mode==='risk')body='<div class="Unhuman">安全验证</div>';
    else if(!authenticated || u.pathname==='/signin')body='<div class="SignFlow"><button id="fixture-login" onclick="document.cookie=\'m12_fixture_session=logged-in; Path=/; Max-Age=86400; Secure; SameSite=Lax\'; this.closest(\'.SignFlow\').remove();">模拟登录</button></div>';
    else if(u.pathname==='/people/'+TOKEN) {
      const card=(id,label,pinned=false)=>`<div class="List-item"><div class="ActivityItem-meta"><span>${label}</span><span>昨天</span></div><div class="ContentItem" data-zop='${JSON.stringify({type:'pin',itemId:id})}'>${pinned ? '<span class="ActivityItem-StickyMark">置顶</span>':''}<a href="/pin/${id}">查看想法</a><span class="RichText ztext">活动预览，不作正式正文</span></div></div>`;
      body='<div class="Profile-main"><div class="List">'+(control.missingId ? '<div class="List-item"><div class="ActivityItem-meta"><span>发布了想法</span></div><div class="ContentItem">正文但缺 ID</div></div>':'')+card(IDS[4],'赞同了回答')+card(IDS[4],'转发了想法')+card(IDS[0],'发布了想法',true)+card(IDS[0],'发布了想法',true)+card(IDS[1],'发布了想法')+card(IDS[2],'发布了想法')+card(IDS[3],'发布了想法')+(control.missingId ? '<div class="List-item"><div class="ActivityItem-meta"><span>发布了想法</span></div><div class="ContentItem">正文但缺 ID</div></div>':'')+'</div><div class="List-end">没有更多了</div></div>';
    } else if(/^\/pin\/\d+$/.test(u.pathname)) {
      const id=u.pathname.split('/').pop(),i=IDS.indexOf(id);
      if(i<0)body='想法不存在';
      else {
        const content=i===4 ? '<img src="https://pic1.zhimg.com/image-only.jpg">' : '<p>'+['置顶的旧想法','近期作者想法','时间待确认的想法','单条自主添加想法','别的动态'][i]+'</p><p>这是完整正文第二段。保留换行和正文。</p>';
        state.entities.pins[id]={id,author:{...author(),urlToken:TOKEN},contentHtml:content,...(i===2 ? {updated:1791482400} : {created:946684800+i*86400}),updated:1791482400};
        body=`<main class="PinMain"><div class="PinItem" data-zop='${JSON.stringify({type:'pin',itemId:id})}'><div class="AuthorInfo"><a class="AuthorInfo-name" href="/people/${TOKEN}">同名知乎作者</a></div><div class="RichText ztext">${content}</div><span class="ContentItem-time">${i===2 ? '编辑于 昨天':'发布于 2000-01-01'}</span></div></main>`;
      }
    } else body='<main>知乎隔离验收</main>';
    return new Response(`<!doctype html><html><head><title>知乎 M12 隔离验收</title></head><body>${body}<script id="js-initialData" type="application/json">${JSON.stringify({initialState:state})}</script></body></html>`,{headers:{'Content-Type':'text/html; charset=utf-8'}});
  });
  const setAuth=async enabled=>session.cookies.set({url:'https://www.zhihu.com',name:'m12_fixture_session',value:enabled ? 'logged-in':'signed-out',secure:true,expirationDate:Date.now()/1000+86400});
  return {UID,OTHER,TOKEN,IDS,visits,control,setAuth};
}
module.exports={install,UID,OTHER,TOKEN,IDS};
