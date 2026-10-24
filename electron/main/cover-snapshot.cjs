const {BrowserWindow}=require('electron');

function allowedCover(raw) {
  try {
    const u=new URL(raw);
    return typeof raw==='string' && raw.length<=4096 && u.protocol==='https:' && !u.username && !u.password && !u.port &&
      (u.hostname.endsWith('.xhscdn.com') || u.hostname.endsWith('.xiaohongshu.com'));
  } catch {return false;}
}

// Offscreen rendering gives hidden collection a real frame without showing or
// focusing any window. The image uses the existing channel session and referrer.
async function captureCover(session,url,outerSignal) {
  if(!allowedCover(url))return null;
  const signal=AbortSignal.any([...(outerSignal?[outerSignal]:[]),AbortSignal.timeout(4000)]);
  signal.throwIfAborted();
  const win=new BrowserWindow({width:96,height:72,useContentSize:true,frame:false,show:false,skipTaskbar:true,
    webPreferences:{session,offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false,backgroundThrottling:false}});
  const wc=win.webContents,abort=()=>{if(!win.isDestroyed())win.destroy();};
  signal.addEventListener('abort',abort,{once:true});
  wc.setWindowOpenHandler(()=>({action:'deny'}));
  for(const event of ['will-navigate','will-redirect'])wc.on(event,(e,target)=>{if(!allowedCover(target))e.preventDefault();});
  try {
    await wc.loadURL(url,{httpReferrer:'https://www.xiaohongshu.com/'});
    signal.throwIfAborted();
    const loaded=await wc.executeJavaScript('!!document.images[0] && document.images[0].complete && document.images[0].naturalWidth>0');
    if(!loaded)return null;
    await wc.insertCSS('html,body{margin:0!important;padding:0!important;width:96px!important;height:72px!important;overflow:hidden!important;background:#fff!important}img{display:block!important;position:static!important;width:96px!important;height:72px!important;max-width:none!important;max-height:none!important;margin:0!important;object-fit:cover!important;object-position:center!important;transform:none!important}');
    await wc.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const image=await wc.capturePage({x:0,y:0,width:96,height:72},{stayHidden:true,stayAwake:true});
    signal.throwIfAborted();
    if(image.isEmpty())return null;
    const jpeg=image.resize({width:192,height:144,quality:'good'}).toJPEG(80);
    return jpeg.length<=36*1024 ? 'data:image/jpeg;base64,'+jpeg.toString('base64') : null;
  } finally {
    signal.removeEventListener('abort',abort);abort();
  }
}
module.exports={captureCover,allowedCover};
