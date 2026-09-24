'use strict';
/* Regression suite — uses REAL browser input (mouse clicks at coordinates,
 * wheel, keys) so pointer-capture and event-bubbling regressions get caught.
 *
 *   T1  grid boot & lazy loading
 *   T2  lightbox opens with the ORIGINAL image (no preview tier)
 *   T3  layout: fitted image never overlapped/clipped (strip shown & hidden)
 *   T4  prev/next buttons work with REAL mouse clicks (pointer-capture regression)
 *   T5  zoom: keyboard, badge click → fit, wheel, double-click
 *   T6  preload: switching to the next image is instant (already decoded)
 *   T7  slideshow: countdown arms only after the image finishes loading
 *   T8  search / filters / theme / deep link
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { spawn } = require('child_process');
const http = require('http');
const URL = 'file:///H:/HDownload/Flickr-Gallery/index.html';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + '  ← ' + JSON.stringify(detail)); }
}

function get(url, headers) {
  return new Promise((resolve) => {
    http.get(url, { headers: headers || {} }, (res) => { res.resume(); resolve({ status: res.statusCode, type: res.headers['content-type'], len: +res.headers['content-length'] || 0 }); })
      .on('error', (e) => resolve({ status: 0, err: e.message }));
  });
}

async function clickCenter(page, selector) {
  const box = await (await page.$(selector)).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
async function layout(page) {
  return page.evaluate(() => {
    const img = document.querySelector('#lbZoom img.show') || document.querySelector('#lbZoom img');
    const ir = img.getBoundingClientRect();
    const strip = document.getElementById('lbStrip').getBoundingClientRect();
    const stage = document.getElementById('lbStage').getBoundingClientRect();
    return {
      stripVisible: strip.height > 0,
      overlapsStrip: strip.height > 0 && ir.bottom > strip.top + 0.5,
      exceedsStage: ir.bottom > stage.bottom + 0.5 || ir.top < stage.top - 0.5 || ir.right > stage.right + 0.5,
      imgBottom: +ir.bottom.toFixed(1), stageBottom: +stage.bottom.toFixed(1),
    };
  });
}

(async () => {
  // 0) Server: REUSE a running instance when possible — spawning detached servers
  //    used to leak one process per run (5 leaked instances once caused editor
  //    write failures: the live server competes for the file handle during an
  //    atomic replace). Only start one if nothing is listening, and stop it after.
  let ownServer = null;
  const probe = await get('http://127.0.0.1:8420/', { Referer: 'http://127.0.0.1:8420/' });
  if (probe.status !== 200) {
    ownServer = spawn('node', ['server.js', '--no-open'], { cwd: __dirname, stdio: 'ignore' });
    await sleep(1800);
    console.log('  · started a temporary server for this run');
  } else {
    console.log('  · reusing the already-running server on port 8420');
  }
  const REF = { Referer: 'http://127.0.0.1:8420/' };
  const r1 = await get('http://127.0.0.1:8420/');
  const r2 = await get('http://127.0.0.1:8420/assets/thumbs/cana00001.webp', REF);
  const r3 = await get('http://127.0.0.1:8420/Flickr/Canada/0001_King%20Street%20West,%20Toronto,%20Canada_55058411398_o.jpg', REF);
  check('S0 server routes', r1.status === 200 && r2.status === 200 && r3.status === 200, [r1, r2, r3]);
  // access protection: media without a local page referer must be refused
  const r4 = await get('http://127.0.0.1:8420/assets/thumbs/cana00001.webp');
  const r5 = await get('http://127.0.0.1:8420/Flickr/Canada/0001_King%20Street%20West,%20Toronto,%20Canada_55058411398_o.jpg', { Referer: 'https://evil.example.com/' });
  check('S0b direct media access blocked (403)', r4.status === 403 && r5.status === 403, [r4.status, r5.status]);
  // range support for large originals
  const r6 = await get('http://127.0.0.1:8420/assets/thumbs/cana00001.webp', Object.assign({ Range: 'bytes=0-1023' }, REF));
  check('S0c range request (206)', r6.status === 206 && r6.len === 1024, r6);

  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1050 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  // T1-home: first-screen paint time (batched rendering should show cards fast)
  let firstPaint = null;
  const tStart = Date.now();
  while (Date.now() - tStart < 8000) {
    if (await page.evaluate(() => document.querySelectorAll('#grid .row').length > 0)) { firstPaint = Date.now() - tStart; break; }
    await sleep(25);
  }
  await sleep(2500);
  const boot = await page.evaluate(() => ({
    cards: document.querySelectorAll('.card').length,
    rows: document.querySelectorAll('#grid .row').length,
    loaded: document.querySelectorAll('.card.ld').length,
    favButtons: document.querySelectorAll('.card .fav-btn').length,
  }));
  check('T1-home first screen paints fast (<1500ms)', firstPaint !== null && firstPaint < 1500, { firstPaint });
  check('T1 grid boot (3688 cards, lazy)', boot.cards === 3688 && boot.rows > 0 && boot.loaded > 0 && boot.loaded < boot.cards, boot);
  check('T1b favourite buttons rendered', boot.favButtons === boot.cards, { favButtons: boot.favButtons, cards: boot.cards });

  // T2 lightbox opens with ORIGINAL
  await clickCenter(page, '.card');
  await sleep(9000);
  const t2 = await page.evaluate(() => ({
    open: !document.getElementById('lightbox').hidden,
    count: document.getElementById('lbCount').textContent,
    shown: document.querySelector('#lbZoom img.show'),
    natural: document.querySelector('#lbZoom img.show') ? document.querySelector('#lbZoom img.show').naturalWidth + 'x' + document.querySelector('#lbZoom img.show').naturalHeight : 'none',
  }));
  check('T2 original loads on click (9504x6336)', t2.open && t2.count === '1 / 3688' && t2.natural === '9504x6336', t2);

  // T3 layout, strip visible then hidden
  const t3a = await layout(page);
  check('T3a no overlap with strip shown', t3a.stripVisible && !t3a.overlapsStrip && !t3a.exceedsStage, t3a);
  await page.keyboard.press('t'); await sleep(300);
  const t3b = await layout(page);
  check('T3b no clipping with strip hidden', !t3b.stripVisible && !t3b.exceedsStage, t3b);
  await page.keyboard.press('t'); await sleep(300);

  // T4 REAL mouse clicks on prev/next buttons
  const c0 = await page.evaluate(() => document.getElementById('lbCount').textContent);
  await clickCenter(page, '#lbNext');
  await sleep(2500);
  const c1 = await page.evaluate(() => document.getElementById('lbCount').textContent);
  await clickCenter(page, '#lbPrev');
  await sleep(2500);
  const c2 = await page.evaluate(() => document.getElementById('lbCount').textContent);
  check('T4 next/prev buttons (real click)', c0 === '1 / 3688' && c1 === '2 / 3688' && c2 === '1 / 3688', { c0, c1, c2 });

  // T5 zoom: keyboard, badge click, wheel, double-click
  await page.keyboard.press('+'); await sleep(150);
  const z1 = await page.evaluate(() => document.getElementById('lbZoomBadge').textContent);
  await clickCenter(page, '#lbZoomBadge');
  await sleep(200);
  const z2 = await page.evaluate(() => document.getElementById('lbZoomBadge').textContent);
  await page.mouse.move(840, 500); await page.mouse.wheel({ deltaY: -240 }); await sleep(200);
  const z3 = await page.evaluate(() => document.getElementById('lbZoomBadge').textContent);
  await page.$eval('#lbStage', el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 840, clientY: 500 })));
  await sleep(200);
  const z4 = await page.evaluate(() => document.getElementById('lbZoomBadge').textContent);
  check('T5 zoom keyboard/badge/wheel/dblclick', z1.includes('%') && z2.includes('适应') && z3.includes('%') && z4.includes('适应'), { z1, z2, z3, z4 });

  // T6 preload: next image should render instantly (already decoded)
  await clickCenter(page, '#lbNext');
  await sleep(400);
  const t6 = await page.evaluate(() => {
    const img = document.querySelector('#lbZoom img.show');
    return { complete: img && img.complete && img.naturalWidth > 0, count: document.getElementById('lbCount').textContent };
  });
  check('T6 preloaded next renders instantly', t6.complete && t6.count === '2 / 3688', t6);

  // T7 slideshow arms only after load — deterministic version:
  // run over HTTP and STALL the next original request, so "loading" is guaranteed.
  async function waitFor(fn, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(200); }
    return false;
  }
  await page.setRequestInterception(true);
  let holdFlickr = false; const held = [];
  page.on('request', (req) => {
    if (holdFlickr && /\/Flickr\/.+\.(jpe?g)$/i.test(req.url())) { held.push(req); return; }
    req.continue().catch(() => {});
  });
  await page.goto('http://127.0.0.1:8420/', { waitUntil: 'load' });
  await sleep(2000);
  await clickCenter(page, '.card');        // first photo (cana00001) — original allowed through
  await sleep(9000);                        // fully loaded; ±1 neighbours preloaded
  holdFlickr = true;                        // stall originals from now on
  await page.keyboard.press('End'); await sleep(800);  // jump FAR away: prefetch covers only ±1/±2, so the target is guaranteed unloaded → request STALLED
  check('T7-pre request stalled', held.length >= 1, held.length);
  const t7diag = await page.evaluate(() => {
    const layers = [document.getElementById('lbImgA'), document.getElementById('lbImgB')];
    const tr = document.getElementById('lbImgTrans');
    return {
      hash: location.hash,
      layers: layers.map(i => ({ key: i.dataset.key, complete: i.complete, show: i.classList.contains('show') })),
      trans: { key: tr.dataset.key, show: tr.classList.contains('show') },
    };
  });
  console.log('  · T7 state      =>', JSON.stringify(t7diag));
  const t7a = await page.evaluate(() => {
    document.querySelector('[data-act="slide"]').click();
    return {
      progressVisible: !document.getElementById('lbProgress').hidden,
      btnActive: document.getElementById('lbSlideBtn').classList.contains('active'),
    };
  });
  await sleep(1500);
  const t7a2 = await page.evaluate(() => !document.getElementById('lbProgress').hidden);
  check('T7a countdown waits for load', t7a.progressVisible === false && t7a.btnActive === true && t7a2 === false, { t7a, t7a2 });
  holdFlickr = false;                       // release → original loads → countdown arms by itself
  for (const r of held) r.continue().catch(() => {});
  const t7b = await waitFor(async () => page.evaluate(() => !document.getElementById('lbProgress').hidden), 25000);
  check('T7b countdown armed after load', t7b, { t7b });
  await page.keyboard.press(' '); await sleep(250);
  const t7c = await page.evaluate(() => !document.getElementById('lbProgress').hidden);
  check('T7c pause works', !t7c, { t7c });
  await page.keyboard.press(' '); await sleep(250);
  const t7d = await waitFor(async () => page.evaluate(() => !document.getElementById('lbProgress').hidden), 8000);
  check('T7d resume works', t7d, { t7d });
  await page.keyboard.press(' '); await sleep(200);   // leave paused for T8
  await page.keyboard.press('Escape'); await sleep(300);

  // T8 search / clear / theme / deep link
  await page.click('#search'); await page.type('#search', 'toronto'); await sleep(500);
  const s1 = await page.evaluate(() => document.querySelectorAll('.card').length);
  await page.evaluate(() => { const s = document.getElementById('search'); s.value = 'zzz'; s.dispatchEvent(new Event('input')); });
  await sleep(400);
  const s2 = await page.evaluate(() => ({ cards: document.querySelectorAll('.card').length, empty: !document.getElementById('empty').hidden }));
  await page.click('#clearFilters'); await sleep(200);
  const s3 = await (async () => {  // batched rendering completes over a few frames
    const dl = Date.now() + 8000;
    while (Date.now() < dl) {
      const n = await page.evaluate(() => document.querySelectorAll('.card').length);
      if (n === 3688) return 3688;
      await sleep(100);
    }
    return await page.evaluate(() => document.querySelectorAll('.card').length);
  })();
  check('T8 search/empty/clear', s1 > 0 && s1 < 3688 && s2.cards === 0 && s2.empty && s3 === 3688, { s1, s2, s3 });

  const th = await page.evaluate(() => { document.getElementById('themeBtn').click(); return document.documentElement.dataset.theme; });
  await page.evaluate(() => document.getElementById('themeBtn').click());
  check('T8 theme toggle', th === 'light', th);

  // deep link: force a fresh load (same-document hash changes don't re-run boot)
  await page.goto('about:blank');
  await page.goto('http://127.0.0.1:8420/#p=cana00002', { waitUntil: 'load' });
  await sleep(1500);
  const dl = await page.evaluate(() => ({
    open: !document.getElementById('lightbox').hidden,
    count: document.getElementById('lbCount').textContent,
  }));
  check('T8 deep link', dl.open && dl.count === '904 / 3688', dl);
  await page.keyboard.press('Escape'); await sleep(300);

  // ---------------- convenience buttons ----------------
  // T9 random (real click, 3 draws must differ)
  const picks = [];
  for (let i = 0; i < 3; i++) {
    await clickCenter(page, '#randomBtn');
    await sleep(900);
    picks.push(await page.evaluate(() => ({
      open: !document.getElementById('lightbox').hidden,
      key: location.hash.replace('#p=', ''),
    })));
    await page.keyboard.press('Escape'); await sleep(250);
  }
  check('T9 random opens lightbox', picks.every(p => p.open && p.key), picks);
  check('T9 random avoids repeats', new Set(picks.map(p => p.key)).size === 3, picks.map(p => p.key));

  // T10 one-click play from the first photo
  await clickCenter(page, '#playBtn');
  await sleep(1200);
  const play = await page.evaluate(() => ({
    open: !document.getElementById('lightbox').hidden,
    count: document.getElementById('lbCount').textContent,
    slideBtn: document.getElementById('lbSlideBtn').classList.contains('active'),
  }));
  check('T10 play from start', play.open && play.count === '1 / 3688' && play.slideBtn, play);
  await page.keyboard.press(' '); await sleep(200);      // pause
  await page.keyboard.press('Escape'); await sleep(300);

  // T11 year filter
  const yearInfo = await page.evaluate(() => {
    const sel = document.getElementById('yearSel');
    return { hidden: sel.hidden, options: [...sel.options].map(o => o.value) };
  });
  let t11 = { yearInfo };
  if (!yearInfo.hidden && yearInfo.options.length > 2) {
    const y = yearInfo.options[1];
    await page.select('#yearSel', y);
    await sleep(500);
    t11 = await page.evaluate((year) => ({
      cards: document.querySelectorAll('.card').length,
      resetVisible: !document.getElementById('resetBtn').hidden,
      allYear: [...document.querySelectorAll('.card .cap-m')].length > 0,
    }), y);
    t11.year = y;
    check('T11 year filter narrows grid', t11.cards > 0 && t11.cards < 3688 && t11.resetVisible, t11);
  } else {
    check('T11 year filter present', false, yearInfo);
  }

  // T12 favourites: star on card (must NOT open lightbox) → chip → filter → persists
  await page.click('#resetBtn'); await sleep(400);
  const favCardKey = await page.evaluate(() => document.querySelector('.card').dataset.key);
  const starBox = await (await page.$('.card .fav-btn')).boundingBox();
  await page.mouse.move(starBox.x + starBox.width / 2, starBox.y + starBox.height / 2);
  await sleep(200);
  await page.mouse.click(starBox.x + starBox.width / 2, starBox.y + starBox.height / 2);
  await sleep(400);
  const fav1 = await page.evaluate(() => ({
    lightboxOpen: !document.getElementById('lightbox').hidden,
    chipText: document.getElementById('favChipText').textContent,
    chipVisible: !document.getElementById('favChip').hidden,
    cardFav: document.querySelector('.card').classList.contains('fav'),
  }));
  check('T12a star toggles without opening lightbox', !fav1.lightboxOpen && fav1.chipVisible && fav1.cardFav && /1/.test(fav1.chipText), fav1);

  await clickCenter(page, '#favChip');
  await sleep(500);
  const fav2 = await page.evaluate(() => ({
    cards: document.querySelectorAll('.card').length,
    chipOn: document.getElementById('favChip').classList.contains('on'),
  }));
  check('T12b favourites-only filter', fav2.cards === 1 && fav2.chipOn, fav2);

  await page.reload({ waitUntil: 'load' }); await sleep(2500);
  const fav3 = await page.evaluate(() => ({
    chipText: document.getElementById('favChipText').textContent,
    onlyFavStillOn: document.getElementById('favChip').classList.contains('on'),
    cards: document.querySelectorAll('.card').length,
  }));
  check('T12c favourites persist after reload', /1/.test(fav3.chipText) && fav3.cards === 1, fav3);

  // T13 reset clears every filter
  await page.click('#resetBtn'); await sleep(200);
  const t13cards = await (async () => {
    const dl = Date.now() + 8000;
    while (Date.now() < dl) {
      const n = await page.evaluate(() => document.querySelectorAll('.card').length);
      if (n === 3688) return n;
      await sleep(100);
    }
    return await page.evaluate(() => document.querySelectorAll('.card').length);
  })();
  const t13 = await page.evaluate(() => ({
    resetHidden: document.getElementById('resetBtn').hidden,
    chipOn: document.getElementById('favChip').classList.contains('on'),
  }));
  check('T13 reset restores full grid', t13cards === 3688 && t13.resetHidden && !t13.chipOn, { t13cards, t13 });

  // T14 statistics inside the help modal
  await clickCenter(page, '#helpBtn');
  await sleep(400);
  const t14 = await page.evaluate(() => {
    const box = document.getElementById('helpStats');
    return { visible: !document.getElementById('helpModal').hidden, hasStats: !!box.querySelector('.stat-grid'), rows: box.querySelectorAll('span').length, text: box.textContent.slice(0, 60) };
  });
  check('T14 help modal shows statistics', t14.visible && t14.hasStats && t14.rows >= 6, t14);

  // T15 slideshow interval picker
  const t15diag = await page.evaluate(() => {
    const row = document.getElementById('slideMsRow');
    const btn = row && row.querySelector('button[data-ms="3000"]');
    if (btn) btn.click();
    return {
      rowExists: !!row, btnExists: !!btn,
      on: btn ? btn.classList.contains('on') : null,
      saved: localStorage.getItem('fg.slideMs'),
      btnCount: row ? row.querySelectorAll('button').length : 0,
    };
  });
  check('T15 interval picker (3s saved)', t15diag.on && JSON.parse(t15diag.saved) === 3000, t15diag);
  await page.evaluate(() => document.querySelector('#slideMsRow button[data-ms="5000"]').click());

  // T16 copy view list: shows toast confirmation
  const t16 = await page.evaluate(() => {
    document.getElementById('copyListBtn').click();
    return { toast: document.getElementById('toast').classList.contains('show'), text: document.getElementById('toast').textContent };
  });
  await sleep(700);
  const t16b = await page.evaluate(() => ({ text: document.getElementById('toast').textContent }));
  check('T16 copy view list confirms', /已复制/.test(t16.text) || /已复制/.test(t16b.text), { t16, t16b });
  await page.keyboard.press('Escape'); await sleep(250);

  console.log('jsErrors           => ' + JSON.stringify(errs.slice(0, 5)));
  check('no JS errors', errs.length === 0, errs);

  await page.close();
  await browser.close();
  if (ownServer) { try { ownServer.kill(); } catch { /* noop */ } }   // only stop what we started
  console.log(failed === 0 ? '\nREGRESSION SUITE: ALL PASSED' : `\nREGRESSION SUITE: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('SMOKE-FATAL', e.message); process.exit(1); });
