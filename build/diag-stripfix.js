'use strict';
/* Probe: nav → strip jump must leave the VISIBLE layer showing the target photo and
   must arm the slideshow. This is the exact sequence that used to double-finish(). */
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
  const loads = [];
  page.on('request', r => { if (/Flickr\/.*\.jpe?g$/i.test(r.url())) loads.push(r.url().split('/').pop().slice(0, 26)); });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 30000 });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 30000 });
  await sleep(1200);

  await page.evaluate(() => document.querySelector('.card').click());
  await page.waitForFunction(() => !document.getElementById('lightbox').hidden, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.strip-item').length > 5, { timeout: 15000 });
  await sleep(500);

  let bad = 0;
  for (const [navFirst, stripIdx] of [[false, 1], [true, 2], [true, 3], [false, 5]]) {
    // nav first: leaves a prefetch / in-flight buffer in the layer the strip jump will reuse
    if (navFirst) { await page.evaluate(() => document.getElementById('lbNext').click()); await sleep(80); }
    await page.evaluate((k) => document.querySelectorAll('.strip-item')[k].click(), stripIdx);
    await page.waitForFunction(() => {
      const s = window.__galleryState();
      return s.displayed === s.key && s.pending === null && !s.loading;
    }, { timeout: 25000 }).catch(() => {});
    await sleep(400);
    const st = await page.evaluate(() => window.__galleryState());
    const shownRight = st.frontShown && st.frontSrc === st.file;
    if (!shownRight) bad++;
    console.log(`${shownRight ? '✓' : '✗'} 跳到第 ${stripIdx + 1} 张(先导航=${navFirst})  idx=${st.idx} key=${st.key} displayed=${st.displayed} ${shownRight ? '' : `显示层=${st.frontSrc} 期望=${st.file} `}scale=${st.scale}`);
  }

  console.log('\n--- 播放按钮(当前照片已加载, 应立即进入倒计时) ---');
  await page.evaluate(() => document.getElementById('lbSlideBtn').click());
  await page.waitForFunction(() => window.__galleryState().slideArmed === true, { timeout: 10000 })
    .then(() => console.log('✓ 幻灯片已进入倒计时'))
    .catch(async () => { bad++; console.log('✗ 幻灯片未启动', JSON.stringify(await page.evaluate(() => window.__galleryState()))); });
  await page.keyboard.press(' '); await sleep(200);

  console.log(`\n原图请求 ${loads.length} 次, 重复请求: ${loads.filter((u, i) => loads.indexOf(u) !== i).length}`);
  console.log('JS 错误:', errs.length ? JSON.stringify(errs.slice(0, 3)) : '无');
  console.log(bad === 0 ? '\n结论: 全部通过 ✓' : `\n结论: ${bad} 项失败 ✗`);
  await browser.close();
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('PROBE-FATAL', e.message); process.exit(1); });
