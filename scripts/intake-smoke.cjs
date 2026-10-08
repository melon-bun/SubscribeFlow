const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

async function verifyIntakeDates({evaluate,until,click,screenshot,core,root}) {
  const runtime=JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json'),'utf8'));
  const fixture=path.join(root,'python/tests/seed_intake_renderer.py');
  const seed=mode=>{
    const result=spawnSync(runtime.python,[fixture,core.dataDir,mode],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  };
  await core.stop(); seed('add'); await core.start();
  await evaluate(`SF.views.overview.reset(); SF.app.navigate('overview',{mode:'calendar'}); SF.app.refreshData(true)`);
  await until(`SF.app.state.counts.total===1 && !!document.querySelector('.calendar-grid')`);
  await click('今天');
  const id='bilibili:video:m11-renderer-fixture';
  await until(`document.querySelector('[data-calendar-item]')?.dataset.calendarItem===${JSON.stringify(id)}`);
  const day=await evaluate(`SF.app.state.selectedDate`);
  const dto=await evaluate(`SF.app.state.client.getContent(${JSON.stringify(id)})`);
  assert.equal(dto.channelId,null);
  assert.equal(dto.intakeMethod,'manual');
  assert.equal(dto.publishedAt,'2000-01-02');
  assert.equal(dto.calendarDate,day);
  assert.equal(dto.calendarBasis,'manual_added_at');
  const month=await evaluate(`SF.app.state.client.getCalendar({month:${JSON.stringify(day.slice(0,7))}})`);
  assert.equal(month.total,1);
  assert.equal(month.days[0].date,day);
  const old=await evaluate(`SF.app.state.client.getCalendar({month:'2000-01'})`);
  assert.equal(old.total,0);
  assert.equal((await core.call('subscription.list')).length,0);
  const sources=await evaluate(`SF.app.state.client.listContentSources()`);
  assert.equal(sources.items[0].id,'bilibili:author:m11-renderer-fixture');
  const filtered=await evaluate(`SF.app.state.client.listContents({from:${JSON.stringify(day)},to:${JSON.stringify(day)},sourceId:'bilibili:author:m11-renderer-fixture',intakeMethod:'manual'})`);
  assert.equal(filtered.total,1);
  await screenshot('m11-manual-calendar.png');
  await click('查看全部 1 条内容');
  await until(`document.querySelector('.content-card')?.dataset.contentId===${JSON.stringify(id)}`);
  assert.equal(await evaluate(`SF.app.state.filters.day`),day);
  await screenshot('m11-manual-day-list.png');
  await core.stop(); seed('remove'); await core.start();
  await evaluate(`SF.views.overview.reset(); SF.app.state.filters={quick:'unread',platform:null,channelId:null}; SF.app.navigate('inbox'); SF.app.refreshData(true)`);
  await until(`SF.app.state.counts.total===0 && !!document.querySelector('[data-view="inbox"] .state')`);
  console.log(JSON.stringify({intakeDateRenderer:'passed',manualOldPublication:true,calendarAndDayList:true,sourceWithoutSubscription:true,realPlatform:false}));
}
module.exports={verifyIntakeDates};
