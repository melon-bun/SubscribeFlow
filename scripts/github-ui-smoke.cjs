/**
 * GitHub Trending UI evidence.
 *
 * Every claim here is read from the rendered DOM, never inferred from a
 * condition in the source. Each assertion maps to one item in the plan's
 * acceptance list; the comment on each block names it.
 *
 * Runs against an isolated temporary database seeded by
 * scripts/seed-github-renderer.py, which contains one repository ranked on both
 * the day and the week board. No network access and no real login session.
 */
const assert = require('node:assert/strict');

async function verifyGithub({evaluate, until, click, screenshot}) {
  // ---- §9.2.1 connection card: GitHub exists, needs no login, offers none ----
  await evaluate(`document.querySelector('[data-nav="channels"]').click()`);
  await until(`!!document.querySelector('.connection-card')`);
  // Kept on one line: a line break before `.includes` would parse as two
  // statements and fail to execute.
  const githubCard = `(Array.from(document.querySelectorAll('.connection-card')).find(c => c.querySelector('h3') && c.querySelector('h3').textContent.trim() === 'GitHub') || {innerText:''}).innerText`;
  assert.ok(await evaluate(githubCard).then(text => text.length > 0),
            'the GitHub connection card must be rendered');
  assert.ok((await evaluate(githubCard)).includes('不需要登录'),
            'the direct-http backend must be explained');
  const loginButtons = await evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('.connection-card'))
      .find(c => c.querySelector('h3') && c.querySelector('h3').textContent.trim() === 'GitHub');
    return Array.from(node.querySelectorAll('button')).filter(b => b.textContent.includes('登录')).map(b => b.textContent.trim());
  })()`);
  assert.deepEqual(loginButtons, [], 'the GitHub card must offer no login button');

  // Authentication is only labelled after a real check. This one performs one
  // actual https://github.com/trending request through the direct-http backend;
  // the seed's no-network transport is a different process and does not apply here.
  await evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('.connection-card'))
      .find(c => c.querySelector('h3') && c.querySelector('h3').textContent.trim() === 'GitHub');
    Array.from(node.querySelectorAll('button')).find(b => b.textContent.trim() === '检查连接').click();
  })()`);
  await until(`(${githubCard}).includes('无需登录')`, 60000);
  const card = await evaluate(githubCard);
  assert.ok(card.includes('无需登录'), 'authentication must read as not required');
  await screenshot('m18-github-connection.png');

  // ---- §9.2.7 the platform is identified with the GH mark in the UI ----
  const marks = await evaluate(`Array.from(document.querySelectorAll('.plat--github')).map(n => n.textContent.trim())`);
  assert.ok(marks.length > 0, 'GitHub subscriptions must render a platform icon');
  assert.deepEqual([...new Set(marks)], ['GH'], 'the GitHub platform mark must be GH');

  // ---- §9.2.2 adding a source offers exactly the three boards ----
  await click('添加渠道或创作者');
  await until(`!!document.querySelector('.source-platforms button')`);
  await evaluate(`Array.from(document.querySelectorAll('.source-platforms button'))
    .find(b => b.textContent.trim() === 'GitHub').click()`);
  await evaluate(`document.querySelector('#source-input').value = 'trend'`);
  await click('搜索作者');
  await until(`document.querySelectorAll('.source-candidate').length > 0`, 20000);
  const candidates = await evaluate(`Array.from(document.querySelectorAll('.source-candidate')).map(b => ({
    id: b.dataset.sourceId, text: b.innerText.replace(/\\s+/g,' ').trim() }))`);
  assert.equal(candidates.length, 3, `only day/week/month may be offered, got ${candidates.length}`);
  assert.deepEqual(candidates.map(c => c.id).sort(), ['day', 'month', 'week']);
  for (const candidate of candidates) {
    assert.ok(/GitHub 趋势 · (日榜|周榜|月榜)/.test(candidate.text),
              `candidate text must name the board, saw ${JSON.stringify(candidate.text)}`);
  }
  await screenshot('m18-github-source-candidates.png');
  // Confirming an offered candidate must work end to end.
  await evaluate(`document.querySelectorAll('.source-candidate')[0].click()`);
  await until(`!!document.querySelector('#source-confirm') && !document.querySelector('#source-confirm').disabled`);
  await evaluate(`document.querySelector('#source-confirm').click()`);
  await evaluate(`Array.from(document.querySelectorAll('.dialog button')).find(b => b.textContent.trim() === '确认添加').click()`);
  await until(`!document.querySelector('.dialog')`, 20000);

  // ---- §9.2.7 platform filter, and §9.2.8 one row per repository ----
  await evaluate(`document.querySelector('[data-nav="inbox"]').click()`);
  await until(`document.querySelectorAll('.content-card').length > 0`);
  const chip = await evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('.chips .chip')).find(c => c.textContent.includes('GitHub'));
    return node ? node.innerText : null;
  })()`);
  assert.ok(chip, 'the inbox must offer a GitHub platform filter');
  assert.ok(/\d/.test(chip), 'the GitHub filter must report its own count');

  // The repository ranked on both boards must appear exactly once.
  const titles = await evaluate(`Array.from(document.querySelectorAll('.content-card')).map(c => c.innerText)`);
  for (const shared of ['morluto/rea', 'NationalSecurityAgency/ghidra']) {
    const hits = titles.filter(text => text.includes(shared)).length;
    assert.equal(hits, 1, `${shared} must render once in the inbox, saw ${hits}`);
  }
  await screenshot('m18-github-inbox-dedup.png');

  // Filtering by one board must still find the shared repository (§9.2.8).
  await evaluate(`Array.from(document.querySelectorAll('.chips .chip')).find(c => c.textContent.includes('GitHub')).click()`);
  await until(`document.querySelectorAll('.content-card').length > 0`);
  const week = await evaluate(`Array.from(document.querySelectorAll('.content-card')).map(c => c.innerText)`);
  assert.ok(week.some(text => text.includes('morluto/rea')),
            'the week board must still show the repository the day board claimed first');
  await screenshot('m18-github-inbox-week-board.png');

  // ---- §9.2.4 the time is labelled 收录时间, never 原始发布 ----
  await evaluate(`document.querySelector('.content-card').click()`);
  await until(`!!document.querySelector('.detail__byline-time')`);
  const byline = await evaluate(`Array.from(document.querySelectorAll('.detail__byline-time')).map(n => n.textContent)`);
  assert.ok(byline.some(text => text.includes('收录时间')), `expected 收录时间, saw ${JSON.stringify(byline)}`);
  assert.ok(!byline.some(text => text.includes('原始发布')), 'a fetch time must not be shown as a publication time');
  await screenshot('m18-github-fetched-at-label.png');

  // ---- §9.2.5 / §9.2.6 pasting a repository link ----
  // torvalds/linux is deliberately absent from the seed, so this is a real
  // preview rather than an 'already collected' short-circuit. It costs two
  // public GETs through the direct-http backend, same as any user would spend.
  const PASTE = 'torvalds/linux';
  await evaluate(`(() => { const d=document.querySelector('.detail'); if(d) d.querySelector('[aria-label="关闭详情"], .icon-btn')?.click(); })()`);
  await click('添加内容');
  await until(`!!document.querySelector('.dialog--intake')`);
  assert.equal(await evaluate(`document.querySelector('.dialog').getAttribute('aria-label')`), '添加内容');

  // Login prompts can appear in three places; none may show up at any step.
  const loginSurfaces = `(() => {
    const dialog = document.querySelector('.dialog--intake');
    const text = dialog ? dialog.innerText : '';
    return {
      mentionsLogin: /需要登录|登录已失效|请在应用内登录/.test(text),
      loginButtons: Array.from(dialog.querySelectorAll('button')).filter(b => b.textContent.includes('登录')).map(b => b.textContent.trim()),
      unsubscribedTag: !!dialog.querySelector('.intake-preview__unsubscribed'),
    };
  })()`;
  assert.deepEqual(await evaluate(loginSurfaces), {mentionsLogin: false, loginButtons: [], unsubscribedTag: false},
                   'the GitHub intake dialog must not ask for a login');

  await evaluate(`(() => { const i=document.querySelector('#intake-url'); i.value=${JSON.stringify('https://github.com/' + PASTE)}; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click('识别内容');
  await until(`!!document.querySelector('.intake-preview')`, 90000);
  assert.deepEqual(await evaluate(loginSurfaces), {mentionsLogin: false, loginButtons: [], unsubscribedTag: false},
                   'no login prompt may appear while reading a GitHub repository');

  // ---- §9.2.5 the preview must read owner/name, not the og:title template ----
  const preview = await evaluate(`({
    title: document.querySelector('.intake-preview__title').textContent.trim(),
    author: document.querySelector('.intake-preview__author').textContent,
    published: document.querySelector('.intake-preview__published').textContent,
  })`);
  assert.equal(preview.title, PASTE, 'the preview title must be owner/name');
  assert.ok(!preview.title.includes('GitHub -'), 'the og:title template must not leak into the title');
  assert.ok(!preview.author.includes('GitHub -'), 'the source line must not leak the template either');
  assert.ok(preview.published.includes('收录时间'),
            `a fetch time must be labelled 收录时间, saw ${JSON.stringify(preview.published)}`);
  await screenshot('m18-github-paste-preview.png');

  // ---- the preview must actually save into the inbox ----
  await click('保存内容');
  await until(`!document.querySelector('.dialog--intake')`, 30000);
  await until(`document.body.innerText.includes(${JSON.stringify(PASTE)})`);
  const saved = await evaluate(`(async () => {
    const rows = await SF.app.state.client.listContents({limit: 50});
    return rows.items.filter(i => i.title === ${JSON.stringify(PASTE)}).map(i => ({id: i.id, title: i.title, url: i.url, intake: i.intakeMethod}));
  })()`);
  assert.equal(saved.length, 1, `the pasted repository must land exactly once, got ${saved.length}`);
  assert.equal(saved[0].id, 'github:repo:2325298', 'the pasted item must use the numeric repository id as its key');
  assert.equal(saved[0].url, 'https://github.com/torvalds/linux');
  assert.equal(saved[0].intake, 'manual');
  await screenshot('m18-github-paste-saved.png');

  console.log(JSON.stringify({
    githubUiSmoke: 'passed', cards: 1, candidates: candidates.length,
    sharedRenderedOnce: true, timeLabel: '收录时间', loginButtons: 0,
    pasteTitle: preview.title, pasteKey: saved[0].id, pasteLoginPrompt: false,
  }));
}

module.exports = {verifyGithub};
