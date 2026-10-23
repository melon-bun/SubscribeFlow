const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 「静流」样式对拍：产品侧取数。
 *
 * 走正式 Renderer（Electron 真进程），逐页打开每个视图，
 * 把关键选择器的计算样式导出成 JSON，交给 scripts/m35-style-parity.cjs
 * 与参考页的导出结果逐项比对。
 *
 * 用法：node scripts/m35-style-probe.cjs
 */
const PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color',
  'backgroundColor', 'backgroundImage', 'borderRadius', 'borderTopWidth', 'borderTopStyle',
  'borderTopColor', 'borderRightWidth', 'borderRightStyle', 'borderRightColor',
  'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor', 'borderLeftWidth',
  'borderLeftStyle', 'borderLeftColor', 'paddingTop', 'paddingRight', 'paddingBottom',
  'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'gap',
  'rowGap', 'columnGap', 'boxShadow', 'opacity', 'display', 'flexDirection',
  'alignItems', 'justifyContent', 'position', 'top', 'right', 'bottom', 'left',
  'inset', 'overflow', 'overflowX', 'overflowY', 'whiteSpace', 'textOverflow',
  'textAlign', 'transform', 'zIndex', 'flex', 'flexWrap', 'flexGrow', 'flexShrink',
  'gridTemplateColumns', 'aspectRatio', 'verticalAlign',
];

/** 每页：参考页选择器 → 产品选择器 → 额外要比的尺寸属性 */
const PAGES = {
  inbox: {
    route: ['inbox', null],
    ready: `document.querySelectorAll('.content-card').length > 0`,
    click: `.content-card`,
    map: [
      ['.app', '.app', []],
      ['.sidebar', '.sidebar', []],
      ['.brand', '.sidebar__brand', []],
      ['.logo', '.brand__mark', ['width', 'height', 'borderRadius']],
      ['.brand b', '.brand__name', []],
      ['.brand small', '.brand__slogan', []],
      ['.nav-item', '.nav__item', ['height']],
      ['.nav-item.on', '.nav__item.is-active', ['height']],
      ['.nav-item .count', '.nav__item.is-active .count-pill--brand', ['height']],
      ['.nav-item.on .count.pill', '.nav__item.is-active .count-pill--brand', ['height']],
      ['.nav-label', '.side-group__title', []],
      ['.pf', '.side-row__icon.plat--bilibili', ['width', 'height', 'borderRadius']],
      ['.pf.sm', '.seg .plat--bilibili', ['width', 'height']],
      ['.sig', '.side-row__icon .prio-sig--high', ['height']],
      ['.sig i', '.side-row__icon .prio-sig--high i', ['width', 'height']],
      ['.prio', '.content-card__meta .prio', []],
      ['.topbar', '.topbar', ['height']],
      ['.search', '.topbar__search', ['height']],
      ['.kbd', '.topbar__search .kbd', ['height']],
      ['.top-right', '.topbar__right', []],
      ['.icon-btn', '.topbar__right .icon-btn', ['width', 'height']],
      ['.avatar', '.topbar__right .avatar', ['width', 'height']],
      ['.sheet', '.workspace', []],
      ['.main', '.main', []],
      ['.page-head', '.view__head', []],
      ['.page-head h3', '.view__title h1', []],
      ['.page-head h3 .count', '.view__title .count-pill', ['height']],
      ['.page-head p', '.view__desc', []],
      ['.page-actions', '.view__actions', []],
      ['.btn', '.view__actions .btn--ghost', ['height']],
      ['.btn-primary', '.view__actions .btn--primary', ['height']],
      ['.btn-secondary', '.view__actions .btn:not(.btn--primary):not(.btn--ghost)', ['height']],
      ['.btn-ghost', '.view__actions .btn--ghost', ['height']],
      ['.btn-ink', '.action-bar .btn--ink', ['height']],
      ['.filters', '.inbox__toolbar', []],
      ['.seg', '.seg', []],
      ['.seg button', '.seg button', ['height']],
      ['.seg button.on', '.seg button.is-active', ['height']],
      ['.seg button .n', '.seg button .n', []],
      ['.select', '.select--btn', ['height']],
      ['.filters .sep', '.filters__sep', ['width', 'height']],
      ['.grid', '.inbox__grid', ['gridTemplateColumns']],
      ['.card', '.content-card.is-selected', ['gridTemplateColumns']],
      ['.card.on', '.content-card.is-selected', []],
      ['.thumb', '.content-card__thumb', ['width', 'height']],
      ['.card h4', '.content-card__title', []],
      ['.card .summary', '.content-card__summary', []],
      ['.meta', '.content-card__meta', []],
      ['.meta .src', '.content-card__author', []],
      ['.meta .dot', '.content-card__dot', ['width', 'height']],
      ['.meta .date', '.content-card__time', []],
      ['.meta .method', '.content-card__method', []],
      ['.card-foot', '.content-card__foot', []],
      ['.card-foot .tag', '.content-card__tags .tag-chip', ['height']],
      ['.card-foot .method', '.content-card__foot .content-card__method', []],
      ['.card-foot .link', '.content-card__link', []],
      ['.check', '.content-selection.is-selected > .check', ['width', 'height']],
      ['.tag', '.content-card__tags .tag-chip', ['height']],
      ['.pager', '.pager', []],
      ['.pager .btn', '.pager .btn', ['height']],
      ['.detail', '.detail', ['width']],
      ['.detail-head', '.detail__head', ['height']],
      ['.detail-head b', '.detail__head b', []],
      ['.detail-head .pos', '.detail__counter', []],
      ['.detail-body', '.detail__body', []],
      ['.hero', '.detail__hero', ['height']],
      ['.detail h5', '.detail__title', []],
      ['.author', '.detail__byline', []],
      ['.author .avatar', '.detail__byline .avatar', ['width', 'height']],
      ['.author b', '.detail__byline-name', []],
      ['.author small', '.detail__byline-time', []],
      ['.readout', '.detail__readout', []],
      ['.readout span', '.detail__readout span', []],
      ['.readout-line', '.fx-readout', []],
      ['.section', '.detail__section', []],
      ['.section-label', '.detail__section-title', []],
      ['.section-label .hint', '.detail__section-hint', []],
      ['.section p', '.detail__summary', []],
      ['.seg.full', '.priority-grid', []],
      ['.tag-row', '.tag-editor__chips', []],
      ['.add-tag', '.tag-editor [data-tag-add]', []],
      ['.link-row', '.detail__link-row', []],
      ['.action-bar', '.action-bar', []],
      ['.state-group', '.state-group', []],
      ['.state-btn', '.state-btn', ['height']],
      ['.input', '.input', ['height']],
      ['.cb', '.check', ['width', 'height']],
      ['.switch', '.switch', ['width', 'height']],
      // 顶部任务条
      ['.task', '.task', []],
      ['.task .lamp', '.task-lamp', ['width', 'height']],
      ['.task .state', '.task-state', []],
      ['.task b', '.task-name', []],
      ['.task .mono', '.task-read', []],
      ['.task .btn', '.task-ops .btn', ['height']],
      ['.task .icon-btn', '.task-ops .icon-btn', ['width', 'height']],
      ['.task .track', '.task-track', []],
    ],
  },
  notes: {
    route: ['notes', null],
    ready: `!!document.querySelector('[data-view="notes"]')`,
    map: [
      ['.notes-wrap', '.notes-layout', []],
      ['.panel', '.panel', []],
      ['.nl-tools', '.notes-toc__tools', []],
      ['.nli', '.notes-toc__item', []],
      ['.nli b', '.notes-toc__title', []],
      ['.nli .meta', '.notes-toc__meta', []],
      ['.nli p', '.notes-toc__excerpt', []],
      ['.nli.on', '.notes-toc__item.is-active', []],
      ['.ed-body', '.notes-reader', []],
      ['.ed-title', '.notes-reader__title', []],
      ['.ed-time', '.notes-reader__meta', []],
      ['.src-card', '.notes-card', []],
      ['.src-card .top', '.notes-card__top', []],
      ['.src-card b', '.notes-card__title', []],
      ['.src-card p', '.notes-card__summary', []],
      ['.ed-sec', '.note-editor', []],
      ['.ed-hint', '.note-editor__hint', []],
      ['.ai-line', '.ai-line', []],
      ['.ai-line i', '.ai-line i', ['width', 'height']],
      ['.ed-foot', '.note-editor__actionbar', []],
      ['.ed-foot .mono', '.note-editor__actionbar .mono', []],
      ['.field', '.note-editor .field', []],
      ['.ta', '.note-editor__input', []],
      ['.caption', '.note-editor .field__hint', []],
      ['.badge', '.notes-toc__meta .badge', ['height']],
    ],
  },
  'ov-cal': {
    route: ['overview', {mode: 'calendar'}],
    ready: `!!document.querySelector('.calendar-grid')`,
    map: [
      ['.stats', '.stat-row', []],
      ['.stat', '.stat', []],
      ['.stat .ic', '.stat__icon', ['width', 'height']],
      ['.stat b', '.stat__value', []],
      ['.stat small', '.stat__label', []],
      ['.stat .share', '.stat__share', []],
      ['.stat .bar', '.stat__bar', []],
      ['.stat .bar i', '.stat__bar > *', []],
      ['.filters', '.overview__filters', []],
      ['.select', '.overview__filters .select', ['height']],
      ['.fchip', '.fchip', ['height']],
      ['.caption', '.legend .caption', []],
      ['.mcal', '.calendar-grid', []],
      ['.mcal .wd', '.calendar-week__cell', []],
      ['.mcal .cell', '.cal-day', ['height']],
      ['.mcal .d', '.cal-day__heading', []],
      ['.mcal .d em', '.cal-day__count', []],
      ['.mcal .ev', '.cal-pill', []],
      ['.mcal .more', '.cal-pill--more', []],
      ['.legend', '.legend', []],
      ['.legend .prio', '.legend .prio', []],
      ['.dli', '.row-card', []],
      ['.dli b', '.row-card__title', []],
      ['.dli .meta', '.row-card__meta', []],
      ['.panel', '.calendar-panel', []],
      ['.panel-head', '.calendar-head', []],
      ['.panel-head h4', '.calendar-head__title', []],
      ['.panel-head p', '.calendar-head__desc', []],
      ['.panel-body', '.calendar-scroll', []],
      ['.panel-foot', '.day-panel__foot', []],
    ],
  },
  'ov-prio': {
    route: ['overview', {mode: 'priority'}],
    ready: `!!document.querySelector('.kanban')`,
    map: [
      ['.stats', '.stat-row', []],
      ['.stat', '.stat', []],
      ['.kb', '.kanban', []],
      ['.kb .col', '.kanban__col', []],
      ['.kb .col-head', '.kanban__head', []],
      ['.kb .col-head .cname', '.kanban__head-name', []],
      ['.kb .col-head .count', '.kanban__head .count-pill--high', []],
      ['.kb .col-sub', '.kanban__head-desc', []],
      ['.kcard', '.kanban__item', []],
      ['.kcard b', '.kanban__item-title', []],
      ['.kcard .meta', '.kanban__item-foot', []],
      ['.kb .col-foot', '.priority-column-foot', []],
      ['.empty', '.kanban__empty', []],
      ['.caption', '.priority-scope', []],
      ['.seg', '.view__actions .seg', []],
      ['.seg button', '.view__actions .seg button', ['height']],
      ['.seg button.on', '.view__actions .seg button.is-active', ['height']],
    ],
  },
  'ch-list': {
    route: ['channels', null],
    ready: `!!document.querySelector('.channels__table-wrap')`,
    map: [
      ['.panel', '.live-panel', []],
      ['table.dt', '.live-channels', []],
      ['.dt th', '.live-channels th', []],
      ['.dt td', '.live-channels td', []],
      ['.dt th:first-child', '.live-channels th:first-child', []],
      ['.dt td:first-child', '.live-channels td:first-child', []],
      ['.who', '.channel-cell', []],
      ['.who .avatar', '.channel-cell .avatar', ['width', 'height']],
      ['.who b', '.channel-cell__name', []],
      ['.who small', '.channel-cell__desc', []],
      ['.cadence b', '.table__time b', []],
      ['.cadence small', '.table__time small', []],
      ['.badge', '.coverage-cell', ['height']],
      ['.badge.warn', '.coverage-cell--limited', []],
      ['.run', '.run-cell', []],
      ['.run i', '.run-cell .status-dot', ['width', 'height']],
      ['.run b', '.run-cell b', []],
      ['.run small', '.run-cell small', []],
      ['.ops', '.table__ops', []],
      ['.switch', '.live-channels .switch', ['width', 'height']],
      ['.btn', '.channels__toolbar .btn', ['height']],
      ['.btn-secondary', '.channels__toolbar .btn', ['height']],
      ['.input', '.search-input .input', ['height']],
      ['.mono', '.channel-cell__desc .mono', []],
    ],
  },
  'ch-prio': {
    route: ['channels', {tab: 'priorities'}],
    ready: `!!document.querySelector('.source-priorities')`,
    map: [
      ['.panel', '.source-priorities', []],
      ['.prow', '.source-priority-row', []],
      ['.who', '.source-priority-row', []],
      ['.who b', '.source-priority-row strong', []],
      ['.who small', '.source-priority-row .muted', []],
      ['.select', '.source-priority-row .select', ['height']],
      ['.sig', '.source-priority-row .prio-sig', ['height']],
      ['.dist', '.dist', []],
      ['.dist i', '.dist i', []],
      ['.mono', '.source-priorities .mono', []],
    ],
  },
  'tg-list': {
    route: ['tags', null],
    ready: `!!document.querySelector('.tags-list')`,
    map: [
      ['.tags-wrap', '.tags-layout', []],
      ['.panel', '.tags-list', []],
      ['.panel-head', '.tags-toolbar', []],
      ['.panel-head h4', '.toolbar__title', []],
      ['.panel-body', '.tags-table-wrap', []],
      ['.panel-foot', '.tags-editor__foot', []],
      ['table.dt', '.table--tags', []],
      ['.dt th', '.table--tags th', []],
      ['.dt td', '.table--tags td', []],
      ['.tag', '.tags-table-wrap .tag-chip', ['height']],
      ['.input', '.tags-toolbar .search-input .input', ['height']],
      ['.select', '.tags-toolbar .select', ['height']],
      ['.btn', '.tags-toolbar .btn', ['height']],
      ['.td-body', '.tags-editor__body', []],
      ['.td-state', '.tags-editor__banner', []],
      ['.group-label', '.tags-editor__section-title', []],
      ['.field', '.tags-editor__body .field', []],
      ['.section-label', '.tags-editor__section-title', []],
      ['.ta', '.tags-editor__body .input', []],
      ['.cdots', '.tags-editor__body .cdots', []],
      ['.preview-row', '.tags-editor__body .tags-field-preview', []],
      ['.tag-row', '.tags-editor__body .tag-row', []],
      ['.meter', '.usage-bar', []],
      ['.meter i', '.usage-bar__fill', []],
      ['.add-tag', '.tags-editor__body .tag-input', []],
      ['.caption', '.tags-editor__body .field__hint', []],
      ['.req', '.tags-editor__body .req', []],
    ],
  },
  'tg-ai': {
    route: ['tags', {tab: 'ai'}],
    ready: `!!document.querySelector('[data-view="tags"]')`,
    map: [
      ['.panel', '.tags-ai .panel', []],
      ['.set-row', '.ai-status__row', []],
      ['.set-row > .lbl b', '.ai-status__name', []],
      ['.set-row > .lbl small', '.ai-status__note', []],
      ['.set-row .ctl', '.ai-status__row .ctl', []],
      ['.opts', '.mode-picker', []],
      ['.opt', '.mode-card', []],
      ['.opt .radio', '.mode-card__mark', ['width', 'height']],
      ['.opt b', '.mode-card__title', []],
      ['.opt small', '.mode-card__desc', []],
      ['.opt .need', '.mode-card .badge', ['height']],
      ['.opt.on', '.mode-card.is-active', []],
      ['.api-line', '.ai-task', []],
      ['.api-line .mono', '.ai-task__note', []],
      ['.api-line .badge', '.ai-task__state', ['height']],
      ['.queue', '.queue', ['height']],
      ['.queue i', '.queue i', []],
      ['.queue-legend', '.queue-legend', []],
      ['.queue-legend span', '.queue-legend span', []],
      ['.badge', '.tags-ai .badge', ['height']],
      ['.switch', '.tags-ai .switch', ['width', 'height']],
      ['.btn', '.tags-ai .btn', ['height']],
      ['.btn-secondary', '.tags-ai .btn', ['height']],
      ['.btn-primary', '.tags-ai .btn--primary', ['height']],
      ['.select', '.tags-ai .select', ['height']],
    ],
  },
};

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
      if (Date.now() - start > timeout) throw new Error('Timed out: ' + expression);
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  };
  const pause = ms => new Promise((resolve) => setTimeout(resolve, ms));

  await until(`SF.app.state.coreStatus && SF.app.state.coreStatus.state === 'ready'`);
  await until(`!!document.querySelector('.shell__body')`);
  await evaluate(`(() => {
    localStorage.setItem('sf.theme', 'light');
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.setAttribute('data-fx', 'on');
    SF.app.state.fx = true;
    SF.app.render();
  })()`);
  await pause(500);

  const out = {};
  for (const [name, cfg] of Object.entries(PAGES)) {
    const [route, params] = cfg.route;
    const args = params ? `, ${JSON.stringify(params)}` : '';
    await evaluate(`SF.app.navigate('${route}'${args})`);
    await until(`SF.app.state.route.name === '${route}'`);
    await until(`!!document.querySelector('[data-view="${route}"]')`);
    if (cfg.ready) await until(cfg.ready);
    if (cfg.click) {
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(cfg.click)}); if (el) el.click(); })()`);
      await pause(600);
    }
    await pause(900);

    const page = await evaluate(`(() => {
      const MAP = ${JSON.stringify(cfg.map)};
      const PROPS = ${JSON.stringify(PROPS)};
      const res = {};
      for (const [refSel, appSel, sizeProps] of MAP) {
        const el = document.querySelector(appSel);
        if (!el) { res[refSel] = {missing: appSel}; continue; }
        const cs = getComputedStyle(el);
        const props = {};
        for (const p of PROPS) props[p] = cs[p];
        const rect = el.getBoundingClientRect();
        props.width = Math.round(rect.width * 100) / 100 + 'px';
        props.height = Math.round(rect.height * 100) / 100 + 'px';
        res[refSel] = props;
      }
      return res;
    })()`);
    out[name] = page;
    console.log('[m35probe] ' + name + ' 取数 ' + Object.values(page).filter(v => !v.missing).length + '/' + Object.keys(page).length);
  }

  const outFile = process.env.SUBSCRIBE_FLOW_STYLE_OUT || path.join(root, 'docs/verification/phase51/m35/product-styles.json');
  fs.mkdirSync(path.dirname(outFile), {recursive: true});
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log('[m35probe] 产品侧样式 ->', outFile);
}

module.exports = {verify};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const child = spawn(require('electron'), [root], {
    env: {...process.env, SUBSCRIBE_FLOW_RENDERER_SMOKE: 'm35style'},
    stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
  child.on('close', code => {
    clearTimeout(timer);
    process.exitCode = code ?? 1;
  });
}
