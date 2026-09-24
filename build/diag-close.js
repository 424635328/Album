'use strict';
/* Probe: is there a REAL long task on close, or is the suite's 2.8s just ambient load?
   closeLightbox() removes inert from the grid and focuses a card, so the grid's
   content-visibility layout is the suspect. Three open/close cycles, long tasks logged. */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = 8420;

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 30000 });
  await sleep(1200);

  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] });
  });

  const roundTrip = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))).then(() => 1));
  const settle = () => page.waitForFunction(() => { const s = window.__galleryState(); return s.pending === null && !s.loading; }, { timeout: 30000 }).catch(() => {});

  for (const scrollTo of [0, 6000, 20000]) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollTo);
    await sleep(600);
    await page.evaluate(() => { window.__lt = []; });

    // open a card in the current viewport
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.card')];
      const vis = cards.find((c) => c.getBoundingClientRect().top > 50 && c.getBoundingClientRect().top < 700) || cards[0];
      vis.click();
    });
    await page.waitForFunction(() => !document.getElementById('lightbox').hidden, { timeout: 10000 });
    await settle();
    await sleep(300);

    await page.evaluate(() => { window.__lt = []; });
    const t0 = Date.now();
    await page.keyboard.press('Escape');
    const keyMs = Date.now() - t0;
    await page.waitForFunction(() => document.getElementById('lightbox').hidden, { timeout: 10000 });
    const hiddenMs = Date.now() - t0;
    const rt0 = Date.now();
    await roundTrip();
    const rtMs = Date.now() - rt0;
    await sleep(400);
    const lt = await page.evaluate(() => window.__lt);

    console.log(`scrollY=${String(scrollTo).padStart(5)}: 按下Esc ${keyMs}ms → 灯箱隐藏 ${hiddenMs}ms → 下一次 rAF 往返 ${rtMs}ms   长任务=[${lt.join(', ')}]`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
  }

  await browser.close();
})().catch(e => { console.error('PROBE-FATAL', e.message); process.exit(1); });
