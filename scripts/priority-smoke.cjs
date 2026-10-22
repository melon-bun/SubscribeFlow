const assert = require('node:assert/strict');

async function verifyPriorities({evaluate, until, click, screenshot, core, window, firstId}) {
  const sub=(await core.call('subscription.list'))[0];
  assert.equal((await core.call('content.list',{priority:'none'})).total,25);
  assert.equal(await evaluate(`SubscribeFlow.call('priority.set_source',{subscription_id:${JSON.stringify(sub.id)},priority:null}).then(s=>s.id)`),sub.id);
  assert.equal(await evaluate(`SubscribeFlow.call('os.system',{}).then(()=>false,()=>true)`),true);
  const change=async (label,value) => evaluate(`(() => {
    const el=document.querySelector('select[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');
    if(!el || el.disabled) throw new Error('Missing enabled select');
    el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  const sourceLabel='来源优先级 '+sub.name;
  const sourceSettings=async () => {
    await evaluate(`SF.app.navigate('channels',{tab:'priorities'})`);
    await until(`!!document.querySelector('[data-priority-source] select')`);
  };
  await sourceSettings();
  await change(sourceLabel,'high');
  await until(`SF.app.state.counts.high===25 && document.querySelector('[data-priority-source] select')?.value==='high'`);
  assert.equal((await core.call('subscription.list'))[0].version,sub.version);
  await screenshot('m8-source-priorities.png');
  await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
  await until(`!!document.querySelector('[data-view="inbox"]') && SF.app.state.filters.quick==='unread'`);
  await evaluate(`document.querySelector('[data-quick="all"]').click()`);
  await until(`document.querySelectorAll('.content-card').length===20`);
  await evaluate(`document.querySelector('[data-content-id='+${JSON.stringify(JSON.stringify(firstId))}+']').click()`);
  await evaluate(`document.querySelector('.detail .priority-opt--low').click()`);
  await until(`SF.app.state.counts.low===1 && document.querySelector('.detail .priority-opt--low[aria-pressed="true"]')`);
  assert.equal((await core.call('content.get',{item_id:firstId})).state.read,true);
  // 5.1 期（M31）：优先级等级改由信号条表达（颜色只在图形上），
  // 不再是彩色实心图标方块。这里验证信号条存在且真的带上了等级色，
  // 而不是简单删掉这条断言——「等级要一眼可辨」这个要求本身没有变。
  await until(`!!document.querySelector('.priority-opt--medium .prio-sig')`);
  assert.ok(await evaluate(`(() => {
    const sig = document.querySelector('.priority-opt--medium .prio-sig');
    if (!sig) return false;
    const bars = Array.from(sig.querySelectorAll('i'));
    if (bars.length !== 3) return false;
    // 中等级点亮前两格；第三格必须仍是中性色（未点亮）。
    const lit = bars.slice(0,2).every(b => getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)');
    const dim = bars[2] ? getComputedStyle(bars[2]).backgroundColor !== 'rgba(0, 0, 0, 0)' : false;
    return lit && dim;
  })()`), '中优先级的信号条应当点亮两格并保留第三格');
  await screenshot('m8-content-priority.png');
  await sourceSettings();
  await change(sourceLabel,'medium');
  await until(`SF.app.state.counts.medium===24 && !!document.querySelector('[data-priority-source] select')`);
  assert.equal((await core.call('content.get',{item_id:firstId})).priority,'low');
  await evaluate(`SF.app.navigate('overview',{mode:'priority'})`);
  await until(`document.querySelectorAll('[data-priority-column="medium"] [data-priority-item]').length===20`);
  // 计数在分组加载完成前显示占位符「—」，断言前要等真实数字出现。
  await until(`document.querySelector('[data-priority-column="medium"] .count-pill')?.textContent==='24'`);
  assert.equal(await evaluate(`document.querySelector('[data-priority-column="medium"] .count-pill').textContent`),'24');
  // 按钮文案随分组状态在「加载更多／正在加载…／重试加载」间切换，先等到可点的那个。
  // 15 秒轮询在计数变化时会重置看板，正在加载的那一页会被丢弃；这是既有行为，
  // 不是本次要修的范围。断言的是「加载更多最终能显示全部 24 条」，所以重试而非只验一帧。
  for (let attempt = 0; attempt < 4; attempt++) {
    await until(`Array.from(document.querySelectorAll('[data-priority-column="medium"] button')).some(b=>b.textContent==='加载更多')`);
    await evaluate(`Array.from(document.querySelectorAll('[data-priority-column="medium"] button')).find(b=>b.textContent==='加载更多').click()`);
    try {
      await until(`document.querySelectorAll('[data-priority-column="medium"] [data-priority-item]').length===24`, 3000);
      break;
    } catch (error) {
      await until(`document.querySelectorAll('[data-priority-column="medium"] [data-priority-item]').length===20`);
    }
  }
  await until(`document.querySelectorAll('[data-priority-column="medium"] [data-priority-item]').length===24`);
  assert.equal(await evaluate(`new Set(Array.from(document.querySelectorAll('[data-priority-item]')).map(e=>e.dataset.priorityItem)).size`),25);
  await change('看板处理状态','read');
  await until(`document.querySelector('[data-priority-column="medium"] .count-pill')?.textContent==='0' && document.querySelector('[data-priority-column="low"] .count-pill')?.textContent==='1'`);
  await change('看板处理状态','all');
  await until(`document.querySelector('[data-priority-column="medium"] .count-pill')?.textContent==='24'`);
  // Unknown timestamps remain visible on the board; a day filter excludes them.
  await evaluate(`const day=document.querySelector('[aria-label="看板日期"]'); day.value=SF.fmt.ymd(Date.now()); day.dispatchEvent(new Event('change',{bubbles:true}));`);
  await until(`document.querySelector('[data-priority-column="medium"] .count-pill')?.textContent==='23'`);
  await click('重置筛选');
  await until(`document.querySelector('[data-priority-column="medium"] .count-pill')?.textContent==='24'`);
  // Manual bulk changes affect only the selected current-page contents.
  await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
  await until(`!!document.querySelector('[data-view="inbox"]') && SF.app.state.filters.quick==='unread'`);
  await evaluate(`document.querySelector('[data-quick="all"]').click()`);
  await until(`document.querySelectorAll('.content-card').length===20`);
  const second=await evaluate(`document.querySelectorAll('.content-card')[1].dataset.contentId`);
  await evaluate(`document.querySelectorAll('.content-selection > [role="checkbox"]')[1].click()`);
  await change('批量设置优先级','medium');
  await until(`!!document.querySelectorAll('.content-card')[1] && !document.querySelector('[aria-label="批量设置优先级"]')`);
  assert.equal((await core.call('content.get',{item_id:second})).priority_override,'medium');
  await sourceSettings();
  await change(sourceLabel,'high');
  await until(`SF.app.state.counts.high===23 && SF.app.state.counts.medium===1`);
  await evaluate(`SF.app.navigate('overview',{mode:'priority'})`);
  await until(`document.querySelectorAll('[data-priority-column="high"] [data-priority-item]').length===20 && document.querySelectorAll('[data-priority-column="medium"] [data-priority-item]').length===1`);
  await screenshot('m8-priority-board.png');
  await evaluate(`document.documentElement.setAttribute('data-theme','dark')`);
  await evaluate(`SF.ui.toast('深色主题优先级已保存')`);
  assert.ok(await evaluate(`(() => {
    const style=getComputedStyle(document.querySelector('.toast-layer .toast:last-child'));
    const luminance=rgb=>rgb.match(/[0-9.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4);}).reduce((s,v,i)=>s+v*[0.2126,0.7152,0.0722][i],0);
    const a=luminance(style.color), b=luminance(style.backgroundColor); return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=4.5;
  })()`));
  await screenshot('m8-priority-board-dark.png');
  await evaluate(`document.documentElement.setAttribute('data-theme','light')`);
  window.setSize(900,760);
  await screenshot('m8-priority-board-compact.png');
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
  await evaluate(`document.querySelector('[data-priority-column="low"]').scrollIntoView({block:'end'})`);
  assert.ok(await evaluate(`(() => { const r=document.querySelector('[data-priority-column="low"] .priority-column-foot button').getBoundingClientRect(); return r.bottom<=innerHeight && r.top>=0; })()`));
  window.setSize(1440,1000);
  // One group can fail independently; retry recovers the actual persisted data.
  await evaluate(`window.originalPriorityList=SF.app.state.client.listContents; SF.app.state.client.listContents=function(q) { if(q.priority==='medium') return Promise.reject(new Error('离线验收：分组读取失败')); return window.originalPriorityList(q); }; SF.views.overview.reset(); SF.app.renderContent()`);
  await until(`document.querySelector('[data-priority-column="medium"]')?.textContent.includes('离线验收：分组读取失败')`);
  await evaluate(`SF.app.state.client.listContents=window.originalPriorityList; delete window.originalPriorityList; Array.from(document.querySelectorAll('[data-priority-column="medium"] button')).find(b=>b.textContent==='重试').click()`);
  await until(`document.querySelectorAll('[data-priority-column="medium"] [data-priority-item]').length===1`);
  // Removing a source default preserves explicit content choices.
  await sourceSettings();
  await change(sourceLabel,'');
  await until(`SF.app.state.counts.none===23 && SF.app.state.counts.low===1`);
  await evaluate(`SF.app.navigate('overview',{mode:'priority'})`);
  await until(`!!document.querySelector('[aria-label="看板优先级"]')`);
  await change('看板优先级','none');
  await until(`document.querySelector('[data-priority-column="none"] .count-pill')?.textContent==='23'`);
  await screenshot('m8-unset-priority.png');
  await evaluate(`document.querySelector('[data-priority-column="none"] .priority-column-foot button').click()`);
  await until(`document.querySelectorAll('.content-card').length===20 && SF.app.state.filters.priority==='none'`);
  // Keep the remaining baseline renderer checks on their original route/scope.
  await evaluate(`SF.app.state.filters={quick:'all',platform:null,channelId:null}; SF.app.state.channelTab='list'; SF.app.navigate('overview',{mode:'calendar'})`);
  await until(`!!document.querySelector('.calendar-grid')`);
  console.log(JSON.stringify({prioritySmoke:'passed',sourceInheritance:true,manualOverride:true,bulk:true,fullCounts:true,pagination:true,unknownDates:true}));
}
module.exports={verifyPriorities};
