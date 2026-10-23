const assert = require('node:assert/strict');

async function verifyCalendar({evaluate,until,click,screenshot,core,window,firstId}) {
  const month=await evaluate('SF.app.state.calendarMonth');
  const sub=(await core.call('subscription.list'))[0];
  const summary=await evaluate(`SubscribeFlow.call('content.calendar',{month:${JSON.stringify(month)}})`);
  assert.equal(summary.total,24); // The 25th item has an unknown publication date.
  assert.deepEqual(summary.priorities,{high:0,medium:1,low:1,none:22});
  /* 日历筛选现在是无框下拉按钮（不是原生 <select>）：用共享的 setFilter，
     点开菜单按值点选项。原生 select 直接赋值那套只留给真正的原生控件。 */
  const {setFilter}=require('./renderer-actions.cjs').rendererActions({evaluate,until});
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
  await setFilter('日历优先级','low');
  await until(`${stats}==='1,0,0,1' && document.querySelectorAll('[data-calendar-item]').length===1`);
  await setFilter('日历处理状态','unread');
  await until(`${stats}==='0,0,0,0' && document.querySelector('.day-panel')?.textContent.includes('这一天没有匹配内容')`);
  await setFilter('日历处理状态','read');
  await until(`${stats}==='1,0,0,1' && document.querySelectorAll('[data-calendar-item]').length===1`);
  // 来源下拉是异步就绪的：等菜单里真有选项再选。
  // 旧写法给原生 <select> 赋一个不存在的值，select 会静默变空——筛选根本没生效，
  // 后面「统计不变」的断言就成了一次空转通过。这里选**真正拥有内容**的来源，
  // 断言才有意义：按来源筛完，统计必须还是那一条。
  await until(`document.querySelector('[aria-label="日历来源"]')?.getAttribute('data-sources') !== '0'`);
  const owned = (await core.call('source.list',{})).items.find(s => (s.content_count||0) > 0);
  assert.ok(owned && owned.id, '隔离样本里应当有带内容的来源');
  await setFilter('日历来源', owned.id);
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
  /* 月份筛选现在是「静流」的无框下拉按钮（不是原生 input）：点开菜单按值点选项。
     选菜单里最早的那个月——内容都在本月，早月的计数应为 0。 */
  await evaluate(`document.querySelector('[aria-label="日历月份"]').click()`);
  await until(`!!document.querySelector('.menu__item')`);
  await evaluate(`(() => { const items=[...document.querySelectorAll('.menu__item')]; items[items.length-1].click(); })()`);
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
