const {test} = require('node:test');
const assert = require('node:assert/strict');
const {BilibiliAPI, validateRequest, signedQuery} = require('../electron/main/bilibili-api.cjs');
const nav = {code:-101,data:{wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'}}};
test('WBI request uses fixed endpoints, exact parameters and correct space encoding',async () => {
  const urls=[];
  const api=new BilibiliAPI(async(url,options)=> {
    urls.push(new URL(url));
    assert.equal(options.credentials,'include'); assert.equal(options.redirect,'error');
    return new Response(JSON.stringify(urls.length===1?nav:{code:-352,message:'platform challenge',data:null}));
  });
  assert.equal((await api.request({operation:'search',query:'hello world!',limit:20},new AbortController().signal)).code,-352);
  assert.equal(urls[1].pathname,'/x/web-interface/wbi/search/type');
  assert.equal(urls[1].searchParams.get('keyword'),'hello world');
  assert.match(urls[1].search,/%20/); assert.match(urls[1].searchParams.get('w_rid'),/^[a-f0-9]{32}$/);
  assert.equal(signedQuery({foo:'114',bar:'514',zab:1919810},nav,1702204169000),
    'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
});
test('acquisition rejects arbitrary URLs, scripts, wrong IDs and extra fields',() => {
  for(const p of [{operation:'fetch',url:'https://example.com'}, {operation:'check',url:'https://example.com'},
    {operation:'list',uid:'1',page:true,limit:20}, {operation:'list',uid:'1&x=y',page:1,limit:20},
    {operation:'search',query:'',limit:20}, {operation:'detail',bvid:'https://example.com'}]) assert.throws(()=>validateRequest(p));
});
test('session check exposes only authenticated flag, never identity or cookies',async () => {
  const api=new BilibiliAPI(async()=>new Response(JSON.stringify({code:0,data:{isLogin:true,mid:123,uname:'private',wbi_img:{}}})));
  assert.deepEqual(await api.request({operation:'check'},new AbortController().signal),{code:0,data:{authenticated:true}});
});
test('HTTP failures, malformed content and cancellation remain distinct',async () => {
  for(const [status,code,retryable] of [[429,'RATE_LIMITED',true],[412,'INTERACTION_REQUIRED',false],[503,'ACCESS_FAILED',true]]) {
    const api=new BilibiliAPI(async()=>new Response('',{status}));
    await assert.rejects(api.request({operation:'check'},new AbortController().signal),e=>e.code===code && e.retryable===retryable);
  }
  const invalid=new BilibiliAPI(async()=>new Response('<html>blocked</html>'));
  await assert.rejects(invalid.request({operation:'check'},new AbortController().signal),e=>e.code==='SCHEMA_CHANGED');
  const controller=new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(invalid.request({operation:'check'},controller.signal),/cancelled/);
});
