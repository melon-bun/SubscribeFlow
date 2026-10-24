/* BUG-124：智能判断的受限桥接与入口状态。
 *
 * 这条链路是真实 Electron + 真实 Core：
 *   Renderer AppClient → preload 白名单 → 主进程 UI_METHODS → Python RPC
 * 任何一段没接上，正式界面就会在选中内容时整块报错（详情面板直接消失）。
 *
 * 场景：默认关闭 → 选中内容不报错、入口不出现；在设置里打开智能判断 →
 * 回到收件箱、仍选同一条内容、不重载 → 入口要出现。
 */
const assert = require('node:assert/strict');

async function verifyPriorityBridge({evaluate, until, click, core, window}) {
  const navigateInbox = async () => {
    await evaluate(`SF.app.state.filters={quick:'all',platform:null,channelId:null};SF.app.navigate('inbox')`);
    await until(`document.querySelector('[data-view="inbox"]')`);
    await until(`document.querySelectorAll('.content-card').length > 0`);
  };
  const rejudgeVisible = () => evaluate(
    `Array.from(document.querySelectorAll('.detail button')).some(b=>b.textContent.trim()==='重新判断')`);

  // 统计状态读取次数：入口的出现依赖一次真实重读。
  await evaluate(`(() => {
    const c = SF.app.state.client;
    window.__statusCalls = 0;
    const orig = c.getPriorityStatus;
    c.getPriorityStatus = function () { window.__statusCalls++; return orig.apply(c, arguments); };
    return true;
  })()`);
  await navigateInbox();
  // 选一条真正在列表里的内容：详情面板只渲染列表里的选中项。
  const firstItem = await evaluate(`document.querySelector('.content-card').dataset.contentId`);
  // 让它处在「自动」态：入口只在自动选中时出现（手动档优先，不给入口）。
  // 记下原来的档位，收尾时原样还回去，后面的用例看到的还是同一套数据。
  const before = await core.call('content.get', {item_id: firstItem});
  const originalPriority = (before.priority_override !== undefined ? before.priority_override : before.priorityOverride) || null;
  await core.call('content.update', {item_id: firstItem, patch: {priority: null}});
  await evaluate(`SF.app.refreshData(true)`);
  await evaluate(`SF.app.state.selectedId=${JSON.stringify(firstItem)};SF.app.renderContent()`);
  await until(`!!document.querySelector('.detail')`);

  // 三个受限方法必须真的存在：缺一个，正式界面就会在这里整块报错。
  assert.equal(await evaluate(`typeof SF.app.state.client.getPriorityStatus`), 'function');
  assert.equal(await evaluate(`typeof SF.app.state.client.judgePriority`), 'function');
  assert.equal(await evaluate(`typeof SF.app.state.client.judgePriorityBulk`), 'function');
  // 详情面板不能出现「核心服务读取失败」。
  assert.equal(await evaluate(`document.body.innerText.includes('app.client.getPriorityStatus is not a function')`), false);
  assert.equal(await evaluate(`document.body.innerText.includes('核心服务读取失败')`), false);
  // 默认关闭：不给一个点了也不会有结果的按钮。
  assert.equal(await rejudgeVisible(), false);

  // 先把一条可用连接配好（设置页的连接选择要有东西可选）。
  await core.call('settings.update', {section: 'ai', patch: {providers: {
    'provider-llm': {endpoint: 'https://example.invalid/v1', model: 'bridge-smoke'}}},
    credential_refs: {'provider-llm': 'llm-key'}});

  // 走正式设置页：选连接 → 打开开关 → 保存设置。
  await evaluate(`SF.app.openSettings('priority')`);
  await until(`document.querySelector('.settings__title')?.textContent === '优先级设置'`);
  // 等设置真正加载完：标题先到，分区内容后到。
  await until(`!!document.querySelector('button.switch[aria-label="启用智能判断"]')`);
  await evaluate(`(() => {
    const sel = document.querySelector('select[aria-label="智能判断使用的连接"]');
    if (!sel) throw new Error('找不到智能判断的连接选择');
    sel.value = 'provider-llm';
    sel.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await evaluate(`document.querySelector('button.switch[aria-label="启用智能判断"]').click()`);
  await evaluate(`Array.from(document.querySelectorAll('.settings__foot button')).find(b=>b.textContent.trim()==='保存设置').click()`);
  await until(`!document.querySelector('.settings__body[disabled]')`);
  const status = await core.call('priority.status');
  assert.equal(status.enabled, true, '智能判断应当已开启');
  // 渲染端自己也要读得到：受限桥接这一段真的通了。
  const fromRenderer = await evaluate(`SF.app.state.client.getPriorityStatus()`);
  assert.equal(fromRenderer && fromRenderer.enabled, true, '渲染端应当读到智能判断已开启');

  // 回收件箱，仍选同一条内容，不重载页面。
  await navigateInbox();
  await evaluate(`SF.app.state.selectedId=${JSON.stringify(firstItem)};SF.app.renderContent()`);
  await until(`!!document.querySelector('.detail')`);
  // 自己轮询：失败时把状态读取次数带进错误信息，便于定位。
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let visible = false;
  for (let i = 0; i < 100 && !visible; i++) {
    visible = await rejudgeVisible();
    if (!visible) await sleep(50);
  }
  assert.ok(visible, `重新判断入口应当出现（状态读取次数 ${await evaluate('window.__statusCalls')}）`);

  // 明确重判：受限调用要真的能落到 Core。
  const queued = await evaluate(`SF.app.state.client.judgePriority(${JSON.stringify(firstItem)})`);
  assert.ok(queued && typeof queued === 'object', 'judgePriority 应当返回排队结果');

  // 收尾：把开关关回去，后面的用例不受影响。
  await evaluate(`SF.app.openSettings('priority')`);
  await until(`document.querySelector('.settings__title')?.textContent === '优先级设置'`);
  await until(`!!document.querySelector('button.switch[aria-label="启用智能判断"]')`);
  await evaluate(`document.querySelector('button.switch[aria-label="启用智能判断"]').click()`);
  await evaluate(`Array.from(document.querySelectorAll('.settings__foot button')).find(b=>b.textContent.trim()==='保存设置').click()`);
  await until(`!document.querySelector('.settings__body[disabled]')`);
  assert.equal((await core.call('priority.status')).enabled, false, '收尾时应当已关闭');
  // 把这条内容的档位还回去：后面的用例看到的还是原来的数据。
  await core.call('content.update', {item_id: firstItem, patch: {priority: originalPriority}});
  await evaluate(`SF.app.refreshData(true)`);
  // 回到原来的位置：后面的用例接着在总览日历上跑。
  await evaluate(`SF.app.state.filters={quick:'all',platform:null,channelId:null}; SF.app.navigate('overview',{mode:'calendar'})`);
  await until(`!!document.querySelector('.calendar-grid')`);
  console.log(JSON.stringify({priorityBridgeSmoke: 'passed', clientMethods: true, detailIntact: true,
    enabledAfterSettings: status.enabled, rejudgeVisible: true}));
  return { bridge: 'passed', enabledAfterSettings: status.enabled, rejudgeVisible: true };
}

module.exports = {verifyPriorityBridge};
