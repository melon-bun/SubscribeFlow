// Focused offline regression: first priority click and recognition enable/connection state.
// Uses the production Renderer and an isolated Core; no AI or platform requests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root, 'docs/verification/priority-recognition-20261026');

if (!process.versions.electron) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-priority-recognition-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const seed = spawnSync(runtime.python, ['-c', `
import sys,json
from pathlib import Path
from subscribe_flow.bootstrap import Core
from subscribe_flow.contracts import ContentItem,Source
c=Core(Path(sys.argv[1])/'subscribe-flow.sqlite3')
s=Source('demo','author','a','Review','https://example.invalid/a')
i=ContentItem('demo','feed','review-target',s,'Review target','https://example.invalid/item')
print(json.dumps({'id':c.repository.save_manual(i)['item_id']}))
c.settings.update('ai',{'providers':{'provider-llm':{'endpoint':'https://example.invalid/v1','model':'fake-review'}}})
c.settings.update('priority',{'smart':{'enabled':True,'providerId':'provider-llm'}})
c.close()
`, folder], {encoding:'utf8', env:{...process.env, PYTHONPATH:path.join(root, 'python/src')}});
  if (seed.status !== 0) throw new Error(seed.stderr);
  const child = spawn(require('electron'), [__filename], {stdio:'inherit', env:{...process.env,
    SUBSCRIBE_FLOW_DATA_DIR:folder, SUBSCRIBE_FLOW_RENDERER_SMOKE:'uishot',
    SUBSCRIBE_FLOW_PROBE_ITEM:JSON.parse(seed.stdout.trim()).id}});
  child.on('close', code => {fs.rmSync(folder, {recursive:true, force:true}); process.exitCode=code ?? 1;});
  return;
}

require(path.join(root, 'scripts/ui-shot-renderer.cjs')).verify = async ({window}) => {
  fs.mkdirSync(output, {recursive:true});
  const ev = code => window.webContents.executeJavaScript(code);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => {
    for (let i=0; i<150; i++) {if (await ev(code)) return; await pause(50);}
    throw new Error('Timed out: ' + code);
  };
  const shot = async name => fs.writeFileSync(path.join(output, name+'.png'), (await window.webContents.capturePage()).toPNG());
  window.setContentSize(1200, 800);
  await until('!!window.SF?.app.state.session && document.querySelectorAll(".content-card").length > 0');
  await ev(`SF.app.state.client.getPriorityStatus=async()=>({enabled:true});
    document.documentElement.dataset.theme='light';
    SF.app.state.selectedId=${JSON.stringify(process.env.SUBSCRIBE_FLOW_PROBE_ITEM)};SF.app.renderContent()`);
  await until('!!document.querySelector(".priority-grid") && [...document.querySelectorAll(".detail button")].some(b=>b.textContent.trim()==="重新判断")');
  await ev(`document.querySelector('.priority-grid').scrollIntoView({block:'center'})`);
  if(process.env.SUBSCRIBE_FLOW_PRIORITY_SCROLL==='bottom')await ev(`const d=document.querySelector('.detail__body');d.scrollTop=d.scrollHeight`);
  await pause(400);
  // Reproduce a scroll restoration between click capture and the first repaint.
  if(process.env.SUBSCRIBE_FLOW_PRIORITY_RELOCATE!=='0')await ev(`(() => {
    const update=SF.app.state.client.updateContent;
    SF.app.state.client.updateContent=function(...args){
      SF.app.state.client.updateContent=update;
      document.querySelector('.detail__body').scrollTop-=48;
      return update.apply(this,args);
    };
  })()`);
  await ev(`(() => {
    const rect = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
    window.__priorityFrames=[];window.__priorityRuns=[];
    const animate=Element.prototype.animate;
    Element.prototype.animate=function(frames,options){
      if(this.matches('.priority-grid')) __priorityRuns.push({frames,options,group:rect(this)});
      return animate.call(this,frames,options);
    };
    window.__prioritySample = () => {
      const g=document.querySelector('.priority-grid');
      const p=getComputedStyle(g,'::before');
      return {ms:performance.now()-window.__priorityStart, group:rect(g), pseudo:{transform:p.transform,opacity:p.opacity,background:p.backgroundColor,width:p.width,height:p.height},
        buttons:[...g.children].map(b=>({name:b.textContent.trim(),rect:rect(b),active:b.classList.contains('is-active'),disabled:b.disabled,
          background:getComputedStyle(b).backgroundColor,opacity:getComputedStyle(b).opacity,weight:getComputedStyle(b).fontWeight})),
        anims:document.getAnimations().filter(a=>a.effect?.target?.closest('.priority-grid')).map(a=>({type:a.constructor.name,property:a.transitionProperty,time:a.currentTime,pseudo:a.effect.pseudoElement,frames:a.effect.getKeyframes()}))};
    };
  })()`);
  const priority = [];
  for (const value of ['high','medium','auto']) {
    await until('!SF.app.isPending("content:"+SF.app.state.selectedId)');
    await pause(300);
    await ev(`window.__priorityFrames=[];window.__priorityRuns=[];window.__priorityStart=performance.now();
      __priorityFrames.push(__prioritySample());
      window.__sampling=new Promise(resolve=>{function frame(){__priorityFrames.push(__prioritySample());
        if(performance.now()-__priorityStart<450)requestAnimationFrame(frame);else resolve();}requestAnimationFrame(frame);});true;`);
    const point=await ev(`(() => {const r=document.querySelector('[data-priority-value="${value}"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    await pause(90);
    await shot('priority-'+value+'-mid');
    await ev('window.__sampling');
    priority.push({value,...await ev('({frames:__priorityFrames,runs:__priorityRuns})')});
  }
  fs.writeFileSync(path.join(output, 'priority-frames.json'), JSON.stringify(priority,null,2));
  console.log(JSON.stringify(priority.map(x=>({value:x.value,runs:x.runs.length,
    groupY:[...new Set(x.frames.map(f=>f.group.y))],
    opacity:[...new Set(x.frames.flatMap(f=>f.buttons.map(b=>b.opacity)))],
    start:x.runs[0]?.frames[0],end:x.runs.at(-1)?.frames[1]}))));
  if(process.env.SUBSCRIBE_FLOW_PRIORITY_PROBE_ONLY==='1')return;
  for(const sample of priority){
    assert.ok(sample.runs.length>0,'Priority change starts a glide');
    for(const run of sample.runs)for(const frame of run.frames){
      const point=/translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(frame.transform);
      assert.ok(point && Math.abs(Number(point[2])-3)<1,'The thumb stays inside the control when its viewport position changes');
      assert.ok(Number(point[1])>=2 && Number(point[1])+parseFloat(frame.width)<=run.group.w-2,'The thumb stays within the control horizontally');
    }
    const end=sample.frames.at(-1);
    assert.ok(end.buttons.find(b=>b.active)?.name===({high:'高',medium:'中',auto:'自动判断'})[sample.value]);
    assert.equal(end.pseudo.opacity,'0','The temporary thumb is cleared');
  }

  // An enabled/disabled recognition setting must keep its connection, including a sole Jev choice.
  await ev(`(() => {
    window.__recognitionSettings={tagging:{enabled:true,mode:'jev',providerIds:{jev:'jev',llm:'text-a'}},
      ai:{providers:{jev:{name:'Jev',configured:true,missing:[],capabilities:['candidate_classification']},
        'text-a':{name:'LLM A',configured:true,missing:[],capabilities:['text_generation']},
        'text-b':{name:'LLM B',configured:true,missing:[],capabilities:['text_generation']}}}};
    window.__recognitionPatches=[];
    SF.app.state.client.getSettings=async()=>structuredClone(__recognitionSettings);
    SF.app.state.client.saveSettings=async payload=>{
      __recognitionPatches.push(structuredClone(payload));
      Object.assign(__recognitionSettings.tagging,payload.patch);return structuredClone(__recognitionSettings);
    };
    SF.app.navigate('tags',{tab:'ai'});
  })()`);
  await until('!!document.querySelector(".tags-ai select[aria-label=\\"选择连接\\"]")');
  const noClear = await ev(`![...document.querySelectorAll('.tags-ai button')].some(b=>b.textContent.includes('不选择这条连接'))`);
  assert.equal(noClear,true,'Recognition has one enable switch, without an unselect action');
  const save = async () => {
    await ev(`[...document.querySelectorAll('.tags-ai button')].find(b=>b.textContent.trim()==='保存识别设置').click()`);
    await until('!SF.views.tags.hasRecognitionDraft()');
  };
  await ev(`document.querySelector('[aria-label="启用自动打标"]').click()`);
  await save();
  assert.equal(await ev('__recognitionSettings.tagging.enabled'),false);
  assert.equal(await ev('__recognitionSettings.tagging.providerIds.jev'),'jev');
  await ev(`document.querySelector('[aria-label="启用自动打标"]').click()`);
  await save();
  assert.equal(await ev('__recognitionSettings.tagging.enabled'),true);
  assert.equal(await ev(`document.querySelector('select[aria-label="选择连接"]').value`),'jev');
  await ev(`[...document.querySelectorAll('.mode-card')].find(b=>b.textContent.includes('LLM')).click()`);
  await ev(`const s=document.querySelector('select[aria-label="选择连接"]');s.value='text-b';s.dispatchEvent(new Event('change',{bubbles:true}))`);
  await save();
  assert.equal(await ev('__recognitionSettings.tagging.providerIds.llm'),'text-b');
  await ev(`SF.app.navigate('overview')`);
  await until('!!document.querySelector("[data-view=overview]")');
  await ev(`SF.app.navigate('tags',{tab:'ai'})`);
  await until('!!document.querySelector(".tags-ai select[aria-label=\\"选择连接\\"]")');
  assert.equal(await ev(`document.querySelector('select[aria-label="选择连接"]').value`),'text-b');
  await shot('recognition');
  // A legacy empty reference must show a real placeholder and allow reselecting the only Jev connection.
  await ev(`__recognitionSettings.tagging={enabled:false,mode:'jev',providerIds:{jev:null,llm:'text-b'}}`);
  await ev(fs.readFileSync(path.join(root,'electron/renderer/scripts/views/tags.js'),'utf8'));
  await ev('SF.app.renderContent()');
  await until(`document.querySelector('select[aria-label="选择连接"]')?.options.length===2`);
  assert.equal(await ev(`document.querySelector('select[aria-label="选择连接"]').selectedOptions[0].textContent`),'请选择连接');
  await ev(`(() => {const s=document.querySelector('select[aria-label="选择连接"]');s.value='jev';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await save();
  assert.equal(await ev(`document.querySelector('select[aria-label="选择连接"]').options.length`),1,'A selected connection has no unselect option');
  assert.equal(await ev('__recognitionSettings.tagging.providerIds.jev'),'jev');
  const result={priority:priority.map(x=>({value:x.value,runs:x.runs.length})),
    recognition:{clearActionRemoved:noClear,disableKeepsConnection:true,reenableSameConnection:true,switchConnectionSaved:true,navigationWorks:true,legacyEmptyRecoverable:true},
    patches:await ev('__recognitionPatches')};
  fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
};
require(path.join(root, 'electron/main/index.cjs'));
