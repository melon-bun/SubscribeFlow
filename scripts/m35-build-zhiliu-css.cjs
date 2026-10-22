const fs = require('node:fs');
const path = require('node:path');
const {CLASS_MAP, FX_MAP, DOC_ONLY} = require('./zhiliu-map.cjs');

/**
 * 「静流」样式移植器。
 *
 * 把参考页 zhiliu-visual-style.html 的 CSS **原样**搬到产品里，
 * 只做一件事：把演示页的类名换成产品真实类名（见 zhiliu-map.cjs）。
 * 规则顺序、取值、层级一律不动——参考页是唯一规格。
 *
 * 产物：electron/renderer/styles/zhiliu.css（在其它样式之后加载），
 * 同时重写 fx.css 里的轻科幻层，使效果层也来自同一份规格。
 *
 * 用法：node scripts/m35-build-zhiliu-css.cjs
 */
const REF = path.resolve(__dirname, '../../zhiliu-visual-style.html');
const OUT = path.resolve(__dirname, '../electron/renderer/styles/zhiliu.css');
const FX_OUT = path.resolve(__dirname, '../electron/renderer/styles/fx.css');

function extractCss(html) {
  const start = html.indexOf('<style>');
  const end = html.indexOf('</style>');
  return html.slice(start + 7, end);
}

/**
 * 把参考页的选择器改写成产品选择器。
 *
 * 必须**一次替换**：逐条 replace 会把已经改好的结果再改一遍
 * （'.check' → '.content-selection > .check' 之后，又被 '.check' 这条规则再替换一次，
 * 变成 '.content-selection > .content-selection > .check'）。
 * 所以把所有键合成一个正则（长的优先），一次扫描过去。
 */
function rename(selector) {
  const keys = Object.keys(CLASS_MAP).sort((a, b) => b.length - a.length);
  const pattern = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp('(?<![\\w-])(?:' + pattern + ')(?![\\w-])', 'g');
  return selector.trim().replace(re, (m) => CLASS_MAP[m]);
}

/** 去掉参考页「方案文档外壳」的规则 */
function isDocOnly(selector) {
  const s = selector.trim();
  return DOC_ONLY.some(d => {
    const re = new RegExp('(?<![\\w-])' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
    return re.test(s);
  });
}

/** 极轻量的 CSS 切块：保留 @media/@keyframes 结构 */
function splitBlocks(css) {
  const blocks = [];
  let i = 0;
  let buf = '';
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      const prelude = buf.trim();
      const body = css.slice(i + 1, j - 1);
      blocks.push({prelude, body});
      buf = '';
      i = j;
      continue;
    }
    buf += ch;
    i++;
  }
  return blocks;
}

function main() {
  const html = fs.readFileSync(REF, 'utf8');
  const css = extractCss(html);
  const blocks = splitBlocks(css);

  const base = [];
  const fx = [];
  let skipped = 0;

  for (const block of blocks) {
    const prelude = block.prelude;
    const body = block.body;

    // @keyframes 整块照搬
    if (prelude.startsWith('@keyframes')) {
      (prelude.includes('fx-') || prelude.includes('indet') || prelude.includes('spin') || prelude.includes('ping') || prelude.includes('sweep') ? fx : base).push({prelude, body});
      continue;
    }
    if (prelude.startsWith('@media')) {
      const inner = splitBlocks(body).map(b => ({prelude: b.prelude, body: b.body}));
      const kept = inner.filter(b => !b.prelude.trim().split(',').every(isDocOnly));
      if (!kept.length) { skipped++; continue; }
      const target = prelude.includes('data-fx') || prelude.includes('prefers-reduced-motion') ? fx : base;
      const keptBody = kept.map(b => {
        const sel = b.prelude.split(',').map(s => s.trim()).filter(s => !isDocOnly(s));
        if (!sel.length) return null;
        return sel.map(s => rename(s)).join(',\n') + ' {\n' + b.body.trim() + '\n}';
      }).filter(Boolean).join('\n\n');
      if (!keptBody.trim()) { skipped++; continue; }
      target.push({prelude, body: keptBody});
      continue;
    }

    const sels = prelude.split(',').map(s => s.trim()).filter(s => s && !isDocOnly(s));
    if (!sels.length) { skipped++; continue; }
    // 令牌块不进这里：tokens.css 是令牌的唯一来源，避免两处取值漂移。
    if (sels.every(s => /^:root/.test(s))) { skipped++; continue; }
    const renamed = sels.map(s => rename(s)).join(',\n');
    const isFx = /\[data-fx="on"\]|\[data-theme="dark"\]\[data-fx="on"\]/.test(prelude);
    (isFx ? fx : base).push({prelude: renamed, body});
  }

  const render = list => list.map(b => {
    if (b.prelude.startsWith('@')) {
      return b.prelude + ' {\n' + b.body + '\n}';
    }
    return b.prelude + ' {\n' + b.body.trim() + '\n}';
  }).join('\n\n');

  const header = `/* ==========================================================================
   知流 / Subscribe_Flow — 「静流」样式层（由参考页移植，勿手改）
   --------------------------------------------------------------------------
   本文件由 scripts/m35-build-zhiliu-css.cjs 从仓库根目录
   zhiliu-visual-style.html 的样式表**逐条移植**而来：
   参考页的类名按 scripts/zhiliu-map.cjs 换成产品真实类名，
   规则顺序与取值一律保持参考页原样。

   要改视觉，改参考页后重跑生成器；直接改这里会在下次生成时被覆盖。
   ========================================================================== */

`;

  fs.writeFileSync(OUT, header + render(base) + '\n');
  fs.writeFileSync(FX_OUT, header + render(fx) + '\n');
  console.log('写入', path.relative(process.cwd(), OUT), '（基础', base.length, '块）');
  console.log('写入', path.relative(process.cwd(), FX_OUT), '（轻科幻', fx.length, '块）');
  console.log('丢弃（文档外壳规则）', skipped, '块');
}

main();
