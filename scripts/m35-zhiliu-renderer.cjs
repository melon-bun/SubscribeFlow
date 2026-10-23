const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

/**
 * M35「静流」完全复刻实机验收。
 *
 * 走正式 Renderer + 正式 Core（Electron 真进程），只导航与断言，不写业务数据、不触网。
 *
 * 验收内容：
 *   1. BUG-119：收件箱选中卡片的外发光环与取景框角标不再被网格裁掉；
 *   2. 卡片结构：96px 缩略图列、脚注行（标签 / 收录方式 / URL）、右上角复选框；
 *   3. 详情面板：顶图 + 取景框 + 读数、四段优先级控件（高 / 中 / 低 不再溢出）、原文链接行；
 *   4. 页头 / 筛选条 / 分页器：动作层级、seg + 竖线 + 无框下拉、分页器分隔线；
 *   5. 外壳：侧栏导航度量与分组标签、顶栏同步状态胶囊；
 *   6. 其它页面：总览 / 渠道 / 标签 / 笔记的页头与分段控件形态。
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
        const diag = await evaluate(`JSON.stringify({
          route: SF.app.state.route && SF.app.state.route.name,
          body: document.body.innerText.slice(0, 300),
        })`).catch(e => String(e));
        throw new Error('Timed out: ' + expression + '\n' + diag);
      }
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  };
  const pause = ms => new Promise((resolve) => setTimeout(resolve, ms));

  const shotDir = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT ||
    '/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/docs/verification/phase51/m35';
  fs.mkdirSync(shotDir, {recursive: true});
  const shoot = async (name) => {
    await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    fs.writeFileSync(path.join(shotDir, name), (await window.webContents.capturePage()).toPNG());
    console.log('[m35] 截图 ' + name);
  };

  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);
  await until(`!!document.querySelector('.shell__body')`);
  await evaluate(`(() => {
    localStorage.removeItem('sf.fx');
    localStorage.setItem('sf.theme', 'light');
    document.documentElement.setAttribute('data-fx', 'on');
    document.documentElement.setAttribute('data-theme', 'light');
    SF.app.state.fx = true;
  })()`);
  await evaluate(`SF.app.render()`);
  await pause(500);

  /* ================= 1. 收件箱：选中卡片的边不能被裁 ================= */

  await evaluate(`SF.app.navigate('inbox')`);
  await until(`!!document.querySelector('[data-view="inbox"]')`);
  await until(`document.querySelectorAll('.content-card').length > 0`);
  await pause(700);
  await evaluate(`(() => {
    const first = document.querySelector('.content-card');
    if (first) first.click();
  })()`);
  await until(`!!document.querySelector('.detail')`);
  await pause(700);

  /* BUG-119 的判据：选中卡片的外环（四边 + 四角）必须完整落在网格的可见范围内。
     以前网格没有内边距，滚动容器的 overflow 把上边和左边裁掉了。 */
  const ring = await evaluate(`(() => {
    const card = document.querySelector('.content-card.is-selected');
    if (!card) return null;
    const grid = card.closest('.inbox__grid');
    const cb = card.getBoundingClientRect();
    const gb = grid.getBoundingClientRect();
    const cs = getComputedStyle(card);
    const gs = getComputedStyle(grid);
    // 角标相对内边距框外扩 8px；边框 1.5px 另算
    const overhang = 8 + 1.5;
    return {
      card: {x: cb.x, y: cb.y, w: cb.width, h: cb.height},
      grid: {x: gb.x, y: gb.y, w: gb.width, h: gb.height},
      gridPad: [gs.paddingTop, gs.paddingRight, gs.paddingBottom, gs.paddingLeft].join(' '),
      gridOverflow: gs.overflowX + ' / ' + gs.overflowY,
      boxShadow: cs.boxShadow,
      // 四条边与网格裁切线的距离：负数即被裁
      clear: {
        top: cb.y - gb.y,
        left: cb.x - gb.x,
        right: gb.right - cb.right,
        bottom: gb.bottom - cb.bottom,
      },
      overhang,
    };
  })()`);
  assert.ok(ring, '收件箱里应有选中卡片');
  // 角标 ::after 的 inset:-8px 是相对**内边距框**的，卡片有 1.5px 边框，
  // 所以角标越出边框 8 - 1.5 = 6.5px。网格留的余量必须不小于它。
  const need = 8 - 1.5;
  assert.ok(ring.clear.top >= need,
    '选中卡片上边必须留出角标余量，实际余量：' + ring.clear.top.toFixed(1) + 'px（需要 ' + need + 'px）');
  assert.ok(ring.clear.left >= need,
    '选中卡片左边必须留出角标余量，实际余量：' + ring.clear.left.toFixed(1) + 'px（需要 ' + need + 'px）');
  // 左右必须在网格内；上下不比较——网格是滚动容器，末行卡片本来就会超出可视高度。
  assert.ok(ring.clear.right >= 0,
    '选中卡片不能越出网格右边界，实际：' + JSON.stringify(ring.clear));
  await shoot('01-inbox.png');

  /* ================= 2. 卡片结构 ================= */

  const card = await evaluate(`(() => {
    const el = document.querySelector('.content-card');
    const thumb = el.querySelector('.content-card__thumb');
    const foot = el.querySelector('.content-card__foot');
    const cs = getComputedStyle(el);
    return {
      columns: cs.gridTemplateColumns,
      thumb: thumb ? Math.round(thumb.getBoundingClientRect().width) + 'x' + Math.round(thumb.getBoundingClientRect().height) : null,
      footKids: foot ? Array.from(foot.children).map(k => k.className) : [],
      linkOpacity: getComputedStyle(el.querySelector('.content-card__link')).opacity,
      hasPlat: !!el.querySelector('.plat'),
      hasSig: !!el.querySelector('.prio-sig'),
      prioText: el.querySelector('.prio') ? el.querySelector('.prio').innerText.trim() : null,
    };
  })()`);
  assert.ok(/^96px/.test(card.columns), '卡片左列应为 96px 缩略图，实际：' + card.columns);
  assert.equal(card.thumb, '96x72', '缩略图尺寸应为 96x72，实际：' + card.thumb);
  assert.ok(card.footKids.some(k => /content-card__tags/.test(k)), '脚注行里应有标签容器');
  assert.ok(card.footKids.some(k => /content-card__method/.test(k)), '脚注行里应有收录方式');
  assert.ok(card.footKids.some(k => /content-card__link/.test(k)), '脚注行里应有 URL 行');
  assert.ok(card.hasPlat && card.hasSig, '卡片元信息里应有平台方块与信号条');
  assert.ok(card.prioText && card.prioText.length <= 3,
    '卡片上的优先级只用等级字（高/中/低），不能是用户自定义长名，实际：' + card.prioText);

  /* ================= 3. 详情面板 ================= */

  const detail = await evaluate(`(() => {
    const d = document.querySelector('.detail');
    const seg = d.querySelector('.priority-grid');
    const opts = seg ? Array.from(seg.querySelectorAll('.priority-opt')).map(b => b.innerText.trim()) : [];
    const hero = d.querySelector('.detail__hero');
    const link = d.querySelector('.detail__link-row');
    const foot = d.querySelector('.action-bar');
    return {
      hasHero: !!hero,
      heroHeight: hero ? Math.round(hero.getBoundingClientRect().height) : null,
      hasReadout: !!d.querySelector('.detail__readout'),
      hasHud: !!d.querySelector('.detail__hud'),
      prioOptions: opts,
      prioWidth: seg ? Math.round(seg.getBoundingClientRect().width) : null,
      prioOverflow: seg ? seg.scrollWidth - seg.clientWidth : null,
      hasLinkRow: !!link,
      hasActionBar: !!foot,
      stateBtns: foot ? Array.from(foot.querySelectorAll('.state-btn')).map(b => b.innerText.trim()) : [],
      counter: d.querySelector('.detail__counter') ? d.querySelector('.detail__counter').innerText.trim() : null,
    };
  })()`);
  assert.ok(detail.hasHero, '详情面板应有顶图');
  assert.equal(detail.heroHeight, 176, '顶图高度应为 176px');
  assert.ok(detail.hasReadout, '顶图下应有等宽读数');
  assert.ok(detail.hasHud, '顶图上应有取景框角标');
  assert.equal(detail.prioOptions.length, 4, '优先级应为四段控件（跟随来源 + 高 + 中 + 低）');
  assert.ok(detail.prioOptions[0].indexOf('跟随来源') >= 0, '第一段应是「跟随来源」');
  assert.ok(detail.prioOverflow === null || detail.prioOverflow <= 0,
    '优先级分段控件不能溢出，实际溢出：' + detail.prioOverflow + 'px');
  assert.ok(detail.hasLinkRow, '详情里应有原文链接行');
  assert.ok(detail.hasActionBar, '详情底部应有操作条');
  assert.equal(detail.stateBtns.length, 3, '操作条应有三个状态键');
  assert.ok(detail.counter && /\d+ \/ \d+/.test(detail.counter), '详情头应有位置读数，实际：' + detail.counter);
  await shoot('02-detail.png');

  /* ================= 4. 页头 / 筛选条 / 分页器 ================= */

  const chrome = await evaluate(`(() => {
    const actions = Array.from(document.querySelectorAll('.view__actions .btn')).map(b => b.innerText.trim());
    const seg = document.querySelector('.inbox__toolbar .seg');
    const sep = document.querySelector('.filters__sep');
    const dropdowns = Array.from(document.querySelectorAll('.inbox__toolbar .select--btn')).map(b => b.innerText.trim());
    const pager = document.querySelector('.pager');
    const pg = pager ? getComputedStyle(pager) : null;
    return {
      actions,
      segItems: seg ? seg.querySelectorAll('button').length : 0,
      hasSep: !!sep,
      dropdowns,
      pagerBorder: pg ? pg.borderTopWidth + ' ' + pg.borderTopStyle : null,
      pagerText: pager ? pager.innerText.replace(/\\s+/g, ' ').trim() : null,
    };
  })()`);
  assert.ok(chrome.actions.length >= 2, '页头应有动作按钮');
  // 「静流」§主界面：页头动作顺序 = 排列方式（ghost）→ 重新查询 → 添加内容（橙色主操作）。
  assert.ok(/按日历时间排列/.test(chrome.actions[0]), '页头第一个动作应是「按日历时间排列」，实际：' + chrome.actions[0]);
  assert.ok(/重新查询/.test(chrome.actions[1]), '页头第二个动作应是「重新查询」，实际：' + chrome.actions[1]);
  assert.ok(/添加内容/.test(chrome.actions[2]), '页头第三个动作应是「添加内容」，实际：' + chrome.actions[2]);
  assert.ok(chrome.segItems >= 2, '筛选条里应有平台分段控件');
  assert.ok(chrome.hasSep, '分段控件与下拉之间应有分隔竖线');
  assert.ok(chrome.dropdowns.length >= 3, '筛选条里应有三个无框下拉，实际：' + chrome.dropdowns.length);
  assert.ok(chrome.pagerBorder && !/^0px/.test(chrome.pagerBorder), '分页器上沿应有分隔线');
  assert.ok(/第 1 页/.test(chrome.pagerText || ''), '分页器应显示页码');

  /* ================= 5. 外壳 ================= */

  const shell = await evaluate(`(() => {
    const nav = document.querySelector('.nav__item');
    const row = document.querySelector('.side-row');
    const title = document.querySelector('.side-group__title');
    const sync = document.querySelector('.topbar__sync');
    const dot = document.querySelector('.topbar__sync .fx-online');
    return {
      navHeight: nav ? Math.round(nav.getBoundingClientRect().height) : null,
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
      groupLetter: title ? getComputedStyle(title).letterSpacing : null,
      groupBorder: title && title.parentElement.parentElement
        ? getComputedStyle(title.parentElement.parentElement).borderTopWidth : null,
      syncRadius: sync ? getComputedStyle(sync).borderRadius : null,
      syncHasDot: !!dot,
    };
  })()`);
  assert.equal(shell.navHeight, 34, '侧栏导航项高度应为 34px，实际：' + shell.navHeight);
  assert.equal(shell.rowHeight, 34, '侧栏快捷筛选项高度应为 34px，实际：' + shell.rowHeight);
  assert.ok(shell.syncHasDot, '顶栏同步胶囊里应有状态点');
  assert.ok(/999|100%/.test(shell.syncRadius || ''), '顶栏同步状态应是胶囊形，实际：' + shell.syncRadius);
  await shoot('03-shell.png');

  /* ================= 5.5 布局级检查（样式对拍兜不住的那一类） =================
     样式对拍比的是「声明值」，抓不到「这条规则用错了地方」。
     下面四件事样式对拍全都看不出来，只能在真实布局里量：
       1. 页面不能有横向溢出；
       2. 没有详情面板时，主区必须占满纸面——不能预留一条空列；
       3. 顶部任务条与页面标题不能叠在一起；
       4. 页面标题与操作行要左对齐。
     这几条正是「整页视图被挤到左边、标题贴住任务条」两个回归的现场。 */

  const layoutOf = async () => evaluate(`(() => {
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect();
      return {l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width)}; };
    const ws = document.querySelector('.workspace');
    const main = document.querySelector('.workspace > .main');
    const detail = document.querySelector('.workspace > .detail');
    const task = document.querySelector('.task');
    const head = document.querySelector('.view__head');
    /* 标题行下面那块内容（筛选条 / 页面主体）——它才该和标题左边缘对齐。
       .view__actions 在标题行的**右边**（参考页 .page-actions { margin-left:auto }），
       拿它比左边缘是比错了。 */
    const row = document.querySelector('.inbox__toolbar') || document.querySelector('.view__body > *');
    return {
      innerWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      ws: box(ws), main: box(main), detail: box(detail),
      task: box(task), head: box(head), row: box(row),
    };
  })()`);

  const checkLayout = async (label) => {
    const L = await layoutOf();
    assert.ok(L.scrollWidth <= L.innerWidth,
      label + '：出现横向溢出（scrollWidth ' + L.scrollWidth + ' > innerWidth ' + L.innerWidth + '）');
    if (L.ws && L.main && !L.detail) {
      const gap = L.ws.r - L.main.r;
      assert.ok(gap <= 1,
        label + '：没有详情面板却给主区留了 ' + gap + 'px 空列（右边缘没贴住纸面）');
    }
    if (L.task && L.head) {
      assert.ok(L.head.t >= L.task.b,
        label + '：页面标题顶到顶部任务条了（标题顶 ' + L.head.t + ' < 任务条底 ' + L.task.b + '）');
    }
    if (L.head && L.row) {
      assert.ok(Math.abs(L.head.l - L.row.l) <= 1,
        label + '：页面标题与操作行左边缘没对齐（' + L.head.l + ' vs ' + L.row.l + '）');
    }
  };

  for (const width of [1440, 900]) {
    window.setSize(width, 1000);
    await pause(500);
    await checkLayout('收件箱 @' + width);
  }
  window.setSize(1440, 1000);
  await pause(400);

  /* ================= 6. 其它页面 ================= */

  const goto = async (route, params, ready) => {
    const args = params ? `, ${JSON.stringify(params)}` : '';
    await evaluate(`SF.app.navigate('${route}'${args})`);
    await until(`SF.app.state.route.name === '${route}'`);
    await until(`!!document.querySelector('[data-view="${route}"]')`);
    if (ready) await until(ready);
    await pause(1000);
    /* 每个页面都要过布局检查——样式对拍抓不到「规则用错地方」这一类。 */
    await checkLayout('页面 ' + route + (params ? '/' + Object.values(params)[0] : ''));
  };

  await goto('overview', null, `!!document.querySelector('.calendar-grid')`);
  await shoot('04-overview-calendar.png');
  await goto('overview', {mode: 'priority'}, `!!document.querySelector('[data-view="overview"][data-mode="priority"]')`);
  await shoot('05-overview-priority.png');
  await goto('channels', null, `!!document.querySelector('[data-view="channels"] .channels__table-wrap')`);
  await shoot('06-channels-list.png');
  await goto('channels', {tab: 'priorities'}, `!!document.querySelector('.source-priorities')`);
  await shoot('07-channels-priorities.png');
  await goto('tags', null, `!!document.querySelector('[data-view="tags"] .tags-list')`);
  await shoot('08-tags-list.png');
  await goto('tags', {tab: 'ai'}, `!!document.querySelector('[data-view="tags"]')`);
  await pause(800);
  await shoot('09-tags-ai.png');
  await goto('notes', null, `!!document.querySelector('[data-view="notes"]')`);
  await shoot('10-notes.png');

  /* ================= 7. 深色主题下同样成立 ================= */

  await evaluate(`(() => {
    localStorage.setItem('sf.theme', 'dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    SF.app.render();
  })()`);
  await goto('inbox', null, `document.querySelectorAll('.content-card').length > 0`);
  await evaluate(`(() => {
    const first = document.querySelector('.content-card');
    if (first) first.click();
  })()`);
  await until(`!!document.querySelector('.detail')`);
  await pause(700);
  await shoot('11-inbox-dark.png');

  console.log('[m35] 「静流」复刻验收通过');
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'm35'},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
  child.on('close', code => {
    clearTimeout(timer);
    process.exitCode = code ?? 1;
  });
}
