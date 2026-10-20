// Run in Electron against the production renderer, with isolated offline data.
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-tags-refresh-'));
const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || temporary;
app.setPath('userData', path.join(temporary, 'profile'));

async function run() {
  fs.mkdirSync(output, {recursive: true});
  const win = new BrowserWindow({show: false, width: 1200, height: 760, webPreferences: {preload: path.join(__dirname, 'tags-refresh-ui-stub.cjs'), contextIsolation: true, sandbox: false, nodeIntegration: false}});
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  const evaluate = async code => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\n' + code); }
  };
  const until = async expression => {
    const start = Date.now();
    while (!(await evaluate(expression))) {
      if (Date.now() - start > 10000) throw new Error('等待超时：' + expression + '\n' + await evaluate('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const idle = () => evaluate('SF.views.tags.whenIdle()');
  const background = reasons => evaluate(`SF.views.tags.invalidate(new Set(${JSON.stringify(reasons)})); if (!SF.views.tags.updateBackground(SF.app.state)) SF.app.renderView('tags'); void 0`);
  const click = label => evaluate(`(() => { const b = Array.from(document.querySelectorAll('[data-view="tags"] button')).find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) throw new Error('按钮不可用'); b.click(); })()`);
  const screenshot = async name => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };

  await win.loadFile(path.join(root, 'electron/renderer/index.html'), {hash: '/tags?tab=list'});
  await until(`!!document.querySelector('[data-tag-editor] textarea')`);
  await idle();
  assert.equal(await evaluate('typeof SF.app.renderView'), 'function');
  await evaluate(`window.savedInput = document.querySelector('#tag-desc'); savedInput.focus(); savedInput.value = '未保存的用户说明'; savedInput.dispatchEvent(new Event('input', {bubbles:true})); savedInput.setSelectionRange(3, 6); window.savedEditor = document.querySelector('.tags-editor__body'); savedEditor.scrollTop = 130; window.savedTop = savedEditor.scrollTop; window.tagsCalls = TagsRefreshStub.calls().filter(c => c.name === 'listTags').length; void 0`);
  for (let index = 0; index < 4; index++) { await background(['content', 'runs']); await idle(); }
  assert.ok(await evaluate(`savedInput === document.querySelector('#tag-desc') && document.activeElement === savedInput && savedInput.value === '未保存的用户说明' && savedInput.selectionStart === 3 && savedInput.selectionEnd === 6`), '内容和进度刷新应保留输入节点、草稿、焦点和选区');
  assert.ok(await evaluate(`document.querySelector('.tags-editor__body').scrollTop === savedTop`), '关联内容滚动不能回到顶部');
  assert.ok(await evaluate(`TagsRefreshStub.calls().filter(c => c.name === 'listTags').length === tagsCalls`), '采集不应重读标签目录');
  await evaluate(`TagsRefreshStub.configure({tags:[{id:'tag-a',name:'服务端新名称',description:'服务端自动补说明',synonyms:['读书'],color:'cyan',enabled:true,contentCount:9}],delays:{listTags:250}}); void 0`);
  await background(['tags']);
  assert.ok(await evaluate(`savedInput.isConnected && document.querySelectorAll('tbody tr').length === 1 && !document.body.innerText.includes('正在载入标签')`), '后台读取时保留已显示数据');
  await idle();
  assert.equal(await evaluate(`document.querySelector('#tag-name').value`), '服务端新名称', '干净字段应读入更新');
  assert.ok(await evaluate(`savedInput === document.querySelector('#tag-desc') && document.activeElement === savedInput && savedInput.value === '未保存的用户说明'`), '标签事件不能覆盖脏字段');
  await screenshot('tags-draft-survives');
  await click('保存修改');
  await until(`TagsRefreshStub.calls().some(c => c.name === 'updateTag')`);
  await idle();
  assert.equal(await evaluate(`TagsRefreshStub.calls().find(c => c.name === 'updateTag').args[1].description`), '未保存的用户说明');
  await evaluate(`const next = document.querySelector('#tag-desc'); next.value = '保存后继续编辑'; next.dispatchEvent(new Event('input', {bubbles:true})); void 0`);
  await click('保存修改');
  await until(`TagsRefreshStub.calls().filter(c => c.name === 'updateTag').length === 2`);
  await idle();
  assert.equal(await evaluate(`TagsRefreshStub.calls().filter(c => c.name === 'updateTag')[1].args[1].description`), '保存后继续编辑', '保存后不能遗留旧闭包');

  await evaluate(`SF.app.navigate('tags', {tab:'ai'}); void 0`);
  await until(`document.body.innerText.includes('还没有自动打标任务')`);
  await click('查看可补打范围');
  await until(`document.body.innerText.includes('立即补打 7 条')`);
  await evaluate(`window.backfill = document.querySelector('[data-ai-slot="backfill"]'); window.confirmButton = Array.from(backfill.querySelectorAll('button')).find(b=>b.textContent.includes('立即补打')); confirmButton.focus({preventScroll:true}); void 0`);
  const recent = Array.from({length: 12}, (_, i) => ({id:'task-'+i,content_id:'zhihu:answer:'+('identifier'.repeat(20))+i,state:i?'failed':'running',model:'long-model-name'.repeat(15),provider:'offline',error_message:'upstream_error_without_spaces'.repeat(10)}));
  await evaluate(`TagsRefreshStub.configure({status:${JSON.stringify({summary:{total:12,active:1,needsAttention:11},recent})}}); void 0`);
  await background(['tagging']); await idle();
  assert.ok(await evaluate(`backfill === document.querySelector('[data-ai-slot="backfill"]') && confirmButton.isConnected && document.activeElement === confirmButton`), 'AI任务更新应保留补打预览节点和焦点');
  assert.equal(await evaluate(`document.querySelectorAll('.ai-task').length`), 12);
  assert.ok(await evaluate(`document.querySelector('.tags-ai').scrollWidth <= document.querySelector('.tags-ai').clientWidth + 1`), '长任务不得横向溢出');
  await screenshot('tags-ai-preview-survives');
  await evaluate(`TagsRefreshStub.configure({delays:{'tagging.status':300}}); void 0`);
  await background(['tagging']);
  await evaluate(`SF.app.navigate('inbox'); void 0`);
  await until(`!!document.querySelector('[data-view="inbox"]')`);
  await evaluate(`window.inboxNode = document.querySelector('[data-view="inbox"]'); void 0`);
  await idle();
  assert.ok(await evaluate(`inboxNode === document.querySelector('[data-view="inbox"]')`), '迟到AI回包不得重画新路由');
  await evaluate(`SF.app.navigate('tags', {tab:'ai'}); void 0`);
  await until(`document.body.innerText.includes('立即补打 7 条')`);
  assert.equal(await evaluate(`document.querySelectorAll('.ai-task').length`), 12, '返回页签应直接展示缓存');
  await evaluate(`TagsRefreshStub.configure({errors:{'tagging.status':'离线错误'}}); void 0`);
  await background(['tagging']); await idle();
  assert.ok(await evaluate(`document.querySelectorAll('.ai-task').length===12 && document.body.innerText.includes('离线错误') && document.body.innerText.includes('立即补打 7 条')`), '刷新失败应保留任务和预览');
  await evaluate(`TagsRefreshStub.configure({errors:{}}); void 0`);
  await background(['tagging']); await idle();
  assert.equal(await evaluate(`document.body.innerText.includes('离线错误')`), false);
  await click('立即补打 7 条');
  await until(`TagsRefreshStub.calls().some(c=>c.name==='tagging.backfill'&&c.args.limit===7)`);
  await idle();
  await screenshot('tags-ai-preview-confirmed');
  assert.deepEqual(errors, []);
  console.log('标签后台刷新验收通过：' + output);
  win.destroy();
}
app.whenReady().then(run).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
