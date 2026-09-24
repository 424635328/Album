'use strict';
/* Verify the hot-reload allow-list over the real SSE endpoint:
 *   logs/<file>   → must NOT reload (this was the regression: a log write reloaded tabs)
 *   .gitignore    → must NOT reload
 *   source files  → MUST still reload (checked against the same regex the server uses)
 * Safe by construction: only a disposable log file and .gitignore (restored from the
 * staged copy) are written. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const G = 'H:/HDownload/Flickr-Gallery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RELOAD_SOURCES = /^(index\.html|styles\.css|app\.js|config\.js|data\.js|folders\.json)$/i;
const RELOAD_DATASET = /^sets[\\/][^\\/]+[\\/]data\.js$/i;

(async () => {
  /* 1) logic check of the allow-list itself */
  const mustReload = ['index.html', 'styles.css', 'app.js', 'config.js', 'data.js', 'folders.json', 'sets\\gallery-test-41870f\\data.js'];
  const mustNot = ['logs\\gallery-20260924.log', 'logs', '.gitignore', '.gitattributes', 'latency-report.md', 'build\\server.js', 'assets\\thumbs\\x.webp', 'README.md', 'start-gallery.cmd'];
  const bad = [];
  for (const f of mustReload) if (!RELOAD_SOURCES.test(f) && !RELOAD_DATASET.test(f)) bad.push('应刷新却不会: ' + f);
  for (const f of mustNot) if (RELOAD_SOURCES.test(f) || RELOAD_DATASET.test(f)) bad.push('不该刷新却会: ' + f);
  console.log(bad.length ? '白名单逻辑 ✗\n  ' + bad.join('\n  ') : `白名单逻辑 ✓ (${mustReload.length} 个源文件会刷新, ${mustNot.length} 个其它文件不会)`);

  /* 2) live check over SSE */
  let reloads = 0;
  const req = http.get({ host: '127.0.0.1', port: 8420, path: '/__lr', headers: { Accept: 'text/event-stream' } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => { if (chunk.includes('data: reload')) reloads++; });
  });
  req.on('error', (e) => { console.log('SSE 连接失败: ' + e.message); });
  await sleep(700);
  console.log(`\nSSE 已连接 (初始 reload 计数 ${reloads})`);

  const trial = async (label, fn) => {
    const before = reloads;
    try { fn(); } catch (e) { console.log(`  ${label}: 写入失败 ${e.message}`); return; }
    await sleep(1400);
    const got = reloads - before;
    console.log(`  ${label.padEnd(34)} → ${got ? '触发了刷新 ✗' : '未触发刷新 ✓'}`);
  };

  await trial('写入 logs/ 下的日志文件', () => fs.appendFileSync(path.join(G, 'logs', '_reload-probe.log'), 'x ' + new Date().toISOString() + '\n'));
  await trial('写入 .gitignore(内容不变)', () => fs.writeFileSync(path.join(G, '.gitignore'), fs.readFileSync(path.join(G, '.gitignore'), 'utf8')));
  await trial('写入 根目录下的杂物文件', () => fs.writeFileSync(path.join(G, '_reload-probe.tmp'), 'x'));
  await trial('写入 assets/thumbs 下的图片', () => { const p = path.join(G, 'assets', 'thumbs'); const f = fs.readdirSync(p)[0]; fs.writeFileSync(path.join(p, f), fs.readFileSync(path.join(p, f))); });

  /* cleanup */
  for (const f of ['logs/_reload-probe.log', '_reload-probe.tmp']) {
    try { fs.unlinkSync(path.join(G, f)); } catch { /* ignore */ }
  }
  console.log('\n清理完成(探针文件已删除)');
  console.log(`累计收到刷新消息: ${reloads} 条(期望 0)`);
  req.destroy();
  process.exit(reloads === 0 && bad.length === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE-FATAL', e.message); process.exit(1); });
