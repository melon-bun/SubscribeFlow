const fs = require('node:fs');
const path = require('node:path');

/**
 * 「静流」样式对拍报告。
 *
 * 输入：
 *   /tmp/ref-styles.json                                  参考页导出（/tmp/ref-probe.cjs）
 *   docs/verification/phase51/m35/product-styles.json      产品导出（scripts/m35-style-probe.cjs）
 *
 * 输出：逐选择器、逐属性的差值清单。差 0 = 完全一致。
 *
 * 判定规则：
 *   · 颜色按 rgba 归一（透明写 transparent，避免 0/0/0/0 与 black 混淆）；
 *   · 长度 0.5px 以内算相等（亚像素渲染的正常抖动），字号 0.01px、字距 0.001em；
 *   · box-shadow 只比「有几层、每层什么色」——偏移量在不同上下文里不可比；
 *   · backgroundImage 只比「有没有图」（参考页的渐变写的是硬编码色值）；
 *   · transform 只比「有没有变换」；
 *   · 参考页没有的属性（产品多出来的）不算差。
 */

/** 容差：按属性给 */
const TOLERANCE = {
  fontSize: 0.01,
  letterSpacing: 0.001,
  lineHeight: 0.5,
};
const DEFAULT_TOL = 0.5;

function normalizeColor(v) {
  if (!v) return v;
  const m = String(v).match(/rgba?\(([^)]+)\)/);
  if (!m) return String(v).trim();
  const parts = m[1].split(',').map(x => x.trim());
  const nums = parts.map(Number);
  if (nums.length === 4 && Math.abs(nums[3]) < 0.004) return 'transparent';
  if (nums.length === 4) return `rgba(${nums.slice(0, 3).map(Math.round).join(',')},${nums[3].toFixed(2)})`;
  if (nums.length === 3) return `rgb(${nums.map(Math.round).join(',')})`;
  return String(v).trim();
}

function normalize(prop, v) {
  if (v == null) return v;
  let s = String(v).trim();
  switch (prop) {
    case 'fontFamily': {
      const first = s.split(',')[0].replace(/["']/g, '').trim();
      return ['-apple-system', 'system-ui', 'BlinkMacSystemFont'].includes(first) ? '-apple-system' : first;
    }
    case 'backgroundImage':
      if (s === 'none') return 'none';
      return /gradient|url\(/i.test(s) ? 'has-image' : 'none';
    case 'boxShadow': {
      if (s === 'none') return 'none';
      const layers = s.split(/,(?![^(]*\))/).map(x => x.trim());
      return layers.map(l => {
        const col = l.match(/rgba?\([^)]+\)/);
        return col ? normalizeColor(col[0]) : 'shadow';
      }).join(' | ');
    }
    case 'transform':
      return s === 'none' ? 'none' : 'has-transform';
    case 'color':
    case 'backgroundColor':
    case 'borderTopColor':
    case 'borderRightColor':
    case 'borderBottomColor':
    case 'borderLeftColor':
      return normalizeColor(s);
    case 'opacity': {
      const n = Number(s);
      if (Math.abs(n) < 0.005) return '0';
      if (Math.abs(n - 1) < 0.005) return '1';
      return n.toFixed(2);
    }
    case 'flex':
      return s.replace(/([\d.]+)px/g, '#px');
    case 'inset':
    case 'gridTemplateColumns':
      return s.replace(/([\d.]+)px/g, '#px');
    case 'fontWeight':
      // 400 与 normal、600 与 bold 视为等价
      if (s === 'normal') return '400';
      if (s === 'bold') return '700';
      return s;
    default:
      return s;
  }
}

function equal(prop, a, b) {
  if (a === b) return true;
  const na = parseFloat(a), nb = parseFloat(b);
  const numeric = /^-?[\d.]+(px|em|rem|%)?$/.test(a) && /^-?[\d.]+(px|em|rem|%)?$/i.test(b);
  if (numeric && !Number.isNaN(na) && !Number.isNaN(nb)) {
    const tol = TOLERANCE[prop] != null ? TOLERANCE[prop] : DEFAULT_TOL;
    return Math.abs(na - nb) <= tol;
  }
  return false;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const refFile = process.env.REF_STYLES || '/tmp/ref-styles.json';
  const prodFile = process.env.PRODUCT_STYLES || path.join(root, 'docs/verification/phase51/m35/product-styles.json');
  if (!fs.existsSync(refFile)) { console.error('缺少参考页样式：' + refFile); process.exit(2); }
  if (!fs.existsSync(prodFile)) { console.error('缺少产品样式：' + prodFile); process.exit(2); }
  const ref = JSON.parse(fs.readFileSync(refFile, 'utf8'));
  const prod = JSON.parse(fs.readFileSync(prodFile, 'utf8'));

  let totalChecked = 0, totalDiff = 0;
  const report = [];

  for (const page of Object.keys(ref)) {
    const r = ref[page], p = prod[page];
    if (!r) continue;
    if (!p) { report.push({page, selector: '(整页)', prop: '-', ref: '-', prod: '缺整页'}); totalDiff++; continue; }
    for (const sel of Object.keys(r)) {
      const rv = r[sel];
      if (!rv) continue;
      const pv = p[sel];
      if (!pv) { report.push({page, selector: sel, prop: '-', ref: '有', prod: '缺'}); totalDiff++; continue; }
      if (pv.missing) {
        report.push({page, selector: sel, prop: '-', ref: '有', prod: '产品缺选择器 ' + pv.missing});
        totalDiff++;
        continue;
      }
      for (const prop of Object.keys(rv)) {
        if (prop === 'width' || prop === 'height') continue; // 尺寸由上下文决定，另行单独比
        totalChecked++;
        const a = normalize(prop, rv[prop]);
        const b = normalize(prop, pv[prop]);
        if (!equal(prop, a, b)) {
          totalDiff++;
          report.push({page, selector: sel, prop, ref: rv[prop], prod: pv[prop]});
        }
      }
    }
  }

  console.log('对拍属性数：' + totalChecked + '，差值：' + totalDiff);
  const byPage = {};
  for (const r of report) (byPage[r.page] = byPage[r.page] || []).push(r);
  for (const [page, list] of Object.entries(byPage)) {
    console.log('\n=== ' + page + '（' + list.length + ' 处差异）===');
    for (const r of list) {
      console.log(`  ${r.selector} { ${r.prop} }`);
      console.log(`      参考: ${r.ref}`);
      console.log(`      产品: ${r.prod}`);
    }
  }
  const outFile = path.join(root, 'docs/verification/phase51/m35/parity-report.txt');
  fs.mkdirSync(path.dirname(outFile), {recursive: true});
  fs.writeFileSync(outFile, report.map(r => `[${r.page}] ${r.selector} { ${r.prop} }  参考=${r.ref}  产品=${r.prod}`).join('\n'));
  console.log('\n报告 -> ' + outFile);
  process.exitCode = totalDiff ? 1 : 0;
}

main();
