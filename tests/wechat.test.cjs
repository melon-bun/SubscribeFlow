const {test}=require('node:test');
const assert=require('node:assert/strict');
const load=()=>import('../electron/main/wechat-api.mjs');

const SHORT='https://mp.weixin.qq.com/s/xU4gmCIp_MSONxdFXPwZ3g';
const PARAMS='https://mp.weixin.qq.com/s?__biz=MzIxODg1OTk1MA%3D%3D&mid=2247551517&idx=1&sn=96379061&chksm=x&scene=27';
const ID='MzIxODg1OTk1MA==_2247551517_1';
const OTHER='MzIxODg1OTk1MA==_2247551518_2';
const ACCOUNT='MzIxODg1OTk1MA==';
// A page shaped like the real one: identity variables, a #js_content body with
// inline images, and a trailing page shell that must never reach the article.
function page({id=ID,idx='1',mid='2247551517',biz=ACCOUNT,name='M14 隔离公众号',byline='署名甲',ct='1780656700',
  body='<p>第一段正文</p><p>第二段完整正文。</p><img data-src="//mmbiz.qpic.cn/mmbiz_png/a.png" />'}={}) {
  return `<!doctype html><html><head><meta property="og:title" content="页面标题" />
<script>
  var nickname = htmlDecode("${name}");
  var round_head_img = "http://mmbiz.qpic.cn/mmbiz_png/avatar.png";
  var ct = "${ct}";
  var user_name = "gh_m14fixture";
  var msg_title = '一篇公众号文章';
  var msg_desc = htmlDecode("摘要");
  var author = "${byline}";
  var biz = "${biz}" || "";
  var mid = "${mid}" || "" || "";
  var idx = "${idx}" || "" || "";
  var msg_link = "${SHORT}";
  var msg_cdn_url = "https://mmbiz.qpic.cn/mmbiz_jpg/cover.jpeg";
</script></head><body>
<div class="rich_media_area"><div id="js_content" style="visibility: hidden;">${body}</div>
<div id="js_article_bottom_bar"><span>阅读 10 万</span><a href="/s/other">推荐阅读</a></div></div>
<script>window.__addLine = 1;</script></body></html>`;
}
function responder(control={}) {
  const visits=[];
  const html=(body,status=200)=>new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8'}});
  const fetch=async (value, options={})=>{
    visits.push({url:String(value),ua:options.headers['User-Agent'],credentials:options.credentials,redirect:options.redirect});
    const u=new URL(value);
    if(control.mode==='blocked')return new Response('',{status:403});
    if(control.mode==='rate')return new Response('',{status:429});
    if(control.mode==='captcha')return new Response('',{status:302,headers:{location:'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=x'}});
    if(control.mode==='offsite')return new Response('',{status:302,headers:{location:'https://example.com/article'}});
    if(control.mode==='loop')return new Response('',{status:302,headers:{location:`https://mp.weixin.qq.com${u.pathname}`}});
    if(control.mode==='risk')return html('<html><body><h1>环境异常</h1><a href="/mp/wappoc_appmsgcaptcha">去验证</a></body></html>');
    if(control.mode==='unknown')return html('<html><body>未知错误，请稍后再试</body></html>');
    if(control.mode==='param')return html('<html><body><div class="weui-msg"><div class="weui-msg__title">参数错误</div></div></body></html>');
    if(control.mode==='deleted')return html('<html><body><div class="weui-msg__title">该内容已被发布者删除</div></body></html>');
    if(control.mode==='huge')return new Response('x'.repeat(9*1024*1024),{status:200,headers:{'content-type':'text/html'}});
    if(control.mode==='ok')return html(page(control.page||{}));
    return new Response('not found',{status:404});
  };
  return {fetch,visits};
}
const reader=(control={})=>load().then(({WechatAPI})=>new WechatAPI(responder(control),{minGap:0,readTimeout:2000}));

test('official article links normalise; everything else is refused', async()=>{
  const {parseArticleURL}=await load();
  assert.equal(parseArticleURL(SHORT).url.href, SHORT);
  assert.equal(parseArticleURL(SHORT).form, 'short');
  assert.equal(parseArticleURL('http://mp.weixin.qq.com/s/xU4gmCIp_MSONxdFXPwZ3g').url.href, SHORT);
  assert.equal(parseArticleURL(PARAMS).form, 'params');
  for (const bad of ['https://mp.weixin.qq.com/s/short','https://mp.weixin.qq.com/mp/homepage',
    'https://example.com/s/xU4gmCIp_MSONxdFXPwZ3g','https://user:pw@mp.weixin.qq.com/s/xU4gmCIp_MSONxdFXPwZ3g',
    'https://mp.weixin.qq.com:8443/s/xU4gmCIp_MSONxdFXPwZ3g','javascript:alert(1)','',
    'https://mp.weixin.qq.com/s?__biz=MzIxODg1OTk1MA==&mid=2247551517']) {
    assert.throws(()=>parseArticleURL(bad), bad);
  }
});

test('page identity, body and cover come from the page itself', async()=>{
  const {parseArticle}=await load();
  const row=parseArticle(page(), new URL(SHORT));
  assert.equal(row.id, ID);
  assert.equal(row.account.id, ACCOUNT);
  assert.equal(row.account.name, 'M14 隔离公众号');
  assert.equal(row.title, '一篇公众号文章');
  assert.equal(row.content, '第一段正文\n第二段完整正文。');
  assert.deepEqual(row.images, ['https://mmbiz.qpic.cn/mmbiz_png/a.png']);
  assert.equal(row.account.avatar, 'https://mmbiz.qpic.cn/mmbiz_png/avatar.png');
  assert.equal(row.cover[0], 'https://mmbiz.qpic.cn/mmbiz_jpg/cover.jpeg');
  assert.equal(row.url, SHORT);
  assert.equal(row.published.value, '2026-06-05T18:51:40+08:00');
  assert.equal(row.published.precision, 'second');
  assert.equal(row.acquisition_complete, true);
});

test('body excludes menus, counters and scripts', async()=>{
  const {parseArticle}=await load();
  const row=parseArticle(page({body:'<p>正文</p>'}), new URL(SHORT));
  for (const noise of ['阅读','推荐阅读','window.__addLine','rich_media_area']) assert.ok(!row.content.includes(noise), noise);
});

test('another article of the same push keeps a separate key', async()=>{
  const {parseArticle}=await load();
  assert.equal(parseArticle(page({mid:'2247551518',idx:'2'}), new URL(SHORT)).id, OTHER);
});

test('missing identity is refused instead of invented', async()=>{
  const {parseArticle}=await load();
  assert.throws(()=>parseArticle(page({biz:''}), new URL(SHORT)), /稳定文章身份/);
  assert.throws(()=>parseArticle(page({name:''}), new URL(SHORT)), /公众号身份/);
  const unknown=parseArticle(page({ct:'99999999999'}), new URL(SHORT));
  assert.equal(unknown.published.precision, 'unknown');
  assert.equal(unknown.published.value, null);
});

test('blocked pages are classified by body evidence, not by status', async()=>{
  const cases=[['blocked','INTERACTION_REQUIRED'],['rate','RATE_LIMITED'],['captcha','INTERACTION_REQUIRED'],
    ['risk','INTERACTION_REQUIRED'],['unknown','ACCESS_FAILED'],['param','NOT_FOUND'],['deleted','NOT_FOUND'],
    ['huge','SCHEMA_CHANGED'],['missing','NOT_FOUND']];
  for (const [mode,code] of cases) {
    await assert.rejects((await reader({mode})).request({channel:'wechat',operation:'resolve',url:SHORT}),
      error=>{assert.equal(error.code, code, mode); return true;}, mode);
  }
});

test('offsite and endless redirects stop the read', async()=>{
  await assert.rejects((await reader({mode:'offsite'})).request({channel:'wechat',operation:'resolve',url:SHORT}), /非官方地址/);
  await assert.rejects((await reader({mode:'loop'})).request({channel:'wechat',operation:'resolve',url:SHORT}), /跳转次数过多/);
});

test('requests carry a browser agent, no credentials and manual redirects', async()=>{
  const control={mode:'ok'},transport=responder(control);
  const {WechatAPI}=await load();
  const api=new WechatAPI(transport,{minGap:0,readTimeout:2000});
  const result=await api.request({channel:'wechat',operation:'resolve',url:SHORT});
  assert.equal(result.article.id, ID);
  assert.equal(transport.visits.length, 1);
  assert.match(transport.visits[0].ua, /Mozilla\/5\.0 .*Chrome/);
  assert.equal(transport.visits[0].credentials, 'omit');
  assert.equal(transport.visits[0].redirect, 'manual');
});

test('the read of one preview reuses the page already confirmed', async()=>{
  const transport=responder({mode:'ok'});
  const {WechatAPI}=await load();
  const api=new WechatAPI(transport,{minGap:0,readTimeout:2000});
  const reference=(await api.request({channel:'wechat',operation:'resolve',url:SHORT})).article;
  const before=transport.visits.length;
  const read=await api.request({channel:'wechat',operation:'read',url:reference.url,id:reference.id});
  assert.equal(read.article.id, reference.id);
  assert.equal(transport.visits.length, before, '不重复读取同一篇文章');
  await assert.rejects(api.request({channel:'wechat',operation:'read',url:reference.url,id:'bad id'}), /身份无效/);
  await assert.rejects(api.request({channel:'wechat',operation:'read',url:reference.url,id:OTHER}), /与预览身份不一致/);
});

test('requests outside the declared shape are refused before any request', async()=>{
  const {validateRequest}=await load();
  for (const bad of [{channel:'bilibili',operation:'resolve',url:SHORT},
    {channel:'wechat',operation:'resolve',url:SHORT,extra:1},
    {channel:'wechat',operation:'list',url:SHORT},
    {channel:'wechat',operation:'read',url:SHORT,id:'a b'}]) {
    assert.throws(()=>validateRequest(bad));
  }
  assert.doesNotThrow(()=>validateRequest({channel:'wechat',operation:'read',url:SHORT,id:ID}));
});