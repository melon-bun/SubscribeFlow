/**
 * M45 公众号付费渠道：正式 Renderer 验收（真实传输层版本）。
 *
 * 与 wxrank-ui-smoke.cjs 的区别只有一处：上游不是仓库里的脱敏样本，
 * 而是本机一个真实 HTTP 服务（scripts/wxrank-mock-upstream.cjs），
 * 它的响应形状照真实上游契约复刻。传输层是产品的真实传输层
 * （真实 urllib、真实 JSON 请求体、真实超时与重定向拒绝）。
 *
 * 所以这份证据证明的是：正式界面／Preload／Main／Core 在真实网络条件下
 * 跑通了付费渠道的完整链路。它**不是**真实付费上游的证据。
 *
 * 断言全部读渲染出来的 DOM 或核心服务的返回值，不看源码里的条件。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BIZ = 'MzI4NTEyMzQ1Ng==';
//: 一次性假密钥：只打本机上游，不接触任何真实凭据。
const SECRET = 'local-upstream-not-a-real-key';

async function verifyWxrankReal({evaluate, until, click, screenshot, core, root}) {
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
  const contents = async () => await core.call('content.list');
  const waitContents = async (previous) => {
    for (let i = 0; i < 240; i += 1) {
      const current = await contents();
      if (current.total > previous) return current;
      await new Promise(r => setTimeout(r, 250));
    }
    return await contents();
  };

  // ---- 渠道卡片存在，且明确写着这是付费渠道 ----
  await evaluate(`document.querySelector('[data-nav="channels"]').click()`);
  await until(`!!document.querySelector('${card}')`);
  await evaluate(`document.querySelector('.connection-row[data-connection-id="wechat:default"] > .connection-row__head').click()`);
  await until(`document.querySelector('${card}').getClientRects().length > 0`);
  await until(inCard(`c.innerText.includes('公众号 · 付费API')`));
  assert.ok((await cardText()).includes('未配置'), '未配置密钥时必须显示未配置');
  assert.ok((await cardText()).includes('本月已确认用量'), '卡片必须显示本地用量');
  await screenshot('m45-wxrank-real-card.png');

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
  assert.equal(afterCheck.calls, beforeCheck.calls, '本地配置检查不得触发任何调用');
  assert.equal(afterCheck.confirmed_credits, 0, '本地配置检查不得产生费用');
  await screenshot('m45-wxrank-real-check.png');

  // ---- 添加来源：解析要一次付费调用，确认添加命中缓存不再收费 ----
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
  assert.equal(afterAdd.calls, 1, '解析一次调用；确认添加命中缓存不得再收费');
  assert.equal(afterAdd.confirmed_credits, 5, '一次调用记 5 积分');

  // ---- 采集条数设为 10：这样刷新与回溯都是一页一次调用 ----
  await evaluate(`Array.from(document.querySelectorAll('.table__ops button')).find(b => (b.getAttribute('aria-label') || '').indexOf('设置采集条数') === 0 || (b.textContent || '').indexOf('采集条数') === 0).click()`);
  await until(`!!document.querySelector('#collect-items')`);
  await evaluate(`(() => {
    const input = document.querySelector('#collect-items');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '10');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await click('保存采集条数');
  await until(`!document.querySelector('#collect-items')`, 20000);

  // ---- 刷新：从头部取一页，内容真实入库 ----
  await evaluate(`Array.from(document.querySelectorAll('.table__ops button')).find(b => b.getAttribute('aria-label') === '刷新来源').click()`);
  await until(`!!document.querySelector('.dialog')`);
  const refreshText = await evaluate(`document.querySelector('.dialog').innerText`);
  assert.ok(refreshText.includes('次调用'), '刷新确认必须显示按实际配置推导的调用次数；实际内容：' + refreshText);
  assert.ok(refreshText.includes('积分'), '刷新确认必须显示费用');
  assert.ok(refreshText.includes('0 条新内容'), '刷新确认必须说明采到 0 条也可能收费');
  await screenshot('m45-wxrank-real-refresh-cost.png');
  await click('开始刷新');
  let items = await waitContents(0);
  assert.ok(items.total > 0, '刷新后必须有内容入库');
  const firstUrl = items.items[0].url;
  assert.ok(firstUrl.startsWith('https://mp.weixin.qq.com/s?'), '文章地址必须是官方 https 地址：' + firstUrl);
  assert.ok(firstUrl.indexOf('&amp;') < 0, '文章地址必须解开一层 HTML 转义：' + firstUrl);
  assert.ok(firstUrl.indexOf('mid=') > 0, '文章地址必须带 mid：' + firstUrl);
  const afterRefresh = await usage();
  assert.equal(afterRefresh.calls, 2, '刷新一次调用');
  assert.equal(afterRefresh.confirmed_credits, 10, '两次调用记 10 积分');

  // ---- 回溯第一次：一页，游标必须真的推进 ----
  const backfillOnce = async (previous) => {
    await evaluate(`Array.from(document.querySelectorAll('.table__ops button')).find(b => b.getAttribute('aria-label') === '回溯历史').click()`);
    await until(`!!document.querySelector('.dialog')`);
    const text = await evaluate(`document.querySelector('.dialog').innerText`);
    assert.ok(/本次最多 \d+ 次调用/.test(text), '回溯确认必须显示调用次数；实际内容：' + text);
    assert.ok(/约 \d+ 积分/.test(text), '回溯确认必须显示费用；实际内容：' + text);
    assert.ok(text.indexOf('续采') < 0 || text.indexOf('可以继续') >= 0,
              '回溯起点必须说清楚是续采还是从头重扫；实际内容：' + text);
    await click('开始回溯');
    return await waitContents(previous);
  };

  const afterBackfill1 = await backfillOnce(items.total);
  assert.ok(afterBackfill1.total > items.total, '第一次回溯必须采到新页');
  const usage1 = await usage();
  assert.equal(usage1.calls, 3, '回溯一次一页一次调用');
  assert.equal(usage1.confirmed_credits, 15, '三次调用记 15 积分');
  const status1 = await core.call('wxrank.status');
  const checkpoint1 = (status1.sources[0] || {}).backfill || {};
  assert.equal((checkpoint1.checkpoint || {}).state, 'resume',
                '回溯提交后必须留下可继续的检查点：' + JSON.stringify(checkpoint1));
  await screenshot('m45-wxrank-real-backfill.png');

  // ---- 回溯第二次：再取一页，游标继续推进 ----
  const afterBackfill2 = await backfillOnce(afterBackfill1.total);
  assert.ok(afterBackfill2.total > afterBackfill1.total, '第二次回溯必须采到新页');
  const usage2 = await usage();
  assert.equal(usage2.calls, 4, '再回溯一次一页一次调用');
  assert.equal(usage2.confirmed_credits, 20, '四次调用记 20 积分');

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
  await screenshot('m45-wxrank-real-list-only.png');

  const summary = {
    wxrankUi: 'passed',
    upstream: 'local-http (真实响应形状，非真实付费上游)',
    calls: usage2.calls,
    confirmedCredits: usage2.confirmed_credits,
    contents: afterBackfill2.total,
    checkpointAfterBackfill: (checkpoint1.checkpoint || {}).state,
  };
  const evidencePath = process.env.SUBSCRIBE_FLOW_WXRANK_EVIDENCE;
  if (evidencePath) {
    fs.mkdirSync(path.dirname(evidencePath), {recursive: true});
    fs.writeFileSync(evidencePath, JSON.stringify(summary, null, 2), 'utf8');
  }
  console.log(JSON.stringify(summary));
}

module.exports = {verifyWxrankReal};
