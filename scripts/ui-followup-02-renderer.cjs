const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

/**
 * ui-followup-02（笔记页美化 + 紧凑原内容卡片）的最小实机验收。
 *
 * 重点是「原内容卡片尽可能简洁」：超长小红书内容（多段正文、话题、长链接）
 * 也不能把卡片撑高，标题与简介限行，查看入口永远可达；完整原文只在本地
 * modal 里读，Core 里的原文一个字都不少。
 *
 * 隔离临时库、离线种子，不触网、不读真实 Key、不碰日常数据。
 */
async function verify({window, core, root}) {
  const evaluate = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(error.message + '\nRenderer assertion: ' + code); }
  };
  const until = async (expression, timeout = 30000) => {
    const start = Date.now();
    while (true) {
      let value;
      try { value = await evaluate(expression); }
      catch (error) {
        if (Date.now() - start > timeout) throw error;
        await new Promise((resolve) => setTimeout(resolve, 120));
        continue;
      }
      if (value) return true;
      if (Date.now() - start > timeout) {
        const diag = await evaluate(`JSON.stringify({main: (document.querySelector('.main')||{}).innerText?.slice(0, 300)})`).catch(e => String(e));
        throw new Error('Timed out: ' + expression + '\n' + diag);
      }
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  };
  const pause = ms => new Promise((resolve) => setTimeout(resolve, ms));
  const shotDir = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT ||
    '/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/docs/verification/phase5-minimax/ui-followup-02';
  fs.mkdirSync(shotDir, {recursive: true});
  const shoot = async (name) => {
    await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    fs.writeFileSync(path.join(shotDir, name), (await window.webContents.capturePage()).toPNG());
  };

  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);
  await until(`!!SF.app.state.session && !!SF.app.state.client`);

  await evaluate(`SF.app.navigate('notes')`);
  await until(`document.querySelectorAll('.notes-toc__item').length >= 2`);
  // 先选中那条超长的小红书内容：紧凑性要拿它来量。
  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.notes-toc__item'));
    items.find(b => b.textContent.trim().indexOf('一条很长的小红书笔记') === 0).click();
  })()`);
  await until(`(document.querySelector('.notes-card__title')||{}).textContent && document.querySelector('.notes-card__title').textContent.indexOf('一条很长的小红书笔记') === 0`);

  /* ---------------- 卡片紧凑：超长内容也不能撑高 ---------------- */
  const card = await evaluate(`(() => {
    const el = document.querySelector('.notes-card');
    const rect = el.getBoundingClientRect();
    const title = el.querySelector('.notes-card__title');
    const summary = el.querySelector('.notes-card__summary');
    const view = Array.from(el.querySelectorAll('button')).find(b => b.textContent.trim() === '查看原内容');
    const viewRect = view ? view.getBoundingClientRect() : null;
    return {
      height: Math.round(rect.height),
      titleHeight: title ? Math.round(title.getBoundingClientRect().height) : 0,
      summaryHeight: summary ? Math.round(summary.getBoundingClientRect().height) : 0,
      titleText: title ? title.textContent : '',
      summaryText: summary ? summary.textContent : '',
      viewVisible: !!viewRect && viewRect.top >= rect.top - 1 && viewRect.bottom <= rect.bottom + 1,
      viewText: view ? view.textContent.trim() : '',
      hasImage: !!el.querySelector('img'),
    };
  })()`);
  assert.ok(card.height <= 200, '超长内容的卡片高度必须有界：' + card.height);
  assert.ok(card.titleHeight <= 60, '标题最多两行：' + card.titleHeight);
  assert.ok(card.summaryHeight <= 60, '简介最多两行：' + card.summaryHeight);
  assert.equal(card.viewVisible, true, '「查看原内容」必须始终可达');
  assert.equal(card.hasImage, false, '卡片里不铺大图');
  assert.ok(!/\n/.test(card.summaryText), '简介要压成单段纯文本');
  assert.ok(card.summaryText.length < 400, '简介片段有界：' + card.summaryText.length);

  /* ---------------- modal 能读到完整原文（含哨兵） ---------------- */
  await evaluate(`Array.from(document.querySelectorAll('.notes-card button')).find(b => b.textContent.trim() === '查看原内容').click()`);
  await until(`!!document.querySelector('.notes-modal')`);
  await until(`(document.querySelector('.notes-modal__text')||{}).textContent`);
  const modalText = await evaluate(`document.querySelector('.notes-modal__text').textContent`);
  assert.ok(modalText.includes('【哨兵-这是正文最后一句】'), 'modal 必须能读到原文末尾');
  const stored = await evaluate(`SF.app.state.client.getContent('xiaohongshu:feed:polish-1').then(c => c.summary.length)`);
  assert.ok(stored > 400, 'Core 里的原文长度不能因为卡片压缩而变短：' + stored);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.getAttribute('aria-label') === '关闭对话框').click()`);
  await until(`!document.querySelector('.notes-modal')`);

  /* ---------------- 短内容自然收缩 ---------------- */
  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.notes-toc__item'));
    const short = items.find(b => b.textContent.trim() === '一条很短的内容');
    short.click();
  })()`);
  await until(`(document.querySelector('.notes-card__title')||{}).textContent === '一条很短的内容'`);
  const shortCard = await evaluate(`(() => {
    const el = document.querySelector('.notes-card');
    return Math.round(el.getBoundingClientRect().height);
  })()`);
  assert.ok(shortCard <= 200, '短内容自然收缩，不留大块空白：' + shortCard);
  await shoot('notes-page-short.png');

  /* ---------------- 回到长内容，检查桌面与低窗 ---------------- */
  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.notes-toc__item'));
    items.find(b => b.textContent.trim().indexOf('一条很长的小红书笔记') === 0).click();
  })()`);
  await until(`(document.querySelector('.notes-card__title')||{}).textContent && document.querySelector('.notes-card__title').textContent.indexOf('一条很长的小红书笔记') === 0`);
  await shoot('notes-page-polish.png');

  const scrollCheck = async (label) => {
    const info = await evaluate(`(() => {
      const reader = document.querySelector('.notes-reader');
      const before = reader.scrollTop;
      reader.scrollTop = before + 400;
      const after = reader.scrollTop;
      const save = Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记');
      const rect = save ? save.getBoundingClientRect() : null;
      const view = reader.getBoundingClientRect();
      return {scrollHeight: reader.scrollHeight, clientHeight: reader.clientHeight, canScroll: after > before,
              saveVisible: !!rect && rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1};
    })()`);
    assert.ok(info.scrollHeight > info.clientHeight, label + '：阅读区应当能滚');
    assert.equal(info.canScroll, true, label + '：scrollTop 必须能推进');
    assert.equal(info.saveVisible, true, label + '：底部保存按钮要能进入可视区');
    return info;
  };
  const tall = await scrollCheck('常用窗口');
  window.setSize(1100, 620);
  await pause(400);
  await until(`document.querySelector('.notes-reader')`);
  const low = await scrollCheck('较低窗口');
  await shoot('notes-page-low.png');
  window.setSize(1440, 1000);
  await pause(300);

  /* ---------------- 目录只显示标题；筛选可用；AI 颜色保留 ---------------- */
  const tocShape = await evaluate(`(() => ({
    items: document.querySelectorAll('.notes-toc__item').length,
    hasSummary: document.querySelectorAll('.notes-toc__summary, .notes-toc__item .content-card__summary').length,
    hasTag: document.querySelectorAll('.notes-toc__item .tag-chip, .notes-toc__item .tag').length,
    filterButton: Array.from(document.querySelectorAll('.notes-toc button')).some(b => b.textContent.trim() === '筛选'),
    sort: !!document.querySelector('.notes-toc__head select'),
  }))()`);
  assert.ok(tocShape.items >= 2, '目录要有条目');
  assert.equal(tocShape.hasSummary, 0, '目录里不出现简介');
  assert.equal(tocShape.hasTag, 0, '目录里不出现标签徽标');
  assert.equal(tocShape.filterButton, true, '要有「筛选」入口');
  assert.equal(tocShape.sort, true, '排序要放在目录头部');

  const aiColor = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === 'AI 总结');
    if (!button) return null;
    const style = getComputedStyle(button);
    return {background: style.backgroundColor, color: style.color};
  })()`);
  assert.ok(aiColor, 'AI 总结按钮要在');
  assert.notEqual(aiColor.background, 'rgba(0, 0, 0, 0)', '前批的着色不能丢');

  /* 筛选面板：展开后来源／结论都在，不是画死的按钮。 */
  await evaluate(`Array.from(document.querySelectorAll('.notes-toc button')).find(b => b.textContent.trim() === '筛选').click()`);
  await until(`!!document.querySelector('.notes-toc__panel')`);
  const panel = await evaluate(`({
    source: !!document.querySelector('.notes-toc__panel select[aria-label="按来源筛选"]'),
    verdict: !!document.querySelector('.notes-toc__panel select[aria-label="按项目结论筛选"]'),
  })`);
  assert.equal(panel.source, true, '来源筛选要留着');
  assert.equal(panel.verdict, true, '结论筛选要留着');

  /* 结论控件改成分段按钮：三个都在，选中项可再点取消（切到项目笔记那条）。 */
  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.notes-toc__item'));
    items.find(b => b.textContent.trim() === '一条很短的内容').click();
  })()`);
  await until(`!!document.querySelector('.note-editor__verdict')`);
  const verdict = await evaluate(`(() => {
    const group = document.querySelector('.note-editor__verdict');
    if (!group) return null;
    return Array.from(group.querySelectorAll('button')).map(b => b.textContent.trim());
  })()`);
  assert.ok(verdict && verdict.length === 3, '结论是三个分段按钮：' + JSON.stringify(verdict));

  /* ---------------- BUG-116：结论按钮的选择／切换／取消 ---------------- */
  // 从「还没决定」开始：选放弃 → 切到观望 → 再点观望取消 → 保存应为 null；
  // 期间的总结与心得输入必须保留，视觉与 aria 要即时同步。
  await evaluate(`(() => {
    const area = document.querySelector('[data-note-editor] textarea');
    area.value = '结论按钮测试期间的总结。';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  const clickVerdict = async (label) => {
    await evaluate(`Array.from(document.querySelectorAll('.note-editor__verdict-btn')).find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
    await pause(60);
    return evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('.note-editor__verdict-btn'));
      return {
        pressed: buttons.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent.trim()),
        active: buttons.filter(b => b.classList.contains('is-active')).map(b => b.textContent.trim()),
      };
    })()`);
  };
  const afterDropped = await clickVerdict('放弃');
  assert.deepEqual(afterDropped.pressed, ['放弃'], '选中后 aria-pressed 要立刻跟着变');
  assert.deepEqual(afterDropped.active, ['放弃'], '选中后高亮要立刻跟着变');
  const afterWatching = await clickVerdict('观望');
  assert.deepEqual(afterWatching.pressed, ['观望'], '切换到另一项后 aria-pressed 要更新');
  const afterCancel = await clickVerdict('观望');
  assert.deepEqual(afterCancel.pressed, [], '再点一次选中的项＝取消结论');
  assert.deepEqual(afterCancel.active, [], '取消后高亮也要清掉');
  const textKept = await evaluate(`document.querySelector('[data-note-editor] textarea').value`);
  assert.equal(textKept, '结论按钮测试期间的总结。', '结论按钮不能动总结里的字');
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记').click()`);
  await until(`SF.app.state.client.getNote('zhihu:feed:polish-2').then(n => n && n.verdict === null)`);
  const savedVerdict = await evaluate(`SF.app.state.client.getNote('zhihu:feed:polish-2').then(n => n.verdict)`);
  assert.equal(savedVerdict, null, '保存的结论要与最后一次选择一致');
  const savedSummary = await evaluate(`SF.app.state.client.getNote('zhihu:feed:polish-2').then(n => n.summary)`);
  assert.equal(savedSummary, '结论按钮测试期间的总结。', '保存的总结不能丢');
  // 切走再切回来：结论仍是「取消」，不是回到旧的在用。
  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.notes-toc__item'));
    items.find(b => b.textContent.trim().indexOf('一条很长的小红书笔记') === 0).click();
  })()`);
  await until(`(document.querySelector('.notes-card__title')||{}).textContent && document.querySelector('.notes-card__title').textContent.indexOf('一条很长的小红书笔记') === 0`);
  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.notes-toc__item'));
    items.find(b => b.textContent.trim() === '一条很短的内容').click();
  })()`);
  await until(`!!document.querySelector('.note-editor__verdict')`);
  const afterReload = await evaluate(`Array.from(document.querySelectorAll('.note-editor__verdict-btn')).filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent.trim())`);
  assert.deepEqual(afterReload, [], '重开后结论仍应是取消状态');

  /* ---------------- 草稿保护与保存不回归 ---------------- */
  // 回到长内容那条再试保存。
  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.notes-toc__item'));
    items.find(b => b.textContent.trim().indexOf('一条很长的小红书笔记') === 0).click();
  })()`);
  await until(`(document.querySelector('.notes-card__title')||{}).textContent && document.querySelector('.notes-card__title').textContent.indexOf('一条很长的小红书笔记') === 0`);
  await until(`!!document.querySelector('[data-note-editor] textarea')`);
  await evaluate(`(() => {
    const area = document.querySelector('[data-note-editor] textarea');
    area.value = '美化之后也要保住这句话。';
    area.dispatchEvent(new Event('input', {bubbles: true}));
  })()`);
  await evaluate(`SF.app.refreshData ? SF.app.refreshData(true) : null`);
  await pause(400);
  const kept = await evaluate(`(document.querySelector('[data-note-editor] textarea')||{}).value`);
  assert.equal(kept, '美化之后也要保住这句话。', '后台刷新不能丢草稿');
  await evaluate(`Array.from(document.querySelectorAll('[data-note-editor] button')).find(b => b.textContent.trim() === '保存笔记').click()`);
  await until(`SF.app.state.client.getNote('xiaohongshu:feed:polish-1').then(n => n && n.summary === '美化之后也要保住这句话。')`);

  console.log('[polish] 笔记页美化与紧凑卡片验收通过', JSON.stringify({card, shortCard, tall, low}));
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-polish-'));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8'));
  const seed = spawnSync(runtime.python, [path.join(root, 'scripts/seed-ui-followup-02.py'), folder], {encoding: 'utf8'});
  if (seed.status !== 0) {
    console.error(seed.stderr || seed.stdout);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = 1;
    return;
  }
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'polish', SUBSCRIBE_FLOW_DATA_DIR: folder},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', code => {
    clearTimeout(timer);
    fs.rmSync(folder, {recursive: true, force: true});
    process.exitCode = code ?? 1;
  });
}
