'use strict';
/* Probe: the three global keyboard shortcuts after a lightbox round-trip, with a full
   state dump after each — activeElement, inert subtrees, fullscreen, lightbox. */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = 8420;

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message)));

  const dump = () => page.evaluate(() => {
    const s = document.getElementById('search');
    return {
      active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none',
      lb: !document.getElementById('lightbox').hidden,
      help: !document.getElementById('helpModal').hidden,
      full: Boolean(document.fullscreenElement),
      topbarInert: document.getElementById('topbar').hasAttribute('inert'),
      gridInert: document.getElementById('grid').hasAttribute('inert'),
      searchVisible: s.offsetParent !== null,
      searchValue: s.value,
    };
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 30000 });
  await sleep(900);
  console.log('起始      ', JSON.stringify(await dump()));

  // what does the app actually receive for these keys?
  await page.evaluate(() => {
    window.__keys = [];
    document.addEventListener('keydown', (e) => window.__keys.push(`${e.key}${e.ctrlKey ? '+ctrl' : ''}${e.shiftKey ? '+shift' : ''}`), true);
  });

  for (const [label, key] of [['R 随机', 'r'], ['/', '/'], ['? 帮助', '?']]) {
    await page.keyboard.press(key);
    await sleep(700);
    console.log(`按下 ${label.padEnd(8)}`, JSON.stringify(await dump()));
    await page.keyboard.press('Escape');
    await sleep(500);
    await page.evaluate(() => { const s = document.getElementById('search'); s.blur(); s.value = ''; });
    console.log(`  Esc 后        `, JSON.stringify(await dump()));
  }

  // does an open lightbox swallow '/'?  (the suite may press '/' too early)
  await page.keyboard.press('r'); await sleep(700);
  console.log('\n灯箱打开时按 /:', JSON.stringify(await dump()));
  await page.keyboard.press('Escape'); await sleep(100);            // short wait on purpose
  await page.keyboard.press('/'); await sleep(700);
  console.log('Esc 后仅 100ms 按 /:', JSON.stringify(await dump()));
  await page.keyboard.press('Escape'); await sleep(400);

  /* THE SUITE'S EXACT SEQUENCE: the F(fullscreen) case runs immediately before the
     global-shortcut cases, so measure what Escape does while fullscreen is active. */
  console.log('\n=== 复现测试顺序: 全屏 → Esc → R → Esc → / ===');
  await page.evaluate(() => { window.__keys = []; });
  await page.evaluate(() => document.querySelector('.card').click());
  await page.waitForFunction(() => !document.getElementById('lightbox').hidden, { timeout: 10000 });
  await sleep(600);
  await page.keyboard.press('f'); await sleep(600);
  console.log('按 f 后      ', JSON.stringify(await dump()));
  await page.keyboard.press('Escape'); await sleep(400);
  console.log('Esc 后       ', JSON.stringify(await dump()), ' 收到:', JSON.stringify(await page.evaluate(() => window.__keys)));
  await page.evaluate(() => { window.__keys = []; });
  await page.keyboard.press('r'); await sleep(700);
  console.log('按 r 后      ', JSON.stringify(await dump()), ' 收到:', JSON.stringify(await page.evaluate(() => window.__keys)));
  await page.evaluate(() => { window.__keys = []; });
  await page.keyboard.press('Escape'); await sleep(400);
  console.log('Esc 后       ', JSON.stringify(await dump()), ' 收到:', JSON.stringify(await page.evaluate(() => window.__keys)));
  await page.evaluate(() => { window.__keys = []; });
  await page.keyboard.press('/'); await sleep(700);
  console.log('按 / 后      ', JSON.stringify(await dump()), ' 收到:', JSON.stringify(await page.evaluate(() => window.__keys)));

  console.log('\n收到的按键:', JSON.stringify(await page.evaluate(() => window.__keys)));
  console.log('JS 错误:', errs.length ? JSON.stringify(errs.slice(0, 3)) : '无');
  await browser.close();
})().catch(e => { console.error('PROBE-FATAL', e.message); process.exit(1); });
