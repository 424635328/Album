'use strict';
/* Probe: what blocks the main thread for ~2s right after a photo becomes ready?
   Uses the Long Tasks API so the answer is measured, not guessed. */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = 8420;

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const client = await page.createCDPSession();
  await client.send('Performance.enable');

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 30000 });
  await sleep(1000);

  // long-task observer: anything ≥50ms on the main thread
  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__lt.push({ start: Math.round(e.startTime), dur: Math.round(e.duration), attr: e.attribution && e.attribution[0] ? (e.attribution[0].name || e.attribution[0].containerType || '?') : '?' });
      }
    }).observe({ entryTypes: ['longtask'] });
  });

  await page.evaluate(() => document.querySelector('.card').click());
  await page.waitForFunction(() => !document.getElementById('lightbox').hidden, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.strip-item').length > 6, { timeout: 15000 });

  const t0 = Date.now();
  await page.waitForFunction(() => { const s = window.__galleryState(); return s.pending === null && !s.loading; }, { timeout: 30000 });
  console.log(`第一张原图就绪耗时 ${Date.now() - t0}ms`);

  // the suite's strip jump, with the round trip timed separately
  await sleep(300);
  await page.evaluate(() => { window.__lt = []; });
  const j0 = Date.now();
  await page.evaluate(() => document.querySelectorAll('.strip-item')[2].click());
  const evalMs = Date.now() - j0;
  const w0 = Date.now();
  await page.waitForFunction(() => document.getElementById('lbCount').textContent.startsWith('3 '), { timeout: 15000 });
  const waitMs = Date.now() - w0;
  await page.waitForFunction(() => { const s = window.__galleryState(); return s.pending === null && !s.loading; }, { timeout: 30000 });
  await sleep(600);

  const lt = await page.evaluate(() => window.__lt);
  console.log(`\n跳转: evaluate 往返 ${evalMs}ms, 谓词等待 ${waitMs}ms, 合计 ${evalMs + waitMs}ms`);
  console.log(`长任务(≥50ms) ${lt.length} 个:`);
  lt.sort((a, b) => b.dur - a.dur).slice(0, 12).forEach(t => console.log(`  ${String(t.dur).padStart(5)}ms  @${t.start}ms  来源=${t.attr}`));

  const metrics = await client.send('Performance.getMetrics');
  const pick = (n) => { const m = metrics.metrics.find(x => x.name === n); return m ? m.value : null; };
  console.log(`\nJS 堆: ${Math.round((pick('JSHeapUsedSize') || 0) / 1048576)}MB   节点数: ${pick('Nodes')}   布局次数: ${pick('LayoutCount')}   样式重算: ${pick('RecalcStyleCount')}`);

  // how many strip images are actually loaded vs. total, and the layout cost of the strip
  const strip = await page.evaluate(() => {
    const items = document.querySelectorAll('.strip-item');
    const inner = document.querySelector('.lb-strip-inner');
    return { items: items.length, loaded: [...items].filter(i => { const im = i.querySelector('img'); return im && im.complete && im.naturalWidth > 0; }).length, scrollWidth: inner.scrollWidth };
  });
  console.log(`缩略图条: ${strip.items} 项, 已加载 ${strip.loaded}, 内容宽度 ${strip.scrollWidth}px`);

  await browser.close();
})().catch(e => { console.error('PROBE-FATAL', e.message); process.exit(1); });
