const assert = require('node:assert/strict');

function rendererActions({evaluate, until}) {
  // 查询、可用性判断和点击必须在同一个 Renderer 任务中，避免中间的重绘换掉节点。
  const clickSelector = selector => until(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button || button.matches(':disabled')) return false;
    button.click(); return true;
  })()`);
  const selectContent = id => {
    assert.ok(id, '必须选择确定的内容 ID');
    return clickSelector('.content-card[data-content-id=' + JSON.stringify(id) + ']');
  };
  const checkContent = id => until(`(() => {
    const card = document.querySelector(${JSON.stringify('.content-card[data-content-id=' + JSON.stringify(id) + ']')});
    const checkbox = card?.closest('.content-selection')?.querySelector('[role="checkbox"]');
    if (!checkbox) return false;
    if (checkbox.getAttribute('aria-checked') !== 'true') checkbox.click();
    return true;
  })()`);
  const contentAction = async (label, id) => {
    if (!id) id = await until('document.querySelector(".detail .op-btn") && SF.app.state.selectedId');
    assert.ok(id, '整理操作必须有选中的内容');
    await until(`(() => {
      if (SF.app.state.selectedId !== ${JSON.stringify(id)} || SF.app.isPending(${JSON.stringify('content:' + id)})) return false;
      const button = Array.from(document.querySelectorAll('.detail .op-btn')).find(b => b.textContent.trim() === ${JSON.stringify(label)});
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`);
    // “已选中”先于操作完成回显，不能把它当成下一次写入的就绪条件。
    await evaluate(`SF.app.act(${JSON.stringify('content:' + id)}, () => {}).then(() => undefined)`);
  };
  return {clickSelector, selectContent, checkContent, contentAction};
}

module.exports = {rendererActions};
