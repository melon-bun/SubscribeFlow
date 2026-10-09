// Fixed, isolated website for M14 acceptance. Enabled only in source smoke mode.
// Shapes mirror the real platform page: identity variables, #js_content body and
// the error pages the reader must classify by body evidence rather than status.
const SHORT='https://mp.weixin.qq.com/s/m14FixtureArticleToken';
const ACCOUNT='M14FixTURE0ACCOUNT==',OTHER_ACCOUNT='M14FixTURE0OTHER==';
const IDS=[{mid:'2247551517',idx:1},{mid:'2247551518',idx:2}];
const ARTICLES=IDS.map(({mid,idx})=>`${ACCOUNT}_${mid}_${idx}`);
const CONTROL={mode:'normal'};

function page({mid='2247551517',idx=1,account=ACCOUNT,name='M14 隔离公众号',byline='署名甲',ct='1780656700',title='M14 隔离验收文章',body}={}) {
  return `<!doctype html><html><head><meta property="og:title" content="页面标题" />
<script>
  var nickname = htmlDecode("${name}");
  var round_head_img = "http://mmbiz.qpic.cn/mmbiz_png/fixture-avatar.png";
  var ct = "${ct}";
  var user_name = "gh_m14fixture";
  var msg_title = '${title}';
  var msg_desc = htmlDecode("摘要");
  var author = "${byline}";
  var biz = "${account}" || "";
  var mid = "${mid}" || "" || "";
  var idx = "${idx}" || "" || "";
  var msg_link = "${SHORT}";
  var msg_cdn_url = "https://mmbiz.qpic.cn/mmbiz_jpg/fixture-cover.jpeg";
</script></head><body>
<div class="rich_media_area"><div id="js_content">${body||'<p>M14 隔离验收正文第一段。</p><p>第二段完整正文，保留换行。</p><img data-src="//mmbiz.qpic.cn/mmbiz_png/fixture-inline.png" />'}</div>
<div id="js_article_bottom_bar"><span>阅读 10 万</span><a href="/s/other">推荐阅读</a></div></div>
<script>window.__fixture=1;</script></body></html>`;
}
const page2=page({mid:'2247551518',idx:2,name:'另一个公众号',byline:'署名乙'});

async function install(session) {
  const visits=[];
  session.protocol.handle('https',async request=>{
    const u=new URL(request.url);visits.push(u.pathname+u.search);
    const html=(body,status=200)=>new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>${body}</body></html>`,{status,headers:{'Content-Type':'text/html; charset=utf-8'}});
    if(u.hostname!=='mp.weixin.qq.com')return new Response('Blocked fixture host',{status:403});
    if(CONTROL.mode==='risk')return html('<h1>环境异常，完成验证后继续</h1>');
    if(CONTROL.mode==='blocked')return new Response('',{status:403});
    if(CONTROL.mode==='param')return html('<div class="weui-msg"><div class="weui-msg__title">参数错误</div></div>');
    if(CONTROL.mode==='deleted')return html('<div class="weui-msg__title">该内容已被发布者删除</div>');
    if(u.pathname!=='/s' && !/^\/s\/[A-Za-z0-9_-]{16,64}\/?$/.test(u.pathname))return html('<div class="weui-msg__title">参数错误</div>');
    if(u.pathname==='/s' && !u.searchParams.get('chksm'))return new Response('',{status:302,headers:{Location:'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=fixture'}});
    // A token without its own article answers with the "second article" page,
    // so a same-account, same-push pair can be told apart in acceptance.
    const second=u.pathname.endsWith('m14FixtureSecondArticle')||(u.pathname==='/s' && u.searchParams.get('idx')==='2');
    // 一篇明显超长的文章：用来验证详情正文 20 行折叠与展开。
    if(u.pathname.endsWith('m14FixtureLongArticle'))return html(page({mid:'2247551519',title:'M14 长正文验收文章',body:Array.from({length:26},(_,i)=>`<p>M14 长正文第 ${i+1} 段，用于验证超过 20 行后需要展开才能看全。</p>`).join('')}));
    return html(second?page2:page());
  });
  return {SHORT,ACCOUNT,OTHER_ACCOUNT,ARTICLES,IDS,visits,control:CONTROL};
}
module.exports={install,SHORT,ACCOUNT,OTHER_ACCOUNT,ARTICLES,IDS};