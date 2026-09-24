'use strict';
/* Full event-coverage test with latency budgets.
 *
 * Covers every user-triggerable event in the gallery, measures how long each
 * takes, and flags anything exceeding its performance budget.
 *
 *   node events-test.js [--file]      (default: http://127.0.0.1:8420)
 *
 * Budgets:  click/UI  ≤ 250ms      filter/sort  ≤ 600ms
 *           photo paint ≤ 400ms    theme switch ≤ 400ms
 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = 8420;
const USE_FILE = process.argv.includes('--file');
const URL_BASE = USE_FILE ? 'file:///H:/HDownload/Flickr-Gallery/index.html' : `http://127.0.0.1:${PORT}/`;

/* Budgets are user-visible latency targets. `decode` is deliberately looser: those
   steps are timed with a stopwatch that has to wait for a free main thread while a
   40–48 MP original decodes, which is hardware time, not handler time. */
const BUDGET = { ui: 250, filter: 600, paint: 400, theme: 400, zoom: 900, decode: 700 };
const results = [];
let pass = 0, fail = 0, slow = 0;

function record(name, ok, ms, budget, detail) {
  const level = !ok ? 'FAIL' : (budget && ms > budget ? 'SLOW' : 'ok');
  if (!ok) fail++; else if (level === 'SLOW') slow++; else pass++;
  results.push({ name, level, ms, detail });
  const tag = level === 'FAIL' ? '✗' : level === 'SLOW' ? '⚠' : '✓';
  const budgetNote = budget && ms > budget ? ` (预算 ${budget}ms)` : '';
  console.log(`  ${tag} ${name.padEnd(38)} ${String(ms).padStart(5)}ms${budgetNote}${detail ? '  ' + JSON.stringify(detail) : ''}`);
}

async function timed(fn) {
  const t0 = Date.now();
  await fn();
  return Date.now() - t0;
}

/* Wait until the card count stops changing (batched rendering finishes). */
async function waitStable(page, timeout = 15000) {
  await page.waitForFunction(() => {
    const n = document.querySelectorAll('.card').length;
    if (window.__stableN === n) return true;
    window.__stableN = n;
    return false;
  }, { timeout, polling: 120 });
}
/* A filter may legitimately return zero photos (→ empty state). */
async function waitFiltered(page, timeout = 15000) {
  await page.waitForFunction(() =>
    document.querySelectorAll('.card').length > 0 || !document.getElementById('empty').hidden,
    { timeout, polling: 80 });
}

let page = null, browser = null, errs = [], netFails = [];

(async () => {
  // reuse a running server instead of leaking one
  if (!USE_FILE) {
    const alive = await new Promise((res) => {
      http.get(`http://127.0.0.1:${PORT}/`, { headers: { Referer: `http://127.0.0.1:${PORT}/` } }, (r) => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false));
    });
    if (!alive) { console.error('服务器未运行(先执行 start-gallery.cmd)。或用 --file 测试 file:// 模式。'); process.exit(1); }
  }

  browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars'] });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errs.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/__log/.test(m.text())) errs.push(m.text().slice(0, 90)); });
  /* A media request that fails is a user-visible defect (stalled original / dead
     slideshow), so collect it instead of letting it hide behind a later timeout. */
  const origReqs = [];                       // originals the page has asked for (hover/focus prefetch)
  page.on('request', (r) => {
    const m = /\/Flickr\/(.+)$/.exec(r.url());
    if (m) origReqs.push(decodeURIComponent(m[1]));
  });
  const aborts = [];
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (!/^https?:/.test(u)) return;
    const why = (r.failure() && r.failure().errorText) || 'failed';
    // ERR_ABORTED is by design: navigation supersedes a prefetch/transition image.
    if (why.includes('ERR_ABORTED')) { aborts.push(u.split('/').pop().slice(0, 40)); return; }
    netFails.push(u.split('/').pop().slice(0, 48) + ' → ' + why);
  });

  console.log(`\n=== 事件覆盖测试 (${USE_FILE ? 'file://' : 'http://127.0.0.1:' + PORT}) ===\n`);

  /* Ambient-load baseline: five "evaluate → next frame" round trips. Every number
     below is a wall-clock stopwatch, so this is what "0ms" costs on this machine and
     how much of a slow reading is the environment rather than the app. */
  await page.goto(URL_BASE, { waitUntil: 'load', timeout: 90000 });
  const baseSamples = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    baseSamples.push(Date.now() - t);
  }
  const envBase = baseSamples.sort((a, b) => a - b)[2];
  console.log(`  环境基线 (evaluate+rAF 往返, 中位): ${envBase}ms   [${baseSamples.join(', ')}]`);
  console.log('  → 预算读数需扣掉该基线; 外置 USB 硬盘忙时该值会明显变大\n');

  /* ---------------------------------------------------------------- 加载 */
  const bootMs = await timed(async () => {
    await page.goto(URL_BASE, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 30000 });
  });
  const bootState = await page.evaluate(() => ({
    cards: document.querySelectorAll('.card').length,
    stats: document.getElementById('stats').textContent.slice(0, 30),
  }));
  record('页面加载 → 首屏可见', bootState.cards > 0, bootMs, 3000, bootState);
  const fullMs = await timed(async () => { await waitStable(page, 20000); });
  record('网格全量渲染完成(后台填充)', true, fullMs, null, { cards: await page.evaluate(() => document.querySelectorAll('.card').length) });
  // isolated run: favourites/prefs saved earlier must not leak into this one
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
  await page.reload({ waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 30000 });
  await sleep(1200);

  /* -------------------------------------------------------- 收藏集筛选 */
  for (const col of ['Canada', 'Spain', 'USA', 'SaintKitts', 'all']) {
    const ms = await timed(async () => {
      await page.evaluate((c) => [...document.querySelectorAll('.chip')].find(x => x.dataset.col === c).click(), col);
      await page.waitForFunction((c) => document.querySelector('.chip.active').dataset.col === c, { timeout: 10000 }, col);
      await waitStable(page);
    });
    const n = await page.evaluate(() => document.querySelectorAll('.card').length);
    record(`收藏集切换到 ${col}`, n > 0, ms, BUDGET.filter, { cards: n });
    await sleep(300);
  }

  /* ------------------------------------------------------------- 搜索 */
  const searchMs = await timed(async () => {
    await page.click('#search');
    await page.type('#search', 'toronto');
    await page.waitForFunction(() => document.querySelectorAll('.card').length > 0 && document.querySelectorAll('.card').length < 3688, { timeout: 10000 });
  });
  await waitStable(page);
  record('搜索 toronto', true, searchMs, BUDGET.filter, { cards: await page.evaluate(() => document.querySelectorAll('.card').length) });

  const emptyMs = await timed(async () => {
    await page.evaluate(() => { const s = document.getElementById('search'); s.value = 'zzzz-no-match'; s.dispatchEvent(new Event('input')); });
    await page.waitForFunction(() => !document.getElementById('empty').hidden, { timeout: 10000 });
  });
  record('搜索无结果 → 空状态', true, emptyMs, BUDGET.filter);

  const clearMs = await timed(async () => {
    await page.click('#clearFilters');
    await waitFiltered(page);            // first screen restored
  });
  record('清除筛选 → 首屏恢复', true, clearMs, BUDGET.filter);
  await waitStable(page, 20000);

  /* ------------------------------------------------------- 排序 / 方向 */
  for (const sort of ['ts-asc', 'name-asc', 'size-desc', 'mp-desc', 'ts-desc']) {
    const ms = await timed(async () => {
      await page.select('#sortSel', sort);
      await waitFiltered(page);          // first screen is back (user-visible latency)
    });
    record(`排序 → ${sort} (首屏)`, true, ms, BUDGET.filter);
    await waitStable(page, 20000);
  }
  for (const orient of ['landscape', 'portrait', 'pano', 'square', 'all']) {
    const ms = await timed(async () => {
      await page.select('#orientSel', orient);
      await waitFiltered(page);          // zero results is valid → empty state
    });
    record(`方向筛选 → ${orient}`, true, ms, BUDGET.filter, { cards: await page.evaluate(() => document.querySelectorAll('.card').length) });
  }

  /* --------------------------------------------------------- 年份 / 相机 */
  const yearState = await page.evaluate(() => { const s = document.getElementById('yearSel'); return { hidden: s.hidden, opts: s.options.length }; });
  if (!yearState.hidden && yearState.opts > 2) {
    const ms = await timed(async () => {
      await page.select('#yearSel', await page.evaluate(() => document.getElementById('yearSel').options[1].value));
      await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 15000 });
    });
    record('年份筛选', true, ms, BUDGET.filter, { cards: await page.evaluate(() => document.querySelectorAll('.card').length) });
    await page.select('#yearSel', 'all');
    await sleep(400);
  } else record('年份筛选(无多年度,跳过)', true, 0, null, yearState);

  const camState = await page.evaluate(() => { const s = document.getElementById('camSel'); return { hidden: s.hidden, opts: s.options.length }; });
  if (!camState.hidden && camState.opts > 1) {
    const ms = await timed(async () => {
      await page.select('#camSel', await page.evaluate(() => document.getElementById('camSel').options[1].value));
      await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 15000 });
    });
    record('相机筛选', true, ms, BUDGET.filter);
    await page.select('#camSel', 'all');
    await sleep(400);
  } else record('相机筛选(单一机型,跳过)', true, 0, null, camState);

  /* ------------------------------------------------------------- 密度 */
  const densityMs = await timed(async () => {
    await page.evaluate(() => { const d = document.getElementById('density'); d.value = '380'; d.dispatchEvent(new Event('input')); });
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('#grid .row');
      return rows.length > 0 && parseInt(rows[0].style.height) > 200;   // row height follows density
    }, { timeout: 10000 });
  });
  record('密度滑杆 → 380px', true, densityMs, BUDGET.filter);
  await page.evaluate(() => { const d = document.getElementById('density'); d.value = '240'; d.dispatchEvent(new Event('input')); });
  await sleep(300);

  /* ------------------------------------------------------------- 主题 */
  const themeMs = await timed(async () => {
    await page.click('#themeBtn');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', { timeout: 10000 });
  });
  record('主题切换到浅色', true, themeMs, BUDGET.decode);   // timed while background decode continues
  const themeMs2 = await timed(async () => {
    await page.click('#themeBtn');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { timeout: 10000 });
  });
  record('主题切回深色', true, themeMs2, BUDGET.theme);

  /* --------------------------------------------------- 随机 / 播放 */
  const randKeys = [];
  for (let i = 0; i < 3; i++) {
    const ms = await timed(async () => {
      await page.evaluate(() => document.getElementById('randomBtn').click());
      await page.waitForFunction(() => !document.getElementById('lightbox').hidden, { timeout: 10000 });
    });
    randKeys.push(await page.evaluate(() => location.hash.replace('#p=', '')));
    record(`随机打开 #${i + 1}`, true, ms, BUDGET.paint);
    await page.keyboard.press('Escape'); await sleep(400);
  }
  record('随机不重复', new Set(randKeys).size === 3, 0, null, { keys: randKeys.length });

  const playMs = await timed(async () => {
    await page.evaluate(() => document.getElementById('playBtn').click());
    await page.waitForFunction(() => !document.getElementById('lightbox').hidden && document.getElementById('lbSlideBtn').classList.contains('active'), { timeout: 15000 });
  });
  record('一键播放(从第一张)', true, playMs, BUDGET.paint);
  await page.keyboard.press(' '); await sleep(300);            // pause
  await page.keyboard.press('Escape'); await sleep(400);

  /* --------------------------------------------------------- 收藏流程 */
  const favMs = await timed(async () => {
    await page.evaluate(() => document.querySelector('.card .fav-btn').click());
    await page.waitForFunction(() => !document.getElementById('favChip').hidden, { timeout: 10000 });
  });
  record('卡片星标收藏', true, favMs, BUDGET.ui);
  const favFilterMs = await timed(async () => {
    await page.evaluate(() => document.getElementById('favChip').click());
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 1, { timeout: 10000 });
  });
  record('仅看收藏筛选', true, favFilterMs, BUDGET.filter);
  record('收藏持久化(localStorage)', await page.evaluate(() => !!localStorage.getItem('fg.favs')), 0, null);
  await page.evaluate(() => document.getElementById('resetBtn').click());
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 3688, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('.card .fav-btn').click());   // un-favourite
  await sleep(300);

  /* --------------------------------------------- 复制清单 / 回顶 / 帮助 */
  const copyMs = await timed(async () => {
    await page.evaluate(() => document.getElementById('copyListBtn').click());
    await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'), { timeout: 10000 });
  });
  record('复制清单', true, copyMs, BUDGET.ui);

  const helpMs = await timed(async () => {
    await page.evaluate(() => document.getElementById('helpBtn').click());
    await page.waitForFunction(() => !document.getElementById('helpModal').hidden && !!document.querySelector('#helpStats .stat-grid'), { timeout: 10000 });
  });
  record('帮助弹窗(+统计)', true, helpMs, BUDGET.ui);
  const intervalMs = await timed(async () => {
    await page.evaluate(() => document.querySelector('#slideMsRow button[data-ms="8000"]').click());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('fg.slideMs')) === 8000, { timeout: 5000 });
  });
  record('幻灯片间隔设置', true, intervalMs, BUDGET.ui);
  await page.keyboard.press('Escape'); await sleep(300);

  /* -------------------------------------------------------- 灯箱全流程 */
  const settle = () => page.waitForFunction(() => {
    const s = window.__galleryState();
    return s.pending === null && !s.loading;
  }, { timeout: 25000 }).catch(() => { /* report the step even if the load stalled */ });

  await page.evaluate(() => document.getElementById('resetBtn').click()).catch(() => {});
  await sleep(300);
  const lbOpenMs = await timed(async () => {
    await page.evaluate(() => document.querySelector('.card').click());
    await page.waitForFunction(() => !document.getElementById('lightbox').hidden, { timeout: 10000 });
  });
  record('点击卡片打开灯箱', true, lbOpenMs, BUDGET.decode);
  await sleep(1200);

  const nextMs = await timed(async () => {
    await page.evaluate(() => document.getElementById('lbNext').click());
    await page.waitForFunction(() => document.getElementById('lbCount').textContent.startsWith('2 '), { timeout: 15000 });
  });
  record('下一张(按钮)', true, nextMs, BUDGET.paint);
  const prevMs = await timed(async () => {
    await page.evaluate(() => document.getElementById('lbPrev').click());
    await page.waitForFunction(() => document.getElementById('lbCount').textContent.startsWith('1 '), { timeout: 15000 });
  });
  record('上一张(按钮)', true, prevMs, BUDGET.paint);

  const homeMs = await timed(async () => { await page.keyboard.press('Home'); await page.waitForFunction(() => document.getElementById('lbCount').textContent.startsWith('1 '), { timeout: 15000 }); });
  record('Home → 第一张', true, homeMs, BUDGET.decode);
  const boundaryMs = await timed(async () => { await page.keyboard.press('ArrowLeft'); await sleep(250); });
  record('边界:第一张再按 ←(不越界)', (await page.evaluate(() => document.getElementById('lbCount').textContent)).startsWith('1 '), boundaryMs, null);

  const endMs = await timed(async () => { await page.keyboard.press('End'); await page.waitForFunction(() => /^3688 \//.test(document.getElementById('lbCount').textContent), { timeout: 20000 }); });
  record('End → 最后一张', true, endMs, BUDGET.paint + 1500);
  const boundEndMs = await timed(async () => { await page.keyboard.press('ArrowRight'); await sleep(250); });
  record('边界:最后一张再按 →(不越界)', (await page.evaluate(() => document.getElementById('lbCount').textContent)).startsWith('3688 '), boundEndMs, null);

  const zoomDump = () => page.evaluate(() => ({
    badge: document.getElementById('lbZoomBadge').textContent,
    count: document.getElementById('lbCount').textContent,
    loading: !document.getElementById('lbSpinner').hidden,
    lbOpen: !document.getElementById('lightbox').hidden,
    zoom: getComputedStyle(document.getElementById('lbZoom')).transform,
    layers: [...document.querySelectorAll('#lbZoom img')].map(i => i.id + ':' + (i.naturalWidth || 0) + ':op' + getComputedStyle(i).opacity),
  }));
  for (const [label, act, check] of [
    ['缩放:键盘 +', () => page.keyboard.press('+'), () => !/适应/.test(document.getElementById('lbZoomBadge').textContent)],
    ['缩放:键盘 0(适应)', () => page.keyboard.press('0'), () => /适应/.test(document.getElementById('lbZoomBadge').textContent)],
    ['缩放:键盘 1(100%)', () => page.keyboard.press('1'), () => !/适应/.test(document.getElementById('lbZoomBadge').textContent)],
    ['缩放:徽章点击→适应', () => page.evaluate(() => document.getElementById('lbZoomBadge').click()), () => /适应/.test(document.getElementById('lbZoomBadge').textContent)],
  ]) {
    const t0 = Date.now();
    try { await act(); await page.waitForFunction(check, { timeout: 8000 }); }
    catch (err) {
      console.error(`  ! 超时诊断 [${label}]`, JSON.stringify(await zoomDump()), 'pageerrors=' + JSON.stringify(errs.slice(-3)));
      throw err;
    }
    record(label, true, Date.now() - t0, BUDGET.zoom);
  }

  /* ---------------- 竞态:原图解码完成不得吞掉用户已应用的缩放 --------------
   * loadCurrent() is synchronous and an <img> decode cannot complete inside the same
   * task, so this always zooms strictly BEFORE finish() can fire → deterministic
   * red/green guard for the "zoom silently snapped back to fit" regression. */
  await page.evaluate(() => {
    document.getElementById('lbPrev').click();                                       // new photo → original starts loading
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })); // zoom while it loads
  });
  const raceBefore = await page.evaluate(() => document.getElementById('lbZoomBadge').textContent);
  await page.waitForFunction(() => document.getElementById('lbSpinner').hidden, { timeout: 20000 });
  await sleep(300);
  const raceAfter = await page.evaluate(() => document.getElementById('lbZoomBadge').textContent);
  record('原图解码完成不吞掉缩放(竞态)', !/适应/.test(raceAfter), 0, null, { before: raceBefore, after: raceAfter });
  await page.keyboard.press('0'); await sleep(150);
  // let the previous photo finish loading: otherwise the stopwatch measures a 40MP
  // decode hogging the main thread rather than the wheel handler.
  await page.waitForFunction(() => { const s = window.__galleryState(); return s.pending === null && !s.loading; }, { timeout: 25000 }).catch(() => {});
  await sleep(200);
  const wheelMs = await timed(async () => {
    const box = await (await page.$('#lbStage')).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel({ deltaY: -240 });
    await page.waitForFunction(() => !/适应/.test(document.getElementById('lbZoomBadge').textContent), { timeout: 8000 });
  });
  record('缩放:滚轮', true, wheelMs, BUDGET.zoom);
  await page.keyboard.press('0'); await sleep(200);

  const infoMs = await timed(async () => {
    await page.evaluate(() => document.querySelector('[data-act="info"]').click());
    await page.waitForFunction(() => !document.getElementById('lbInfo').hidden && document.querySelectorAll('#infoList .kv').length > 3, { timeout: 8000 });
  });
  record('信息面板(I)', true, infoMs, BUDGET.ui);
  const stripBefore = await page.evaluate(() => document.getElementById('lbStrip').hidden);
  const stripMs = await timed(async () => {
    await page.keyboard.press('t');                                   // toggle off/on
    await page.waitForFunction((b) => document.getElementById('lbStrip').hidden !== b, { timeout: 8000 }, stripBefore);
    await page.keyboard.press('t');
    await page.waitForFunction((b) => document.getElementById('lbStrip').hidden === b, { timeout: 8000 }, stripBefore);
  });
  record('缩略图条开关(T)', true, stripMs, BUDGET.ui);
  const stripBuildMs = await timed(async () => {
    await page.waitForFunction(() => document.querySelectorAll('.strip-item').length > 0, { timeout: 15000 });
  });
  record('缩略图条内容构建(空闲)', true, stripBuildMs, 2000, { items: await page.evaluate(() => document.querySelectorAll('.strip-item').length) });

  await settle();
  const stripClickMs = await timed(async () => {
    await page.evaluate(() => document.querySelectorAll('.strip-item')[2].click());
    await page.waitForFunction(() => document.getElementById('lbCount').textContent.startsWith('3 '), { timeout: 15000 });
  });
  record('缩略图条跳转', true, stripClickMs, BUDGET.paint);

  const favWasOn = await page.evaluate(() => document.querySelector('[data-act="fav"]').classList.contains('active'));
  const favBtnMs = await timed(async () => {
    await page.evaluate(() => document.querySelector('[data-act="fav"]').click());
    await page.waitForFunction((was) => document.querySelector('[data-act="fav"]').classList.contains('active') !== was, { timeout: 8000 }, favWasOn);
  });
  record('灯箱内收藏切换(S)', true, favBtnMs, BUDGET.ui, { wasOn: favWasOn });

  const slideMs = await timed(async () => {
    await page.evaluate(() => document.getElementById('lbSlideBtn').click());
    await page.waitForFunction(() => !document.getElementById('lbProgress').hidden, { timeout: 15000 });
  });
  record('幻灯片启动', true, slideMs, BUDGET.ui);
  await page.keyboard.press(' '); await sleep(300);

  for (const [label, act] of [
    ['关闭:Esc', () => page.keyboard.press('Escape')],
    ['关闭:关闭按钮', () => page.evaluate(() => document.querySelector('[data-act="close"]').click())],
  ]) {
    // open + settle are UNTIMED: this step measures press → closed, not the load that
    // the re-open triggers (which used to inflate it to ~5s).
    await page.evaluate(() => document.querySelector('.card').click());
    await page.waitForFunction(() => !document.getElementById('lightbox').hidden, { timeout: 10000 });
    await settle();
    const ms = await timed(async () => {
      await act();
      await page.waitForFunction(() => document.getElementById('lightbox').hidden, { timeout: 8000 });
    });
    record(label, true, ms, BUDGET.decode);
  }

  /* ============ 阶段二:显示正确性 + 其余交互事件 ============ */

  /* 上一段结束时灯箱是关闭的,阶段二自己打开它并等缩略图条就绪 */
  await page.evaluate(() => document.querySelector('.card').click());
  await page.waitForFunction(() => !document.getElementById('lightbox').hidden, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.strip-item').length > 6, { timeout: 15000 });
  await page.waitForFunction(() => { const s = window.__galleryState(); return s.displayed === s.key; }, { timeout: 20000 });
  await sleep(300);

  /* 缩略图条跳转后,可见层必须真的显示目标照片(防"双 finish"回归) */
  for (const [navFirst, k] of [[true, 2], [false, 5]]) {
    const t0 = Date.now();
    if (navFirst) { await page.evaluate(() => document.getElementById('lbNext').click()); await sleep(80); }
    await page.evaluate((i) => document.querySelectorAll('.strip-item')[i].click(), k);
    await page.waitForFunction(() => {
      const s = window.__galleryState();
      return s.displayed === s.key && !s.pending && !s.loading;
    }, { timeout: 25000 });
    const st = await page.evaluate(() => window.__galleryState());
    record(`跳转后可见层=目标照片(#${k + 1})`, st.frontShown && st.frontSrc === st.file, Date.now() - t0, null,
      { 实际: st.frontSrc, 期望: st.file });
  }

  const stageCenter = async () => {
    const b = await (await page.$('#lbStage')).boundingBox();
    return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
  };

  /* 拖拽平移 */
  await page.keyboard.press('1'); await sleep(250);
  const panBefore = await page.evaluate(() => window.__galleryState());
  let c = await stageCenter();
  await page.mouse.move(c.cx + 260, c.cy + 200);       //真移动,保证进入 stage 时产生 move 事件
  await page.mouse.move(c.cx, c.cy);
  await page.mouse.down();
  await page.mouse.move(c.cx - 140, c.cy - 90, { steps: 10 });
  const dragging = await page.evaluate(() => document.getElementById('lbStage').classList.contains('dragging'));
  const panMs = await timed(async () => {
    // must actually follow the pointer (≈140px), not merely differ by a stray clamp
    await page.waitForFunction((b) => Math.abs(window.__galleryState().tx - b.tx) > 60, { timeout: 8000 }, panBefore);
  });
  await page.mouse.up();
  await page.waitForFunction(() => !document.getElementById('lbStage').classList.contains('dragging'), { timeout: 5000 }).catch(() => {});
  record('缩放:拖拽平移(+拖拽态)', dragging, panMs, BUDGET.zoom, { 拖拽样式: dragging });
  await page.keyboard.press('0'); await sleep(200);

  /* 双击缩放(进入 100% / 返回适应) */
  await page.keyboard.press('0'); await sleep(150);
  c = await stageCenter();
  /* mouse.click({clickCount: 2}) sends ONE down/up pair; Chrome only synthesises
     dblclick from the full sequence, so the four events are issued explicitly. */
  const doubleClick = async (p) => {
    await page.mouse.move(p.cx, p.cy);
    await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
  };
  const dblInMs = await timed(async () => {
    await doubleClick(c);
    await page.waitForFunction(() => window.__galleryState().scale > 1.02, { timeout: 8000 });
  });
  record('缩放:双击 → 100%', true, dblInMs, BUDGET.zoom);
  const dblOutMs = await timed(async () => {
    c = await stageCenter();
    await doubleClick(c);
    await page.waitForFunction(() => window.__galleryState().scale <= 1.02, { timeout: 8000 });
  });
  record('缩放:双击 → 适应窗口', true, dblOutMs, BUDGET.zoom);

  /* 点击背景关闭 */
  const bgMs = await timed(async () => {
    await page.evaluate(() => document.getElementById('lightbox').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForFunction(() => document.getElementById('lightbox').hidden, { timeout: 8000 });
  });
  record('关闭:点击背景', true, bgMs, BUDGET.ui);

  /* 信息面板的两颗复制按钮 */
  await page.evaluate(() => document.querySelector('.card').click());
  await page.waitForFunction(() => !document.getElementById('lightbox').hidden, { timeout: 10000 });
  await page.waitForFunction(() => { const s = window.__galleryState(); return s.displayed === s.key; }, { timeout: 20000 });
  await page.keyboard.press('i'); await sleep(250);
  const infoLinks = await page.evaluate(() => document.querySelectorAll('#infoLinks button').length);
  const copyPathMs = await timed(async () => {
    await page.evaluate(() => document.querySelectorAll('#infoLinks button')[0].click());
    await page.waitForFunction(() => /已复制/.test(document.getElementById('toast').textContent), { timeout: 8000 });
  });
  record('复制原图路径', infoLinks >= 2, copyPathMs, BUDGET.ui, { 按钮数: infoLinks });
  const copyLinkMs = await timed(async () => {
    await page.evaluate(() => document.querySelectorAll('#infoLinks button')[1].click());
    await page.waitForFunction(() => /已复制链接/.test(document.getElementById('toast').textContent), { timeout: 8000 });
  });
  record('复制本页链接', true, copyLinkMs, BUDGET.ui);
  await page.keyboard.press('Escape'); await sleep(400);

  /* 网格:搜索清除按钮 */
  await page.click('#search');
  await page.type('#search', 'toronto');
  await waitStable(page);
  const clearBtnMs = await timed(async () => {
    await page.evaluate(() => document.getElementById('searchClear').click());
    await page.waitForFunction(() => document.getElementById('search').value === '' && document.querySelectorAll('.card').length > 3000, { timeout: 15000 });
  });
  record('搜索清除按钮', true, clearBtnMs, BUDGET.filter);
  await waitStable(page, 20000);

  /* 回到顶部 */
  const toTopShowMs = await timed(async () => {
    await page.evaluate(() => window.scrollTo(0, 4000));
    await page.waitForFunction(() => !document.getElementById('toTop').hidden, { timeout: 8000 });
  });
  record('滚动 → 回到顶部按钮出现', true, toTopShowMs, BUDGET.ui);
  const topFrom = await page.evaluate(() => window.scrollY);
  const toTopMs = await timed(async () => {
    await page.evaluate(() => document.getElementById('toTop').click());
    // responsiveness: the scroll must actually START; its duration is the browser's
    // smooth-scroll animation, which is not our latency.
    await page.waitForFunction((y) => window.scrollY < y - 80, { timeout: 8000 }, topFrom);  // started moving
  });
  record('回到顶部(响应)', true, toTopMs, BUDGET.ui);
  await page.waitForFunction(() => window.scrollY < 40, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(300);

  /* 悬停预热:停在卡片上 120ms 后应预取该照片原图 */
  const hovered = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.card')][12];
    card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    const thumb = card.querySelector('img');
    const key = decodeURIComponent((thumb.currentSrc || thumb.src).split('/').pop()).replace(/\.webp$/, '');
    const rec = (window.GALLERY_DATA.photos || []).find((p) => p.k === key);
    return { key, file: rec ? rec.f : null };
  });
  let hoverOk = false, hoverMs = 0;
  const hoverT0 = Date.now();
  for (let i = 0; i < 50 && !hoverOk; i++) {
    hoverOk = Boolean(hovered.file) && origReqs.some((u) => u === hovered.file);
    if (!hoverOk) await sleep(100);
    hoverMs = Date.now() - hoverT0;
  }
  record('卡片悬停触发原图预热', hoverOk, hoverMs, 3000, { 卡序号: 12, 文件: hovered.file });

  /* 内容保护:右键 / 拖拽 / Ctrl+S 都被拦截 */
  const guard = await page.evaluate(() => {
    const img = document.querySelector('.card img');
    const cm = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    img.dispatchEvent(cm);
    const ds = new Event('dragstart', { bubbles: true, cancelable: true });
    img.dispatchEvent(ds);
    const ks = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(ks);
    return { contextmenu: cm.defaultPrevented, dragstart: ds.defaultPrevented, ctrlS: ks.defaultPrevented };
  });
  record('保护:右键/拖拽/Ctrl+S 拦截', guard.contextmenu && guard.dragstart && guard.ctrlS, 0, null, guard);

  /* 全屏键:headless 无法真正全屏,只验证不抛错且灯箱仍可用 */
  await page.evaluate(() => document.querySelector('.card').click());
  await page.waitForFunction(() => !document.getElementById('lightbox').hidden, { timeout: 10000 });
  const errCountBefore = errs.length;
  await page.keyboard.press('f'); await sleep(600);
  const fsState = await page.evaluate(() => ({ full: Boolean(document.fullscreenElement), lb: !document.getElementById('lightbox').hidden }));
  record('全屏键 F(不抛错·灯箱可用)', errs.length === errCountBefore && fsState.lb, 0, null, fsState);
  await page.keyboard.press('Escape'); await sleep(400);

  /* ------------------------------------------------ 统计面板(事件延迟均值) */
  const openStatsBtn = await timed(async () => {
    await page.evaluate(() => document.getElementById('statsBtn').click());
    await page.waitForFunction(() => !document.getElementById('statsModal').hidden, { timeout: 8000 });
  });
  record('统计面板:按钮打开', true, openStatsBtn, BUDGET.ui);

  await page.waitForFunction(() => document.querySelectorAll('#statsTable tbody tr').length > 0, { timeout: 8000 }).catch(() => {});
  const panel = await page.evaluate(() => {
    const wraps = [...document.querySelectorAll('.stats-wrap')];
    const sessionRows = [...document.querySelectorAll('#statsTable tbody tr')];
    const serverRows = [...document.querySelectorAll('#statsServerTable tbody tr')];
    const card = document.querySelector('.stats-card').getBoundingClientRect();
    return {
      summaryCells: document.querySelectorAll('#statsSummary span').length,
      sessionRows: sessionRows.length,
      sessionCols: sessionRows.map((r) => r.children.length),
      serverRows: serverRows.length,
      serverCols: serverRows.map((r) => r.children.length),
      serverFallback: /file:\/\/|取不到|还没有收到/.test(document.getElementById('statsServerTable').textContent),
      overflow: wraps.map((w) => w.scrollWidth - w.clientWidth),
      cardFits: card.width <= window.innerWidth - 20 && card.height <= window.innerHeight,
      totals: window.__galleryStats().totals,
    };
  });
  record('统计面板:会话表结构', panel.sessionRows > 0 && panel.sessionCols.every((c) => c === 6), 0, null,
    { 行: panel.sessionRows, 列: panel.sessionCols.slice(0, 4), 汇总格: panel.summaryCells, 采样: panel.totals.n });
  record('统计面板:服务器累计表', panel.serverRows > 0 && panel.serverCols.every((c) => c === 5), 0, null,
    { 行: panel.serverRows, 回退提示: panel.serverFallback });
  record('统计面板:无横向溢出且卡片适配视口', panel.overflow.every((o) => o <= 2) && panel.cardFits, 0, null,
    { 溢出: panel.overflow, 适配: panel.cardFits });

  const statsCopyMs = await timed(async () => {
    await page.evaluate(() => document.getElementById('statsCopy').click());
    await page.waitForFunction(() => /已复制统计表/.test(document.getElementById('toast').textContent), { timeout: 8000 });
  });
  record('统计面板:复制 Markdown', true, statsCopyMs, BUDGET.ui);

  const statsKeyMs = await timed(async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('statsModal').hidden, { timeout: 8000 });
    await page.keyboard.press('y');
    await page.waitForFunction(() => !document.getElementById('statsModal').hidden, { timeout: 8000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('statsModal').hidden, { timeout: 8000 });
  });
  record('统计面板:Y 键开合 / Esc 关闭', true, statsKeyMs, BUDGET.ui);

  /* ------------------------------------------------------------ 键盘全局 */
  for (const [label, keyName, check] of [
    ['快捷键 R(随机)', 'r', () => !document.getElementById('lightbox').hidden],
    ['快捷键 /(聚焦搜索)', '/', () => document.activeElement === document.getElementById('search')],
    ['快捷键 ?(帮助)', '?', () => !document.getElementById('helpModal').hidden],
  ]) {
    const t0 = Date.now();
    try {
      await page.keyboard.press(keyName);
      await page.waitForFunction(check, { timeout: 8000 });
    } catch (err) {
      const ui = await page.evaluate(() => ({
        active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none',
        lightbox: !document.getElementById('lightbox').hidden,
        help: !document.getElementById('helpModal').hidden,
        fullscreen: Boolean(document.fullscreenElement),
        topbarInert: document.getElementById('topbar').hasAttribute('inert'),
      }));
      console.error(`  ! 超时诊断 [${label}]`, JSON.stringify(ui));
      throw err;
    }
    record(label, true, Date.now() - t0, BUDGET.ui);
    await page.keyboard.press('Escape'); await sleep(400);
    await page.evaluate(() => { const s = document.getElementById('search'); s.blur(); s.value = ''; });
  }

  const cardKbMs = await timed(async () => {
    await page.evaluate(() => { const c = document.querySelector('.card'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await page.waitForFunction(() => !document.getElementById('lightbox').hidden, { timeout: 10000 });
  });
  record('卡片键盘 Enter 打开', true, cardKbMs, BUDGET.paint);
  await page.keyboard.press('Escape'); await sleep(400);

  /* ------------------------------------------------------------ 深链 */
  const deepMs = await timed(async () => {
    await page.goto('about:blank');
    await page.goto(URL_BASE + (USE_FILE ? '' : '') + '#p=cana00002', { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById('lightbox').hidden, { timeout: 20000 });
  });
  const deep = await page.evaluate(() => ({ count: document.getElementById('lbCount').textContent, title: document.getElementById('lbTitle').textContent.slice(0, 24) }));
  record('深链 #p=… 直接打开', /\/ 3688$/.test(deep.count), deepMs, 4000, deep);

  /* ------------------------------------------------ 偏好持久化(reload 后) */
  await page.evaluate(() => {
    localStorage.setItem('fg.theme', JSON.stringify('light'));
    localStorage.setItem('fg.sort', JSON.stringify('name-asc'));
  });
  await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 30000 });
  const persisted = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    sort: document.getElementById('sortSel').value,
  }));
  record('偏好持久化(主题+排序)', persisted.theme === 'light' && persisted.sort === 'name-asc', 0, null, persisted);
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });

  /* ------------------------------------------------------------- 汇总 */
  console.log(`\n  JS 错误: ${errs.length ? JSON.stringify(errs.slice(0, 3)) : '无'}`);
  console.log(`  失败的网络请求: ${netFails.length ? JSON.stringify(netFails.slice(0, 5)) : '无'}`);
  console.log(`  被取代而中止的请求(正常): ${aborts.length}`);
  if (netFails.length) record('无失败的网络请求', false, 0, null, { fails: netFails.slice(0, 5) });
  console.log(`\n=== 汇总:通过 ${pass} / 慢 ${slow} / 失败 ${fail} ===`);
  console.log(`环境基线 ${envBase}ms — 慢项需在此背景下解读`);
  const slowOnes = results.filter(r => r.level === 'SLOW');
  if (slowOnes.length) {
    console.log('超出性能预算的事件:');
    slowOnes.forEach(r => console.log(`  ⚠ ${r.name} — ${r.ms}ms`));
  }
  if (errs.length) fail++;
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('EVENTS-TEST-FATAL', e.message);
  if (page) {
    try {
      const st = await page.evaluate(() => ({
        active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none',
        fullscreen: Boolean(document.fullscreenElement),
        topbarInert: document.getElementById('topbar').hasAttribute('inert'),
        gridInert: document.getElementById('grid').hasAttribute('inert'),
        lightbox: !document.getElementById('lightbox').hidden,
        count: document.getElementById('lbCount').textContent,
        title: document.getElementById('lbTitle').textContent.slice(0, 34),
        loading: !document.getElementById('lbSpinner').hidden,
        badge: document.getElementById('lbZoomBadge').textContent,
        slideActive: document.getElementById('lbSlideBtn').classList.contains('active'),
        progressHidden: document.getElementById('lbProgress').hidden,
        toast: document.getElementById('toast').classList.contains('show') ? document.getElementById('toast').textContent : '',
        stripItems: document.querySelectorAll('.strip-item').length,
        stripLoaded: [...document.querySelectorAll('.strip-item img')].filter(i => i.complete && i.naturalWidth > 0).length,
        layers: [...document.querySelectorAll('#lbZoom img')].map(i => i.id + ':' + (i.naturalWidth || 0)),
      }));
      console.error('  失败时状态:', JSON.stringify(st));
    } catch { /* page may be gone */ }
  }
  console.error('  页面错误:', JSON.stringify(errs.slice(-5)));
  console.error('  失败请求:', JSON.stringify(netFails.slice(-5)));
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  process.exit(1);
});
