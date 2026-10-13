const assert = require('node:assert/strict');

// 在真实桥接上控制返回时机，确定性复现并发刷新与写入完成前的再次点击。
async function verifyRendererRaces({evaluate, until, core}) {
  await evaluate(`SF.app.refreshData(true)`);
  await until(`document.querySelectorAll('.content-card').length === 20`);
  try {
    await evaluate(`(() => {
      window.raceCounts = SF.app.state.client.getCounts;
      window.raceReleases = [];
      SF.app.state.client.getCounts = () => new Promise(resolve => {
        window.raceReleases.push(() => resolve(window.raceCounts()));
      });
      window.raceFirst = SF.app.refreshData(true);
    })()`);
    await until(`window.raceReleases.length === 1`);
    await evaluate(`window.raceSecondDone = false; window.raceSecond = SF.app.refreshData(true).then(() => {window.raceSecondDone = true;}); window.raceReleases.shift()(); void 0`);
    await until(`window.raceReleases.length === 1`);
    assert.equal(await evaluate(`window.raceSecondDone`), false,
      '排队的刷新尚未返回时，等待刷新者不得提前继续');
    await evaluate(`SF.app.state.client.getCounts = window.raceCounts; window.raceReleases.shift()(); Promise.all([window.raceFirst, window.raceSecond]).then(() => undefined)`);
    await until(`document.querySelectorAll('.content-card').length === 20`);
  } finally {
    await evaluate(`if (window.raceCounts) SF.app.state.client.getCounts = window.raceCounts; (window.raceReleases || []).splice(0).forEach(release => release()); void 0`);
    await evaluate(`Promise.all([window.raceFirst, window.raceSecond]).then(() => undefined)`);
  }

  await evaluate(`document.querySelector('[data-quick="all"]').click()`);
  await until(`document.querySelectorAll('.content-card').length === 20 && !!document.querySelector('.detail .op-btn')`);
  const id = await evaluate(`SF.app.state.selectedId`);
  try {
    await evaluate(`(() => {
      window.raceRefresh = SF.app.refreshData;
      SF.app.refreshData = () => new Promise(resolve => {window.raceReleaseWrite = () => resolve(window.raceRefresh(true));});
      Array.from(document.querySelectorAll('.detail .op-btn')).find(b => b.textContent.trim() === '已读').click();
    })()`);
    await until(`!!window.raceReleaseWrite && document.querySelector('.detail .op-btn[aria-pressed="true"]')?.textContent.trim() === '已读'`);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.detail .op-btn')).every(b => b.disabled)`), true,
      '写入结果先显示时，尚未结束的操作必须显式锁定控件');
    await evaluate(`SF.app.refreshData = window.raceRefresh; window.raceReleaseWrite(); void 0`);
    await evaluate(`SF.app.act(${JSON.stringify('content:' + id)}, () => {}).then(() => undefined)`);
    await until(`(() => { const b = Array.from(document.querySelectorAll('.detail .op-btn')).find(b => b.textContent.trim() === '稍后处理'); if (!b || b.disabled) return false; b.click(); return true; })()`);
    await evaluate(`SF.app.act(${JSON.stringify('content:' + id)}, () => {}).then(() => undefined)`);
    assert.equal((await core.call('content.get', {item_id: id})).state.deferred, true,
      '解除锁定后的下一次整理操作必须真正写入');
  } finally {
    await evaluate(`SF.app.refreshData = window.raceRefresh; if (window.raceReleaseWrite) window.raceReleaseWrite(); void 0`);
    await evaluate(`SF.app.act(${JSON.stringify('content:' + id)}, () => {}).then(() => undefined)`);
    await core.call('content.update', {item_id: id, patch: {read: false, deferred: false, archived: false}});
    await evaluate(`document.querySelector('[data-nav="inbox"]').click(); SF.app.refreshData(true)`);
    await until(`document.querySelectorAll('.content-card').length === 20 && SF.app.state.counts.unread === 25`);
  }
  console.log(JSON.stringify({rendererRaces:'passed',refreshDrain:true,contentWriteLock:true,nextWritePersisted:true}));
}

module.exports = {verifyRendererRaces};
