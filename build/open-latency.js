'use strict';
/* Measures the latency of opening a photo FROM THE GRID (the path the user
 * reported as slow), separating "user sees a picture" (transitional layer)
 * from "original fully decoded".
 *
 *   node open-latency.js [port]
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = process.argv[2] || '8420';

async function run(page, label, hoverMs) {
  await page.evaluate(() => { performance.clearMarks(); });
  const box = await (await page.$('.card')).boundingBox();
  const t0 = Date.now();
  if (hoverMs > 0) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(hoverMs);
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // wait for the original to be ready (mark lb-ready) or timeout
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const layers = [document.getElementById('lbImgA'), document.getElementById('lbImgB')];
      const front = layers.find(i => i.classList.contains('show'));
      return { key: front && front.dataset.key, ready: !!(front && front.complete && front.naturalWidth > 0) };
    });
    if (st.ready) { ready = true; break; }
    await sleep(10);
  }
  const total = Date.now() - t0;
  const marks = await page.evaluate(() => {
    const last = (n) => { const e = performance.getEntriesByName(n); return e.length ? Math.round(e[e.length - 1].startTime) : null; };
    return { nav: last('lb-nav'), trans: last('lb-trans'), ready: last('lb-ready') };
  });
  const ms = (a, b) => (a === null || b === null ? 'n/a' : (b - a) + ' ms');
  console.log(`  ${label}`);
  console.log(`    [页面内] 过渡层显示(用户看到画面): ${marks.trans !== null ? ms(marks.nav, marks.trans) : '未使用'}`);
  console.log(`    [页面内] 原图就绪               : ${ms(marks.nav, marks.ready)}`);
  console.log(`    [探针]   端到端(含点击往返)     : ${total} ms  (ready=${ready})`);
  // back to the grid
  await page.keyboard.press('Escape');
  await sleep(600);
}

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 60000 });
  await sleep(2500);

  console.log('\n=== 从首页网格打开照片的延迟 ===');
  await run(p, '① 直接点击(无悬停)', 0);
  await sleep(1500);
  await run(p, '② 悬停 500ms 后点击', 500);
  await sleep(1500);
  await run(p, '③ 悬停 150ms 后点击', 150);
  await sleep(1500);
  await run(p, '④ 再次直接点击(热缓存)', 0);

  await b.close();
})().catch(e => { console.error('PROBE-FATAL', e.message); process.exit(1); });
