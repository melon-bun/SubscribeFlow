const assert = require('node:assert/strict');

// Uses the formal desktop bridge and an isolated SQLite fixture, never user data.
async function verifyListState({evaluate, until, click, screenshot, core, window}) {
  const list = '.inbox__grid.scroll-y';
  const ids = () => evaluate(`Array.from(document.querySelectorAll('.content-card')).map(c=>c.dataset.contentId)`);
  const scroll = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollTop`);
  const setScroll = async (selector, top = 350) => {
    const actual = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); el.scrollTop=${top}; return el.scrollTop; })()`);
    assert.equal(actual, top, 'Fixture must really overflow');
    return actual;
  };
  const select = async id => evaluate(`document.querySelector('[data-content-id='+${JSON.stringify(JSON.stringify(id))}+']').click()`);
  const arrange = async label => evaluate(`Array.from(document.querySelectorAll('.detail .op-btn')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
  const absent = id => `!document.querySelector('[data-content-id='+${JSON.stringify(JSON.stringify(id))}+']')`;
  const loaded = count => until(`document.querySelectorAll('.content-card').length===${count}`);
  const original = (await core.call('content.list', {limit:50})).items;
  const allIds = original.map(item => item.id);
  const sub = (await core.call('subscription.list'))[0];
  const restore = async () => {
    await core.call('content.bulk_update', {item_ids:allIds, patch:{read:false,deferred:false,archived:false}});
    await core.call('priority.set_source', {subscription_id:sub.id, priority:null});
    await evaluate(`SF.app.state.filters={quick:'unread',platform:null,channelId:null}; SF.app.state.search=''; SF.app.navigate('inbox'); SF.views.inbox.reset(); SF.app.refreshData(true)`);
    await until(`SF.app.state.counts.unread===25 && document.querySelectorAll('.content-card').length===20`);
  };
  window.setSize(1100,760);
  try {
    await loaded(20);
    await setScroll(list);
    await select((await ids())[5]);
    assert.equal(await scroll(list),350,'Selecting a card preserves scroll');
    await evaluate(`document.querySelectorAll('.content-selection > [role="checkbox"]')[5].click()`);
    assert.equal(await scroll(list),350,'Checking a card preserves scroll');
    await click('取消选择');
    await evaluate('SF.app.render()');
    assert.equal(await scroll(list),350,'Full shell rebuild preserves scroll');

    // Explicitly traverse the asynchronous loading state, not just a synchronous repaint.
    await evaluate(`window.listOriginal=SF.app.state.client.listContents; window.listReleases=[]; SF.app.state.client.listContents=q=>new Promise(resolve=>window.listReleases.push(()=>resolve(window.listOriginal(q)))); SF.app.refreshData(true); void 0`);
    await until(`!!document.querySelector('.skeleton-card') && !document.querySelector('.inbox__grid.scroll-y') && window.listReleases.length>0`);
    await evaluate(`window.listReleases.splice(0).forEach(release=>release()); void 0`);
    await loaded(20);
    assert.equal(await scroll(list),350,'Loading placeholder must not erase saved scroll');
    await evaluate(`SF.app.state.client.listContents=window.listOriginal; delete window.listOriginal; delete window.listReleases; void 0`);

    const failedId=await evaluate('SF.app.state.selectedId');
    await evaluate(`window.updateOriginal=SF.app.state.client.updateContent; SF.app.state.client.updateContent=()=>Promise.reject(new Error('列表状态验收失败')); void 0`);
    await arrange('已读');
    await until(`document.body.textContent.includes('列表状态验收失败')`);
    assert.equal(await evaluate('SF.app.state.selectedId'),failedId);
    assert.equal(await scroll(list),350);
    await evaluate(`SF.app.state.client.updateContent=window.updateOriginal; delete window.updateOriginal; void 0`);

    for (const label of ['已读','稍后处理','归档']) {
      const before=await ids();
      await select(before[5]);
      await setScroll(list);
      await arrange(label);
      await until(`document.querySelectorAll('.content-card').length===20 && ${absent(before[5])} && SF.app.state.selectedId===${JSON.stringify(before[6])}`);
      assert.equal(await scroll(list),350,`${label}: preserve list scroll after removal`);
    }
    // A batch can remove the immediate successor as well; pick the next survivor.
    const batch=await ids();
    await select(batch[5]);
    for (const index of [5,6]) await evaluate(`document.querySelectorAll('.content-selection > [role="checkbox"]')[${index}].click()`);
    await evaluate(`Array.from(document.querySelectorAll('.inbox__toolbar button')).find(b=>b.textContent.trim()==='已读').click()`);
    await until(`SF.app.state.selectedId===${JSON.stringify(batch[7])} && ${absent(batch[5])} && ${absent(batch[6])}`);
    await screenshot('bug-043-044-list-after-processing.png');

    await restore();
    const page=await ids();
    const nextPage=(await core.call('content.list', {read:false,archived:false,deferred:false,limit:1,offset:20})).items[0].id;
    await select(page[19]);
    await arrange('已读');
    await until(`SF.app.state.selectedId===${JSON.stringify(nextPage)} && document.querySelectorAll('.content-card').length===20 && ${absent(page[19])}`);
    await click('下一页');
    await loaded(4);
    assert.equal(await scroll(list),0,'A new page starts at the top');
    const tail=await ids();
    await select(tail[3]);
    await arrange('归档');
    await until(`SF.app.state.selectedId===${JSON.stringify(tail[2])} && document.querySelectorAll('.content-card').length===3`);
    for (let index=0;index<3;index++) await evaluate(`document.querySelectorAll('.content-selection > [role="checkbox"]')[${index}].click()`);
    const preceding=(await core.call('content.list', {read:false,archived:false,deferred:false,limit:20})).items[19].id;
    await evaluate(`Array.from(document.querySelectorAll('.inbox__toolbar button')).find(b=>b.textContent.trim()==='归档').click()`);
    await until(`document.querySelectorAll('.content-card').length===20 && SF.app.state.selectedId===${JSON.stringify(preceding)} && document.body.innerText.includes('第 1 页')`);

    // Shared content partitions use the same scroll policy; processing in all keeps selection.
    await restore();
    await evaluate(`document.querySelector('[data-quick="all"]').click()`);
    await loaded(20);
    const keep=(await ids())[5];
    await select(keep);
    await setScroll(list);
    await arrange('已读');
    await until(`SF.app.state.counts.read===1 && SF.app.state.selectedId===${JSON.stringify(keep)} && !!document.querySelector('.detail .op-btn[aria-pressed="true"]')`);
    assert.equal(await scroll(list),350);
    await core.call('content.bulk_update',{item_ids:allIds,patch:{deferred:true}});
    await evaluate(`document.querySelector('[data-quick="deferred"]').click(); SF.app.refreshData(true)`);
    await loaded(20);
    await setScroll(list);
    await select((await ids())[6]);
    assert.equal(await scroll(list),350,'Other partition preserves scroll');

    // View-specific independent scroll containers also survive data refresh.
    await core.call('priority.set_source',{subscription_id:sub.id,priority:'high'});
    await evaluate(`SF.app.state.filters={quick:'all',platform:null,channelId:null}; SF.app.navigate('overview',{mode:'priority'}); SF.app.refreshData(true)`);
    await until(`document.querySelectorAll('[data-priority-column="high"] [data-priority-item]').length===20`);
    const board='[data-priority-column="high"] .kanban__list';
    await setScroll(board);
    await evaluate('SF.app.refreshData(true)');
    await until(`document.querySelectorAll('[data-priority-column="high"] [data-priority-item]').length===20`);
    assert.equal(await scroll(board),350);
    await evaluate(`SF.app.navigate('overview',{mode:'calendar'})`);
    await until(`!!document.querySelector('.calendar-grid')`);
    await click('今天');
    await until(`document.querySelectorAll('[data-calendar-item]').length===20`);
    await setScroll('.day-panel__list');
    await evaluate('SF.app.refreshData(true)');
    await until(`document.querySelectorAll('[data-calendar-item]').length===20`);
    assert.equal(await scroll('.day-panel__list'),350);
    await evaluate(`document.querySelector('[data-calendar-item]').click()`);
    await until(`!!document.querySelector('.dialog .priority-opt--low')`);
    const detail='.dialog__body';
    const detailTop=await setScroll(detail,120);
    await evaluate(`document.querySelector('.dialog .priority-opt--low').click()`);
    await until(`!!document.querySelector('.dialog .priority-opt--low[aria-pressed="true"]')`);
    assert.equal(await scroll(detail),detailTop,'Modal detail repaint preserves scroll');
    await evaluate(`document.querySelector('.dialog [aria-label="关闭对话框"]').click()`);
    await core.call('content.bulk_update',{item_ids:allIds,patch:{priority:null,archived:true}});
    await evaluate(`document.querySelector('[data-nav="inbox"]').click(); SF.app.refreshData(true)`);
    await until(`!document.querySelector('.content-card') && document.body.innerText.includes('当前没有待处理内容')`);
    assert.equal(await evaluate('SF.app.state.selectedId == null'),true);
    assert.equal(await evaluate(`!!document.querySelector('.detail')`),false);
    console.log(JSON.stringify({listStateSmoke:'passed',scroll:true,loadingRestore:true,nextSelection:true,batchAndPageEdges:true,failedWrite:true,partitions:true,boardAndCalendar:true,modalDetail:true}));
  } finally {
    await evaluate(`if(window.listOriginal) { SF.app.state.client.listContents=window.listOriginal; (window.listReleases||[]).splice(0).forEach(release=>release()); } if(window.updateOriginal) SF.app.state.client.updateContent=window.updateOriginal; delete window.listOriginal; delete window.listReleases; delete window.updateOriginal; void 0`);
    await restore();
    window.setSize(1440,1000);
  }
}
module.exports={verifyListState};
