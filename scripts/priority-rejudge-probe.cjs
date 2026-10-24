/* BUG-124 复验探针（Codex 原探针的等价复跑，输出写到 batch-04 证据目录）。
 *
 * 原探针（batch-03/codex-rejudge-probe.cjs）用 node 直接 require 主进程入口，
 * 那样跑不起来（主进程需要 Electron 运行时）。这里改成和冒烟脚本一样的形状：
 * 父进程准备隔离数据目录并拉起 Electron，Electron 里再 require 主进程入口。
 *
 * 场景：正式设置里打开智能判断 → 回到收件箱、仍选同一条内容、不重载 →
 * 详情应当出现「重新判断」，且不再报「app.client.getPriorityStatus is not a function」。
 *
 * 隔离数据目录，不碰用户日常数据库／配置／会话。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {spawnSync, spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const outputPath = process.env.SUBSCRIBE_FLOW_REJUDGE_OUTPUT
  || path.join(root, 'docs/verification/priority-minimax/batch-04/rejudge-probe-batch04.json');

if (!process.versions.electron) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-bug124-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const seed = spawnSync(runtime.python, ['-c', `
import sys,json
from pathlib import Path
from subscribe_flow.bootstrap import Core
from subscribe_flow.contracts import ContentItem,Source
c=Core(Path(sys.argv[1])/'subscribe-flow.sqlite3')
s=Source('demo','author','a','Review','https://example.invalid/a')
i=ContentItem('demo','feed','review-target',s,'Review target','https://example.invalid/item')
print(json.dumps({'id':c.repository.save_manual(i)['item_id']}))
c.settings.update('ai',{'providers':{'provider-llm':{'endpoint':'https://example.invalid/v1','model':'fake-review'}}})
c.database.close();c.lease.close()
`, folder], {encoding: 'utf8', env: {...process.env, PYTHONPATH: path.join(root, 'python/src')}});
  if (seed.status !== 0) throw new Error(seed.stderr);
  const itemId = JSON.parse(seed.stdout.trim()).id;
  const child = spawn(require('electron'), [__filename], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'uishot',
      SUBSCRIBE_FLOW_DATA_DIR: folder, SUBSCRIBE_FLOW_PROBE_ITEM: itemId},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', (code) => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
  return;
}

/* ---- 以下在 Electron 主进程里执行 ---- */
const itemId = process.env.SUBSCRIBE_FLOW_PROBE_ITEM;
process.env.SUBSCRIBE_FLOW_RENDERER_SMOKE = 'uishot';
require(path.join(root, 'scripts/ui-shot-renderer.cjs')).verify = async ({window, core}) => {
  const evaluate = async s => {
    try { return await window.webContents.executeJavaScript(s); }
    catch (e) { throw new Error(e.message + '\nSOURCE: ' + s); }
  };
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const until = async s => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(s).catch(() => false)) return;
      await pause(50);
    }
    throw new Error('wait: ' + s);
  };
  await until('!!window.SF?.app.state.session');
  // 详情面板只渲染列表里的选中项：先进收件箱，等列表重绘，再选那条内容。
  const navigateInbox = async () => {
    await evaluate(`SF.app.state.filters={quick:'all',platform:null,channelId:null};SF.app.navigate('inbox')`);
    await until('document.querySelectorAll(".content-card").length > 0');
  };
  const rejudgeVisible = () => evaluate(
    `Array.from(document.querySelectorAll('.detail button')).some(b=>b.textContent.trim()==='重新判断')`);
  await navigateInbox();
  await evaluate(`SF.app.state.selectedId=${JSON.stringify(itemId)};SF.app.renderContent()`);
  await until('!!document.querySelector(".detail")');
  await pause(300);
  const before = await core.call('priority.status');
  const beforeTypes = await evaluate(`({status:typeof SF.app.state.client.getPriorityStatus,judge:typeof SF.app.state.client.judgePriority,bulk:typeof SF.app.state.client.judgePriorityBulk})`);
  const beforeRaw = await evaluate(`SubscribeFlow.request('getPriorityStatus',[])`);
  const beforeButton = await rejudgeVisible();

  await core.call('settings.update', {section: 'priority', patch: {smart: {enabled: true, providerId: 'provider-llm'}}});
  await evaluate(`SF.app.openSettings('priority')`);
  await until('!!document.querySelector(".settings")');
  await navigateInbox();
  await evaluate(`SF.app.state.selectedId=${JSON.stringify(itemId)};SF.app.renderContent()`);
  await until('!!document.querySelector(".detail")');
  // 入口依赖一次状态重读，等它自己出现。
  let button = false;
  for (let i = 0; i < 100 && !button; i++) {
    button = await rejudgeVisible();
    if (!button) await pause(50);
  }

  const after = await core.call('priority.status');
  const types = await evaluate(`({status:typeof SF.app.state.client.getPriorityStatus,judge:typeof SF.app.state.client.judgePriority,bulk:typeof SF.app.state.client.judgePriorityBulk})`);
  const raw = await evaluate(`SubscribeFlow.request('getPriorityStatus',[])`);
  const body = await evaluate(`document.body.innerText.slice(0,350)`);
  const result = {
    beforeEnabled: before.enabled,
    afterEnabled: after.enabled,
    rejudgeButtonVisible: button,
    rejudgeButtonVisibleBefore: beforeButton,
    clientTypes: types,
    beforeClientTypes: beforeTypes,
    rawStatus: raw,
    beforeRawStatus: beforeRaw,
    detailVisible: await evaluate(`!!document.querySelector(".detail")`),
    body,
    itemId,
  };
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
};
require(path.join(root, 'electron/main/index.cjs'));
