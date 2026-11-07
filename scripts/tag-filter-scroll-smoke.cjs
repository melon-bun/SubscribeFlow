// Exercise the production inbox with an isolated, offline tag catalog.
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-tag-filter-'));
app.setPath('userData', path.join(temporary, 'profile'));

async function run() {
  const win = new BrowserWindow({show: false, width: 1200, height: 760, webPreferences: {preload: path.join(__dirname, 'tags-refresh-ui-stub.cjs'), contextIsolation: true, sandbox: false, nodeIntegration: false}});
  const ev = code => win.webContents.executeJavaScript(code);
  const until = async expression => {
    const start = Date.now();
    while (!(await ev(expression))) {
      if (Date.now() - start > 10000) throw new Error('等待超时：' + expression);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  try {
    await win.loadFile(path.join(root, 'electron/renderer/index.html'), {hash: '/inbox'});
    await until(`!!SF.app.state.session && !!document.querySelector('[data-view="inbox"]')`);
    const tags = Array.from({length: 100}, (_, i) => ({id: 'tag-' + i, name: '标签 ' + String(i).padStart(3, '0'), color: 'cyan', enabled: true, contentCount: 1}));
    await ev(`TagsRefreshStub.configure({tags:${JSON.stringify(tags)}}); SF.views.inbox.invalidate(new Set(['tags'])); SF.app.renderView('inbox'); void 0`);
    await ev(`SF.views.inbox.whenIdle()`);
    await ev(`Array.from(document.querySelectorAll('.inbox__toolbar button')).find(b => b.textContent.trim() === '标签').click(); void 0`);
    await until(`document.querySelectorAll('.tag-filter__tags [data-tag-filter]').length === 100`);
    for (const [width, height] of [[1200, 760], [900, 700]]) {
      win.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 200));
      const state = await ev(`(() => { const list = document.querySelector('.tag-filter__tags'), panel = document.querySelector('.tag-filter'), mode = document.querySelector('.tag-filter__mode'), body = document.querySelector('.inbox'); const a = list.getBoundingClientRect(), b = body.getBoundingClientRect(), p = panel.getBoundingClientRect(), m = mode.getBoundingClientRect(); return {overflow: getComputedStyle(list).overflowY, clientHeight:list.clientHeight, scrollHeight:list.scrollHeight, visible:a.top >= b.top && a.bottom <= b.bottom && p.bottom <= b.bottom && m.bottom <= b.bottom}; })()`);
      assert.equal(state.overflow, 'auto', JSON.stringify(state));
      assert.ok(state.scrollHeight > state.clientHeight && state.clientHeight > 0 && state.visible, JSON.stringify(state));
      await ev(`document.querySelector('.tag-filter__tags').scrollTop = 0; document.querySelector('.tag-filter__tags').focus(); void 0`);
      win.webContents.sendInputEvent({type:'keyDown', keyCode:'End'});
      win.webContents.sendInputEvent({type:'keyUp', keyCode:'End'});
      await until(`document.querySelector('.tag-filter__tags').scrollTop > 0`);
      await ev(`document.querySelector('.tag-filter__tags').scrollTop = 0; void 0`);
      const point = await ev(`(() => { const r = document.querySelector('.tag-filter__tags').getBoundingClientRect(); return {x:Math.round(r.left + 20), y:Math.round(r.top + Math.min(30, r.height / 2))}; })()`);
      for (let i = 0; i < 20; i++) {
        win.webContents.sendInputEvent({type:'mouseWheel', ...point, deltaX:0, deltaY:-500, canScroll:true});
        await new Promise(resolve => setTimeout(resolve, 100));
        if (await ev(`(() => { const e = document.querySelector('.tag-filter__tags'); return e.scrollTop + e.clientHeight >= e.scrollHeight - 1; })()`)) break;
      }
      await until(`(() => { const e = document.querySelector('.tag-filter__tags'); return e.scrollTop + e.clientHeight >= e.scrollHeight - 1; })()`);
      await new Promise(resolve => setTimeout(resolve, 350));
      const top = await ev(`document.querySelector('.tag-filter__tags').scrollTop`);
      await ev(`document.querySelector('[data-tag-filter="tag-99"]').click(); void 0`);
      await ev(`SF.views.inbox.whenIdle()`);
      assert.ok(await ev(`document.querySelector('[data-tag-filter="tag-99"]').getAttribute('aria-pressed') === 'true'`));
      assert.ok(await ev(`Math.abs(document.querySelector('.tag-filter__tags').scrollTop - ${top}) < 2`), '选择标签后应保留滚动位置');
      await ev(`document.querySelector('[data-tag-filter="tag-98"]').click(); void 0`);
      await ev(`SF.views.inbox.whenIdle()`);
      await ev(`Array.from(document.querySelectorAll('.tag-filter__mode button')).find(b => b.textContent.trim() === '全部符合').click(); void 0`);
      await ev(`SF.views.inbox.whenIdle()`);
      assert.ok(await ev(`SF.app.state.filters.tagMode === 'all' && SF.app.state.filters.tags.includes('tag-99') && SF.app.state.filters.tags.includes('tag-98')`), '应保留所选标签与筛选方式');
      await ev(`Array.from(document.querySelectorAll('.tag-filter__head button')).find(b => b.textContent.trim() === '清除标签筛选').click(); void 0`);
      await ev(`SF.views.inbox.whenIdle()`);
      assert.ok(await ev(`!SF.app.state.filters.tags.length && SF.app.state.filters.tagMode === 'any'`), '清除筛选应恢复默认方式');
    }
    await ev(`TagsRefreshStub.configure({tags:${JSON.stringify(tags.slice(0, 2))}}); SF.views.inbox.invalidate(new Set(['tags'])); SF.app.renderView('inbox'); void 0`);
    await ev(`SF.views.inbox.whenIdle()`);
    assert.ok(await ev(`(() => { const e = document.querySelector('.tag-filter__tags'); return e.children.length === 2 && e.scrollHeight <= e.clientHeight + 1; })()`), '少量标签应完整显示');
    console.log('标签筛选滚动、选择和清除验收通过');
  } finally { win.destroy(); fs.rmSync(temporary, {recursive:true, force:true}); }
}
app.whenReady().then(run).then(() => app.exit(0)).catch(error => {console.error(error); app.exit(1);});
