const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../../../..');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-codex-priority-'));
const runtime = JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json'),'utf8'));
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
c.database.close();c.lease.close()
`, folder], {encoding:'utf8', env:{...process.env,PYTHONPATH:path.join(root,'python/src')}});
if(seed.status!==0) throw new Error(seed.stderr);
const itemId=JSON.parse(seed.stdout.trim()).id;
process.env.SUBSCRIBE_FLOW_RENDERER_SMOKE='uishot';
process.env.SUBSCRIBE_FLOW_DATA_DIR=folder;
require(path.join(root,'scripts/ui-shot-renderer.cjs')).verify=async({window,core})=>{
 const evaluate=async s=>{try{return await window.webContents.executeJavaScript(s);}catch(e){throw new Error(e.message+"\nSOURCE: "+s);}};
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async s=>{for(let i=0;i<150;i++){if(await evaluate(s).catch(()=>false))return;await pause(50);}throw new Error('wait: '+s);};
 await until('!!window.SF?.app.state.session');
 await evaluate(`SF.app.state.selectedId=${JSON.stringify(itemId)};SF.app.renderContent()`);
 await until('!!document.querySelector(".detail")');
 await pause(300);
 const before=await core.call('priority.status');
 await core.call('settings.update',{section:'priority',patch:{smart:{enabled:true,providerId:'provider-llm'}}});
 await evaluate(`SF.app.openSettings('priority')`);
 await until('!!document.querySelector(".settings")');
 await evaluate(`SF.app.navigate('inbox');SF.app.state.selectedId=${JSON.stringify(itemId)};SF.app.renderContent()`);
 await pause(800);
 const after=await core.call('priority.status');
 const button=await evaluate(`Array.from(document.querySelectorAll('.detail button')).some(b=>b.textContent.trim()==='重新判断')`);
 const types=await evaluate(`({status:typeof SF.app.state.client.getPriorityStatus,judge:typeof SF.app.state.client.judgePriority})`);
 const raw=await evaluate(`SubscribeFlow.request('getPriorityStatus')`);
 const result={beforeEnabled:before.enabled,afterEnabled:after.enabled,rejudgeButtonVisible:button,clientTypes:types,rawStatus:raw,detailVisible:await evaluate(`!!document.querySelector(".detail")`),body:await evaluate(`document.body.innerText.slice(0,350)`),itemId};
 fs.writeFileSync(path.join(__dirname,'codex-rejudge-probe.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
};
require(path.join(root,'electron/main/index.cjs'));
