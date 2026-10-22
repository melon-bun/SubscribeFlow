const fs = require('node:fs');
const path = require('node:path');
const {CLASS_MAP, FX_MAP, DOC_ONLY} = require('./zhiliu-map.cjs');

/**
 * 「静流」样式移植器的第二步：**清冲突**。
 *
 * 第一步（m35-build-zhiliu-css.cjs）把参考页的规则整条搬过来（选择器改成产品真实类名），
 * 但产品自己那套旧规则还在，而且它们会「漏」出参考页没有的属性：
 * 参考页没写 border-radius，产品写了 → 产品多了一圈圆角；
 * 参考页没写 font-size，产品写了 → 产品比参考页大一号。
 * 移植规则管不到的属性，差异就留在了那里。
 *
 * 这一步按**参考页每个选择器实际声明了哪些属性**，
 * 把产品同名规则里「参考页没声明」的那些视觉属性删掉——
 * 删掉之后这些属性重新从父级继承，与参考页完全一致。
 *
 * 结构属性（display / 宽高 / flex / grid / position）一律保留：
 * 产品的 DOM 与参考页不完全相同（按钮 vs  div、面板的滚动容器不同），
 * 这些差异靠结构属性撑住，删了会塌版。
 */

const ROOT = path.resolve(__dirname, '..');
const REF = path.resolve(ROOT, '../zhiliu-visual-style.html');
const CSS_DIR = path.join(ROOT, 'electron/renderer/styles');
const PROD_FILES = ['base.css', 'layout.css', 'components.css', 'views.css', 'settings.css', 'intake.css'];

/** 视觉属性：参考页没声明就应当继承，不该由产品自己定 */
const VISUAL = new Set([
  'color', 'background', 'background-color', 'background-image', 'border', 'border-top', 'border-right',
  'border-bottom', 'border-left', 'border-color', 'border-style', 'border-width', 'border-radius',
  'box-shadow', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-bottom',
  // margin-left/right 保留：参考页的「贴右」是内联样式给的，靠清声明会把它清没
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'text-align', 'text-indent', 'text-transform', 'text-overflow', 'white-space', 'word-break',
  'vertical-align', 'opacity', 'gap', 'row-gap', 'column-gap', 'outline', 'outline-offset',
  'list-style', 'overflow-wrap', 'word-spacing', 'font-variant', 'font-feature-settings',
]);

function extractCss(html) {
  const start = html.indexOf('<style>');
  const end = html.indexOf('</style>');
  return html.slice(start + 7, end);
}

function rename(selector) {
  let out = selector.trim();
  const keys = Object.keys(CLASS_MAP).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const re = new RegExp('(?<![\\w-])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])', 'g');
    out = out.replace(re, CLASS_MAP[key]);
  }
  return out;
}

function isDocOnly(selector) {
  return DOC_ONLY.some(d => {
    const re = new RegExp('(?<![\\w-])' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
    return re.test(selector);
  });
}

/** 参考页每个选择器声明了哪些属性 */
function referenceProps() {
  const css = extractCss(fs.readFileSync(REF, 'utf8'));
  const props = {};
  const re = /(^|\})\s*([^{}@]+?)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const prelude = m[2];
    if (prelude.trim().startsWith('@')) continue;
    const body = m[3];
    for (const sel of prelude.split(',')) {
      const s = sel.trim();
      if (!s || isDocOnly(s)) continue;
      const target = rename(s);
      const set = props[target] || (props[target] = new Set());
      for (const decl of body.split(';')) {
        const i = decl.indexOf(':');
        if (i > 0) set.add(decl.slice(0, i).trim().toLowerCase());
      }
    }
  }
  return props;
}

function main() {
  const refProps = referenceProps();
  let removed = 0, touched = 0;

  for (const file of PROD_FILES) {
    const p = path.join(CSS_DIR, file);
    if (!fs.existsSync(p)) continue;
    let s = fs.readFileSync(p, 'utf8');
    const out = s.replace(/(^|\n)([^{}\n]*?)\{([^}]*)\}/g, (all, lead, sel, body) => {
      const selector = sel.trim();
      if (!selector || selector.startsWith('@') || selector.includes(',')) return all;
      const ref = refProps[selector];
      if (!ref) return all;
      const decls = body.split(';');
      const kept = [];
      let hit = false;
      for (const decl of decls) {
        const i = decl.indexOf(':');
        if (i <= 0) { kept.push(decl); continue; }
        const prop = decl.slice(0, i).trim().toLowerCase();
        if (VISUAL.has(prop) && !ref.has(prop)) { hit = true; removed++; continue; }
        kept.push(decl);
      }
      if (!hit) return all;
      touched++;
      return lead + sel + '{' + kept.join(';') + '}';
    });
    fs.writeFileSync(p, out);
  }
  console.log('清冲突：改写 ' + touched + ' 条产品规则，删除 ' + removed + ' 个多余声明');
  console.log('参考页属性集：' + Object.keys(refProps).length + ' 个选择器');
}

main();
