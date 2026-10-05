const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.join(__dirname,'..');
const source=path.join(root,'assets','logo.png');
const target=process.argv[2];
if(!fs.existsSync(source)) throw new Error(`缺少应用图标源文件：${source}`);
// 源图是白底方图，先裁掉四周留白再放进 macOS 圆角画布，否则小尺寸下标记几乎看不清。
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-icon-'));
app.setPath('userData',folder);
app.whenReady().then(async()=>{
  const dataUrl='data:image/png;base64,'+fs.readFileSync(source).toString('base64');
  const window=new BrowserWindow({width:1024,height:1024,useContentSize:true,show:false,frame:false,transparent:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<style>html,body{margin:0;width:1024px;height:1024px;background:transparent}canvas{display:block}</style><canvas id="c" width="1024" height="1024"></canvas>'));
  const png=await window.webContents.executeJavaScript(`(async()=>{
    const size=1024, inset=Math.round(size*.15), corner=Math.round(size*.2237);
    const img=new Image(); img.src=${JSON.stringify(dataUrl)}; await img.decode();
    const probe=document.createElement('canvas'); probe.width=img.naturalWidth; probe.height=img.naturalHeight;
    const pctx=probe.getContext('2d'); pctx.drawImage(img,0,0);
    const {data,width,height}=pctx.getImageData(0,0,probe.width,probe.height);
    let minX=width,minY=height,maxX=-1,maxY=-1;
    for(let y=0;y<height;y++) for(let x=0;x<width;x++){
      const i=(y*width+x)*4;
      if(data[i]<245||data[i+1]<245||data[i+2]<245){
        if(x<minX)minX=x; if(x>maxX)maxX=x;
        if(y<minY)minY=y; if(y>maxY)maxY=y;
      }
    }
    if(maxX<0) throw new Error('源图没有可识别的图形内容');
    const mark=document.createElement('canvas');
    mark.width=maxX-minX+1; mark.height=maxY-minY+1;
    mark.getContext('2d').drawImage(img,minX,minY,mark.width,mark.height,0,0,mark.width,mark.height);
    const ctx=document.getElementById('c').getContext('2d');
    ctx.clearRect(0,0,size,size);
    ctx.fillStyle='#ffffff';
    ctx.beginPath();
    ctx.moveTo(corner,0); ctx.lineTo(size-corner,0); ctx.quadraticCurveTo(size,0,size,corner);
    ctx.lineTo(size,size-corner); ctx.quadraticCurveTo(size,size,size-corner,size);
    ctx.lineTo(corner,size); ctx.quadraticCurveTo(0,size,0,size-corner);
    ctx.lineTo(0,corner); ctx.quadraticCurveTo(0,0,corner,0);
    ctx.closePath(); ctx.fill();
    const box=size-inset*2, scale=Math.min(box/mark.width,box/mark.height);
    const w=mark.width*scale, hgt=mark.height*scale;
    ctx.drawImage(mark,(size-w)/2,(size-hgt)/2,w,hgt);
    return document.getElementById('c').toDataURL('image/png').split(',')[1];
  })()`);
  // The canvas above only validates the geometry; capturePage returns the composited window.
  if (!png) throw new Error('图标画布未能生成');
  const shot=await window.webContents.capturePage();
  window.destroy();app.quit();
  fs.mkdirSync(target,{recursive:true});
  for(const size of [16,32,128,256,512]) for(const scale of [1,2]) {
    fs.writeFileSync(path.join(target,`icon_${size}x${size}${scale===2?'@2x':''}.png`),shot.resize({width:size*scale,height:size*scale}).toPNG());
  }
}).catch(error=>{console.error(error.message);app.exit(1);});
app.on('quit',()=>fs.rmSync(folder,{recursive:true,force:true}));
