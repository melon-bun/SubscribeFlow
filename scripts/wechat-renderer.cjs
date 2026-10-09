const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
async function verify({window,core,root,fixture}) {
  const evaluate=async code=>{try{return await window.webContents.executeJavaScript(code);}catch(e){throw new Error(e.message+'\nRenderer expression: '+code);}};
  const until=async(code,timeout=18000)=>{const end=Date.now()+timeout;while(!await evaluate(code)){if(Date.now()>end)throw new Error('WeChat renderer timed out: '+code+'\n'+await evaluate('document.body.innerText'));await new Promise(r=>setTimeout(r,50));}};
  const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b||b.disabled)throw new Error('Missing enabled button '+${JSON.stringify(label)});b.click();})()`);
  const input=(selector,value)=>evaluate(`(()=>{const i=document.querySelector(${JSON.stringify(selector)});i.value=${JSON.stringify(value)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const shot=async name=>{await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const out=process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT||path.join(root,'docs/verification/m14');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,name),(await window.webContents.capturePage()).toPNG());};
  // The inbox renders either a list or an empty state; both mean it is ready.
  const inbox=()=>until(`!!document.querySelector('[data-view="inbox"] .content-card, [data-view="inbox"] .state')`);
  const recognize=async url=>{
    if(!await evaluate(`!!document.querySelector('#intake-url')`)){await click('添加内容');await until(`!!document.querySelector('#intake-url')`);}
    await input('#intake-url',url);await click('识别内容');
  };
  await until(`!!SF.app.state.session && !!document.querySelector('[data-view="inbox"]')`);await inbox();
  assert.equal(await evaluate('SF.app.state.source'),'real');
  assert.equal(await evaluate(`SF.app.state.session.capabilities.canIntake`),true);
  const descriptor=(await core.call('channel.list')).find(d=>d.channel==='wechat');
  assert.equal(descriptor.name,'微信公众号');
  assert.deepEqual(Object.keys(descriptor.operations).filter(op=>descriptor.operations[op].supported).sort(),['match_item_url','read_item','resolve_item']);
  assert.equal(descriptor.content_types[0],'article');

  // W12: a single-item channel offers no subscription entry and no login window.
  await evaluate(`SF.app.navigate('channels')`);await until(`!!document.querySelector('.channels__toolbar')`);
  await click('添加渠道或创作者');
  await until(`!!document.querySelector('.source-platforms')`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.source-platforms button')].map(b=>b.dataset.connectionId)`),['bilibili:default','xiaohongshu:default','zhihu:default']);
  await evaluate(`document.querySelector('.dialog [aria-label="关闭对话框"]').click()`);await until(`!document.querySelector('.dialog')`);
  await click('检查连接');await until(`!!document.querySelector('.connection-card')`);
  const wechatCard=`[...document.querySelectorAll('.connection-card')].find(c=>c.textContent.includes('微信公众号'))`;
  assert.ok(await evaluate(`!!${wechatCard}`),'微信连接卡片存在');
  assert.ok(await evaluate(`${wechatCard}.textContent.includes('仅支持自主添加')`));
  assert.equal(await evaluate(`[...${wechatCard}.querySelectorAll('button')].some(b=>b.textContent.includes('应用内登录'))`),false,'微信没有登录入口');
  assert.equal((await core.call('connection.check',{connection_id:'wechat:default',operation:'read_item'})).state,'ready');

  // W01/W02: preview carries account, title, body, cover and the original time.
  await evaluate(`SF.app.navigate('inbox');SF.app.render()`);await inbox();
  await recognize(fixture.SHORT);
  await until(`!!document.querySelector('.intake-preview')`);
  assert.equal((await core.call('content.list')).total,0,'预览不写入内容');
  assert.equal((await core.call('subscription.list')).length,0);
  assert.equal((await core.call('sync.list')).length,0);
  const text=await evaluate(`document.querySelector('.intake-preview').textContent`);
  assert.ok(text.includes('M14 隔离公众号')&&text.includes('M14 隔离验收文章')&&text.includes('第二段完整正文'));
  assert.ok(text.includes('2026-06-05'),'展示原始发布时间');
  assert.ok(text.includes('日历将按保存成功的时间归档'));
  assert.equal(await evaluate(`!!document.querySelector('.intake-preview__cover img')`),true,'封面可用');
  assert.equal(await evaluate(`!!document.querySelector('.intake-preview__unsubscribed')`),false,'不可订阅的渠道不显示未订阅');
  await evaluate(`document.querySelector('[data-intake-priority="high"]').click()`);
  await shot('m14-wechat-preview.png');

  const article=(await core.call('content.list')) ;
  await click('保存内容');
  await until(`!document.querySelector('.dialog') && SF.app.state.counts.total===1`);
  const saved=(await core.call('content.list')).items[0];
  assert.equal(saved.id,`wechat:article:${fixture.ARTICLES[0]}`);
  assert.equal(saved.source.kind,'account');
  assert.equal(saved.source.external_id,fixture.ACCOUNT);
  assert.equal(saved.intake_method,'manual');
  assert.equal(saved.calendar_basis,'manual_added_at');
  assert.equal(saved.priority,'high');
  assert.equal(saved.published.value,'2026-06-05T18:51:40+08:00');
  assert.equal(saved.published.timezone,'Asia/Shanghai');
  assert.ok(saved.summary.includes('第二段完整正文'));
  assert.equal((await core.call('subscription.list')).length,0,'保存不创建订阅');
  assert.equal((await core.call('sync.list')).length,0,'保存不创建同步任务');
  assert.ok(await evaluate(`document.querySelector('.detail-preview').textContent.includes('文章正文') && getComputedStyle(document.querySelector('.detail__text')).whiteSpace==='pre-wrap'`));
  assert.equal(await evaluate(`[...document.querySelectorAll('.detail button')].some(b=>b.textContent.trim()==='补充详情')`),false,'微信内容不提供依赖订阅的补充详情');
  await shot('m14-wechat-saved-detail.png');

  // W03: the parameter form and share parameters resolve to the same record.
  const before=await core.call('content.get',{item_id:saved.id});
  const readsBefore=fixture.visits.length;
  await recognize(`https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(fixture.ACCOUNT)}&mid=${fixture.IDS[0].mid}&idx=${fixture.IDS[0].idx}&chksm=fixture&scene=27`);
  await until(`!!document.querySelector('.intake-exists')`);
  assert.equal(fixture.visits.length,readsBefore+1,'命中已有记录不再读取正文');
  assert.deepEqual(await core.call('content.get',{item_id:saved.id}),before,'重复添加不修改原记录');
  await click('完成');await until(`!document.querySelector('.dialog')`);

  // W04: the other article of the same push is a separate record.
  await recognize('https://mp.weixin.qq.com/s/m14FixtureSecondArticle');
  await until(`!!document.querySelector('.intake-preview')`);
  assert.ok((await evaluate(`document.querySelector('.intake-preview').textContent`)).includes('另一个公众号'));
  await click('保存内容');await until(`!document.querySelector('.dialog') && SF.app.state.counts.total===2`);

  // W10: platform, source and intake-mode filters all reach the saved articles.
  const sources=(await core.call('source.list',{channel:'wechat'})).items;
  assert.equal(sources.length,1);assert.equal(sources[0].kind,'account');assert.equal(sources[0].external_id,fixture.ACCOUNT);
  assert.equal((await core.call('content.list',{source_id:sources[0].id})).total,2);
  assert.equal((await core.call('content.list',{intake_method:'subscription'})).total,0);
  await evaluate(`SF.app.state.filters={quick:'all',platform:'wechat'};SF.app.navigate('inbox');SF.app.refreshData(true)`);
  await until(`document.querySelectorAll('.content-card').length===2`);
  assert.ok(await evaluate(`[...document.querySelectorAll('.content-card')].every(c=>c.dataset.contentId.startsWith('wechat:article:'))`));

  // 正文超过 20 行才折叠，并可展开/收起；短正文不给这个按钮。
  await evaluate(`SF.app.state.filters={quick:'all',platform:'wechat'};SF.app.navigate('inbox');SF.app.refreshData(true)`);
  await until(`document.querySelectorAll('.content-card').length===2`);
  await evaluate(`[...document.querySelectorAll('.content-card')].find(c=>c.textContent.includes('M14 隔离验收文章')).click()`);
  await until(`!!document.querySelector('.detail__text')`);
  assert.equal(await evaluate(`!!document.querySelector('.detail__more-btn:not([hidden])')`),false,'短正文不显示展开按钮');
  await recognize('https://mp.weixin.qq.com/s/m14FixtureLongArticle');
  await until(`!!document.querySelector('.intake-preview')`);
  await click('保存内容');
  await until(`!!document.querySelector('.detail__text.is-clamped')`);
  assert.equal(await evaluate(`!!document.querySelector('.detail__more-btn:not([hidden])')`),true,'超过 20 行显示展开按钮');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.detail__text')).webkitLineClamp`),'20');
  await shot('m14-long-body-collapsed.png');
  await click('展开内容');
  await until(`!document.querySelector('.detail__text.is-clamped')`);
  assert.equal(await evaluate(`document.querySelector('.detail__more-btn').textContent`),'收起内容');
  assert.equal(await evaluate(`document.querySelector('.detail__more-btn').getAttribute('aria-expanded')`),'true');
  assert.ok((await evaluate(`document.querySelector('.detail__text').textContent`)).includes('第 26 段'),'展开后能看到末尾');
  await shot('m14-long-body-expanded.png');
  await click('收起内容');
  await until(`!!document.querySelector('.detail__text.is-clamped')`);
  assert.equal(await evaluate(`document.querySelector('.detail__more-btn').textContent`),'展开内容');

  // W08: manual articles enter the calendar by first-added time.
  await evaluate(`SF.app.state.filters={quick:'all',intakeMethod:'manual'};SF.app.navigate('overview',{mode:'calendar'});SF.app.refreshData(true)`);
  await until(`!!document.querySelector('.calendar-grid')`);await click('今天');
  await until(`document.querySelectorAll('[data-calendar-item]').length===3`);
  await shot('m14-wechat-calendar.png');

  // W13: a verification page stops the read, keeps nothing and is not retried.
  fixture.control.mode='risk';
  await evaluate(`SF.app.navigate('inbox');SF.app.render()`);await inbox();
  const visitsBefore=fixture.visits.length;
  await recognize('https://mp.weixin.qq.com/s/m14FixtureRiskPage1');
  await until(`!!document.querySelector('.dialog .notice__title')`);
  const notice=await evaluate(`document.querySelector('.dialog .notice__title').textContent+'|'+document.querySelector('.dialog .notice__text').textContent`);
  assert.equal(notice.split('|')[0],'平台要求人工验证');
  assert.ok(notice.includes('出口 IP')&&notice.includes('User-Agent')&&notice.includes('未保存任何内容'));
  assert.equal(await evaluate(`[...document.querySelectorAll('.dialog button')].some(b=>b.textContent.includes('应用内登录'))`),false,'拦截提示不引导登录');
  assert.equal(fixture.visits.length,visitsBefore+1,'拦截后不重试、不轮询');
  assert.equal((await core.call('content.list')).total,3,'拦截不产生任何记录');
  await shot('m14-wechat-blocked.png');
  fixture.control.mode='param';
  await input('#intake-url','https://mp.weixin.qq.com/s/m14FixtureUnknownPage');await click('重新识别');
  await until(`!!document.querySelector('.dialog .notice__title')`);
  assert.equal(await evaluate(`document.querySelector('.dialog .notice__title').textContent`),'无法识别这个链接');
  assert.equal((await core.call('content.list')).total,3,'错误页不产生任何记录');
  fixture.control.mode='normal';

  // Restart and reload keep the manual articles and create no subscription.
  await core.restart();
  assert.equal((await core.call('content.list',{channel:'wechat'})).total,3);
  assert.equal((await core.call('subscription.list')).length,0);
  await evaluate(`SF.app.navigate('inbox');SF.app.refreshData(true)`);
  await until(`SF.app.state.counts.total===3`);
  console.log(JSON.stringify({wechatRenderer:'passed',realBridge:true,realCore:true,realPlatform:false,intakeOnlyChannel:true,
    capabilityFilter:true,connectionCheck:true,previewNoWrite:true,accountSource:true,originalTime:true,manualCalendar:true,
    aliasSameKey:true,samePushSeparate:true,noSubscriptionOrJob:true,filtersAndCalendar:true,blockedPageStops:true,
    errorPageNotSaved:true,restartPersisted:true,contents:3,longBodyCollapse:true}));
}
module.exports={verify};