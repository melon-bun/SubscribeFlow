const assert = require('node:assert/strict');

/**
 * M9 标签系统专项验收。
 *
 * 覆盖计划的验收条件：真实持久化的创建／改名／删除／打标／移除／筛选、
 * 改名不丢关联、重复操作不产生重复关系、删除影响被如实回报、与优先级和
 * 处理状态互相独立、重新采集不覆盖人工标签，以及深色主题下的可读性。
 *
 * DOM 选择器以 views/tags.js 与 views/inbox.js 的实际结构为准：
 * 列表行是 [data-view="tags"] tbody tr，行内编辑器带 [data-tag-editor="<id>"]，
 * 新建标签走对话框而非行内编辑器。
 */
async function verifyTags({evaluate, until, click, screenshot, core, window, firstId}) {
  const {selectContent} = require('./renderer-actions.cjs').rendererActions({evaluate, until});
  const tagByName = async name => (await core.call('tag.list', {})).items.filter(t => t.name === name)[0];
  /** 等到某个按钮可点再点：视图可能在异步数据到达后重画，测试不能假设 DOM 静止。 */
  const clickWhenReady = async (label, scope) => {
    // 对话框挂在 body 上而不是视图内部，所以默认全文档搜索。
    await until(`(() => {
      const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : "document.querySelector('.dialog:last-child') || document"};
      if (!root) return false;
      const button = Array.from(root.querySelectorAll('button'))
        .find(b => (b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)}) && !b.disabled);
      if (!button) return false;
      button.click();
      return true;
    })()`);
  };
  /** 赋值并确认真的生效：对话框会在数据到达时重建自身，写完不复核会点到旧元素上。 */
  const setValue = async (selector, value) => {
    const selectorLiteral = JSON.stringify(selector);
    await until(`(() => {
        const el = document.querySelector(${selectorLiteral});
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
        return document.querySelector(${selectorLiteral})?.value === ${JSON.stringify(value)};
      })()`);
  };

  /* ---------------- 空态与新建 ---------------- */

  await evaluate(`document.querySelector('[data-nav="tags"]').click()`);
  await until(`!!document.querySelector('[data-view="tags"]')`);
  assert.equal(await evaluate(`SF.app.state.tagTab`), 'list');
  await until(`/还没有任何标签/.test(document.querySelector('[data-view="tags"]').textContent)`);
  await screenshot('m9-tags-empty.png');

  await clickWhenReady('新建标签');
  await until(`!!document.querySelector('.dialog [aria-label="标签名称"]')`);
  await setValue('.dialog [aria-label="标签名称"]', '   ');
  await click('创建标签');
  await until(`!!document.querySelector('.dialog .field__error')`);
  assert.ok(await evaluate(`/请填写标签名称/.test(document.querySelector('.dialog .field__error').textContent)`),
    '空白名称应给出字段级错误');

  await setValue('.dialog [aria-label="标签名称"]', '旅行');
  await evaluate(`document.querySelector('.dialog [data-color="cyan"]').click()`);
  await click('创建标签');
  await until(`!document.querySelector('.dialog')`);
  await until(`document.querySelectorAll('[data-view="tags"] tbody tr').length === 1`);
  const travel = await tagByName('旅行');
  assert.ok(travel, '标签未写入真实存储');
  assert.equal(travel.color, 'cyan', '用户选择的颜色应被保存');
  assert.equal(travel.contentCount, 0);
  await screenshot('m9-tags-list.png');

  /* ---------------- 同名冲突 ---------------- */

  await clickWhenReady('新建标签');
  await until(`!!document.querySelector('.dialog [aria-label="标签名称"]')`);
  await setValue('.dialog [aria-label="标签名称"]', '旅行');
  await click('创建标签');
  await until(`/同名/.test(document.querySelector('.dialog')?.textContent || '')`);
  assert.equal((await core.call('tag.list', {})).items.length, 1, '重名不应产生第二个标签');
  await clickWhenReady('取消');
  await until(`!document.querySelector('.dialog')`);

  /* ---------------- 再建两个，让使用量条与颜色轮转有东西可看 ---------------- */

  for (const [name, color] of [['美食', 'amber'], ['摄影', 'green']]) {
    await clickWhenReady('新建标签');
    await until(`!!document.querySelector('.dialog [aria-label="标签名称"]')`);
    await setValue('.dialog [aria-label="标签名称"]', name);
    await evaluate(`document.querySelector('.dialog [data-color=${JSON.stringify(color)}]').click()`);
    await click('创建标签');
    await until(`document.querySelectorAll('[data-view="tags"] tbody tr').length === ${color === 'amber' ? 2 : 3}`);
  }
  const food = await tagByName('美食');
  assert.equal(food.color, 'amber');

  /* ---------------- 改名不换稳定 ID ---------------- */

  await evaluate(`Array.from(document.querySelectorAll('[data-view="tags"] tbody tr'))
    .find(r => r.textContent.includes('旅行')).click()`);
  await until(`!!document.querySelector('[data-tag-editor="' + ${JSON.stringify(travel.id)} + '"]')`);
  await setValue(`[data-tag-editor] [aria-label="标签名称"]`, '出行');
  await clickWhenReady('保存修改');
  await evaluate(`SF.app.act(${JSON.stringify('tag:' + travel.id)}, () => {})`);
  await until(`Array.from(document.querySelectorAll('[data-view="tags"] tbody tr')).some(r => r.textContent.includes('出行'))`);
  const renamed = await tagByName('出行');
  assert.equal(renamed.id, travel.id, '改名后稳定 ID 必须不变');
  assert.equal(await core.call('tag.get', {tag_id: travel.id}).then(t => t.name), '出行');
  await setValue('[data-tag-editor] [aria-label="标签描述"]', '用于出行规划');
  await clickWhenReady('保存修改');
  await evaluate(`SF.app.act(${JSON.stringify('tag:' + travel.id)}, () => {})`);
  await until(`document.querySelector('[data-tag-editor] [aria-label="标签描述"]')?.value === '用于出行规划'`);
  assert.equal((await core.call('tag.get', {tag_id: travel.id})).description, '用于出行规划');
  await setValue('[data-tag-editor] [aria-label="标签描述"]', '');
  await clickWhenReady('保存修改');
  await evaluate(`SF.app.act(${JSON.stringify('tag:' + travel.id)}, () => {})`);
  await until(`document.querySelector('[data-tag-editor] [aria-label="标签描述"]')?.value === ''`);
  assert.equal((await core.call('tag.get', {tag_id: travel.id})).description, '');

  /* ---------------- 从收件箱给内容打标 ---------------- */

  // 前面两个专项处理过 firstId，收件箱里未必还在；切到「全部更新」下取当前第一张卡。
  await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
  await until(`!!document.querySelector('[data-view="inbox"]')`);
  await evaluate(`document.querySelector('[data-quick="all"]').click()`);
  await until(`document.querySelectorAll('.content-card').length > 0`);
  const itemId = await until(`document.querySelector('.content-card')?.dataset.contentId`);
  const addTrigger = `.detail [data-tag-add]`;
  const openPicker = async () => {
    await until(`(() => { const b = document.querySelector(${JSON.stringify(addTrigger)});
      if (!b || b.disabled || document.querySelector('.tag-pool')) return false;
      b.click(); return true; })()`);
    await until(`!!document.querySelector('.tag-pool')`);
  };
  // 标签池在对话框里，点选只是挂载到托盘，真正写入要等「确认挂载」。
  const pickTag = async (id) => {
    const sel = `.tag-pool [data-tag-option="${id}"]`;
    await until(`(() => { const b = document.querySelector(${JSON.stringify(sel)});
      if (!b || b.disabled) return false; b.click(); return true; })()`);
  };
  const confirmPicker = async () => {
    await clickWhenReady('确认挂载', '.dialog');
    await until(`!document.querySelector('.tag-pool')`);
    // 外部色块会先乐观更新；等保存动作完成后再测试下一次编辑。
    await evaluate(`SF.app.act(${JSON.stringify('tags:' + itemId)}, () => {}).then(() => SF.app.refreshData(true))`);
  };
  await selectContent(itemId);
  await until(`!!document.querySelector('.detail')`);
  await openPicker();
  await pickTag(travel.id);
  await until(`!!document.querySelector('.tag-pool__mounted')`);
  await confirmPicker();
  await until(`document.querySelector('.detail')?.textContent.includes('出行')`);
  assert.deepEqual((await core.call('content.get', {item_id: itemId})).tags.map(t => [t.name, t.origin]),
    [['出行', 'manual']], '人工写入的关联来源必须是 manual');

  await openPicker();
  await pickTag(food.id);
  await until(`document.querySelectorAll('.tag-pool__mounted').length === 2`);
  await confirmPicker();
  await until(`document.querySelectorAll('.detail .tag-chip').length === 2`);

  // 相同数量的替换也必须持久化：出行+美食 → 出行+摄影。
  const photo = await tagByName('摄影');
  await openPicker();
  await pickTag(food.id);
  await pickTag(photo.id);
  await confirmPicker();
  await until(`Array.from(document.querySelectorAll('.detail .tag-chip__text')).some(el => el.textContent === '摄影')`);
  assert.deepEqual(new Set((await core.call('content.get', {item_id: itemId})).tags.map(t => t.id)), new Set([travel.id, photo.id]));
  await openPicker();
  await pickTag(photo.id);
  await pickTag(food.id);
  await confirmPicker();
  await until(`Array.from(document.querySelectorAll('.detail .tag-chip__text')).some(el => el.textContent === '美食')`);

  // 已挂载的停用标签留在托盘，不能作为新候选选用。
  await evaluate(`SF.app.state.client.setTagEnabled(${JSON.stringify(food.id)}, false).then(() => SF.app.refreshData(true))`);
  await openPicker();
  await until(`!!document.querySelector(${JSON.stringify('.tag-pool [aria-label="取消挂载 美食"]')})`);
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify('.tag-pool [data-tag-option="' + food.id + '"]')})`), false);
  await clickWhenReady('取消', '.dialog');
  assert.equal((await core.call('content.get', {item_id: itemId})).tags.length, 2);
  await evaluate(`SF.app.state.client.setTagEnabled(${JSON.stringify(food.id)}, true).then(() => SF.app.refreshData(true))`);
  await openPicker();
  await setValue('.tag-pool [aria-label="筛选或新建标签"]', '对话框新建');
  await evaluate(`document.querySelector('.tag-pool input').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))`);
  await until(`Array.from(document.querySelectorAll('.tag-pool__mounted-name')).some(el => el.textContent === '对话框新建')`);
  assert.equal((await core.call('content.get', {item_id:itemId})).tags.length, 2, '确认前不得写入内容关联');
  await confirmPicker();
  await until(`Array.from(document.querySelectorAll('.detail .tag-chip__text')).some(el => el.textContent === '对话框新建')`);
  const quickCreated = await tagByName('对话框新建');
  assert.ok((await core.call('content.get', {item_id:itemId})).tags.some(t => t.id === quickCreated.id));
  await clickWhenReady('移除标签 对话框新建', '.detail');
  await evaluate(`SF.app.act(${JSON.stringify('tags:' + itemId)}, () => {}).then(() => SF.app.refreshData(true))`);
  await evaluate(`SF.app.state.client.removeTag(${JSON.stringify(quickCreated.id)}).then(() => SF.app.refreshData(true))`);
  await evaluate(`document.querySelector('.detail [aria-label="关闭对话框"]')?.click()`);
  await until(`document.querySelectorAll('[data-content-id=${JSON.stringify(itemId)}] .tag-chip').length === 2`);

  // 重复写入同一组标签是幂等的，不产生重复关系
  await evaluate(`document.querySelector('[data-content-id=${JSON.stringify(itemId)}]').click()`);
  await evaluate(`SF.app.state.client.setContentTags(${JSON.stringify(itemId)}, ${JSON.stringify([travel.id, food.id])})`);
  await evaluate(`document.querySelector('.detail [aria-label="关闭对话框"]')?.click()`);
  await until(`!!document.querySelector('[data-view="inbox"]')`);
  assert.equal((await core.call('content.get', {item_id: itemId})).tags.length, 2, '重复打标不应产生重复关系');

  /* ---------------- 筛选：任一符合 / 全部符合 / 与优先级组合 ---------------- */

  const otherIds = (await core.call('content.list', {})).items.filter(item => item.id !== itemId).slice(0, 2).map(item => item.id);
  assert.equal(otherIds.length, 2);
  await evaluate(`SF.app.state.client.setContentTags(${JSON.stringify(otherIds[0])}, ${JSON.stringify([travel.id])})`);
  await evaluate(`SF.app.state.client.setContentTags(${JSON.stringify(otherIds[1])}, ${JSON.stringify([food.id])}).then(() => SF.app.refreshData(true))`);

  await clickWhenReady('标签', '[data-view="inbox"]');
  await until(`!!document.querySelector('.tag-filter')`);
  await evaluate(`Array.from(document.querySelectorAll('.tag-filter [data-tag-filter]'))
    .find(x => x.textContent.includes('出行')).click()`);
  await until(`document.querySelectorAll('.content-card').length === 2`);
  assert.equal((await core.call('content.list', {tags: [travel.id]})).total, 2);
  await evaluate(`Array.from(document.querySelectorAll('.tag-filter [data-tag-filter]'))
    .find(x => x.textContent.includes('美食')).click()`);
  await until(`document.querySelectorAll('.content-card').length === 3`);
  await clickWhenReady('全部符合', '.tag-filter');
  await until(`SF.app.state.filters.tagMode === 'all' && document.querySelectorAll('.content-card').length === 1`);
  assert.equal((await core.call('content.list', {tags: [travel.id, food.id], tag_mode: 'all'})).total, 1);
  await clickWhenReady('任一符合', '.tag-filter');
  await until(`SF.app.state.filters.tagMode === 'any' && document.querySelectorAll('.content-card').length === 3`);
  await clickWhenReady('全部符合', '.tag-filter');
  await until(`document.querySelectorAll('.content-card').length === 1`);
  // 还原额外的样本归类，让后续使用量与删除影响断言保持可读。
  await evaluate(`SF.app.state.client.bulkSetTags(${JSON.stringify(otherIds)}, []).then(() => SF.app.refreshData(true))`);

  await setValue('[aria-label="筛选优先级"]', 'high');
  await until(`document.querySelectorAll('.content-card').length === 0`);
  assert.equal((await core.call('content.list', {tags: [travel.id], priority: 'high'})).total, 0,
    '标签与优先级应能组合筛选');
  await setValue('[aria-label="筛选优先级"]', '');
  await until(`document.querySelectorAll('.content-card').length === 1`);
  await screenshot('m9-tags-inbox-filter.png');

  /* ---------------- 重新采集不覆盖人工标签 ---------------- */

  const before = (await core.call('content.get', {item_id: itemId})).tags.length;
  await evaluate(`SF.app.refreshData(true)`);
  await until(`document.querySelectorAll('[data-content-id=${JSON.stringify(itemId)}] .tag-chip').length === ${before}`);

  /* ---------------- 使用次数反映真实归类 ---------------- */

  await evaluate(`document.querySelector('[data-nav="tags"]').click()`);
  await until(`!!document.querySelector('[data-view="tags"]')`);
  await until(`/出行/.test(document.querySelector('[data-view="tags"]').textContent)`);
  assert.equal((await tagByName('出行')).contentCount, 1);
  assert.equal((await tagByName('美食')).contentCount, 1);
  assert.equal((await tagByName('摄影')).contentCount, 0);

  /* ---------------- AI 页签是设计化空态 ---------------- */

  await evaluate(`Array.from(document.querySelectorAll('.tags-tab')).find(t => /AI/.test(t.textContent)).click()`);
  await until(`SF.app.state.tagTab === 'ai'`);
  assert.ok(await evaluate(`!!document.querySelector('[data-view="tags"]').textContent.trim()`), 'AI 页签不应是空白页');
  // M9：未接入识别时本页不得出现可用的模型配置控件——放一个填了也没人用的表单，
  // 比诚实地说明「还没有这个功能」更糟。M15 起配置改到设置页，这里只保留入口。
  assert.ok(await evaluate(`!document.querySelector('[data-view="tags"] input, [data-view="tags"] select, [data-view="tags"] textarea')`),
    '未接入识别时不应出现模型配置控件');
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('[data-view="tags"] button')).some(b => /去设置/.test(b.textContent))`),
    '应提供通往设置页的配置入口');
  assert.ok(await evaluate(`!/模型选择|Base URL/.test(document.querySelector('[data-view="tags"]').textContent)`),
    '未接入识别时不应出现内联模型配置项');
  await screenshot('m9-tags-ai.png');
  await evaluate(`Array.from(document.querySelectorAll('.tags-tab')).find(t => /列表/.test(t.textContent)).click()`);
  await until(`SF.app.state.tagTab === 'list'`);

  /* ---------------- 删除如实回报影响条数 ---------------- */

  await evaluate(`Array.from(document.querySelectorAll('[data-view="tags"] tbody tr'))
    .find(r => r.textContent.includes('美食')).click()`);
  await until(`!!document.querySelector('[data-tag-editor="' + ${JSON.stringify(food.id)} + '"]')`);
  await clickWhenReady('删除标签');
  await until(`!!document.querySelector('.dialog') && /1 条内容/.test(document.querySelector('.dialog').textContent)`,
    '删除确认必须告知会摘掉多少条内容');
  await screenshot('m9-tags-delete-confirm.png');
  await clickWhenReady('删除标签');
  await until(`document.querySelectorAll('[data-view="tags"] tbody tr').length === 2`);
  assert.equal((await core.call('tag.list', {})).items.length, 2);
  assert.equal((await core.call('content.get', {item_id: itemId})).tags.length, 1,
    '删除标签后内容不应残留悬空关联');
  assert.equal((await core.call('content.get', {item_id: itemId})).tags[0].name, '出行');

  // 删除当前筛选中的美食后仍能看到并清除旧条件，不能留下隐藏筛选。
  await evaluate(`SF.app.navigate('inbox'); SF.app.renderContent()`);
  await until(`!!document.querySelector('.tag-filter')`);
  await until(`Array.from(document.querySelectorAll('.tag-filter button')).some(b => b.textContent.trim() === '清除标签筛选' && !b.disabled)`);
  await until(`document.querySelector('.tag-filter')?.textContent.includes('已删除标签')`);
  await clickWhenReady('清除标签筛选', '.tag-filter');
  await until(`SF.app.state.filters.tags.length === 0 && document.querySelectorAll('.content-card').length === 20`);
  await evaluate(`document.querySelector('[data-nav="tags"]').click()`);
  await until(`document.querySelectorAll('[data-view="tags"] tbody tr').length === 2`);

  /* ---------------- 深色主题可读性 ---------------- */

  await evaluate(`document.documentElement.setAttribute('data-theme','dark')`);
  await until(`!!document.querySelector('[data-view="tags"]')`);
  await screenshot('m9-tags-dark.png');
  assert.ok(await evaluate(`(() => {
    const lum = c => { const p = c.match(/[0-9.]+/g).slice(0,3).map(Number)
      .map(v => { v/=255; return v<=0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
      return 0.2126*p[0] + 0.7152*p[1] + 0.0722*p[2]; };
    const ratio = (a,b) => { const s=[lum(a),lum(b)].sort((x,y)=>y-x); return (s[0]+0.05)/(s[1]+0.05); };
    const chips = Array.from(document.querySelectorAll('[data-view="tags"] .tag-chip'));
    return chips.length > 0 && chips.every(el => {
      const s = getComputedStyle(el);
      return ratio(s.color, s.backgroundColor) >= 4.5;
    });
  })()`), '深色模式下标签文字对比度不足 4.5:1');

  await evaluate(`document.documentElement.setAttribute('data-theme','light')`);
  window.setSize(900, 760);
  await until(`!!document.querySelector('[data-view="tags"]')`);
  await screenshot('m9-tags-compact.png');
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`));
  window.setSize(1440, 1000);

  console.log(JSON.stringify({
    tagsSmoke: 'passed',
    createRenameDelete: true,
    duplicateNameRejected: true,
    renameKeepsStableId: true,
    taggingIdempotent: true,
    filterAnyAndAll: true,
    combinedWithPriority: true,
    deleteReportsImpact: true,
    aiEmptyState: true,
    darkContrast: true
  }));
}

module.exports = { verifyTags };
