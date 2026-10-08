// Offline platform fixture below the actual private API, Adapter and Core.
const {BilibiliAPI} = require('../electron/main/bilibili-api.cjs');
const BVID='BV1xx411c700';
function bilibiliAPI() {
  const visits=[];
  const api=new BilibiliAPI(async (raw,options) => {
    options.signal?.throwIfAborted();
    const u=new URL(raw); visits.push(u.origin+u.pathname);
    if(u.hostname==='b23.tv') return new Response(null,{status:302,headers:{location:`https://www.bilibili.com/video/${BVID}`}});
    if(u.hostname!=='api.bilibili.com') throw new Error('Unexpected fixture endpoint');
    if(u.pathname==='/x/web-interface/nav') return Response.json({code:0,data:{isLogin:true}});
    if(u.pathname==='/x/web-interface/view') return Response.json({code:0,data:{bvid:u.searchParams.get('bvid')||BVID,aid:123,
      title:'M13 隔离视频',desc:'用于验证真实 Core 的自主添加流程',owner:{mid:946974,name:'验收作者'},pubdate:946684800,duration:90}});
    throw new Error('Unexpected fixture operation');
  });
  return {api,visits,BVID};
}
async function install(bilibili,xiaohongshu) {
  const bili=bilibiliAPI(); bilibili.api=bili.api;
  const xhs=require('./xiaohongshu-fixture.cjs').install(xiaohongshu.session);
  await xiaohongshu.session.cookies.set({url:'https://www.xiaohongshu.com',name:'fixture_session',value:'logged-in',secure:true});
  return {bili,xhs};
}
module.exports={install,bilibiliAPI,BVID};
