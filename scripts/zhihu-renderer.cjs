const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
async function verify({window,core,root,zhihu,fixture}) {
  const evaluate=async code=>{try{return await window.webContents.executeJavaScript(code);}catch(e){throw new Error(e.message+'\nRenderer expression: '+code);}};
  const until=async(code,timeout=18000)=>{const end=Date.now()+timeout;while(!await evaluate(code)){if(Date.now()>end)throw new Error('Zhihu Renderer timed out: '+code+'\n'+await evaluate('document.body.innerText'));await new Promise(r=>setTimeout(r,50));}};
  const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)} || b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b || b.disabled)throw new Error('Missing enabled button '+${JSON.stringify(label)});b.click();})()`);
  const input=(selector,value)=>evaluate(`(()=>{const i=document.querySelector(${JSON.stringify(selector)});i.value=${JSON.stringify(value)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const shot=async name=>{await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await evaluate(`Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`);const out=process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root,'docs/verification/m12');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,name),(await window.webContents.capturePage()).toPNG());};
  const jobWait=async id=>{for(let i=0;i<300;i++){const j=await core.call('sync.get',{job_id:id});if(!['queued','running'].includes(j.state))return j;await new Promise(r=>setTimeout(r,50));}throw new Error('Job did not finish');};
  const recognize=async id=>{await evaluate(`SF.app.navigate('inbox')`);await until(`!!document.querySelector('[data-view="inbox"]')`);await click('添加内容');await until(`!!document.querySelector('#intake-url')`);await input('#intake-url',`https://zhihu.com/pin/${id}?utm_source=fixture`);await click('识别内容');};
  await until(`!!SF.app.state.session && !!document.querySelector('[data-view="inbox"] .state')`);
  assert.equal(await evaluate('SF.app.state.source'),'real');assert.equal(await evaluate('typeof require'),'undefined');
  assert.ok((await core.call('channel.list')).find(d=>d.channel==='zhihu').operations.read_item.supported);
  assert.equal((await core.call('connection.check',{connection_id:'zhihu:default'})).state,'ready');
  await evaluate(`SF.app.navigate('channels')`);await until(`!!document.querySelector('.channels__toolbar')`);
  await click('添加渠道或创作者');await evaluate(`document.querySelector('.source-platforms [data-connection-id="zhihu:default"]').click()`);await input('#source-input','同名知乎作者');await click('搜索作者');
  await until(`document.querySelectorAll('.source-candidate').length===2`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.source-candidate')].map(b=>b.dataset.sourceId)`),[fixture.UID,fixture.OTHER]);
  await shot('m12-author-candidates.png');
  await evaluate(`document.querySelector('[data-source-id="${fixture.UID}"]').click()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='确认添加').disabled`),true);
  await evaluate(`document.querySelector('#source-confirm').click()`);await click('确认添加');await until(`!document.querySelector('.dialog') && !!document.querySelector('[data-channel-id]')`);
  let sub=(await core.call('subscription.list'))[0];assert.equal(sub.source_id,'zhihu:author:'+fixture.UID);
  await click('设置采集条数');await until(`!!document.querySelector('#collect-items')`);assert.ok(await evaluate(`document.querySelector('.dialog').textContent.includes('条想法')`));await input('#collect-items','3');await click('保存采集条数');await until(`!document.querySelector('.dialog')`);
  await click('刷新来源');
  await until(`SF.app.state.counts.total===3`,25000);
  let jobs=await core.call('sync.list'),first=jobs[0];assert.equal(first.state,'succeeded');assert.equal(first.new_items,3);assert.equal(first.acquisition_metrics.discovered,3);
  assert.equal(first.coverage,'window_only');assert.equal(first.backfill_complete,undefined);
  const contents=(await core.call('content.list',{channel:'zhihu'})).items;
  assert.equal(contents.length,3);assert.ok(contents.every(c=>c.intake_method==='subscription' && c.source.external_id===fixture.UID && c.summary.includes('\n') && c.summary.includes('完整正文第二段')));
  assert.ok(!contents.some(c=>c.external_id===fixture.IDS[4]),'赞同和转发不采集');
  assert.equal(contents.find(c=>c.external_id===fixture.IDS[2]).published.precision,'unknown');
  assert.equal((await core.call('content.calendar',{month:'2000-01',channel:'zhihu'})).total,2,'未知发布不伪造日期');
  await shot('m12-subscription-result.png');
  const before=await core.call('content.get',{item_id:'zhihu:pin:'+fixture.IDS[0]}),reads=fixture.visits.filter(v=>v.includes('/pin/')).length;
  await click('刷新来源');await until(`SF.app.state.runs[0]?.state==='succeeded' && SF.app.state.runs[0]?.id!==${JSON.stringify(first.id)}`,25000);
  assert.equal(fixture.visits.filter(v=>v.includes('/pin/')).length,reads,'复采已收录不详情读取');
  assert.deepEqual(await core.call('content.get',{item_id:before.id}),before);
  await recognize(fixture.IDS[0]);await until(`!!document.querySelector('.intake-exists')`);assert.equal(fixture.visits.filter(v=>v.includes('/pin/')).length,reads);
  await click('查看已有记录');await until(`!!document.querySelector('.dialog .detail-preview')`);await click('关闭对话框');
  const tag=await core.call('tag.create',{name:'知乎验收',color:'cyan'});
  await recognize(fixture.IDS[3]);await until(`!!document.querySelector('.intake-preview')`);
  assert.equal((await core.call('content.list')).total,3);assert.equal((await core.call('subscription.list')).length,1);

  await evaluate(`document.querySelector('[data-intake-priority="high"]').click()`);
  await evaluate(`document.querySelector('.dialog [data-tag-add]').click()`);await until(`!!document.querySelector('.tag-pool__chip')`);await evaluate(`document.querySelector('.tag-pool__chip').click()`);await click('确认挂载');
  await shot('m12-manual-preview.png');await click('保存内容');await until(`!document.querySelector('.dialog') && SF.app.state.counts.total===4 && !!document.querySelector('.detail__body')`);
  assert.ok(await evaluate(`document.querySelector('.detail-preview').textContent.includes('想法正文') && getComputedStyle(document.querySelector('.detail__body')).whiteSpace==='pre-wrap'`));
  const manual=await core.call('content.get',{item_id:'zhihu:pin:'+fixture.IDS[3]});assert.equal(manual.intake_method,'manual');assert.equal(manual.priority,'high');assert.equal(manual.tags[0].id,tag.id);
  assert.equal(manual.calendar_basis,'manual_added_at');assert.equal(manual.published.value.slice(0,4),'2000');
  await core.call('subscription.update',{subscription_id:sub.id,collect_items:4});
  const duplicateJob=await jobWait((await core.call('sync.start',{subscription_id:sub.id})).job_id);assert.equal(duplicateJob.new_items,0);assert.equal(duplicateJob.acquisition_metrics.skipped,4);
  assert.deepEqual(await core.call('content.get',{item_id:manual.id}),manual);
  // Official UI filters use the same persisted source and independent intake mode.
  await evaluate(`SF.app.state.filters={quick:'all',platform:'zhihu',intakeMethod:'manual',sourceId:${JSON.stringify(sub.source_id)},tags:[${JSON.stringify(tag.id)}]};SF.app.navigate('inbox');SF.app.refreshData(true)`);
  await until(`document.querySelectorAll('.content-card').length===1`);
  assert.equal(await evaluate(`document.querySelector('.content-card').dataset.contentId`),manual.id);
  await evaluate(`SF.app.navigate('overview',{mode:'calendar'});SF.app.refreshData(true)`);await until(`!!document.querySelector('.calendar-grid')`);await click('今天');
  await until(`document.querySelectorAll('[data-calendar-item]').length===1`);assert.equal(await evaluate(`document.querySelector('[data-calendar-item]').dataset.calendarItem`),manual.id);await shot('m12-manual-calendar.png');
  await evaluate(`SF.app.navigate('overview',{mode:'priority'})`);await until(`document.querySelectorAll('[data-priority-column="high"] [data-priority-item]').length===1`);await until(`document.querySelectorAll('[data-priority-item]').length===1`);
  // An image-only authored pin has no invented text and keeps a usable cover.
  let image=await core.call('intake.start',{url:'https://www.zhihu.com/pin/'+fixture.IDS[4]});
  for(let i=0;i<100 && ['queued','running'].includes(image.state);i++){await new Promise(r=>setTimeout(r,30));image=await core.call('intake.get',{task_id:image.task_id});}
  assert.equal(image.state,'preview');assert.equal(image.preview.title,'图片想法');assert.equal(image.preview.summary,'');assert.equal(image.preview.thumbnail,'https://pic1.zhimg.com/image-only.jpg');
  await core.call('intake.cancel',{task_id:image.task_id});assert.equal((await core.call('content.list')).total,4);
  // Auth loss, explicit login recovery, cancellation, invalid schema, then retry.
  await fixture.setAuth(false);assert.equal((await core.call('connection.check',{connection_id:'zhihu:default'})).state,'blocked');
  const waiting=await jobWait((await core.call('sync.start',{subscription_id:sub.id})).job_id);assert.equal(waiting.state,'waiting');assert.equal(waiting.error.code,'AUTH_REQUIRED');
  await zhihu.openLogin(window);zhihu.host.hide();await zhihu.view.webContents.loadURL('https://www.zhihu.com/signin');
  assert.ok(await zhihu.view.webContents.executeJavaScript(`!!document.querySelector('#fixture-login')`));
  await zhihu.view.webContents.executeJavaScript(`document.querySelector('#fixture-login').click()`);zhihu.host.close();await zhihu.session.cookies.flushStore();
  assert.equal((await core.call('connection.check',{connection_id:'zhihu:default'})).state,'ready');
  const retry=await core.call('sync.retry',{job_id:waiting.id});assert.equal((await jobWait(retry.job_id)).state,'succeeded');
  fixture.control.missingId=true;const changed=await jobWait((await core.call('sync.start',{subscription_id:sub.id})).job_id);assert.equal(changed.state,'failed');assert.equal(changed.error.code,'SCHEMA_CHANGED');fixture.control.missingId=false;
  const cancel=await core.call('sync.start',{subscription_id:sub.id});await core.call('sync.cancel',{job_id:cancel.job_id});assert.equal((await core.call('sync.get',{job_id:cancel.job_id})).state,'cancelled');
  await core.call('subscription.update',{subscription_id:sub.id,sync_mode:'automatic',interval_seconds:3600});assert.equal((await core.call('subscription.list'))[0].sync_mode,'automatic');
  await core.restart();assert.equal((await core.call('content.list')).total,4);assert.deepEqual(await core.call('content.get',{item_id:manual.id}),manual);
  assert.equal((await core.call('connection.check',{connection_id:'zhihu:default'})).state,'ready');
  await window.reload();await until(`!!SF.app.state.session && SF.app.state.counts.total===4`);
  assert.equal((await core.call('subscription.list'))[0].sync_mode,'automatic');assert.equal((await core.call('content.list',{tags:[tag.id]})).total,1);
  // A new hidden host with the same persistent partition reuses the fixture login.
  await zhihu.close();const {ZhihuSession}=require('../electron/main/zhihu-session.cjs');const replacement=new ZhihuSession({apiOptions:{delay:0}});
  try{assert.equal((await replacement.request({operation:'check'})).authenticated,true);}finally{await replacement.close();}
  console.log(JSON.stringify({zhihuRenderer:'passed',realBridge:true,realCore:true,realPlatform:false,authorConfirmation:true,stableAuthorId:true,pinnedAndMixed:true,fullBody:true,unknownTime:true,bothDuplicateOrders:true,manualCalendar:true,tagsAndFilters:true,authRecovery:true,cancel:true,schemaChanged:true,persistedSession:true,imageOnly:true,restartAndReload:true,contents:4}));
}
module.exports={verify};
