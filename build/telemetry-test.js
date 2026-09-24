'use strict';
/* Telemetry smoke test: drives real interactions against a running server and
 * lets you verify that client events reach the server log.
 *
 *   node telemetry-test.js [port]        (default 8450)
 * then check the server output for lines containing "[client]".
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = process.argv[2] || '8450';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu', '--no-proxy-server'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 60000 });
  await sleep(4000);

  // interactions: random photo → favourite inside lightbox → next → theme → close
  await p.evaluate(() => document.getElementById('randomBtn').click());
  await sleep(3500);
  await p.evaluate(() => { const btn = document.querySelector('[data-act="fav"]'); if (btn) btn.click(); });
  await sleep(600);
  await p.keyboard.press('ArrowRight');
  await sleep(3000);
  await p.evaluate(() => document.getElementById('themeBtn').click());
  await sleep(400);
  await p.keyboard.press('Escape');
  await sleep(3000);                       // let the batch flush timer fire

  await b.close();
  console.log('interactions done on port ' + PORT);
})().catch(e => { console.error('TEST-FATAL', e.message); process.exit(1); });
