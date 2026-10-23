const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

async function verify({window, root}) {
  const output = process.env.SUBSCRIBE_FLOW_VERIFY_OUTPUT || path.join(root, 'docs/verification/phase51/m35-details');
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
  };
  const shot = async name => {
    await pause(250);
    await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG());
  };
  /* 筛选条形态（对照参考页 .select）：每个下拉都是**带 1px 内描边**的按钮，
     宽度只由按钮文字决定；原生 <select> 的宽度由最长选项决定，
     真实来源名一长就把整行撑爆、「重置筛选」被挤到第二行。
     断言量的是几何与形态，不是「看起来还行」。 */
  const filterRowShape = rowSelector => `(() => {
    const row = document.querySelector(${JSON.stringify(rowSelector)});
    if (!row) return {ok:false, reason:'缺少筛选条'};
    const native = row.querySelectorAll('select');
    const btns = [...row.querySelectorAll('.select--btn')];
    const noRing = btns.filter(b => !/inset/.test(getComputedStyle(b).boxShadow)).length;
    const wide = btns.filter(b => b.getBoundingClientRect().width > 230).map(b => Math.round(b.getBoundingClientRect().width));
    const reset = [...row.querySelectorAll('button')].find(b => b.textContent.indexOf('重置筛选') >= 0);
    const first = btns[0];
    const sameLine = reset && first ? Math.abs(reset.getBoundingClientRect().top - first.getBoundingClientRect().top) < 4 : false;
    return {ok: native.length === 0 && btns.length >= 5 && noRing === 0 && wide.length === 0 && sameLine,
      native: native.length, buttons: btns.length, noRing, wide, sameLine};
  })()`;
  const go = async (route, params = {}) => {
    await ev(`SF.app.navigate(${JSON.stringify(route)},${JSON.stringify(params)})`);
    await until(`!!document.querySelector('[data-view="${route}"]')`);
    await pause(450);
  };
  window.setContentSize(1440, 960);
  await until(`!!window.SF?.app.state.session && document.querySelectorAll('.content-card').length > 0`);
  await ev(`SF.app.state.fx = true; document.documentElement.dataset.fx = 'on'; document.documentElement.dataset.theme = 'light'; SF.app.render();`);
  await until(`document.querySelectorAll('.content-card').length > 0`);
  await ev(`document.querySelector('[data-content-id="zhihu:feed:m35-0"]').click()`);
  await until(`!!document.querySelector('.detail__hero')`);
  await check('task-insets', `(() => {const p=document.querySelector('.workspace').getBoundingClientRect(), t=document.querySelector('.task').getBoundingClientRect();const left=t.left-p.left,top=t.top-p.top;return {ok:Math.abs(left-14)<1&&Math.abs(top-12)<1,left,top};})()`);
  await check('card-text-bounds', `(() => {const bad=[...document.querySelectorAll('.content-card')].filter(c=>c.querySelector('.content-card__main').getBoundingClientRect().right>c.getBoundingClientRect().right-8);return {ok:bad.length===0,bad:bad.map(c=>c.dataset.contentId)};})()`);
  await check('high-signal', `(() => {const e=document.querySelector('.prio-sig--high i'),p=document.createElement('i');p.style.color='var(--c-high)';document.body.append(p);const actual=getComputedStyle(e).backgroundColor,expected=getComputedStyle(p).color;p.remove();return {ok:actual===expected,actual,expected};})()`);
  const githubInk = `(() => {const p=document.createElement('i');p.style.color='var(--c-github-ink)';document.body.append(p);const expected=getComputedStyle(p).color,icons=[...document.querySelectorAll('.plat--github path')].map(e=>({actual:getComputedStyle(e).fill,host:e.closest('.plat').className}));p.remove();return {ok:icons.length>1&&icons.every(e=>e.actual===expected),icons,expected};})()`;
  await check('github-ink', githubInk);
  await check('card-tag-space', `(() => {const c=document.querySelector('[data-content-id="zhihu:feed:m35-0"]'),t=c.querySelector('.tag-chip'),r=t.getBoundingClientRect(),m=c.querySelector('.content-card__method').getBoundingClientRect(),n=c.querySelector('.tag-chip__text');return {ok:r.width>=70&&r.right<=m.left+1,width:r.width,methodGap:m.left-r.right,textWidth:n?.getBoundingClientRect().width,text:n?.textContent};})()`);
  await check('detail-text-bounds', `(() => {const bad=[...document.querySelectorAll('.detail__title,.detail__summary,.detail__byline-time')].filter(e=>e.scrollWidth>e.clientWidth+1);return {ok:!bad.length,bad:bad.map(e=>({class:e.className,scroll:e.scrollWidth,width:e.clientWidth}))};})()`);
  await check('placeholder-bounds', `(() => {const e=document.querySelector('.content-card__thumb svg'),r=e.getBoundingClientRect(),p=e.parentNode.getBoundingClientRect();return {ok:r.left>=p.left-.5&&r.right<=p.right+.5,left:r.left-p.left,right:p.right-r.right};})()`);
  await check('single-tag-dot', `(() => {const e=document.querySelector('.tag-chip:not(.tag-chip--more)'),s=getComputedStyle(e,'::before'),d=e.querySelector('.tag-chip__dot');const pseudo=!(s.content==='none'||s.content==='normal')&&parseFloat(s.width)>0,child=d&&getComputedStyle(d).display!=='none';return {ok:Number(pseudo)+Number(!!child)===1,pseudo,child:!!child};})()`);
  await check('single-dropdown-arrow', `(() => {const e=document.querySelector('button.select--btn'),s=getComputedStyle(e,'::after');return {ok:s.content==='none'||s.content==='normal',content:s.content};})()`);
  await check('detail-hud', `(() => {const e=document.querySelector('.detail__hud');return {ok:!!e&&getComputedStyle(e).display!=='none',display:e&&getComputedStyle(e).display};})()`);
  await check('online-dot', `(() => {const r=document.querySelector('.fx-online').getBoundingClientRect();return {ok:r.width>=5&&r.height>=5,width:r.width,height:r.height};})()`);
  await check('footnote-size', `(() => {const size=parseFloat(getComputedStyle(document.querySelector('.content-card__method')).fontSize);return {ok:size<=12.5,size};})()`);
  /* 平台色块里的字不能超出方块：小红书原来用「RED」三个字母，
     塞进 15px 的方块里会顶出边框（参考页用的是「红」一个字）。 */
  await check('platform-mark-fits', `(() => {
    const bad=[];
    for (const e of document.querySelectorAll('.plat')) {
      const box=e.getBoundingClientRect();
      for (const n of e.childNodes) {
        if (n.nodeType!==3 || !n.textContent.trim()) continue;
        const r=document.createRange(); r.selectNodeContents(n);
        const t=r.getBoundingClientRect();
        if (t.width>box.width+0.5 || t.height>box.height+0.5) bad.push({cls:e.className,text:n.textContent.trim(),textWidth:Math.round(t.width*10)/10,boxWidth:Math.round(box.width*10)/10});
      }
    }
    return {ok:!bad.length,bad};
  })()`);
  await shot('01-inbox-light');
  await go('overview');
  await ev(`SF.app.state.calendarMonth='2026-10';SF.app.state.selectedDate='2026-10-18';SF.app.renderContent()`);
  await until(`!!document.querySelector('.cal-pill__dot')`);
  await check('single-calendar-dot', `(() => {const e=document.querySelector('.cal-pill:has(.cal-pill__dot)'),s=getComputedStyle(e,'::before'),d=e.querySelector('.cal-pill__dot');const pseudo=!(s.content==='none'||s.content==='normal')&&parseFloat(s.width)>0,child=getComputedStyle(d).display!=='none';return {ok:Number(pseudo)+Number(child)===1,pseudo,child};})()`);
  await check('calendar-heading', `(() => {const e=document.querySelector('.cal-day__heading:has(.cal-day__count)'),r=e.getBoundingClientRect(),c=e.querySelector('.cal-day__count').getBoundingClientRect();return {ok:r.right-c.right<2,gap:r.right-c.right};})()`);
  await check('calendar-filter-row', filterRowShape('.calendar-filters'));
  await shot('02-calendar');
  /* 当日列表的元信息行：来源名不能被挤没。
     同一行里头像、平台标签、优先级标签、日期都不压缩，缺口全落在名字上，
     名字会被压成「长」甚至「Mi…」——看着像渲染坏了。 */
  await ev(`(() => { const cells=[...document.querySelectorAll('.cal-day')].filter(c=>!c.classList.contains('is-outside')); const withItems=cells.find(c=>c.querySelector('.cal-pill')); if (withItems) withItems.click(); })()`);
  await until(`!!document.querySelector('.row-card')`);
  await check('day-card-meta-width', `(() => {
    const card = document.querySelector('.row-card');
    if (!card) return {ok:false, reason:'没有当日列表条目'};
    const meta = card.querySelector('.row-card__meta');
    const name = meta && meta.querySelector('.t-ellipsis');
    if (!name) return {ok:false, reason:'没有来源名'};
    const kids = [...meta.children].map(c => ({cls:c.className||c.tagName, w:Math.round(c.getBoundingClientRect().width)}));
    const nr = name.getBoundingClientRect();
    return {ok:nr.width>=48, nameWidth:Math.round(nr.width), nameText:name.textContent, kids};
  })()`);
  /* 选中那个超长来源名之后，按钮必须封顶并用省略号收尾——
     原生 <select> 会按最长选项撑宽，整条筛选行随之失控。 */
  await ev(`document.querySelector('[aria-label="日历来源"]').click()`);
  await until(`!!document.querySelector('.menu__item')`);
  await ev(`(() => { const items=[...document.querySelectorAll('.menu__item')].filter(b=>b.getAttribute('data-value')); items.sort((a,b)=>b.textContent.length-a.textContent.length); if (items[0]) items[0].click(); })()`);
  await until(`document.querySelector('[aria-label="日历来源"]')?.getAttribute('data-value')`);
  await check('long-source-truncated', `(() => {const b=document.querySelector('[aria-label="日历来源"]'),r=b.getBoundingClientRect(),lab=b.querySelector('.select__label');const truncated=lab.scrollWidth>lab.clientWidth+1;return {ok:r.width<=230&&truncated,width:r.width,text:lab.textContent,scroll:lab.scrollWidth,client:lab.clientWidth};})()`);
  await ev(`document.querySelector('[aria-label="日历来源"]').click()`);
  await until(`!!document.querySelector('.menu__item')`);
  await ev(`(() => { const items=[...document.querySelectorAll('.menu__item')]; const s=items.find(b=>b.getAttribute('data-value')===''); if (s) s.click(); })()`);
  await until(`document.querySelector('[aria-label="日历来源"]')?.getAttribute('data-value')===''`);
  await go('overview', {mode:'priority'});
  await until(`!!document.querySelector('.kanban__item')`);
  await check('kanban-reading-order', `(() => {const e=document.querySelector('.kanban__item'),t=e.querySelector('.kanban__item-title').getBoundingClientRect(),a=e.querySelector('.kanban__item-author').getBoundingClientRect();return {ok:t.bottom<=a.top+2,titleBottom:t.bottom,authorTop:a.top};})()`);
  await check('kanban-rule-size', `(() => {const e=document.querySelector('.kanban__item-rule'),r=e.getBoundingClientRect();return {ok:r.height<22&&r.width<70,width:r.width,height:r.height};})()`);
  await check('priority-filter-row', filterRowShape('.priority-filters'));
  await shot('03-priority');  await go('notes');
  await until(`!!document.querySelector('.notes-toc__item')`);
  await ev(`document.querySelector('.notes-toc__item').click()`);
  await until(`!!document.querySelector('[data-note-editor] textarea')`);
  await pause(500);
  await check('note-field-width', `(() => {const e=document.querySelector('.note-editor__fields .field'),p=e.closest('[data-note-editor]'),r=e.getBoundingClientRect(),b=p.getBoundingClientRect(),s=getComputedStyle(p);const gap=b.right-r.right-parseFloat(s.paddingRight);return {ok:gap<12,gap,width:r.width};})()`);
  await check('no-empty-ai-box', `(() => {const e=[...document.querySelectorAll('.note-editor__ai')].filter(n=>!n.textContent.trim());return {ok:!e.length,count:e.length};})()`);
  await check('notes-left-aligned', `(() => {const align=getComputedStyle(document.querySelector('.notes-toc__item')).textAlign;return {ok:['left','start'].includes(align),align};})()`);
  await shot('04-notes');
  await go('tags');await until(`!!document.querySelector('.tags-toolbar')`);
  await check('tag-toolbar-row', `(() => {const e=document.querySelector('.tags-toolbar'),a=e.querySelector('.toolbar__title').getBoundingClientRect(),b=[...e.querySelectorAll('button')].find(n=>n.textContent.includes('新建标签')).getBoundingClientRect();return {ok:Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<3,titleY:a.top,buttonY:b.top};})()`);
  await shot('05-tags');
  await go('tags',{tab:'ai'});await pause(350);
  await ev(`document.querySelector('[aria-label="启用自动打标"]').click()`);
  await check('ai-switch-state', `(() => {const e=document.querySelector('[aria-label="启用自动打标"]'),s=getComputedStyle(e,'::after');return {ok:e.tagName==='BUTTON'&&e.getAttribute('aria-checked')==='true'&&e.classList.contains('is-on')&&s.transform!=='none',tag:e.tagName,checked:e.getAttribute('aria-checked'),transform:s.transform};})()`);
  await check('selected-mode-hud', `(() => {const e=document.querySelector('.mode-card.is-active .mode-card__hud'),s=getComputedStyle(e),r=e.getBoundingClientRect(),inactive=document.querySelector('.mode-card:not(.is-active) .mode-card__hud');return {ok:s.position==='absolute'&&r.width>100&&s.backgroundImage!=='none'&&getComputedStyle(inactive).display==='none',position:s.position,width:r.width,background:s.backgroundImage};})()`);
  await shot('06-tags-ai');
  await ev(`document.querySelector('[aria-label="启用自动打标"]').click()`);
  for (const width of [1100,800]) {
    window.setContentSize(width,700);await go('notes');await pause(250);
    await check('notes-viewport-'+width, `(() => {const e=document.querySelector('.notes-layout').getBoundingClientRect(),w=document.querySelector('.workspace').getBoundingClientRect();return {ok:e.bottom<=w.bottom+.5&&document.documentElement.scrollWidth<=innerWidth,bottom:e.bottom,paperBottom:w.bottom};})()`);
    await shot('notes-'+width);
    await ev(`document.querySelector('.note-editor__actions').scrollIntoView({block:'end'})`);
    await check('notes-actions-reachable-'+width, `(() => {const e=document.querySelector('.note-editor__actions').getBoundingClientRect(),p=document.querySelector('.workspace').getBoundingClientRect();return {ok:e.bottom<=p.bottom+1&&e.top>=p.top,top:e.top,bottom:e.bottom,paperBottom:p.bottom};})()`);
    await check('notes-reader-surface-'+width, `(() => {const p=document.querySelector('.notes-reader').getBoundingClientRect(),e=document.querySelector('.note-editor__actions').getBoundingClientRect();return {ok:e.bottom<=p.bottom+1,actionsBottom:e.bottom,panelBottom:p.bottom};})()`);
    await ev(`[...document.querySelectorAll('[data-note-editor] textarea')].at(-1).scrollIntoView({block:'center'})`);
    await check('notes-last-field-reachable-'+width, `(() => {const e=[...document.querySelectorAll('[data-note-editor] textarea')].at(-1).getBoundingClientRect(),p=document.querySelector('.workspace').getBoundingClientRect();return {ok:e.top>=p.top&&e.bottom<=p.bottom,top:e.top,bottom:e.bottom,paperBottom:p.bottom};})()`);
    if(width===800) await check('collapsed-nav-icons', `(() => {const e=document.querySelector('.nav__item'),r=e.getBoundingClientRect(),i=e.querySelector('svg').getBoundingClientRect(),count=e.querySelector('.count-pill');return {ok:i.width>=15&&i.left>=r.left&&i.right<=r.right&&getComputedStyle(count).display==='none',iconWidth:i.width,iconLeft:i.left,buttonLeft:r.left};})()`);
    await shot('notes-'+width+'-actions');
  }
  window.setContentSize(1440,960);await go('inbox');await ev(`document.documentElement.dataset.theme='dark'`);
  await check('github-ink-dark',githubInk);await shot('07-inbox-dark');
  await ev(`document.documentElement.dataset.fx='off'`);
  await check('fx-off-decoration', `(() => {const els=[...document.querySelectorAll('.detail__hud,.brand__orbit')],visible=els.filter(e=>getComputedStyle(e).display!=='none');return {ok:visible.length===0,visible:visible.map(e=>e.className)};})()`);
  await shot('08-inbox-dark-simple');
  const failures=checks.filter(c=>!c.ok);
  fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify({checks,failed:failures.length,passed:checks.length-failures.length},null,2));
  console.log(JSON.stringify({checks:checks.length,failures:failures.length,output}));
  if(failures.length)throw new Error('M35 细节未通过：'+failures.map(c=>c.name).join(', '));
}
module.exports={verify};
if(require.main===module){
  const root=path.resolve(__dirname,'..'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'subscribe-flow-m35-details-'));
  const python=JSON.parse(fs.readFileSync(path.join(root,'.runtime-paths.json'),'utf8')).python;
  const seed=spawnSync(python,[path.join(root,'scripts/seed-m35-details.py'),folder],{encoding:'utf8'});
  if(seed.status!==0){console.error(seed.stderr||seed.stdout);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=1;}
  else {const child=spawn(require('electron'),[root],{env:{...process.env,SUBSCRIBE_FLOW_DATA_DIR:folder,SUBSCRIBE_FLOW_RENDERER_SMOKE:process.argv.includes('--baseline')?'m35':'m35details'},stdio:'inherit'});
    const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
    child.on('close',code=>{clearTimeout(timer);fs.rmSync(folder,{recursive:true,force:true});process.exitCode=code??1;});}
}
