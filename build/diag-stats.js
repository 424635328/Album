'use strict';
/* Drive real interactions, then verify the statistics panel renders both tables and
   that /__stats accumulated the same events. Also captures a screenshot for review. */
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
  page.on('console', m => { if (m.type() === 'error' && !/__log|__stats/.test(m.text())) errs.push(m.text().slice(0, 100)); });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 30000 });
  await sleep(1000);

  // a realistic interaction mix
  await page.evaluate(() => document.querySelectorAll('.chip')[1].click()); await sleep(500);
  await page.evaluate(() => document.querySelectorAll('.chip')[0].click()); await sleep(500);
  await page.select('#sortSel', 'name-asc'); await sleep(600);
  await page.select('#sortSel', 'ts-desc'); await sleep(600);
  await page.evaluate(() => document.querySelectorAll('.card')[3].click()); await sleep(2500);
  await page.keyboard.press('ArrowRight'); await sleep(2000);
  await page.keyboard.press('ArrowLeft'); await sleep(1500);
  await page.keyboard.press('Escape'); await sleep(500);
  await page.evaluate(() => document.getElementById('themeBtn').click()); await sleep(400);
  await page.evaluate(() => document.getElementById('themeBtn').click()); await sleep(400);

  // panel
  await page.keyboard.press('y'); await sleep(1200);
  const state = await page.evaluate(() => ({
    open: !document.getElementById('statsModal').hidden,
    summary: document.getElementById('statsSummary').textContent.replace(/\s+/g, ' ').trim(),
    sessionRows: document.querySelectorAll('#statsTable tbody tr').length,
    sessionFirst: [...document.querySelectorAll('#statsTable tbody tr')].slice(0, 3).map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    serverRows: document.querySelectorAll('#statsServerTable tbody tr').length,
    serverFirst: [...document.querySelectorAll('#statsServerTable tbody tr')].slice(0, 3).map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    hook: window.__galleryStats().totals,
  }));
  console.log('面板状态:', JSON.stringify(state, null, 1));

  await page.screenshot({ path: 'H:/HDownload/Flickr-Gallery/logs/stats-panel.png' });
  console.log('截图: H:\\HDownload\\Flickr-Gallery\\logs\\stats-panel.png');

  // close via Esc, reopen via button
  await page.keyboard.press('Escape'); await sleep(400);
  const closed = await page.evaluate(() => document.getElementById('statsModal').hidden);
  await page.evaluate(() => document.getElementById('statsBtn').click()); await sleep(600);
  const reopened = await page.evaluate(() => !document.getElementById('statsModal').hidden);
  console.log(`Esc 关闭: ${closed}   按钮重新打开: ${reopened}`);

  console.log('JS 错误:', errs.length ? JSON.stringify(errs.slice(0, 3)) : '无');
  await browser.close();
})().catch(e => { console.error('PROBE-FATAL', e.message); process.exit(1); });
