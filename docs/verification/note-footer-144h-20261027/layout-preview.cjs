const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const phase=process.argv[2]||'before',out=path.join(root,'docs/verification/note-footer-144h-20261027');
const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'sf-note-footer-'));app.setPath('userData',isolated);
const renderer=path.join(root,'electron/renderer');
const css=['tokens','base','layout','components','views','settings','intake','fx','zhiliu'];
const scripts=['core/dom','core/icons','core/format','core/catalog','core/tag-catalog','ui/tooltip','ui/components','ui/note-editor'];
if(phase==='before'){for(const [source,name] of [['electron/renderer/styles/components.css','components.css'],['electron/renderer/scripts/ui/note-editor.js','note-editor.js']]){const old=spawnSync('git',['show','25aea7c:'+source],{cwd:root,encoding:'utf8'});if(old.status!==0)throw Error(old.stderr);fs.writeFileSync(path.join(isolated,name),old.stdout);}}
const html=`<!doctype html><html lang="zh-CN" data-theme="light" data-fx="on"><meta charset="utf-8">${css.map(x=>`<link rel="stylesheet" href="file://${phase==='before'&&x==='components'?path.join(isolated,'components.css'):path.join(renderer,'styles',x+'.css')}">`).join('')}<style>body{display:block;overflow:auto;padding:24px;background:var(--c-bg)}#host{width:360px}.note-editor{margin:0}</style><div id="host"></div>${scripts.map(x=>`<script src="file://${phase==='before'&&x==='ui/note-editor'?path.join(isolated,'note-editor.js'):path.join(renderer,'scripts',x+'.js')}"></script>`).join('')}<script>
window.note=null;window.saved=0;window.client={getNote:()=>Promise.resolve(window.note),getSettings:()=>Promise.resolve({summarization:{enabled:false}}),saveNote:(_id,payload)=>{window.saved++;window.note={template:payload.template,summary:payload.summary,takeaway:payload.takeaway,summary_origin:'manual',verdict:null,version:'fixture-'+window.saved,updated_at:'2026-10-27T11:27:00+09:00'};return Promise.resolve(window.note)}};
window.paint=()=>document.getElementById('host').replaceChildren(SF.noteUi.noteEditor({itemId:'note-layout',client:window.client,repaint:window.paint}));
window.paint();
</script></html>`;
const page=path.join(isolated,'page.html');fs.writeFileSync(page,html);
app.whenReady().then(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const win=new BrowserWindow({width:900,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true}});
 await win.loadFile(page);const ev=code=>win.webContents.executeJavaScript(code);
 const wait=async code=>{for(let i=0;i<80;i++){if(await ev(code))return;await new Promise(r=>setTimeout(r,25));}throw Error('timeout '+code)};
 await wait("!!document.querySelector('select[aria-label=笔记类型]')");
 await ev("(()=>{const t=document.querySelector('select[aria-label=笔记类型]');t.value='general';t.dispatchEvent(new Event('change',{bubbles:true}));})()");
 await wait("!!document.querySelector('textarea[aria-label=总结]')");
 await ev("(()=>{const t=document.querySelector('textarea[aria-label=总结]');t.value='布局验收';t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.note-editor__actions .btn--primary').click();})()");
 await wait("window.saved===1&&!![...document.querySelectorAll('button')].find(b=>b.textContent==='删除这条笔记')");
 const results=[];
 for(const theme of ['light','dark'])for(const width of [280,320,360,420,640]){
   await ev(`document.documentElement.dataset.theme='${theme}';document.getElementById('host').style.width='${width}px'`);
   await ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
   const sample=await ev(`(()=>{const row=document.querySelector('.note-editor__actionbar>.note-editor__actions'),buttons=[...row.querySelectorAll('button')];return {width:${width},theme:'${theme}',rowOverflow:row.scrollWidth-row.clientWidth,buttons:buttons.map(b=>{const r=b.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(b.querySelector('span'));const label=range.getBoundingClientRect(),s=getComputedStyle(b);return {text:b.textContent,width:r.width,labelWidth:label.width,deficit:label.width+parseFloat(s.paddingLeft)+parseFloat(s.paddingRight)-r.width,centerError:Math.abs((label.left+label.right-r.left-r.right)/2)}})}})()`);
   results.push(sample);
   if(width===360){await new Promise(r=>setTimeout(r,150));fs.writeFileSync(path.join(out,`${phase}-${theme}.png`),(await win.webContents.capturePage()).toPNG());}
 }
 fs.writeFileSync(path.join(out,`${phase}.json`),JSON.stringify(results,null,2)+'\n');
 console.log(JSON.stringify({phase,samples:results.length,clipped:results.filter(s=>s.buttons.some(b=>b.deficit>0.5)).length,offCenter:results.filter(s=>s.buttons.some(b=>b.centerError>0.5)).length,overflow:results.filter(s=>s.rowOverflow>1).length}));
 win.destroy();
}).then(()=>{fs.rmSync(isolated,{recursive:true,force:true});app.exit(0)}).catch(e=>{console.error(e);fs.rmSync(isolated,{recursive:true,force:true});app.exit(1)});
