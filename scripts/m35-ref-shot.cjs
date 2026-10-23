const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');

/**
 * 参考页单页实拍。
 *
 * 参考页把 7 个页面叠在同一个 .app 里，用 .pv 切换。这里把文档外壳藏掉，
 * 只留「其他页面」那个 frame，并把 .app.pages 撑成 1440×960，
 * 拍出来和产品的整窗截图（1440×960）就是同一个画布，可以并排比。
 *
 * 用法：node scripts/m35-ref-shot.cjs <outDir>
 */
const REF = '/Users/xor/Documents/Subscribe_Call/zhiliu-visual-style.html';
const PAGES = ['ov-cal', 'ov-prio'];
const W = 1440, H = 960;

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const outDir = process.argv[2] || '/tmp/m35-ref';
  fs.mkdirSync(outDir, {recursive: true});
  const w = new BrowserWindow({width: W, height: H, useContentSize: true, show: false});
  await w.loadFile(REF);
  await sleep(1500);

  for (const page of PAGES) {
    await w.webContents.executeJavaScript(`(() => {
      const frames = document.querySelectorAll('.frame-wrap');
      const target = frames[1];
      document.body.appendChild(target);
      for (const el of Array.from(document.body.children)) {
        if (el !== target) el.style.display = 'none';
      }
      document.body.style.margin = '0';
      document.body.style.padding = '0';
      target.style.display = 'block';
      target.style.overflow = 'visible';
      target.style.borderRadius = '0';
      target.style.boxShadow = 'none';
      target.style.padding = '0';
      const appEl = target.querySelector('.app.pages');
      appEl.style.height = '${H}px';
      appEl.style.width = '${W}px';
      appEl.style.minWidth = '0';
      const pv = target.querySelector('.pv[data-page="${page}"]');
      target.querySelectorAll('.pv').forEach(x => x.classList.toggle('on', x === pv));
      window.scrollTo(0, 0);
    })()`);
    await sleep(700);
    const file = outDir + '/ref-' + page + '.png';
    fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG());
    console.log('参考页截图 -> ' + file);
  }
  app.exit(0);
});
