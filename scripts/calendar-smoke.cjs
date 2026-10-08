const assert = require('node:assert/strict');

async function verifyCalendar({evaluate,until,click,screenshot,core,window,firstId}) {
  const month=await evaluate('SF.app.state.calendarMonth');
  const sub=(await core.call('subscription.list'))[0];
  const summary=await evaluate(`SubscribeFlow.call('content.calendar',{month:${JSON.stringify(month)}})`);
  assert.equal(summary.total,24); // The 25th item has an unknown publication date.
  assert.deepEqual(summary.priorities,{high:0,medium:1,low:1,none:22});
  const change=async (label,value) => evaluate(`(() => {
    const el=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');
    if(!el) throw new Error('Missing calendar filter');
    el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  const stats=`Array.from(document.querySelectorAll('[data-calendar-stats] .stat__num')).map(e=>e.textContent).join(',')`;
  await until(`${stats}==='24,0,1,1'`);
  await click('今天');
  await until(`document.querySelectorAll('[data-calendar-item]').length===20`);
  assert.ok(await evaluate(`document.querySelector('.cal-day.is-selected').getAttribute('aria-label').includes('24 条内容')`));
  assert.equal(await evaluate(`document.querySelector('.cal-day.is-selected .cal-pill--more').textContent`),'+21 条');
  assert.ok(await evaluate(`!!document.querySelector('.cal-pill--none') && !!document.querySelector('.cal-pill--low') && !!document.querySelector('.cal-pill--mid')`));
  // Pagination failure keeps the first page and the full-day count; retry appends.
  await evaluate(`window.calendarOriginalList=SF.app.state.client.listContents; SF.app.state.client.listContents=q=>q.offset===20?Promise.reject(new Error('日历分页验收失败')):window.calendarOriginalList(q); void 0`);
  await click('加载更多当日内容');
  await until(`document.querySelector('.day-panel')?.textContent.includes('日历分页验收失败')`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-calendar-item]').length`),20);
  await evaluate(`SF.app.state.client.listContents=window.calendarOriginalList; delete window.calendarOriginalList`);
  await click('重试加载当日内容');
  await until(`document.querySelectorAll('[data-calendar-item]').length===24`);
  assert.equal(await evaluate(`new Set(Array.from(document.querySelectorAll('[data-calendar-item]')).map(e=>e.dataset.calendarItem)).size`),24);
  await change('日历优先级','low');
  await until(`${stats}==='1,0,0,1' && document.querySelectorAll('[data-calendar-item]').length===1`);
  await change('日历处理状态','unread');
  await until(`${stats}==='0,0,0,0' && document.querySelector('.day-panel')?.textContent.includes('这一天没有匹配内容')`);
  await change('日历处理状态','read');
  await until(`${stats}==='1,0,0,1' && document.querySelectorAll('[data-calendar-item]').length===1`);
  await change('日历来源',sub.source_id);
  await until(`${stats}==='1,0,0,1'`);
  // Editing within calendar detail refreshes its summary and removes it from
  // the active low filter, while leaving the processing state untouched.
  // 统计先于当日列表刷新，点击前要等条目真的在 DOM 里。
  await until(`document.querySelectorAll('[data-calendar-item]').length===1`);
  await evaluate(`document.querySelector('[data-calendar-item]').click()`);
  await until(`!!document.querySelector('.dialog .priority-opt--high')`);
  await evaluate(`document.querySelector('.dialog .priority-opt--high').click()`);
  await until(`${stats}==='0,0,0,0' && !!document.querySelector('.dialog .priority-opt--high[aria-pressed="true"]')`);
  assert.equal((await core.call('content.get',{item_id:firstId})).state.read,true);
  await evaluate(`document.querySelector('.dialog [aria-label="关闭对话框"]').click()`);
  await click('重置筛选');
  await until(`${stats}==='24,1,1,0'`);
  await evaluate(`SF.app.navigate('overview',{mode:'priority'})`);
  await until(`document.querySelector('[data-priority-column="high"] .count-pill')?.textContent==='1' && document.querySelector('[data-priority-column="low"] .count-pill')?.textContent==='0'`);
  // A source default then updates calendar inheritance without overwriting the override.
  await core.call('priority.set_source',{subscription_id:sub.id,priority:'low'});
  await evaluate(`SF.app.navigate('overview',{mode:'calendar'})`);
  await until(`${stats}==='24,1,1,22' && document.querySelectorAll('[data-calendar-item]').length===20`);
  await screenshot('m8-calendar-priorities.png');
  await evaluate(`document.documentElement.setAttribute('data-theme','dark')`);
  await screenshot('m8-calendar-priorities-dark.png');
  await evaluate(`document.documentElement.setAttribute('data-theme','light')`);
  window.setSize(900,760);
  await screenshot('m8-calendar-priorities-compact.png');
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
  await evaluate(`document.querySelector('.day-panel__foot button').scrollIntoView({block:'end'})`);
  assert.ok(await evaluate(`(() => { const r=document.querySelector('.day-panel__foot button').getBoundingClientRect(); return r.bottom<=innerHeight && r.top>=0; })()`));
  window.setSize(1440,1000);
  await click('查看全部 24 条内容');
  await until(`!!document.querySelector('[data-view="inbox"]') && document.querySelectorAll('.content-card').length===20`);
  assert.equal(await evaluate(`SF.app.state.filters.day`),summary.days[0].date);
  await evaluate(`SF.app.navigate('overview',{mode:'calendar'})`);
  await until(`!!document.querySelector('.calendar-grid')`);
  // Monthly failure is explicit, then a retry returns real data.
  await evaluate(`window.calendarOriginalGet=SF.app.state.client.getCalendar; SF.app.state.client.getCalendar=()=>Promise.reject(new Error('日历月份验收失败')); SF.views.overview.reset(); SF.app.renderContent()`);
  await until(`document.querySelector('[data-mode="calendar"]')?.textContent.includes('日历月份验收失败')`);
  await evaluate(`SF.app.state.client.getCalendar=window.calendarOriginalGet; delete window.calendarOriginalGet`);
  await click('重试');
  await until(`${stats}==='24,1,1,22'`);
  await change('日历月份','2000-01');
  await until(`${stats}==='0,0,0,0' && !!document.querySelector('.calendar-grid')`);
  await click('今天');
  await until(`${stats}==='24,1,1,22'`);
  // Return the fixture to the previously verified processing/priority state.
  await core.call('priority.set_source',{subscription_id:sub.id,priority:null});
  await core.call('content.update',{item_id:firstId,patch:{priority:'low'}});
  await evaluate(`SF.app.state.filters={quick:'all',platform:null,channelId:null}; SF.app.refreshData(true)`);
  await until(`${stats}==='24,0,1,1'`);
  console.log(JSON.stringify({calendarSmoke:'passed',fullMonthCounts:true,priorityFilters:true,dayPagination:true,detailAndBoardSync:true,monthAndPageRetry:true,unknownDates:true}));
}
module.exports={verifyCalendar};
