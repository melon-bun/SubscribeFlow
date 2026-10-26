/**
 * M45 公众号付费渠道（wxrank）的正式 Renderer 验收。
 *
 * 这里的每一条断言都读渲染出来的 DOM 或核心服务的返回值，不看源码里的条件。
 * 上游换成脱敏样本（SUBSCRIBE_FLOW_WXRANK_FIXTURE），因此整条链路
 * Main／Preload／Renderer／Core 跑通但不产生任何真实费用。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BIZ = 'MzI4NTEyMzQ1Ng==';
const SECRET = 'wxrank-smoke-secret-not-a-real-key';

async function verifyWxrank({evaluate, until, click, screenshot, core, root}) {
  const card = `[data-refresh-key="wxrank-card"]`;
  const inCard = (expression) => `(() => { const c = document.querySelector(${JSON.stringify(card)}); if (!c) return null; return ${expression}; })()`;

  const cardText = async () => (await evaluate(inCard('c.innerText')) || '');
  const clickInCard = async (label) => {
    const found = await evaluate(inCard(`(() => {
      const b = Array.from(c.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!b || b.disabled) return false;
      b.click(); return true;
    })()`));
    assert.ok(found, '渠道卡片上必须能找到按钮：' + label);
  };
  const setInput = async (selector, value) => {
    const done = await evaluate(inCard(`(() => {
      const input = c.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', {bubbles:true}));
      return true;
    })()`));
    assert.ok(done, '渠道卡片上必须能找到输入框：' + selector);
  };
  const usage = async () => await core.call('wxrank.usage');

  // ---- 付费配置归入微信公众号，默认收起，展开后才能操作 ----
  await evaluate(`document.querySelector('[data-nav="channels"]').click()`);
  await until(`!!document.querySelector('${card}')`);
  const group = '.connection-row[data-connection-id="wechat:default"]';
  const head = group + ' > .connection-row__head';
  assert.equal(await evaluate(`document.querySelector('${card}').closest('.connection-row')?.dataset.connectionId`),
               'wechat:default', '付费配置必须放在微信公众号内');
  assert.equal(await evaluate(`document.querySelector('${head}').getAttribute('aria-expanded')`), 'false');
  assert.equal(await evaluate(`document.querySelector('${card}').getClientRects().length`), 0,
               '默认收起时不得露出付费配置');
  await screenshot('m45-wechat-collapsed.png');
  await evaluate(`document.querySelector('${head}').click()`);
  await until(`document.querySelector('${head}').getAttribute('aria-expanded') === 'true'`);
  assert.ok(await evaluate(`document.querySelector('${card}').getClientRects().length > 0`));
  await until(inCard(`c.innerText.includes('公众号 · 付费API')`));
  assert.ok((await cardText()).includes('未配置'), '未配置密钥时必须显示未配置');
  assert.ok((await cardText()).includes('本月已确认用量'), '卡片必须显示本地用量');
  await screenshot('m45-wxrank-card.png');

  // ---- 保存密钥：加密落盘，界面只显示是否已配置 ----
  await setInput('#wxrank-secret', SECRET);
  await clickInCard('保存密钥');
  try {
    await until(inCard(`c.innerText.includes('已配置')`), 20000);
  } catch (error) {
    throw new Error('保存密钥后卡片没有变成已配置；卡片内容：' + (await cardText()));
  }
  const dataDir = process.env.SUBSCRIBE_FLOW_DATA_DIR;
  if (dataDir) {
    const credentialFile = path.join(dataDir, 'credentials.json');
    if (fs.existsSync(credentialFile)) {
      const raw = fs.readFileSync(credentialFile, 'utf8');
      assert.ok(!raw.includes(SECRET), '密钥必须加密落盘，磁盘上不得出现明文');
    }
  }

  // ---- 免费本地配置检查：不联网、也不花钱 ----
  const beforeCheck = await usage();
  await clickInCard('检查配置');
  await until(inCard(`c.innerText.includes('未联网验证')`), 30000);
  const afterCheck = await usage();
  assert.equal(await evaluate(`document.querySelector('${head}').getAttribute('aria-expanded')`), 'true',
               '保存密钥与配置检查后的刷新必须保留展开状态');
  await evaluate(`document.querySelector('${head}').click()`);
  assert.equal(await evaluate(`document.querySelector('${card}').getClientRects().length`), 0);
  await evaluate(`document.querySelector('${head}').click()`);
  await until(`document.querySelector('${head}').getAttribute('aria-expanded') === 'true'`);
  assert.equal(afterCheck.calls, beforeCheck.calls, '本地配置检查不得触发任何调用');
  assert.equal(afterCheck.confirmed_credits, 0, '本地配置检查不得产生费用');
  await screenshot('m45-wxrank-check.png');

  // ---- 显式付费测试：绕过缓存，且真的产生一次付费调用 ----
  await setInput('#wxrank-biz', BIZ);
  assert.ok((await cardText()).includes('预计 5 积分'), '付费测试必须写明预计费用');
  await clickInCard('测试接口 · 预计 5 积分');
  await until(`!!document.querySelector('.dialog')`);
  const confirmText = await evaluate(`document.querySelector('.dialog').innerText`);
  assert.ok(confirmText.includes('付费'), '付费测试必须先确认会产生付费调用');
  await click('付费测试');
  await until(inCard(`c.innerText.includes('已解析')`), 30000);
  const afterTest = await usage();
  assert.equal(afterTest.confirmed_credits, 5, '一次付费测试记 5 积分');
  assert.equal(afterTest.calls, 1, '付费测试只产生一次调用');
  await screenshot('m45-wxrank-test.png');

  // ---- 添加来源：解析要钱，确认添加命中缓存不再收费 ----
  await click('添加渠道或创作者');
  await until(`!!document.querySelector('#source-input')`);
  await evaluate(`(() => {
    const b = document.querySelector('[data-connection-id="wxrank:default"]');
    if (b) b.click();
  })()`);
  await until(`document.querySelector('.source-platforms [data-connection-id="wxrank:default"]')?.getAttribute('aria-pressed') === 'true'`);
  assert.ok((await evaluate(`document.querySelector('.dialog').innerText`)).includes('积分'),
            '添加来源时必须说明首次解析的费用');
  await evaluate(`document.querySelector('#source-input').value = ${JSON.stringify(BIZ)}; document.querySelector('#source-input').dispatchEvent(new Event('input', {bubbles:true}));`);
  await click('解析 UID / 主页');
  await until(`!!document.querySelector('#source-confirm') && !document.querySelector('#source-confirm').disabled`, 30000);
  await evaluate(`document.querySelector('#source-confirm').click()`);
  await click('确认添加');
  await until(`!document.querySelector('.dialog') && !!document.querySelector('[data-channel-id]')`, 30000);
  const afterAdd = await usage();
  assert.equal(afterAdd.confirmed_credits, 10, '解析一次 5 积分；确认添加命中缓存不再收费');
  assert.equal(afterAdd.calls, 2, '确认添加不得再产生一次付费调用');

  // ---- 刷新：从头部取一页，内容入库 ----
  await evaluate(`Array.from(document.querySelectorAll('.table__ops button')).find(b => b.getAttribute('aria-label') === '刷新来源').click()`);
  await until(`!!document.querySelector('.dialog')`);
  const refreshText = await evaluate(`document.querySelector('.dialog').innerText`);
  assert.ok(refreshText.includes('次调用'), '刷新确认必须显示按实际配置推导的调用次数；实际内容：' + refreshText);
  assert.ok(refreshText.includes('积分'), '刷新确认必须显示费用');
  assert.ok(refreshText.includes('0 条新内容'), '刷新确认必须说明采到 0 条也可能收费');
  await screenshot('m45-wxrank-refresh-cost.png');
  await click('开始刷新');
  let contents = {total:0};
  for (let i = 0; i < 120; i += 1) {
    contents = await core.call('content.list');
    if (contents.total > 0) break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(contents.total > 0, '刷新后必须有内容入库');
  const afterRefresh = await usage();
  assert.equal(afterRefresh.confirmed_credits, 15, '一次刷新一页记 5 积分');

  // ---- 回溯：费用按实际配置推导，检查点语义要写清 ----
  const ops = await evaluate(`Array.from(document.querySelectorAll('.table__ops button')).map(b => ({label:b.getAttribute('aria-label'), disabled:b.disabled}))`);
  assert.ok(ops.some(b => b.label === '回溯历史' && !b.disabled), '回溯按钮必须可用：' + JSON.stringify(ops));
  await evaluate(`Array.from(document.querySelectorAll('.table__ops button')).find(b => b.getAttribute('aria-label') === '回溯历史').click()`);
  await until(`!!document.querySelector('.dialog')`);
  const backfillText = await evaluate(`document.querySelector('.dialog').innerText`);
  assert.ok(/本次最多 \d+ 次调用/.test(backfillText), '回溯确认必须显示调用次数');
  assert.ok(/约 \d+ 积分/.test(backfillText), '回溯确认必须显示费用');
  assert.ok(!backfillText.includes('续采'), '没有有效检查点时不得说成续采');
  await screenshot('m45-wxrank-backfill-cost.png');
  await click('取消');

  // ---- 来源地址不是可浏览主页 ----
  const homepageDisabled = await evaluate(`(() => {
    const row = document.querySelector('[data-channel-id]');
    const button = Array.from(row.querySelectorAll('button')).find(b => b.textContent.trim() === '打开主页');
    return button ? !!button.disabled : null;
  })()`);
  assert.equal(homepageDisabled, true, '公众号来源的「打开主页」必须禁用');

  // ---- 内容详情：只有列表信息，不宣称取得了正文 ----
  await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
  await until(`!!document.querySelector('.content-card')`);
  await evaluate(`document.querySelector('.content-card').click()`);
  await until(`!!document.querySelector('.detail')`);
  await until(`document.querySelector('.detail').innerText.includes('仅列表信息')`);
  const detailText = await evaluate(`document.querySelector('.detail').innerText`);
  assert.ok(!detailText.includes('已采集正文'), '不得宣称正文已取得');
  assert.ok(!detailText.includes('正文已采集'), '读数条也不得宣称正文已采集');
  await screenshot('m45-wxrank-list-only.png');

  console.log(JSON.stringify({wxrankUi:'passed', confirmedCredits:afterRefresh.confirmed_credits,
    calls:afterRefresh.calls, contents:contents.total}));
}

module.exports = {verifyWxrank};
