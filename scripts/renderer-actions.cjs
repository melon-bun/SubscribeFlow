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
    if (!id) id = await until('document.querySelector(".detail .state-btn") && SF.app.state.selectedId');
    assert.ok(id, '整理操作必须有选中的内容');
    await until(`(() => {
      if (SF.app.state.selectedId !== ${JSON.stringify(id)} || SF.app.isPending(${JSON.stringify('content:' + id)})) return false;
      const button = Array.from(document.querySelectorAll('.detail .state-btn')).find(b => b.textContent.trim() === ${JSON.stringify(label)});
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`);
    // “已选中”先于操作完成回显，不能把它当成下一次写入的就绪条件。
    await evaluate(`SF.app.act(${JSON.stringify('content:' + id)}, () => {}).then(() => undefined)`);
  };
  /**
   * 设置收件箱的筛选条件。
   *
   * 5.1 期（M33）起，收件箱的下拉改成了方案里的无框按钮 + 浮层菜单
   * （原生 <select> 的宽度由最长选项决定，优先级名可长到 12 个字，
   * 一条筛选条会被撑散）。这里同时支持两种形态：
   * 原生 select 直接赋值；无框按钮则点开菜单再按值点选项。
   */
  const setFilter = async (ariaLabel, value) => {
    const label = JSON.stringify(ariaLabel);
    const wanted = JSON.stringify(String(value));
    await until(`(() => {
      const el = document.querySelector('[aria-label=' + ${label} + ']');
      if (!el) return false;
      if (el.tagName === 'SELECT') {
        el.value = ${wanted};
        el.dispatchEvent(new Event('change', {bubbles: true}));
        return true;
      }
      el.click();
      return true;
    })()`);
    // 原生 select 已经生效，不用等菜单。
    const isNative = await evaluate(`(() => {
      const el = document.querySelector('[aria-label=' + ${label} + ']');
      return !!el && el.tagName === 'SELECT';
    })()`);
    if (isNative) return;
    await until(`(() => {
      const item = Array.from(document.querySelectorAll('.menu__item'))
        .find(b => b.getAttribute('data-value') === ${wanted});
      if (!item) return false;
      item.click();
      return true;
    })()`);
  };
  return {clickSelector, selectContent, checkContent, contentAction, setFilter};
}

module.exports = {rendererActions};
