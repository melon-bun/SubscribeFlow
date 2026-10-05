const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-icon-'));
app.setPath('userData',folder);
app.whenReady().then(async()=>{
  const target=process.argv[2];
  const svg=fs.readFileSync(path.join(__dirname,'../packaging/icon.svg'),'utf8');
  const window=new BrowserWindow({width:1024,height:1024,useContentSize:true,show:false,frame:false,transparent:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<style>html,body{margin:0;width:1024px;height:1024px;background:transparent}svg{width:1024px;height:1024px}</style>'+svg));
  await window.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const image=await window.webContents.capturePage();
  fs.mkdirSync(target,{recursive:true});
  for(const size of [16,32,128,256,512]) for(const scale of [1,2]) {
    fs.writeFileSync(path.join(target,`icon_${size}x${size}${scale===2?'@2x':''}.png`),image.resize({width:size*scale,height:size*scale}).toPNG());
  }
  window.destroy();app.quit();
}).catch(error=>{console.error(error.message);app.exit(1);});
app.on('quit',()=>fs.rmSync(folder,{recursive:true,force:true}));
