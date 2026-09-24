'use strict';
/* Verifies the transitional layer's upgrade path:
   frame 0 = cached 640px thumbnail, then the 2560px preview, then the original.
   Run against a live server:  node transition-check.js [port] */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = process.argv[2] || '8420';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-gpu', '--no-proxy-server'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 60000 });
  await sleep(2500);

  const box = await (await p.$('.card')).boundingBox();
  const t0 = Date.now();
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const samples = [];
  for (let i = 0; i < 14; i++) {
    const st = await p.evaluate(() => {
      const tr = document.getElementById('lbImgTrans');
      const layers = [document.getElementById('lbImgA'), document.getElementById('lbImgB')];
      const front = layers.find(x => x.classList.contains('show'));
      const kind = (tr.currentSrc || '').indexOf('/preview/') >= 0 ? 'preview' : (tr.currentSrc || '').indexOf('/thumbs/') >= 0 ? 'thumb' : 'none';
      return {
        transPx: tr.naturalWidth,
        transKind: kind,
        transVisible: tr.classList.contains('show'),
        frontPx: front ? front.naturalWidth : 0,
      };
    });
    samples.push(`${String(Date.now() - t0).padStart(4)}ms  trans=${st.transKind}/${st.transPx}px visible=${st.transVisible}  original=${st.frontPx}px`);
    if (st.frontPx > 5000) break;
    await sleep(120);
  }
  console.log('过渡层升级时序:');
  samples.forEach(s => console.log('  ' + s));
  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
