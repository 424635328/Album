'use strict';
/* Latency probe v2 — STRICT judging.
 * The previous version was a false positive: it read `img.show`, which matched
 * the still-visible OLD layer (or the transitional layer), and reported
 * "shown" while nothing had actually changed.
 *
 * Now: the front layer must carry the TARGET key AND be decoded, and two rAFs
 * must have passed, before it counts as painted. The transitional layer is
 * measured separately — that is the moment the user actually SEES the new photo.
 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { spawn } = require('child_process');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn('node', ['server.js', '--no-open'], { cwd: __dirname, stdio: 'ignore', detached: true });
  srv.unref();
  await sleep(1500);

  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1050 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message || e)));
  await page.goto('http://127.0.0.1:8420/', { waitUntil: 'load' });
  await sleep(2500);
  await page.mouse.click(300, 400);          // open first photo
  await sleep(11000);                        // let it load and prefetch settle

  async function measure(label, action, budgetMs = 25000) {
    await page.evaluate(() => performance.clearMarks());
    const t0 = Date.now();
    await action();
    const target = await page.evaluate(() => location.hash.replace('#p=', ''));
    let fullAt = null;
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const st = await page.evaluate(() => {
        const layers = [document.getElementById('lbImgA'), document.getElementById('lbImgB')];
        const front = layers.find(i => i.classList.contains('show'));
        return {
          frontKey: front && front.dataset.key,
          frontReady: !!(front && front.complete && front.naturalWidth > 0),
        };
      });
      if (st.frontKey === target && st.frontReady) { fullAt = Date.now(); break; }
      await sleep(8);
    }
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    // in-page marks: immune to CDP round-trip overhead
    const mk = await page.evaluate(() => {
      const last = (n) => { const e = performance.getEntriesByName(n); return e.length ? e[e.length - 1].startTime : null; };
      return { nav: last('lb-nav'), trans: last('lb-trans'), ready: last('lb-ready') };
    });
    const t = (v) => (v === null ? null : Math.round(v));
    const ms = (a, b) => (a === null || b === null ? null : Math.round((b - a)) + ' ms');
    console.log(`  ${label}`);
    console.log(`    [页面内计时] 过渡层显示(用户看到新画面): ${mk.trans !== null && mk.nav !== null ? ms(mk.nav, mk.trans) : '未使用过渡层(预取直接命中)'}`);
    console.log(`    [页面内计时] 原图就绪: ${ms(mk.nav, mk.ready)}`);
    console.log(`    [探针观测]   原图就绪: ${fullAt ? (fullAt - t0) + ' ms (含探针往返开销)' : 'TIMEOUT'}`);
  }

  console.log('\n=== 优化后延迟实测 ===');
  await sleep(4000);   // settle so the prefetch pipeline has finished its work
  await measure('① 预取命中(停留 4s 后按下一张)', async () => { await page.keyboard.press('ArrowRight'); });
  await sleep(6000);
  await measure('② 冷切换(End 远跳,预取覆盖不到)', async () => page.keyboard.press('End'));
  await sleep(6000);
  await measure('③ 冷切换(Home 远跳返回)', async () => page.keyboard.press('Home'));

  console.log('\n=== 连续快翻 5 张 ===');
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) { await page.keyboard.press('ArrowRight'); await sleep(120); }
  await sleep(8000);
  const final = await page.evaluate(() => {
    const layers = [document.getElementById('lbImgA'), document.getElementById('lbImgB')];
    const front = layers.find(i => i.classList.contains('show'));
    return { hash: location.hash, frontKey: front && front.dataset.key, ready: !!(front && front.complete && front.naturalWidth > 0) };
  });
  console.log(`  5 次快翻耗时 ${Date.now() - t0} ms`);
  console.log(`  最终状态: ${JSON.stringify(final)}`);
  console.log(`  hash 与显示层一致: ${final.hash.replace('#p=', '') === final.frontKey ? '✓' : '✗ 不一致!'}`);
  console.log(`  JS 错误: ${errs.length ? JSON.stringify(errs.slice(0, 3)) : '无'}`);

  await browser.close();
  try { process.kill(-srv.pid); } catch { try { srv.kill(); } catch { /* noop */ } }
})().catch(e => { console.error('PROBE-FATAL', e.message); process.exit(1); });
