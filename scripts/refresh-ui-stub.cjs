const {contextBridge} = require('electron');
const listeners = {}, calls = {};
let step = 0, state = 'running', delay = 250, fail = false;
const rows = Array.from({length:40}, (_,i) => ({
  id:'fixture-'+i, title:'离线阅读内容 '+i, summary:'用于验证采集更新不会打断阅读。'.repeat(12),
  platform:i%2?'zhihu':'xiaohongshu', kind:'note', channelId:'source', channelName:'离线作者', author:'离线作者',
  url:'https://example.invalid/'+i, publishedAt:'2026-10-20', publishedPrecision:'date',
  state:{read:false,archived:false,deferred:false}, tags:[], priority:null,
}));
const session = {user:{name:'采集刷新验证'}, capabilities:{canManageTags:true,canManageChannels:true},
  connection:{state:'ready',dependency:'available',authentication:'not_required',actions:[]}, connections:[],channels:[]};
const emit = (name, data) => {for(const fn of listeners[name] || []) fn(data);};
const bridge = {async call(name,args) {
  calls[name]=(calls[name]||0)+1;
  switch(name) {
    case 'core.status': return {state:'ready'};
    case 'getSession': return session;
    case 'getCounts': return {total:rows.length,unread:rows.length};
    case 'listPlatforms': return ['xiaohongshu','zhihu'].map(id=>({id,count:rows.filter(row=>row.platform===id).length}));
    case 'listPriorities': return [];
    case 'getRuns': return [{id:'scan',channelId:'source',channelName:'离线采集',kind:'refresh',state,items:step,newItems:step,pages:step,message:'已采集 '+step+' 条',startedAt:Date.now()-10000}];
    case 'listContents': {
      const query=args[0]||{}, matching=rows.filter(row=>(!query.platform||row.platform===query.platform)&&(!query.search||row.title.includes(query.search)));
      const result={items:matching.slice(query.offset||0,(query.offset||0)+(query.limit||20)),total:matching.length,next_offset:null};
      const shouldFail=fail; fail=false;
      await new Promise(resolve=>setTimeout(resolve,delay));
      if(shouldFail) throw new Error('后台读取模拟失败');
      return result;
    }
    case 'getContent': return rows.find(row=>row.id===args[0]);
    case 'getNote': return null;
    case 'getSettings': return {summarization:{enabled:false}};
    case 'listTags': case 'listContentSources': case 'listChannels': return {items:[],total:0};
    default: throw new Error('Refresh stub missing '+name);
  }
}, on(name,fn) {(listeners[name]||=new Set()).add(fn);return ()=>listeners[name].delete(fn);}};
contextBridge.exposeInMainWorld('SubscribeFlow',bridge);
contextBridge.exposeInMainWorld('RefreshFixture',{
  calls:()=>({...calls}), total:()=>rows.length,
  emit, delay:value=>{delay=value;}, fail:()=>{fail=true;},
  progress:(content,platform='xiaohongshu')=>{
    step++; state='running';
    if(content) rows.unshift({...rows[0],id:'new-'+step,title:'新采集内容 '+step,platform});
    emit('content.changed',{ids:content?['new-'+step]:[]}); emit('content',null);
    emit('sync.changed',{id:'scan',state}); emit('run',null); emit('runs',null);
  },
  finish:value=>{state=value;emit('sync.changed',{id:'scan',state});emit('run',null);},
});
