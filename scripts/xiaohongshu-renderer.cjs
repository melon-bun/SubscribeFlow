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
  await evaluate("(()=>{const input=document.querySelector('[aria-label=\"来源平台\"]');input.value='xiaohongshu:default';input.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#source-input').value='同名作者';document.querySelector('#source-input').dispatchEvent(new Event('input',{bubbles:true}));})()");
  await click('搜索作者');await until("!!document.querySelector('.dialog .field__error')?.textContent");
  assert.match(await evaluate("document.querySelector('.dialog .field__error').textContent"),/登录/);
  assert.equal(xiaohongshu.host.isVisible(),false);
  await click('应用内登录');
  for(let i=0;i<100 && !xiaohongshu.loginVisible;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(xiaohongshu.host.isVisible(),true);
  await xiaohongshu.view.webContents.executeJavaScript("document.querySelector('#fixture-login').click()");
  xiaohongshu.host.close();
  for(let i=0;i<100 && xiaohongshu.loginVisible;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(xiaohongshu.host.isVisible(),false);
  await click('搜索作者');await until("document.querySelectorAll('.source-candidate').length===2");
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
  assert.equal(xiaohongshu.host.isVisible(),false);
  const key='xiaohongshu:note:'+fixture.IDS[0];
  await core.call('content.update',{item_id:key,patch:{priority:'high',read:true}});
  const tag=await core.call('tag.create',{name:'M10验收标签'});await core.call('content.set_tags',{item_id:key,tag_ids:[tag.id]});
  const detailVisits=fixture.visits.filter(u=>/\/explore\/[a-f0-9]{24}$/.test(u)).length;
  await click('刷新来源');await until("SF.app.state.runs.some(r=>r.state==='succeeded' && r.acquisitionMetrics?.skipped===3)");
  assert.equal(fixture.visits.filter(u=>/\/explore\/[a-f0-9]{24}$/.test(u)).length,detailVisits);
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
  const result={renderer:'passed',transport:'A',hidden:true,candidates:2,items:3,repeatDetailVisits:0,manualMetadataPreserved:true,coreRestart:true,rendererReload:true,expiredSession:true,realPlatform:false};
  await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
module.exports={verify};
