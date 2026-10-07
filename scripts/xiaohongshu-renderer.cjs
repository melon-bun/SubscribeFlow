const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
async function verify({window,core,root,xiaohongshu,fixture}) {
  const evaluate=code=>window.webContents.executeJavaScript(code);
  const until=async expression=>{
    const end=Date.now()+20000;
    while(!await evaluate(expression)) {
      if(Date.now()>end)throw new Error('Renderer timed out: '+expression+'\n'+await evaluate('document.body.innerText'));
      await new Promise(r=>setTimeout(r,70));
    }
  };
  const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)} || b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b || b.disabled)throw new Error('Missing button: '+${JSON.stringify(label)});b.click();})()`);
  const output=path.join(root,'docs/verification/m10-xiaohongshu');await fs.mkdir(output,{recursive:true});
  const screenshot=async name=>{await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await fs.writeFile(path.join(output,name),(await window.webContents.capturePage()).toPNG());};
  await until('!!window.SF?.app.state.session');
  assert.equal((await core.call('channel.list')).length,2);
  await evaluate("SF.app.navigate('channels')");await until("!!document.querySelector('.channels__toolbar')");
  await click('添加渠道或创作者');
  await evaluate("(()=>{document.querySelector('[data-connection-id=\"xiaohongshu:default\"]').click();document.querySelector('#source-input').value='同名作者';document.querySelector('#source-input').dispatchEvent(new Event('input',{bubbles:true}));})()");
  assert.equal(await evaluate("!!document.querySelector('.source-platforms select')"),false);
  assert.equal(await evaluate("document.querySelector('[data-connection-id=\"xiaohongshu:default\"]').getAttribute('aria-pressed')"),'true');
  // Delay the actual search response to inspect every control and close path.
  await evaluate("(()=>{const client=SF.app.state.client;window.savedSearch=client.searchSources;client.searchSources=async function(q){await new Promise(r=>setTimeout(r,200));return window.savedSearch.call(client,q);};})()");
  await click('搜索作者');await until("!!document.querySelector('.dialog .field__error')?.textContent");
  assert.match(await evaluate("document.querySelector('.dialog .field__error').textContent"),/登录/);
  assert.equal(xiaohongshu.host.isVisible(),false);
  await evaluate('SF.app.state.client.searchSources=window.savedSearch;void 0');
  await click('应用内登录');
  for(let i=0;i<100 && !xiaohongshu.loginVisible;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(xiaohongshu.host.isVisible(),true);
  await xiaohongshu.view.webContents.executeJavaScript("document.querySelector('#fixture-login').click()");
  xiaohongshu.host.close();
  for(let i=0;i<100 && xiaohongshu.loginVisible;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(xiaohongshu.host.isVisible(),false);
  await evaluate("SF.app.state.client.searchSources=async function(q){await new Promise(r=>setTimeout(r,200));return window.savedSearch.call(SF.app.state.client,q);};void 0");
  await click('搜索作者');
  assert.equal(await evaluate("[...document.querySelectorAll('.dialog button, .dialog input')].every(c=>c.disabled)"),true);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.querySelector('.dialog-mask').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));");
  assert.equal(await evaluate("!!document.querySelector('.dialog')"),true);
  await until("document.querySelectorAll('.source-candidate').length===2");
  await evaluate('SF.app.state.client.searchSources=window.savedSearch;void 0');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"关闭对话框\"]').disabled"),false);
  assert.equal(await evaluate("document.querySelector('#source-confirm').disabled"),true);
  await screenshot('author-candidates-light.png');
  await evaluate(`document.querySelector('[data-source-id="${fixture.UID}"]').click()`);
  await click('确认添加').catch(()=>{}); // Must still be disabled until explicit account confirmation.
  assert.equal((await core.call('subscription.list')).length,0);
  await evaluate("document.querySelector('#source-confirm').click()");await click('确认添加');
  await until("document.querySelectorAll('[data-channel-id]').length===1 && !document.querySelector('.dialog')");
  const sub=(await core.call('subscription.list'))[0];assert.equal(sub.external_id,fixture.UID);assert.equal(sub.name,'同名作者');
  await click('刷新来源');
  await until("SF.app.state.runs.some(r=>r.state==='succeeded' && r.newItems===3)");
  const items=await core.call('content.list');assert.equal(items.total,3);assert.equal(items.items.filter(i=>i.published.value===null).length,1);
  for(const item of items.items)assert.equal(new URL(item.url).searchParams.get('xsec_source'),'pc_share');
  assert.equal(await xiaohongshu.view.webContents.executeJavaScript('window.fixtureClipboardWrites'),0);
  assert.equal(await xiaohongshu.view.webContents.executeJavaScript('navigator.clipboard.writeText===window.fixtureOriginalClipboard && !window.__SF_XHS_SHARE_CAPTURE__'),true);
  assert.equal(xiaohongshu.host.isVisible(),false);
  const key='xiaohongshu:note:'+fixture.IDS[0];
  await core.call('content.update',{item_id:key,patch:{priority:'high',read:true}});
  const tag=await core.call('tag.create',{name:'M10验收标签'});await core.call('content.set_tags',{item_id:key,tag_ids:[tag.id]});
  // A fourth older note exists but must not fill a skipped slot in a size-3 window.
  fixture.IDS.push('444444444444444444444444');
  await click('设置采集条数');
  assert.match(await evaluate("document.querySelector('.dialog').textContent"),/已收录的也占名额/);
  await evaluate("document.querySelector('#collect-items').value='3'");await click('保存采集条数');
  await until("!document.querySelector('.dialog')");
  assert.equal((await core.call('subscription.list'))[0].collect_items,3);
  const detailVisits=fixture.visits.filter(u=>/\/explore\/[a-f0-9]{24}$/.test(u)).length;
  await click('刷新来源');await until("SF.app.state.runs.some(r=>r.state==='succeeded' && r.acquisitionMetrics?.skipped===3)");
  assert.equal(fixture.visits.filter(u=>/\/explore\/[a-f0-9]{24}$/.test(u)).length,detailVisits);
  assert.equal((await core.call('content.list')).total,3);
  assert.ok(!fixture.visits.some(u=>u.includes('444444444444444444444444')));
  let saved=await core.call('content.get',{item_id:key});assert.equal(saved.state.read,true);assert.equal(saved.priority,'high');assert.equal(saved.tags[0].id,tag.id);
  const platforms=await evaluate('SF.app.state.session.channels.map(c=>c.channel)');assert.deepEqual(platforms,['bilibili','xiaohongshu']);
  await screenshot('channels-light.png');
  await evaluate("document.documentElement.dataset.theme='dark'");await screenshot('channels-dark.png');
  window.setSize(1024,760);await screenshot('channels-compact.png');
  await core.restart();saved=await core.call('content.get',{item_id:key});assert.equal(saved.tags[0].id,tag.id);
  await window.reload();await until('!!window.SF?.app.state.session');
  await evaluate("SF.app.navigate('inbox')");await until("document.querySelectorAll('.content-card').length===2");
  await screenshot('inbox-dark.png');
  // Expire only the synthetic isolated session. Persisted notes remain readable.
  await xiaohongshu.session.cookies.remove('https://www.xiaohongshu.com','fixture_session');
  await xiaohongshu.view.webContents.loadURL('https://www.xiaohongshu.com/explore');
  assert.equal((await core.call('connection.check',{connection_id:'xiaohongshu:default'})).authentication,'required');
  assert.equal((await core.call('content.list')).total,3);
  await evaluate("SF.app.navigate('channels')");await until("!!document.querySelector('.channels__toolbar')");await click('添加渠道或创作者');
  await evaluate(`(()=>{document.querySelector('[data-connection-id="xiaohongshu:default"]').click();document.querySelector('#source-input').value='超时测试';const client=SF.app.state.client;window.savedSearch=client.searchSources;client.searchSources=()=>new Promise(resolve=>{window.lateSearch=resolve;});window.savedTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>{if(ms===60000){window.searchTimeoutBudget=ms;return window.savedTimeout(fn,30,...args);}return window.savedTimeout(fn,ms,...args);};})()`);
  await click('搜索作者');await until("document.querySelector('.dialog .field__error').textContent.includes('60 秒')");
  assert.equal(await evaluate('window.searchTimeoutBudget'),60000);
  assert.equal(await evaluate("document.querySelector('[data-connection-id=\"bilibili:default\"]').disabled"),false);
  await evaluate("window.lateSearch({items:[{external_id:'late',name:'不应显示'}]});SF.app.state.client.searchSources=window.savedSearch;window.setTimeout=window.savedTimeout;void 0");
  await new Promise(r=>setTimeout(r,60));assert.equal(await evaluate("document.querySelectorAll('.source-candidate').length"),0);
  await click('取消');
  const result={renderer:'passed',transport:'A',hidden:true,candidates:2,items:3,repeatDetailVisits:0,boundedKnownWindow:true,olderUncollectedNoteNotVisited:true,shareLinks:true,platformButtons:true,allSearchControlsDisabled:true,searchTimeoutSeconds:60,lateResponseIgnored:true,manualMetadataPreserved:true,coreRestart:true,rendererReload:true,expiredSession:true,realPlatform:false};
  await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
module.exports={verify};
