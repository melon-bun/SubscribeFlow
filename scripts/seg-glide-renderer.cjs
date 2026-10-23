const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * 分段控件滑块动画验收（scripts/ui/seg-glide.js）。
 *
 * 走正式 Renderer + 隔离数据（seed-m35-details.py），逐个分段控件：
 *   - 静止：选中项仍由按钮自己绘制，::before 滑块透明；contain: layout 不改变任何布局；
 *   - 切换：滑块动画起跑，中途目标按钮的底被压住、滑块位于两项之间（暂停在中点截图）；
 *   - 结束：动画全部清理，目标按钮恢复静止样式；
 *   - 中途再切：新动画从滑块当时的位置出发；减少动态效果时不播放。
 *
 * 用法：node scripts/seg-glide-renderer.cjs
 */
const HELPER = `window.__sg = {
  groupOf(a) { const t = a.effect && a.effect.target; return t && t.closest ? t.closest('.seg, .segment') : null; },
  anims() { return document.getAnimations().filter(a => this.groupOf(a)); },
  thumbs() { return this.anims().filter(a => a.effect.pseudoElement === '::before'); },
  async waitThumb(timeout = 1500) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      const live = this.thumbs().filter(a => a.playState === 'running');
      if (live.length) return live[0];
      await new Promise(r => requestAnimationFrame(r));
    }
    return null;
  },
  buttons(g) { return [...g.children].filter(b => b.tagName === 'BUTTON'); },
  x(transform) { const m = /translate\\(([-\\d.]+)px/.exec(transform || ''); return m ? Number(m[1]) : null; },
}; true;`;

async function verify({window, root}) {
  const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root, 'docs/verification/phase51/seg-glide');
  fs.mkdirSync(output, {recursive: true});
  const ev = code => window.webContents.executeJavaScript(code);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async expression => {
    for (let i = 0; i < 250; i++) {
      if (await ev(expression).catch(() => false)) return;
      await pause(60);
    }
    throw new Error('等待超时：' + expression);
  };
  const checks = [];
  const check = async (name, expression) => {
    const result = await ev(expression);
    checks.push({name, ...result});
    console.log((result.ok ? 'PASS ' : 'FAIL ') + name + ' ' + JSON.stringify(result));
    return result;
  };
  const shot = async name => {
    await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG());
  };
  const go = async (route, params = {}) => {
    await ev(`SF.app.navigate(${JSON.stringify(route)},${JSON.stringify(params)})`);
    await until(`!!document.querySelector('[data-view="${route}"]')`);
    await pause(600);
  };

  /* 静止态：每个分段控件的选中项自己有底，滑块透明；去掉 contain 后布局一像素不差。 */
  const resting = name => check('resting-' + name, `(() => {
    const groups = [...document.querySelectorAll('.seg, .segment')];
    const bad = groups.filter(g => {
      const a = __sg.buttons(g).find(b => b.classList.contains('is-active'));
      return getComputedStyle(g, '::before').opacity !== '0' || (a && getComputedStyle(a).backgroundColor === 'rgba(0, 0, 0, 0)');
    }).map(g => g.className);
    const rects = () => groups.flatMap(g => [g, g.parentElement, ...__sg.buttons(g)]).map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(v => Math.round(v * 100) / 100).join(','); });
    const before = rects();
    const probe = document.createElement('style');
    probe.textContent = '.seg, .segment { contain: none !important; }';
    document.head.append(probe);
    const after = rects();
    probe.remove();
    const moved = before.filter((r, i) => r !== after[i]).length;
    return {ok: groups.length > 0 && !bad.length && !moved, groups: groups.length, bad, moved};
  })()`);

  /* 切换一次：暂停在中点截图，再放行到结束，检查清理。 */
  const glide = async (name, selector, prepare) => {
    if (prepare) await ev(prepare);
    const mid = await check('glide-mid-' + name, `(async () => {
      const group = document.querySelector(${JSON.stringify(selector)});
      if (!group) return {ok: false, reason: 'missing group'};
      const btns = __sg.buttons(group), from = btns.find(b => b.classList.contains('is-active'));
      const target = btns.find(b => b !== from && !b.disabled);
      if (!from || !target) return {ok: false, reason: 'no target'};
      const index = btns.indexOf(target), rest = getComputedStyle(from).backgroundColor;
      const g0 = group.getBoundingClientRect(), fx = from.getBoundingClientRect().left - g0.left, tx = target.getBoundingClientRect().left - g0.left;
      target.click();
      const thumb = await __sg.waitThumb();
      if (!thumb) return {ok: false, reason: 'no glide'};
      __sg.anims().forEach(a => { a.pause(); a.currentTime = 130; });
      const g = __sg.groupOf(thumb), t = __sg.buttons(g)[index], pseudo = getComputedStyle(g, '::before');
      const x = __sg.x(pseudo.transform) ?? new DOMMatrix(pseudo.transform).m41;
      window.__sgHold = {g, index, rest};
      const between = x > Math.min(fx, tx) + 1 && x < Math.max(fx, tx) - 1;
      return {ok: pseudo.opacity === '1' && between && getComputedStyle(t).backgroundColor === 'rgba(0, 0, 0, 0)',
        replaced: g !== group, opacity: pseudo.opacity, x: Math.round(x), fromX: Math.round(fx), toX: Math.round(tx)};
    })()`);
    await shot('mid-' + name);
    await check('glide-end-' + name, `(async () => {
      const {g, index, rest} = window.__sgHold || {};
      __sg.anims().forEach(a => a.play());
      const t0 = performance.now();
      while (__sg.anims().length && performance.now() - t0 < 1500) await new Promise(r => requestAnimationFrame(r));
      const live = g && g.isConnected ? g : null;
      const group = live || document.querySelector(${JSON.stringify(selector)});
      const t = group && __sg.buttons(group)[index];
      return {ok: !__sg.anims().length && !!t && t.classList.contains('is-active') &&
        getComputedStyle(t).backgroundColor === rest && getComputedStyle(group, '::before').opacity === '0',
        left: __sg.anims().length, bg: t && getComputedStyle(t).backgroundColor, rest};
    })()`);
    await pause(500);
    return mid;
  };

  window.setContentSize(1440, 960);
  await until(`!!window.SF?.app.state.session && document.querySelectorAll('.content-card').length > 0`);
  await ev(`SF.app.state.fx = true; document.documentElement.dataset.fx = 'on'; document.documentElement.dataset.theme = 'light'; SF.app.render();`);
  await ev(HELPER);
  await check('module-loaded', `({ok: !!(window.SF && SF.segGlide), selector: SF.segGlide && SF.segGlide.selector})`);

  // 收件箱：平台筛选（就地改 class）+ 详情优先级（刷新边界整块替换）
  await until(`document.querySelectorAll('.content-card').length > 0`);
  await ev(`document.querySelector('.content-card').click()`);
  await until(`!!document.querySelector('.priority-grid')`);
  await pause(500);
  await resting('inbox');
  await glide('inbox-platform', '.inbox__toolbar .seg');
  await ev(`document.querySelector('.content-card') && document.querySelector('.content-card').click()`);
  await until(`!!document.querySelector('.priority-grid')`);
  await pause(400);
  await glide('detail-priority', '.priority-grid');

  // 中途再切：第二段动画从滑块当时的位置起跑
  await check('interrupt', `(async () => {
    const group = document.querySelector('.inbox__toolbar .seg'), btns = __sg.buttons(group);
    const from = btns.find(b => b.classList.contains('is-active')), others = btns.filter(b => b !== from && !b.disabled);
    if (others.length < 2) return {ok: false, reason: 'need 3 items'};
    const g0 = group.getBoundingClientRect(), ax = from.getBoundingClientRect().left - g0.left, bx = others[0].getBoundingClientRect().left - g0.left;
    const second = btns.indexOf(others[1]);
    others[0].click();
    const first = await __sg.waitThumb();
    if (!first) return {ok: false, reason: 'first glide missing'};
    await new Promise(r => setTimeout(r, 90));
    // 首次点击后分组可能已被重绘替换，需按位置在当前分组里重新取按钮
    const held = __sg.groupOf(first);
    const live = held && held.isConnected ? held : document.querySelector('.inbox__toolbar .seg');
    __sg.buttons(live)[second].click();
    await new Promise(r => requestAnimationFrame(r));
    const thumb = __sg.thumbs().find(a => a.playState === 'running');
    const x = thumb && __sg.x(thumb.effect.getKeyframes()[0].transform);
    __sg.anims().forEach(a => a.finish());
    return {ok: x !== null && x > Math.min(ax, bx) + 1 && x < Math.max(ax, bx) - 1, startX: x && Math.round(x), ax: Math.round(ax), bx: Math.round(bx)};
  })()`);
  await pause(400);

  // 标签筛选方式（.segment）：需要先选两个标签才可切换
  await ev(`(() => {
    const btn = [...document.querySelectorAll('.inbox__toolbar button')].find(b => /标签/.test(b.textContent));
    if (btn) btn.click();
  })()`);
  await pause(500);
  const picked = await ev(`(() => {
    const chips = [...document.querySelectorAll('.tag-filter__tags .chip--tag')].slice(0, 2);
    chips.forEach(c => c.click());
    return chips.length;
  })()`);
  await pause(600);
  const segmentReady = await ev(`(() => { const s = document.querySelector('.tag-filter__mode .segment'); return !!s && __sg.buttons(s).some(b => !b.disabled && !b.classList.contains('is-active')); })()`);
  if (picked >= 2 && segmentReady) await glide('tag-filter-mode', '.tag-filter__mode .segment');
  else console.log('SKIP tag-filter-mode（隔离数据里可选标签不足 2 个）');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
  await pause(300);

  // 内容总览：日历 / 优先级
  await go('overview');
  await until(`!!document.querySelector('.view__actions .seg')`);
  await resting('overview');
  await glide('overview-mode', '.view__actions .seg');

  // 渠道管理：渠道列表 / 优先级设置
  await go('channels');
  await until(`!!document.querySelector('[data-view="channels"] .seg')`);
  await resting('channels');
  await glide('channels-tab', '[data-view="channels"] .seg');

  // 标签：标签列表 / AI 自动识别（深色下再拍一次）
  await go('tags');
  await until(`!!document.querySelector('.tags-tabbar .seg')`);
  await resting('tags');
  await glide('tags-tab', '.tags-tabbar .seg');
  await ev(`document.documentElement.dataset.theme = 'dark'`);
  await pause(300);
  await glide('tags-tab-dark', '.tags-tabbar .seg');
  await ev(`document.documentElement.dataset.theme = 'light'`);

  // 减少动态效果：不播放滑块，直接切换
  const dbg = window.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await go('channels');
  await until(`!!document.querySelector('[data-view="channels"] .seg')`);
  await check('reduced-motion', `(async () => {
    const group = document.querySelector('[data-view="channels"] .seg');
    const target = __sg.buttons(group).find(b => !b.classList.contains('is-active'));
    target.click();
    const thumb = await __sg.waitThumb(500);
    return {ok: !thumb && matchMedia('(prefers-reduced-motion: reduce)').matches, glided: !!thumb};
  })()`);
  await dbg.sendCommand('Emulation.setEmulatedMedia', {features: []});
  dbg.detach();

  const failures = checks.filter(c => !c.ok);
  fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({checks, failed: failures.length, passed: checks.length - failures.length}, null, 2));
  console.log(JSON.stringify({checks: checks.length, failures: failures.length, output}));
  if (failures.length) throw new Error('分段控件滑块未通过：' + failures.map(c => c.name).join(', '));
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..'), folder = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribe-flow-m35-details-seg-glide-'));
  const python = JSON.parse(fs.readFileSync(path.join(root, '.runtime-paths.json'), 'utf8')).python;
  const seed = spawnSync(python, [path.join(root, 'scripts/seed-m35-details.py'), folder], {encoding: 'utf8'});
  if (seed.status !== 0) { console.error(seed.stderr || seed.stdout); fs.rmSync(folder, {recursive: true, force: true}); process.exitCode = 1; }
  else {
    const child = spawn(require('electron'), [root], {env: {...process.env, SUBSCRIBE_FLOW_DATA_DIR: folder, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'segglide'}, stdio: 'inherit'});
    const timer = setTimeout(() => child.kill('SIGKILL'), 150000);
    child.on('close', code => { clearTimeout(timer); fs.rmSync(folder, {recursive: true, force: true}); process.exitCode = code ?? 1; });
  }
}
