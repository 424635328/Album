'use strict';
/* Flickr-Gallery one-click dev/preview server — zero dependencies (Node built-ins only).
 *
 *   node server.js [--port 8420] [--no-open]
 *
 * Features
 *   • Static serving of the gallery website (C:\FlickrGallery)
 *   • Route /Flickr/...         -> H:\HDownload\Flickr   (originals, read-only, traversal-guarded)
 *   • Route /assets/...         -> C:\FlickrGalleryAssets (thumbs + preview)
 *   • Hot reload: SSE endpoint /__lr + fs.watch on HTML/CSS/JS/data.js → every open tab auto-refreshes
 *   • Auto-opens the default browser (disable with --no-open)
 *   • Port collision → auto-increments up to +20
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const log = require('./logger');
const latency = require('./latency');

const GALLERY = path.resolve(__dirname, '..');                    // gallery website root

const args = process.argv.slice(2);
const argNum = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) || d : d; };
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
let PORT = argNum('--port', 8420);
const NO_OPEN = args.includes('--no-open');

/* Source folder + dataset
     --src <dir>      folder of originals to serve   (default: ../Flickr)
     --dataset <id>   serve sets/<id>/{data.js,assets} instead of the legacy root
                      layout, so different folders keep separate manifests/assets. */
const DATASET = argVal('--dataset', '');
const FLICKR = path.resolve(argVal('--src', path.join(GALLERY, '..', 'Flickr')));
const ASSETS_ROOT = DATASET ? path.join(GALLERY, 'sets', DATASET, 'assets') : path.join(GALLERY, 'assets');
const DATA_FILE = DATASET ? path.join(GALLERY, 'sets', DATASET, 'data.js') : path.join(GALLERY, 'data.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/* ---------------- SSE hot-reload hub ---------------- */

/* --no-reload disables both the watcher and the injected client, so a test run can
   never have its page reloaded out from under it. */
const NO_RELOAD = args.includes('--no-reload');

const clients = new Set();

function broadcast(msg) {
  for (const res of clients) {
    try { res.write('data: ' + msg + '\n\n'); } catch { clients.delete(res); }
  }
}

setInterval(() => {
  for (const res of clients) { try { res.write(': hb\n\n'); } catch { clients.delete(res); } }
}, 25000).unref();

function injectReloadClient(html) {
  if (NO_RELOAD) return html;
  if (!/<\/body>/i.test(html)) return html;
  const snippet = '<script>window.__GALLERY_LOG_LEVEL=' + JSON.stringify(log.getLevel()) + ';' +
    '(function(){try{var es=new EventSource("/__lr");' +
    'es.onmessage=function(e){if(e.data==="reload"){location.reload();}};' +
    '}catch(e){}})();</script>';
  return html.replace(/<\/body>/i, snippet + '</body>');
}

/* Allow-list, not deny-list: only the files whose edit actually changes the page may
   trigger a refresh. A deny-list reloaded every open tab on any other write in the
   gallery root (stray files, .gitignore, logs) — and it broke a test run mid-flight. */
const RELOAD_SOURCES = /^(index\.html|styles\.css|app\.js|config\.js|data\.js|folders\.json)$/i;
const RELOAD_DATASET = /^sets[\\/][^\\/]+[\\/]data\.js$/i;
let reloadTimer = null;
if (!NO_RELOAD) {
  try {
    fs.watch(GALLERY, { persistent: true }, (event, file) => {
      const f = String(file || '');
      if (!RELOAD_SOURCES.test(f) && !RELOAD_DATASET.test(f)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        broadcast('reload');
        log.debug('hot-reload', `"${f}" changed → refreshing ${clients.size} client(s)`);
      }, 200);
    });
  } catch (e) {
    log.warn('hot-reload', 'watcher unavailable: ' + e.message);
  }
}

/* ---------------- static file serving ---------------- */

function cacheFor(abs) {
  if (/\.(webp|jpe?g|png|gif|ico|svg)$/i.test(abs)) return 'public, max-age=86400';
  return 'no-cache';
}

/* ---- access protection ---------------------------------------------------
   1. Referer allow-list: media is only served to pages hosted on this machine,
      so a copied image URL opened elsewhere (or a bare curl) gets 403.
      Anything that passes the allow-list is the machine's own browser, which is
      why a separate rate limit would only hurt normal browsing.
   2. Content-Disposition: inline + nosniff → no download prompt / no sniffing.
   Note: a browser fundamentally cannot stop screenshots or "save displayed
   image"; these measures stop direct downloads and hot-linking. */
const ALLOWED_REF = [
  /^https?:\/\/localhost(:\d+)?(\/|$)/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?(\/|$)/i,
  /^https?:\/\/\[::1\](:\d+)?(\/|$)/i,
];
function refererAllowed(req) {
  const ref = req.headers.referer || req.headers.origin || '';
  if (!ref) return false;
  return ALLOWED_REF.some((re) => re.test(ref));
}

function sendFile(req, res, abs, opts) {
  const ext = path.extname(abs).toLowerCase();
  const stat = fs.statSync(abs);
  const isHtml = ext === '.html' || ext === '.htm';
  const guard = opts && opts.guard;                      // media route → apply protection
  const isMedia = /\.(webp|jpe?g|png|gif)$/i.test(abs);

  if (guard && isMedia && !refererAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403 forbidden: direct access disabled');
    return;
  }

  if (isHtml && stat.size < 5 * 1024 * 1024) {
    const body = Buffer.from(injectReloadClient(fs.readFileSync(abs, 'utf8')));
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(body);
    return;
  }

  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheFor(abs),
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',      // allow the Netlify page to embed these
  };
  if (isMedia) headers['Content-Disposition'] = 'inline';

  // HTTP Range support (206): resume-friendly for 36–78 MB originals
  const range = req.headers.range;
  let start = 0, end = stat.size - 1, code = 200;
  if (range && isMedia) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      if (m[1] === '' && m[2] !== '') { const n = parseInt(m[2], 10); start = Math.max(0, stat.size - n); }
      else { start = parseInt(m[1] || '0', 10); if (m[2]) end = parseInt(m[2], 10); }
      if (isNaN(start) || isNaN(end) || start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(abs, { start, end });
  stream.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
  stream.pipe(res);
}

/* A long-running local server must survive individual bad requests. */
process.on('uncaughtException', (e) => log.error('server', 'recovered: ' + e.message));
process.on('unhandledRejection', (e) => log.error('server', 'rejection: ' + (e && e.message || e)));

const server = http.createServer((req, res) => {
  res.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  if (urlPath === '/__lr') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 1500\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // With an active dataset the page's `data.js` request is served from
  // sets/<id>/data.js, so the same index.html works for any folder.
  if (DATASET && urlPath === '/data.js') {
    if (!fs.existsSync(DATA_FILE)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404: dataset not built: ' + DATASET);
      return;
    }
    try { sendFile(req, res, DATA_FILE, {}); }
    catch (e) { res.writeHead(500).end('500: ' + e.message); }
    return;
  }

  /* ---- client behaviour telemetry ---------------------------------------
     The page batches clicks, image-load outcomes and JS errors and posts them
     here via navigator.sendBeacon. They go through the same leveled logger:
     errors always, normal events at INFO, chatty ones only in --debug mode. */
  if (urlPath === '/__log' && req.method === 'POST') {
    let body = '', size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) { req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const batch = Array.isArray(parsed && parsed.batch) ? parsed.batch : [];
        for (const ev of batch) {
          if (!ev || typeof ev !== 'object') continue;
          const name = String(ev.event || 'event');
          const detail = ev.data ? ' ' + JSON.stringify(ev.data) : '';
          const level = ev.level === 'error' ? 'error' : ev.level === 'debug' ? 'debug' : 'info';
          latency.observe(name, ev.data);                     // running mean per event
          log[level]('client', name + detail);
        }
      } catch { /* malformed payload — ignore */ }
      res.writeHead(204).end();
    });
    return;
  }

  /* ---- on-demand latency means ------------------------------------------
     The same aggregate the periodic record writes to the log, available as JSON so
     a test or a monitoring script does not have to parse the log file. */
  if (urlPath === '/__stats') {
    const snap = latency.snapshot();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ generated: new Date().toISOString(), events: snap }, null, 2));
    return;
  }

  let base, rel, guard = false;
  if (urlPath === '/Flickr' || urlPath.startsWith('/Flickr/')) {
    base = FLICKR;
    rel = urlPath.slice('/Flickr'.length) || '/';
    guard = 'strict';                               // originals: strict rate limit
  } else if (urlPath.startsWith('/assets/')) {
    base = ASSETS_ROOT;
    rel = urlPath.slice('/assets'.length) || '/';
    guard = 'loose';                                // thumbnails/previews: browse-friendly
  } else {
    base = GALLERY;
    rel = urlPath;
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  const abs = path.resolve(base, '.' + rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let target = abs;
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found: ' + rel);
    return;
  }

  try {
    sendFile(req, res, target, { guard });
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500: ' + e.message);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && PORT < 8440) {
    log.info('server', `port ${PORT} busy → trying ${PORT + 1}`);
    PORT += 1;
    server.listen(PORT, '127.0.0.1');
  } else {
    log.error('server', 'fatal: ' + e.message);
    process.exit(1);
  }
});

/* Mirror every record — server routing AND the browser's own telemetry — to a
   rotating file, so a detached server keeps its log instead of losing it with the
   console. Disable with --no-log-file. */
const LOG_FILE = !args.includes('--no-log-file') ? log.attachFile(path.join(GALLERY, 'logs'), 'gallery') : null;

/* Record the current event-latency means on a fixed cadence (default 60s, --stats-sec 0
   disables). Only windows with activity are written, so an idle gallery stays quiet. */
const STATS_SEC = argNum('--stats-sec', 60);
latency.startPeriodic((line) => log.info('stats', '事件延迟均值(近 ' + STATS_SEC + 's): ' + line), STATS_SEC);

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  const line = '─'.repeat(52);
  console.log('');
  console.log(line);
  console.log('  风景画廊 · Landscape Gallery');
  console.log(`  地址      ${url}`);
  if (DATASET) console.log(`  数据集    ${DATASET}   (data.js → sets\\${DATASET}\\data.js)`);
  console.log(`  图片目录  ${FLICKR}`);
  console.log(`  资产目录  ${ASSETS_ROOT}`);
  console.log(`  热更新    ${NO_RELOAD ? '已关闭 (--no-reload)' : '已启用(仅 index/styles/app/config/data.js 变化才刷新)'}`);
  console.log(`  日志      ${LOG_FILE || '(仅控制台)'}${log.isDebug() ? '' : '   [--debug 可记录每次路由与解码预热]'}`);
  console.log(`  延迟均值  ${STATS_SEC ? `每 ${STATS_SEC}s 记录一行 [stats];随时查看 http://127.0.0.1:${PORT}/__stats` : '已关闭 (--stats-sec 0)'}`);
  console.log('  停止      关闭本窗口 或 Ctrl+C(或双击 stop-gallery.cmd)');
  console.log(line);
  console.log('');
  if (!NO_OPEN) {
    try {
      const child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch { /* user can open the URL manually */ }
  }
});
