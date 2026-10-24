const fs = require('node:fs');
const path = require('node:path');
const {CLASS_MAP, FX_MAP, DOC_ONLY} = require('./zhiliu-map.cjs');

/**
 * 「静流」样式移植器。
 *
 * 把参考页 zhiliu-visual-style.html 的 CSS **原样**搬到产品里，
 * 把演示页的类名换成产品真实类名（见 zhiliu-map.cjs），
 * 笔记样张的固定最小高度适配真实窗口；其余取值与规则顺序沿用规格。
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
  const mapping = {...CLASS_MAP, ...FX_MAP};
  const keys = Object.keys(mapping).sort((a, b) => b.length - a.length);
  const pattern = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp('(?<![\\w-])(?:' + pattern + ')(?![\\w-])', 'g');
  return selector.trim().replace(re, (m) => mapping[m]);
}

// 产品把顶栏和纸面包在同一个 shell；侧栏只占根网格的第一行。
// 参考页直接把二者放在根网格，照搬跨两行会生成随内容伸缩的空行（BUG-102）。
function adaptWindow(selector, body) {
  // 知流使用原始白底品牌图，不沿用参考页橙底 + 20px SVG 的演示 logo。
  if (/\.brand__mark\s*$/.test(selector)) body = body
    .replace(/background:\s*var\(--c-orange\);/, 'background: #fff;')
    .replace(/box-shadow:[^;]+;/, 'box-shadow: var(--sh-card);');
  if (/\.brand__mark img\s*$/.test(selector)) body = 'width: 100%; height: 100%; object-fit: contain; border-radius: inherit;';
  if (/\.sidebar\s*$/.test(selector)) body = body.replace(/grid-row:\s*1\s*\/\s*3/g, 'grid-row: 1');
  // 参考页是固定高度样张；真实窗口由滚动容器分配剩余空间。
  return /\.notes-layout\s*$/.test(selector) ? body.replace(/min-height:\s*640px/g, 'min-height: 0') : body;
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
    (isFx ? fx : base).push({prelude: renamed, body: adaptWindow(renamed, body)});
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
   规则顺序与取值沿用参考页；笔记布局的固定样张高度适配真实窗口。

   规格取值在参考页维护，产品映射在 zhiliu-map.cjs 维护；改源后重跑生成器。
   直接改这里会在下次生成时被覆盖。
   ========================================================================== */

`;

  fs.writeFileSync(OUT, header + render(base) + '\n');
  fs.writeFileSync(FX_OUT, header + render(fx) + '\n');
  console.log('写入', path.relative(process.cwd(), OUT), '（基础', base.length, '块）');
  console.log('写入', path.relative(process.cwd(), FX_OUT), '（轻科幻', fx.length, '块）');
  console.log('丢弃（文档外壳规则）', skipped, '块');
}

main();
