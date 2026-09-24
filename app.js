/* Flickr Landscape Gallery — app.js
   Vanilla JS, zero dependencies, works over both file:// and the companion
   server (http://127.0.0.1:8420). URLs stay relative so the gallery folder is
   fully portable. Lightbox policy: clicking a photo loads the ORIGINAL file
   immediately — no intermediate preview tier.
   Performance: double-buffered switching, prefetch of the next original, and
   idle-time (requestIdleCallback) warming of previews off the critical path.
   - http:  /assets/... and /Flickr/... (served by build/server.js)
   - file:  ./assets/... and ../Flickr/... (sibling folder on the same drive) */
(() => {
'use strict';

/* ============================== Data & helpers ============================== */

const DATA = window.GALLERY_DATA;
const PHOTOS = DATA.photos;
const COL_BY_ID = new Map(DATA.collections.map(c => [c.id, c.name]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('fg.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fg.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/* ============================== Client telemetry ==============================
   Batches user interactions (clicks, image-load outcomes, JS errors) and posts
   them to the server, which writes them through its leveled logger. Disabled on
   file:// (no server to receive them). debug-level events are dropped unless the
   server runs with --debug. */
/* ============================== Latency statistics ==============================
   Every reported event that carries a numeric `ms` also feeds a local aggregator, so
   the statistics panel can show this session's means even in file:// mode (where no
   server exists to aggregate them). Keys mirror build/log-stats.js and build/latency.js
   exactly — click per target, photo.loaded/paint split by prefetch hit vs cold read —
   otherwise the panel, the log and the CLI report would disagree. */
const STATS = (() => {
  const map = new Map();
  const MAX_SAMPLES = 400;                 // per key; bounds memory, keeps percentiles sane
  const keyFor = (event, data) => {
    if (event === 'click' && data && data.target) return 'click:' + data.target;
    if (data && data.cached === true) return event + ' (预取命中)';
    if (data && data.cached === false) return event + ' (冷读)';
    return event;
  };
  function add(event, data) {
    const ms = data && typeof data.ms === 'number' ? data.ms : null;
    if (ms === null || !Number.isFinite(ms) || ms < 0) return;
    const key = keyFor(event, data);
    let s = map.get(key);
    if (!s) { s = { n: 0, sum: 0, min: Infinity, max: 0, samples: [] }; map.set(key, s); }
    s.n++; s.sum += ms; s.min = Math.min(s.min, ms); s.max = Math.max(s.max, ms);
    s.samples.push(ms);
    if (s.samples.length > MAX_SAMPLES) s.samples.shift();
  }
  const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null;
  function rows() {
    return [...map.entries()].map(([key, s]) => {
      const sorted = s.samples.slice().sort((a, b) => a - b);
      return { key, n: s.n, mean: Math.round(s.sum / s.n), median: pct(sorted, 50), p95: pct(sorted, 95), min: s.min, max: s.max, window: s.samples.length };
    }).sort((a, b) => b.n - a.n);
  }
  function totals() {
    let n = 0, sum = 0, worst = 0, worstKey = '';
    for (const r of rows()) { n += r.n; sum += r.mean * r.n; if (r.max > worst) { worst = r.max; worstKey = r.key; } }
    return { n, mean: n ? Math.round(sum / n) : 0, worst, worstKey, keys: map.size };
  }
  return { add, rows, totals, reset() { map.clear(); } };
})();

const WEBLOG = (() => {
  const level = (typeof window.__GALLERY_LOG_LEVEL === 'string') ? window.__GALLERY_LOG_LEVEL : 'info';
  let enabled = location.protocol !== 'file:';
  let queue = [], timer = null;
  function disable() { enabled = false; queue.length = 0; }
  function flush() {
    clearTimeout(timer); timer = null;
    if (!queue.length || !enabled) { queue.length = 0; return; }
    const payload = JSON.stringify({ batch: queue.splice(0, queue.length) });
    try {
      if (navigator.sendBeacon) {
        if (!navigator.sendBeacon('/__log', new Blob([payload], { type: 'application/json' }))) disable();
      } else {
        fetch('/__log', { method: 'POST', body: payload, keepalive: true })
          .then((r) => { if (r.status === 404 || r.status === 405) disable(); })
          .catch(disable);
      }
    } catch { disable(); }
  }
  function send(lv, event, data) {
    STATS.add(event, data);                               // local aggregation, always on
    if (!enabled) return;
    if (lv === 'debug') {
      // read at call time: the server injects __GALLERY_LOG_LEVEL into the page
      // after app.js has been parsed, so an init-time read would miss --debug
      const lvl = (typeof window.__GALLERY_LOG_LEVEL === 'string') ? window.__GALLERY_LOG_LEVEL : 'info';
      if (lvl !== 'debug') return;                        // chatty events only in debug mode
    }
    const ev = { level: lv, event };
    if (data) ev.data = data;
    queue.push(ev);
    if (queue.length >= 20) flush();
    else if (!timer) timer = setTimeout(flush, 1500);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);
  return { send, flush, level };
})();

/* Stopwatch used to report operation latency together with each event. */
const PERF = {
  _m: Object.create(null),
  now() { return (window.performance && performance.now) ? performance.now() : Date.now(); },
  mark(name) { this._m[name] = this.now(); },
  since(name) { const t = this._m[name]; return t === undefined ? null : Math.round(this.now() - t); },
};

const $ = (sel) => document.querySelector(sel);
const els = {
  grid: $('#grid'), empty: $('#empty'), chips: $('#chips'), search: $('#search'),
  searchClear: $('#searchClear'), sortSel: $('#sortSel'), orientSel: $('#orientSel'),
  camSel: $('#camSel'), density: $('#density'), stats: $('#stats'),
  themeBtn: $('#themeBtn'), helpBtn: $('#helpBtn'), helpModal: $('#helpModal'),
  helpClose: $('#helpClose'), clearFilters: $('#clearFilters'), toTop: $('#toTop'),
  lightbox: $('#lightbox'), lbStage: $('#lbStage'), lbZoom: $('#lbZoom'),
  imgs: [$('#lbImgA'), $('#lbImgB')], imgTrans: $('#lbImgTrans'), spinner: $('#lbSpinner'),
  lbPrev: $('#lbPrev'), lbNext: $('#lbNext'), lbCount: $('#lbCount'),
  lbTitle: $('#lbTitle'), lbZoomBadge: $('#lbZoomBadge'), lbProgress: $('#lbProgress'),
  lbInfo: $('#lbInfo'), infoTitle: $('#infoTitle'), infoBadges: $('#infoBadges'),
  infoList: $('#infoList'), infoLinks: $('#infoLinks'),
  lbStrip: $('#lbStrip'), lbStripInner: $('#lbStripInner'),
  lbSlideBtn: $('#lbSlideBtn'), lbStripBtn: $('#lbStripBtn'), lbFsBtn: $('#lbFsBtn'),
  randomBtn: $('#randomBtn'), playBtn: $('#playBtn'), yearSel: $('#yearSel'),
  favChip: $('#favChip'), favChipText: $('#favChipText'), resetBtn: $('#resetBtn'),
  copyListBtn: $('#copyListBtn'), slideMsRow: $('#slideMsRow'), helpStats: $('#helpStats'),
  lbFavBtn: $('#lbFavBtn'),
  statsBtn: $('#statsBtn'), statsModal: $('#statsModal'), statsClose: $('#statsClose'),
  statsRefresh: $('#statsRefresh'), statsCopy: $('#statsCopy'), statsSummary: $('#statsSummary'),
  statsTable: $('#statsTable'), statsServerTable: $('#statsServerTable'), statsNote: $('#statsNote'),
  toast: $('#toast'),
};

/* ---- asset source resolution -------------------------------------------
   The page can run in three situations:
     1. local file://  → assets beside the page, originals in ../Flickr
     2. local server   → /assets and /Flickr routes (build/server.js)
     3. hosted remotely (Netlify) → everything comes from the tunnel
   Priority: ?src=<tunnel> (shareable, also remembered) → localStorage fg.src →
   window.GALLERY_CONFIG.sourceBase (injected at deploy time) → relative paths. */
function resolveSourceBase() {
  try {
    const q = new URLSearchParams(location.search).get('src');
    if (q) { try { localStorage.setItem('fg.src', q); } catch { /* ignore */ } return q; }
    const saved = localStorage.getItem('fg.src');
    if (saved) return saved;
  } catch { /* ignore */ }
  const cfg = window.GALLERY_CONFIG || {};
  return cfg.sourceBase || '';
}
const SOURCE_BASE = String(resolveSourceBase() || '').replace(/\/+$/, '');
const FILE_MODE = location.protocol === 'file:' && !SOURCE_BASE;
const encodePath = (rel) => SOURCE_BASE
  ? SOURCE_BASE + '/Flickr/' + encodeURI(rel)
  : (FILE_MODE ? '../Flickr/' : '/Flickr/') + encodeURI(rel);
const assetURL = (p) => (SOURCE_BASE ? SOURCE_BASE + '/' + p : p);
const thumbURL = (k) => assetURL('assets/thumbs/' + k + '.webp');
const previewURL = (k) => assetURL('assets/preview/' + k + '.webp');

function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
}
const fmtMP = (p) => ((p.w * p.h) / 1e6).toFixed(1) + 'MP';
const fmtTime = (ts) => (ts ? ts.replace('T', '  ').slice(0, 16) : null);
function ratioClass(p) {
  const r = p.w / p.h;
  if (r >= 2.5) return 'pano';
  if (r > 1.05) return 'landscape';
  if (r < 0.95) return 'portrait';
  return 'square';
}
let tsvCache = new WeakMap();
function tsv(p) {
  let v = tsvCache.get(p);
  if (v === undefined) { v = p.ts ? Date.parse(p.ts) || 0 : -Infinity; tsvCache.set(p, v); }
  return v;
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 250);
  }, 1900);
}

function copyText(text, okMsg) {
  let settled = false;
  const done = () => { if (!settled) { settled = true; toast(okMsg || '已复制'); } };
  const fail = () => { if (!settled) { settled = true; toast('复制失败,请手动复制'); } };
  const fallback = () => {
    if (settled) return;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    ok ? done() : fail();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    // Some environments (headless / file://) leave the promise pending forever —
    // fall back to execCommand if it does not settle within 400 ms.
    navigator.clipboard.writeText(text).then(done, fallback);
    setTimeout(fallback, 400);
  } else fallback();
}

/* ============================== State ============================== */

const state = {
  col: LS.get('col', 'all'),
  q: '',
  sort: LS.get('sort', 'ts-desc'),
  orient: LS.get('orient', 'all'),
  cam: LS.get('cam', 'all'),
  year: LS.get('year', 'all'),
  onlyFav: LS.get('onlyFav', false),
  density: LS.get('density', 240),
  slideMs: LS.get('slideMs', 5000),
  theme: LS.get('theme', 'dark'),
};

/* Favourites: persisted set of photo keys. */
const favs = new Set(Array.isArray(LS.get('favs', [])) ? LS.get('favs', []) : []);
function saveFavs() { LS.set('favs', [...favs]); }

let view = [];          // filtered + sorted photo refs
let rows = [];          // justified layout rows
let gridW = 0;
let lastRandomKey = null;

/* ============================== Toolbar ============================== */

function buildChips() {
  const counts = new Map();
  for (const p of PHOTOS) {
    const id = p.f.split('/')[0];
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const frag = document.createDocumentFragment();
  const mk = (id, label, n) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.col = id;
    b.setAttribute('role', 'tab');
    const t = document.createElement('span'); t.textContent = label;
    const c = document.createElement('span'); c.className = 'n'; c.textContent = String(n);
    b.append(t, c);
    b.addEventListener('click', () => { state.col = id; LS.set('col', id); applyState(true); });
    return b;
  };
  frag.appendChild(mk('all', '全部', PHOTOS.length));
  for (const c of DATA.collections) {
    if (counts.has(c.id)) frag.appendChild(mk(c.id, c.name, counts.get(c.id)));
  }
  els.chips.replaceChildren(frag);
  syncChips();
}
function syncChips() {
  for (const b of els.chips.children) b.classList.toggle('active', b.dataset.col === state.col);
}

function buildCamSel() {
  const cams = new Map();
  for (const p of PHOTOS) {
    const c = p.cam || '未知相机';
    cams.set(c, (cams.get(c) || 0) + 1);
  }
  const list = [...cams.entries()].sort((a, b) => b[1] - a[1]);
  if (list.length < 2) { els.camSel.hidden = true; return; }
  els.camSel.hidden = false;
  els.camSel.replaceChildren(...list.map(([name]) => {
    const o = document.createElement('option');
    o.value = name === '未知相机' ? '__unknown__' : name;
    o.textContent = name;
    return o;
  }));
  const all = document.createElement('option');
  all.value = 'all'; all.textContent = '全部相机';
  els.camSel.prepend(all);
  els.camSel.value = state.cam;
}

function buildStats() {
  let bytes = 0, maxMP = 0;
  const cams = new Set();
  for (const p of PHOTOS) {
    bytes += p.b;
    if (p.cam) cams.add(p.cam);
    const mp = p.w * p.h;
    if (mp > maxMP) maxMP = mp;
  }
  els.stats.textContent =
    `${PHOTOS.length.toLocaleString()} 张照片 · ${(bytes / 1073741824).toFixed(0)} GB · ` +
    `${cams.size} 台相机 · 最大 ${(maxMP / 1e6).toFixed(0)}MP · ${DATA.collections.length} 个收藏集`;
}

/* Year filter, derived from EXIF capture dates. */
function buildYearSel() {
  const years = new Map();
  for (const p of PHOTOS) {
    const y = p.ts ? p.ts.slice(0, 4) : null;
    if (y) years.set(y, (years.get(y) || 0) + 1);
  }
  if (years.size < 2) { els.yearSel.hidden = true; return; }
  const list = [...years.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  els.yearSel.hidden = false;
  els.yearSel.replaceChildren(...list.map(([y, n]) => {
    const o = document.createElement('option');
    o.value = y; o.textContent = `${y} 年 (${n})`;
    return o;
  }));
  const all = document.createElement('option');
  all.value = 'all'; all.textContent = '全部年份';
  els.yearSel.prepend(all);
  if (!list.some(([y]) => y === state.year)) state.year = 'all';
  els.yearSel.value = state.year;
}

/* Live favourites UI. Chrome (chip + lightbox star) is cheap and updated on every
   navigation; the card sweep only runs when the grid is (re)rendered or a
   favourite is toggled, so switching photos never walks 3,688 nodes. */
function syncFavChrome() {
  const n = favs.size;
  els.favChip.hidden = n === 0;
  els.favChip.disabled = n === 0;
  els.favChip.classList.toggle('on', state.onlyFav);
  els.favChipText.textContent = `只看收藏 (${n})`;
  if (els.lbFavBtn) {
    const c = view[lb.idx];
    const on = !!(c && favs.has(c.k));
    els.lbFavBtn.classList.toggle('active', on);
    els.lbFavBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}
function syncFavCards() {
  for (const card of els.grid.querySelectorAll('.card')) {
    const on = favs.has(card.dataset.key);
    card.classList.toggle('fav', on);
    const b = card.querySelector('.fav-btn');
    if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  }
}
function syncFavUI() { syncFavChrome(); syncFavCards(); }

function setCardFav(key, on) {
  const card = els.grid.querySelector('.card[data-key="' + key + '"]');
  if (!card) return;
  card.classList.toggle('fav', on);
  const b = card.querySelector('.fav-btn');
  if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
}

function toggleFav(key) {
  const on = !favs.has(key);
  if (on) favs.add(key); else favs.delete(key);
  saveFavs();
  setCardFav(key, on);
  syncFavChrome();
  // when the "favourites only" filter is active the grid must react immediately
  if (state.onlyFav) applyState(false);
  toast(on ? '已收藏' : '已取消收藏');
}

function hasActiveFilters() {
  return state.col !== 'all' || !!state.q || state.orient !== 'all' ||
    state.cam !== 'all' || state.year !== 'all' || state.onlyFav;
}
function syncResetBtn() { els.resetBtn.hidden = !hasActiveFilters(); }

function randomPhoto() {
  if (!view.length) return;
  let i = Math.floor(Math.random() * view.length);
  // avoid repeating the previous random pick
  if (view.length > 1 && (view[i].k === lastRandomKey || view[i].k === lb.displayedKey)) {
    i = (i + 1 + Math.floor(Math.random() * (view.length - 1))) % view.length;
  }
  lastRandomKey = view[i].k;
  if (lb.open) jumpTo(i); else openLightbox(i);
}

function playFromStart() {
  if (!view.length) return;
  slideWanted = true;                     // must be set before loadCurrent so onload arms it
  openLightbox(0);
  els.lbSlideBtn.classList.add('active');
  toast('从第一张开始播放 · 空格暂停');
}

function resetAll() {
  state.col = 'all'; state.q = ''; state.orient = 'all';
  state.cam = 'all'; state.year = 'all'; state.onlyFav = false;
  els.search.value = ''; els.orientSel.value = 'all'; els.camSel.value = 'all';
  els.yearSel.value = 'all';
  LS.set('col', state.col); LS.set('orient', state.orient);
  LS.set('cam', state.cam); LS.set('year', state.year); LS.set('onlyFav', false);
  applyState(true);
}

/* Statistics shown inside the help modal. */
function renderStats() {
  let bytes = 0;
  const cams = new Map(), years = new Map(), orients = new Map();
  for (const p of PHOTOS) {
    bytes += p.b;
    if (p.cam) cams.set(p.cam, (cams.get(p.cam) || 0) + 1);
    if (p.ts) { const y = p.ts.slice(0, 4); years.set(y, (years.get(y) || 0) + 1); }
    const oc = ratioClass(p);
    orients.set(oc, (orients.get(oc) || 0) + 1);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const nameOf = { landscape: '横向', portrait: '纵向', square: '方形', pano: '全景' };
  const rows = [
    ['照片总数', PHOTOS.length.toLocaleString()],
    ['收藏', favs.size.toLocaleString()],
    ['总容量', (bytes / 1073741824).toFixed(1) + ' GB'],
    ['拍摄年份', years.size ? `${[...years.keys()].sort()[0]} – ${[...years.keys()].sort().pop()}` : '—'],
    ...top(orients, 4).map(([k, v]) => ['· ' + (nameOf[k] || k), v.toLocaleString()]),
    ...top(years, 6).map(([k, v]) => ['· ' + k + ' 年', v.toLocaleString()]),
    ...top(cams, 4).map(([k, v]) => ['· ' + k, v.toLocaleString()]),
  ];
  els.helpStats.innerHTML = '<h4>图库统计</h4><div class="stat-grid">' +
    rows.map(([k, v]) => `<span><em style="font-style:normal;color:var(--text-dim)">${k}</em><b>${v}</b></span>`).join('') +
    '</div>';
}

/* ============================== Filter / sort ============================== */

function filtered() {
  const q = state.q.trim().toLowerCase();
  const out = [];
  for (const p of PHOTOS) {
    if (state.onlyFav && !favs.has(p.k)) continue;
    if (state.col !== 'all' && !p.f.startsWith(state.col + '/')) continue;
    if (state.orient !== 'all' && ratioClass(p) !== state.orient) continue;
    if (state.year !== 'all' && (!p.ts || p.ts.slice(0, 4) !== state.year)) continue;
    if (state.cam !== 'all') {
      const c = p.cam || '__unknown__';
      if (c !== state.cam) continue;
    }
    if (q && !(p.t.toLowerCase().includes(q) || p.f.toLowerCase().includes(q))) continue;
    out.push(p);
  }
  const cmp = {
    'ts-desc': (a, b) => tsv(b) - tsv(a) || (a.f < b.f ? -1 : 1),
    'ts-asc': (a, b) => tsv(a) - tsv(b) || (a.f < b.f ? -1 : 1),
    'name-asc': (a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0),
    'size-desc': (a, b) => b.b - a.b,
    'mp-desc': (a, b) => b.w * b.h - a.w * a.h,
  }[state.sort] || ((a, b) => (a.f < b.f ? -1 : 1));
  out.sort(cmp);
  return out;
}

/* ============================== Justified layout ============================== */

const GAP = 8;
function layoutRows() {
  gridW = els.grid.clientWidth;
  if (gridW <= 0) return;
  const target = state.density;
  rows = [];
  let row = [], sum = 0;
  for (const p of view) {
    row.push(p); sum += p.w / p.h;
    const h = (gridW - GAP * (row.length - 1)) / sum;
    if (h <= target) { rows.push({ items: row, h }); row = []; sum = 0; }
  }
  if (row.length) {
    const h = Math.min(target, (gridW - GAP * (row.length - 1)) / sum);
    rows.push({ items: row, h });
  }
}

/* Batched rendering: paint the first screen immediately, then insert the
   remaining rows a frame at a time. A full 3,688-card render (~22k DOM nodes)
   used to block the main thread for ~1s; now the first screen paints in <80ms. */
let renderGen = 0;
function renderGrid() {
  const gen = ++renderGen;
  gridW = els.grid.clientWidth;
  const total = rows.length;
  els.grid.replaceChildren();
  els.grid.hidden = total === 0;
  if (!total) return;
  let ri = 0, gi = 0;
  const BATCH = 30;

  function chunk() {
    if (gen !== renderGen) return;             // superseded by a newer render
    const frameT0 = PERF.now();
    const frag = document.createDocumentFragment();
    let n = 0;
    // Fill the frame budget instead of a fixed row count: the whole 715-row grid
    // used to take ~24 round-trips (~700ms); with a ~12ms budget it finishes in
    // a few frames while still yielding between them.
    while (ri < total && (n === 0 || PERF.now() - frameT0 < 12)) {
      const rowEl = document.createElement('div');
      rowEl.className = 'row';
      rowEl.style.height = rows[ri].h + 'px';
      for (const p of rows[ri].items) rowEl.appendChild(makeCard(p, rows[ri].h, gi++));
      frag.appendChild(rowEl);
      ri++; n++;
    }
    els.grid.appendChild(frag);
    if (ri <= BATCH) WEBLOG.send('info', 'page.firstPaint', { ms: Math.round(PERF.now()), rows: ri });
    if (ri < total) requestAnimationFrame(() => setTimeout(chunk, 0));
    else syncFavCards();                       // whole grid done → reconcile star states
  }
  chunk();
}

function makeCard(p, h, idx) {
  const w = (p.w / p.h) * h;
  const fig = document.createElement('figure');
  fig.className = 'card';
  fig.style.width = w.toFixed(1) + 'px';
  if (p.lq) fig.style.setProperty('--lq', `url("${p.lq}")`);
  fig.tabIndex = 0;
  fig.setAttribute('role', 'button');
  fig.setAttribute('aria-label', p.t);
  fig.dataset.idx = idx;
  fig.dataset.key = p.k;
  if (favs.has(p.k)) fig.classList.add('fav');

  const img = document.createElement('img');
  img.alt = p.t;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = thumbURL(p.k);
  const thumbT0 = PERF.now();
  img.addEventListener('load', () => {
    fig.classList.add('ld');
    const ms = Math.round(PERF.now() - thumbT0);
    if (ms > 2000) WEBLOG.send('warn', 'thumb.slow', { k: p.k, ms: ms });
  }, { once: true });
  img.addEventListener('error', () => {
    fig.classList.add('err');
    WEBLOG.send('error', 'thumb.error', { k: p.k });
  }, { once: true });
  fig.appendChild(img);

  // favourite star (must not open the lightbox)
  const favBtn = document.createElement('button');
  favBtn.type = 'button';
  favBtn.className = 'fav-btn' + (favs.has(p.k) ? ' on' : '');
  favBtn.title = '收藏 (S)';
  favBtn.setAttribute('aria-label', '收藏 ' + p.t);
  favBtn.setAttribute('aria-pressed', favs.has(p.k) ? 'true' : 'false');
  favBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8-5.2-2.75L6.8 19.6l1-5.8-4.2-4.1 5.8-.85z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  favBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFav(p.k); });
  favBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
  fig.appendChild(favBtn);

  // Hover-prefetch: after 350ms of hovering, start loading this ORIGINAL so the
  // imminent click opens it almost instantly (decode cache does the rest).
  fig.addEventListener('mouseenter', () => {
    clearTimeout(fig._pfT);
    // 120ms of intent is enough: start the original AND warm the small preview,
    // so clicking a hovered photo is usually instant.
    fig._pfT = setTimeout(() => { warmPreview(p.k); ensurePreloaded(p.k, p.f, p.w, p.h); }, 120);
  });
  fig.addEventListener('mouseleave', () => clearTimeout(fig._pfT));

  const cap = document.createElement('figcaption');
  const t = document.createElement('div'); t.className = 'cap-t'; t.textContent = p.t;
  const m = document.createElement('div'); m.className = 'cap-m';
  m.textContent = [fmtTime(p.ts) || null, fmtMP(p)].filter(Boolean).join(' · ');
  cap.append(t, m);
  fig.appendChild(cap);

  if (state.col === 'all') {
    const tag = document.createElement('span');
    tag.className = 'cap-col';
    tag.textContent = COL_BY_ID.get(p.f.split('/')[0]) || '';
    fig.appendChild(tag);
  }

  fig.addEventListener('click', (e) => {
    if (fig.classList.contains('err')) { // retry
      fig.classList.remove('err');
      img.src = thumbURL(p.k);
      return;
    }
    PERF.mark('open');                       // latency start: click → first painted frame
    openLightbox(Number(fig.dataset.idx));
  });
  fig.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(Number(fig.dataset.idx)); }
  });
  return fig;
}

/* ============================== Apply state ============================== */

function applyState(scrollTop) {
  const applyT0 = PERF.now();
  view = filtered();
  layoutRows();
  renderGrid();
  els.empty.hidden = view.length > 0;
  els.grid.hidden = view.length === 0;
  syncChips();
  syncFavUI();
  syncResetBtn();
  els.searchClear.hidden = !state.q;
  if (scrollTop) window.scrollTo({ top: 0 });
  WEBLOG.send('info', 'filter.apply', {
    ms: Math.round(PERF.now() - applyT0), results: view.length,
    col: state.col, orient: state.orient, year: state.year,
    fav: state.onlyFav, search: state.q ? 1 : 0,
  });
}

const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

/* True idle-time scheduling: runs the callback only when the main thread is
   otherwise free (with a timeout cap so important work is never starved).
   Safari has no requestIdleCallback → falls back to a short timer. */
function idle(fn, timeout = 800) {
  if (window.requestIdleCallback) {
    const id = requestIdleCallback((deadline) => fn(deadline), { timeout });
    return () => cancelIdleCallback(id);
  }
  const t = setTimeout(() => fn({ timeRemaining: () => 12 }), 120);
  return () => clearTimeout(t);
}

new ResizeObserver(debounce(() => {
  if (Math.abs(els.grid.clientWidth - gridW) > 2 && view.length) {
    layoutRows();
    renderGrid();
  }
}, 120)).observe(els.grid);

/* ============================== Lightbox ============================== */

const lb = {
  open: false,
  idx: -1,
  scale: 1, tx: 0, ty: 0,
  front: 0,          // which buffer layer is currently visible (0 = A, 1 = B)
  loadToken: 0,      // increments per navigation; stale load callbacks are dropped
  displayedKey: null, // key of the photo currently VISIBLE (not just loading)
  pendingKey: null,  // key the buffer layer is loading for the FOREGROUND (blocks prefetch)
  loadWatch: null,   // safety net for a missed onload
  slideTimer: null,
  stripVisible: LS.get('strip', true),
  infoVisible: false,
  fullLoaded: new Set(),
};

function cur() { return view[lb.idx]; }
const frontImg = () => els.imgs[lb.front];
/* File names contain spaces and CJK, so compare them decoded (and never let a
   malformed escape sequence throw inside the diagnostics accessor). */
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

function openLightbox(idx) {
  if (!view.length) return;
  lb.idx = Math.max(0, Math.min(idx, view.length - 1));
  lb.open = true;
  els.lightbox.hidden = false;
  document.body.classList.add('lb-open');
  els.grid.setAttribute('inert', '');
  $('#topbar').setAttribute('inert', '');
  els.lbStrip.hidden = !lb.stripVisible;
  els.lbStripBtn.classList.toggle('active', lb.stripVisible);
  buildStrip();
  loadCurrent();
  WEBLOG.send('info', 'photo.open', { k: cur().k, index: lb.idx, of: view.length });
  els.lbStage.focus({ preventScroll: true });
  history.replaceState(null, '', '#p=' + cur().k);
}

function closeLightbox() {
  if (!lb.open) return;
  lb.open = false;
  slideWanted = false;
  stopSlide();
  clearTimeout(lb.loadWatch); lb.loadWatch = null;   // no watchdog firing into a closed viewer
  lb.pendingKey = null;
  // Fullscreen was entered from the lightbox, so leaving the lightbox should leave it
  // too — otherwise the user lands on the grid still stuck in fullscreen.
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  els.lightbox.hidden = true;
  document.body.classList.remove('lb-open');
  els.grid.removeAttribute('inert');
  $('#topbar').removeAttribute('inert');
  els.lbInfo.hidden = true;
  lb.infoVisible = false;
  els.lightbox.querySelector('[data-act="info"]').classList.remove('active');
  document.title = '风景画廊 · Flickr Landscape Gallery';
  history.replaceState(null, '', location.pathname + location.search);
  const card = els.grid.querySelector(`[data-idx="${lb.idx}"]`);
  if (card) card.focus({ preventScroll: true });
}

function loadCurrent() {
  const p = cur();
  if (!p) return;
  if (window.performance && performance.mark) performance.mark('lb-nav');
  lb.navAt = (window.performance && performance.now) ? performance.now() : 0;
  clearTimeout(lb.slideTimer); lb.slideTimer = null;   // slideshow re-arms after the new image loads
  els.lbProgress.hidden = true;

  els.lbCount.textContent = `${lb.idx + 1} / ${view.length}`;
  els.lbTitle.textContent = p.t;
  els.lbTitle.title = p.t;
  document.title = p.t + ' · 风景画廊';

  /* Every photo change starts at fit. Resetting HERE, at navigation time, instead of
     when the original finally decodes 0.7–2s later, is what stops a slow load from
     silently throwing away a zoom the user already applied to the incoming preview. */
  lb.scale = 1; lb.tx = 0; lb.ty = 0;
  applyTransform();

  // Double buffering: the PREVIOUS photo stays fully visible on the front layer
  // while the next ORIGINAL decodes on the back layer; then they cross-fade.
  const key = p.k;
  const url = encodePath(p.f);
  const token = ++lb.loadToken;
  lb.pendingKey = key;                               // this layer now belongs to the foreground
  const front = frontImg();
  const back = els.imgs[1 - lb.front];
  // Prefetch hit → the idle buffer already holds this photo, so switching costs nothing.
  const readyHit = back.dataset.key === key && back.complete && back.naturalWidth > 0;

  // (A) Instant transitional frame: paint the 2560px preview (already on disk) right
  //     away, so the screen updates in ~100ms instead of waiting seconds for the
  //     60MP original. It fades out the moment the original is on screen.
  if (!readyHit) showTransition(key, token);

  let done = false;
  const finish = () => {
    if (done) return;                                  // one photo, one swap — no double finish
    if (lb.loadToken !== token || !lb.open) return;    // stale navigation
    done = true;
    clearTimeout(lb.loadWatch); lb.loadWatch = null;
    lb.pendingKey = null;
    if (window.performance && performance.mark) performance.mark('lb-ready');
    lb.fullLoaded.add(key);
    lb.displayedKey = key;
    back.classList.add('show');
    front.classList.remove('show');
    lb.front = 1 - lb.front;
    // The zoom reset now lives in loadCurrent(); here we only re-clamp the pan to the
    // new natural size, so a zoom applied while the original was decoding survives.
    clampPan();
    els.imgTrans.classList.remove('show');             // original is on screen now
    els.spinner.hidden = true;
    if (readyHit) {                                    // prefetch hit → near-instant page turn
      els.lbZoom.classList.add('nofade');
      requestAnimationFrame(() => els.lbZoom.classList.remove('nofade'));
    }
    updateBadge();
    if (lb.infoVisible) renderInfo();
    const loadMs = Math.round(PERF.now() - (lb.navAt || 0));
    WEBLOG.send('info', 'photo.loaded', { k: key, ms: loadMs, cached: readyHit });
    if (readyHit) {                              // instant switch → report paint latency too
      const hitPaintMs = lb.navAt ? Math.round(PERF.now() - lb.navAt) : null;
      if (hitPaintMs !== null) WEBLOG.send('info', 'photo.paint', { k: key, ms: hitPaintMs, cached: true, sinceOpen: PERF.since('open') });
    }
    if (slideWanted) armSlide();                       // countdown starts only after full load
    syncFavChrome();                                   // lightbox star reflects the new photo
    schedulePrefetch();
  };

  if (readyHit) { finish(); return; }

  els.spinner.hidden = false;
  updateBadge();
  /* Is this layer really showing THIS photo? After src changes, complete and
     naturalWidth still describe the previous bitmap for a moment, so the URL is the
     only trustworthy part of the answer. */
  const servingNow = () => back.dataset.key === key && back.complete && back.naturalWidth > 0 &&
    Boolean(back.currentSrc) && back.currentSrc === back.src;
  back.onload = () => { if (servingNow()) finish(); };
  back.onerror = () => {
    if (back.dataset.key !== key) return;
    if (!back.dataset.retried) {                       // a dropped USB read is usually transient
      back.dataset.retried = '1';
      WEBLOG.send('warn', 'original.retry', { k: key });
      back.src = url + (url.includes('?') ? '&' : '?') + 'retry=1';
      return;
    }
    els.spinner.hidden = true;
    toast('原图加载失败 · 已保留预览');
    WEBLOG.send('error', 'original.error', { k: key });
    if (slideWanted) armSlide();                       // never strand the slideshow
  };
  back.dataset.key = key;
  delete back.dataset.retried;
  back.alt = p.t;
  back.src = url;
  /* Decode off the critical path: onload can fire while the bitmap is not yet ready
     to paint, which used to stall the frame that swaps the photo in. */
  if (typeof back.decode === 'function') back.decode().then(() => { if (servingNow()) finish(); }).catch(() => { /* onerror handles it */ });
  /* Safety net only — the shortcut is what caused the double swap, so it must not be
     able to fire on the previous bitmap, and it runs once, verified. */
  if (servingNow()) finish();
  else {
    clearTimeout(lb.loadWatch);
    lb.loadWatch = setTimeout(() => { if (servingNow()) finish(); }, 1500);
  }

  // info panel
  if (lb.infoVisible) renderInfo();

  // highlight strip
  syncStrip();

  // NOTE: prefetching must NOT start here — the back layer is busy loading this
  // photo. It is scheduled from finish() once that layer has been swapped out.
}

/* Transitional layer: 2560px preview first, cached 640px thumbnail as fallback. */
function showTransition(key, token) {
  const trans = els.imgTrans;
  const tKey = 't:' + key;
  if (trans.dataset.key === tKey) {
    if (trans.complete && trans.naturalWidth > 0) { trans.classList.add('show'); els.spinner.hidden = true; }
    return;                                            // already loading/showing this photo
  }
  trans.dataset.key = tKey;
  delete trans.dataset.fallback;
  // Frame zero in ~0ms: the 640px thumbnail is already decoded in memory (it is
  // exactly what the grid was showing), so the screen updates immediately.
  trans.classList.add('show');
  els.spinner.hidden = true;
  if (window.performance && performance.mark) performance.mark('lb-trans');
  // Per-photo latency (not "since the lightbox first opened", which only made sense
  // for photo #1 and reported nonsense like 11345ms afterwards).
  const paintMs = lb.navAt ? Math.round(PERF.now() - lb.navAt) : null;
  if (paintMs !== null) WEBLOG.send('info', 'photo.paint', { k: key, ms: paintMs, sinceOpen: PERF.since('open') });
  trans.onerror = () => { /* keep whatever is displayed */ };
  trans.src = thumbURL(key);
  // Then upgrade to the sharper 2560px preview as soon as it is decoded.
  const pv = new Image();
  try { pv.fetchPriority = 'high'; } catch { /* older browser */ }
  const pvT0 = PERF.now();
  pv.onload = () => {
    if (trans.dataset.key === tKey && lb.loadToken === token) trans.src = previewURL(key);
    WEBLOG.send('debug', 'photo.preview', { k: key, ms: Math.round(PERF.now() - pvT0) });
  };
  pv.onerror = () => { /* the thumbnail stays on screen */ };
  pv.src = previewURL(key);
}

/* ---- Prefetch pipeline: priority + serial + generation-cancelled ----------
 * NEXT is loaded into the IDLE BACK BUFFER, so pressing "next" takes the
 * ready-path above: zero network, zero decode, ~instant.
 * PREV and next+2 are decode-warmed through detached images, delayed so they
 * never compete with NEXT for the disk bandwidth. */
let pfGen = 0, pfTimer = null;
function schedulePrefetch() {
  const gen = ++pfGen;

  // Warm the SMALL previews of nearby photos first (a few hundred KB each):
  // that is what the transitional layer paints, so cold switches show the new
  // photo in ~40ms instead of waiting for the disk to deliver the preview.
  for (const d of [1, -1, 2, -2]) {
    const n = view[lb.idx + d];
    if (n) warmPreview(n.k);
  }

  const nxt = view[lb.idx + 1];
  const back = els.imgs[1 - lb.front];
  // Never touch a layer that is serving the photo the user asked for: neither the one
  // already on screen nor the one still downloading it. (A prefetch used to hijack the
  // loading layer, abort that photo and strand the lightbox.)
  if (back.dataset.key === lb.displayedKey) return;
  if (lb.pendingKey && back.dataset.key === lb.pendingKey) return;
  if (nxt) {
    if (back.dataset.key !== nxt.k || !back.complete) {
      back.dataset.key = nxt.k;
      back.onload = null;                              // pure prefetch: no finish callback
      back.onerror = null;
      back.src = encodePath(nxt.f);
    }
  } else if (back.dataset.key) {                       // last photo: free the buffer
    back.dataset.key = '';
    back.removeAttribute('src');
  }

  clearTimeout(pfTimer);
  // Low-priority decode-warming runs in TRUE idle time — it must never steal
  // the main thread or disk from the user's scrolling/zooming.
  idle(() => {
    if (pfGen !== gen || !lb.open) return;
    const prv = view[lb.idx - 1];
    if (prv) ensurePreloaded(prv.k, prv.f, prv.w, prv.h);
    const nn = view[lb.idx + 2];
    if (nn) ensurePreloaded(nn.k, nn.f, nn.w, nn.h);
  }, 900);
}

const preloads = new Map();   // decoded bitmaps kept warm (small/medium photos)
const byteWarm = new Set();   // large originals fetched into the HTTP cache, no bitmap
/* Holding a 40–60MP photo decoded costs ~240MB of pixels; doing that in the background
   showed up in the log as ~2s main-thread stalls right after a photo was already on
   screen. Above this size we warm the BYTES only: the later <img> load is then a local
   read instead of a cold seek, at the price of no bitmap. (The instant NEXT switch does
   not depend on either path — that is the buffer-layer prefetch.) */
const WARM_MAX_PX = 25e6;
const BYTE_WARM_MAX = 6;
function ensurePreloaded(k, f, w, h) {
  if (lb.fullLoaded.has(k)) return;
  if (w && h && w * h > WARM_MAX_PX) {
    if (byteWarm.has(k)) return;
    while (byteWarm.size >= BYTE_WARM_MAX) byteWarm.delete(byteWarm.values().next().value);
    byteWarm.add(k);
    /* file:// cannot be fetched — Chrome rejects it as a cross-origin request and
       logs an error, so bytes are warmed only when the page is served over http(s). */
    if (/^https?:$/.test(location.protocol)) {
      try {
        // must read the body for the response to land in the HTTP cache
        fetch(encodePath(f), { priority: 'low' }).then((r) => r.arrayBuffer()).catch(() => {});
      } catch { /* older browser: no warm, still correct */ }
    }
    return;
  }
  if (preloads.has(k)) return;
  while (preloads.size >= 3) preloads.delete(preloads.keys().next().value);
  const im = new Image();
  im.src = encodePath(f);
  im.decode().catch(() => { /* decode failures surface on the main element */ });
  preloads.set(k, im);
}

/* Small preview bitmaps kept warm so the transitional layer never has to wait. */
const previewWarm = new Map();
function warmPreview(k) {
  if (previewWarm.has(k)) return;
  while (previewWarm.size >= 8) previewWarm.delete(previewWarm.keys().next().value);
  const im = new Image();
  im.src = previewURL(k);
  im.decode().catch(() => { /* preview may be absent; thumb fallback handles it */ });
  previewWarm.set(k, im);
}

function nav(d) {
  if (!lb.open) return;
  const next = lb.idx + d;
  if (next < 0 || next >= view.length) return;
  lb.idx = next;
  WEBLOG.send('debug', 'photo.nav', { dir: d, index: lb.idx });
  loadCurrent();
  history.replaceState(null, '', '#p=' + cur().k);
}

function jumpTo(i) {
  if (i < 0 || i >= view.length) return;
  lb.idx = i;
  loadCurrent();
  history.replaceState(null, '', '#p=' + cur().k);
}

/* ---------- zoom / pan engine ---------- */

function stageBox() {
  const r = els.lbStage.getBoundingClientRect();
  return { w: r.width, h: r.height, left: r.left, top: r.top };
}
function fitSize() {
  const p = cur();
  const { w: sw, h: sh } = stageBox();
  const availW = Math.max(50, sw - 28), availH = Math.max(50, sh - 28);
  const nw = frontImg().naturalWidth || p.w;
  const nh = frontImg().naturalHeight || p.h;
  const r = Math.min(availW / nw, availH / nh, 1e9);
  return { w: nw * r, h: nh * r, nw, nh };
}
function applyTransform() {
  els.lbZoom.style.transform = `translate(${lb.tx}px, ${lb.ty}px) scale(${lb.scale})`;
  els.lbStage.classList.toggle('zoomed', lb.scale > 1.02);
}
function clampPan() {
  // Keep the rendered image rect inside the stage. The image is centered inside
  // the zoom box at scale 1 (offset ox/oy), so pan bounds must account for it.
  const { w: sw, h: sh } = stageBox();
  const fit = fitSize();
  const s = lb.scale;
  const ox = (sw - fit.w) / 2, oy = (sh - fit.h) / 2;
  const vw = fit.w * s, vh = fit.h * s;
  if (vw <= sw) lb.tx = (sw - vw) / 2 - s * ox;
  else lb.tx = Math.max(Math.min(lb.tx, -s * ox), sw - vw - s * ox);
  if (vh <= sh) lb.ty = (sh - vh) / 2 - s * oy;
  else lb.ty = Math.max(Math.min(lb.ty, -s * oy), sh - vh - s * oy);
  applyTransform();
}
function zoomTo(s2, ax, ay) {
  s2 = Math.max(1, Math.min(16, s2));
  if (ax === undefined) { const b = stageBox(); ax = b.w / 2; ay = b.h / 2; }
  const k = s2 / lb.scale;
  lb.tx = ax - (ax - lb.tx) * k;
  lb.ty = ay - (ay - lb.ty) * k;
  lb.scale = s2;
  if (s2 <= 1.001) { lb.scale = 1; lb.tx = 0; lb.ty = 0; applyTransform(); }
  else clampPan();
  updateBadge();
}
function updateBadge() {
  const img = frontImg();
  const ready = img.complete && img.naturalWidth > 0;
  const base = lb.scale <= 1.001 ? '适应窗口' : Math.round(lb.scale * 100) + '%';
  els.lbZoomBadge.textContent = base + (ready ? ' · 原图' : ' · 原图加载中');
}

els.lbStage.addEventListener('wheel', (e) => {
  if (!lb.open) return;
  e.preventDefault();
  const b = stageBox();
  zoomTo(lb.scale * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX - b.left, e.clientY - b.top);
}, { passive: false });

els.lbZoomBadge.addEventListener('click', () => { zoomTo(1); els.lbStage.focus({ preventScroll: true }); });

/* Buttons and the badge live INSIDE the stage. The stage's pointerdown handler
 * calls setPointerCapture(), which would otherwise swallow their click events
 * entirely (regression: prev/next appeared dead). Isolate them from panning. */
for (const el of [els.lbPrev, els.lbNext, els.lbZoomBadge]) {
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('pointerup', (e) => e.stopPropagation());
}

els.lbStage.addEventListener('dblclick', (e) => {
  if (e.target.closest('.lb-nav, .lb-zoom-badge')) return;   // double-clicking a button must not zoom
  if (!lb.open) return;
  e.preventDefault();
  if (lb.scale > 1.02) { zoomTo(1); return; }
  const b = stageBox();
  const fit = fitSize();
  zoomTo(fit.nw / fit.w, e.clientX - b.left, e.clientY - b.top);
});

// pointer: pan / swipe / pinch
const ptrs = new Map();
let panStart = null, pinchStart = null, swipeDx = 0;

els.lbStage.addEventListener('pointerdown', (e) => {
  if (!lb.open) return;
  /* Record the gesture BEFORE capturing: setPointerCapture throws when there is no
     active pointer for that id (synthetic input, or a pointer already released), and
     as the first statement it used to take the whole handler down with it — leaving
     panning and swipe-to-navigate silently dead. Capture is only an optimisation. */
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { els.lbStage.setPointerCapture(e.pointerId); } catch { /* drag still works */ }
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), s: lb.scale };
    panStart = null;
  } else if (ptrs.size === 1) {
    panStart = { x: e.clientX, y: e.clientY, tx: lb.tx, ty: lb.ty, zoomed: lb.scale > 1.02 };
    swipeDx = 0;
    if (lb.scale > 1.02) els.lbStage.classList.add('dragging');
  }
});
els.lbStage.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2 && pinchStart) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const box = stageBox();
    zoomTo(pinchStart.s * (d / pinchStart.d), mx - box.left, my - box.top);
    return;
  }
  if (!panStart) return;
  const dx = e.clientX - panStart.x, dy = e.clientY - panStart.y;
  if (panStart.zoomed) {
    lb.tx = panStart.tx + dx;
    lb.ty = panStart.ty + dy;
    clampPan();
  } else {
    swipeDx = dx;
    els.lbZoom.style.transform = `translate(${dx * 0.15}px, 0) scale(1)`;
  }
});
function endPtr(e) {
  if (ptrs.delete(e.pointerId)) {
    if (ptrs.size < 2) pinchStart = null;
    if (ptrs.size === 0) {
      els.lbStage.classList.remove('dragging');
      if (panStart && !panStart.zoomed) {
        els.lbZoom.style.transform = '';
        if (Math.abs(swipeDx) > 70) nav(swipeDx < 0 ? 1 : -1);
      }
      panStart = null;
      swipeDx = 0;
    }
  }
}
els.lbStage.addEventListener('pointerup', endPtr);
els.lbStage.addEventListener('pointercancel', endPtr);

/* ---------- info panel ---------- */

function renderInfo() {
  const p = cur();
  if (!p) return;
  els.infoTitle.textContent = p.t;
  const orientName = { landscape: '横向', portrait: '纵向', square: '方形', pano: '全景' }[ratioClass(p)];
  els.infoBadges.replaceChildren(
    ...[COL_BY_ID.get(p.f.split('/')[0]), orientName, fmtMP(p)].filter(Boolean).map((s) => {
      const el = document.createElement('span'); el.textContent = s; return el;
    })
  );
  const rows = [];
  const add = (k, v) => { if (v !== null && v !== undefined && v !== '') rows.push([k, v]); };
  add('拍摄时间', fmtTime(p.ts) ? fmtTime(p.ts) + (p.ts.slice(19) || '') : null);
  add('相机', p.cam);
  add('镜头', p.lens);
  add('焦距', p.fl);
  add('光圈', p.fn);
  add('快门', p.exp);
  add('ISO', p.iso);
  add('像素', `${p.w} × ${p.h}`);
  add('文件大小', fmtBytes(p.b));
  add('文件', p.f.split('/').pop());
  if (p.lat != null) add('GPS', `${Math.abs(p.lat).toFixed(5)}°${p.lat >= 0 ? 'N' : 'S'}, ${Math.abs(p.lon).toFixed(5)}°${p.lon >= 0 ? 'E' : 'W'}` + (p.alt != null ? ` · ${p.alt}m` : ''));

  els.infoList.replaceChildren(...rows.map(([k, v]) => {
    const d = document.createElement('div'); d.className = 'kv';
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    d.append(dt, dd);
    return d;
  }));

  const links = [];
  if (p.lat != null) {
    links.push(['🗺️ 在地图中查看拍摄点',
      `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=15/${p.lat}/${p.lon}`]);
  }
  if (p.id) links.push(['🌐 在 Flickr 上查看', `https://www.flickr.com/photo.gne?id=${p.id}`]);
  els.infoLinks.replaceChildren();
  for (const [label, href] of links) {
    const a = document.createElement('a');
    a.href = href; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = label;
    els.infoLinks.appendChild(a);
  }
  const btnPath = document.createElement('button');
  btnPath.textContent = '📋 复制原图路径';
  btnPath.addEventListener('click', () => copyText('H:\\HDownload\\Flickr\\' + p.f.split('/').join('\\'), '已复制文件路径'));
  const btnLink = document.createElement('button');
  btnLink.textContent = '🔗 复制本页链接';
  btnLink.addEventListener('click', () => copyText(location.href.split('#')[0] + '#p=' + p.k, '已复制链接'));
  els.infoLinks.append(btnPath, btnLink);
}

/* ---------- strip ---------- */

let stripBuiltFor = null;
let stripGen = 0;
function buildStrip() {
  if (stripBuiltFor === view) { syncStrip(); return; }  // same filtered list → reuse DOM
  stripBuiltFor = view;
  const gen = ++stripGen;
  // Building 3,688 strip items synchronously used to block the click that opened
  // the lightbox (~470ms). Defer it to idle time — the strip is rarely touched
  // within the first moments after opening.
  idle(() => {
    if (gen !== stripGen || !lb.open) return;
    buildStripNow();
  }, 700);
  return;
}
function buildStripNow() {
  const frag = document.createDocumentFragment();
  view.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'strip-item';
    b.dataset.i = i;
    b.title = p.t;
    b.setAttribute('aria-label', `${i + 1}: ${p.t}`);
    const im = document.createElement('img');
    im.loading = 'lazy'; im.decoding = 'async'; im.alt = '';
    im.src = thumbURL(p.k);
    b.appendChild(im);
    b.addEventListener('click', () => jumpTo(i));
    frag.appendChild(b);
  });
  els.lbStripInner.replaceChildren(frag);
  syncStrip();
}
function syncStrip() {
  const items = els.lbStripInner.children;
  const prevActive = els.lbStripInner.querySelector('.strip-item.active');
  if (prevActive) prevActive.classList.remove('active');
  const el = items[lb.idx];
  if (el) {
    el.classList.add('active');
    // instant: smooth scrolling inside a 3,688-item strip costs ~300ms per navigation
    el.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
}

/* ---------- slideshow ---------- */

let slideWanted = false;   // user turned the slideshow on; timer arms after each image finishes loading

function stopSlide() {
  clearTimeout(lb.slideTimer);
  lb.slideTimer = null;
  els.lbSlideBtn.classList.remove('active');
  els.lbProgress.hidden = true;
}

function armSlide() {
  // Called only when the current original has FULLY loaded and slideWanted is set.
  stopSlide();
  slideWanted = true;
  els.lbSlideBtn.classList.add('active');
  els.lbProgress.hidden = false;
  els.lbProgress.style.transition = 'none';
  els.lbProgress.style.transform = 'scaleX(0)';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    els.lbProgress.style.transition = `transform ${state.slideMs}ms linear`;
    els.lbProgress.style.transform = 'scaleX(1)';
  }));
  lb.slideTimer = setTimeout(() => {
    if (lb.idx >= view.length - 1) { slideWanted = false; stopSlide(); toast('幻灯片播放完毕'); return; }
    lb.idx = lb.idx + 1;
    loadCurrent();
    history.replaceState(null, '', '#p=' + cur().k);
  }, state.slideMs);
}
function syncSlideMs() {
  els.slideMsRow.querySelectorAll('button[data-ms]').forEach(b => b.classList.toggle('on', Number(b.dataset.ms) === state.slideMs));
}

function toggleSlide() {
  slideWanted = !slideWanted;
  if (!slideWanted) { stopSlide(); toast('幻灯片已暂停'); return; }
  // Only arm the countdown when the CURRENT photo (not a stale buffer layer)
  // has fully loaded; otherwise the onload callback arms it automatically.
  const img = frontImg();
  if (lb.displayedKey === cur().k && img.complete && img.naturalWidth > 0) {
    armSlide();
  } else {
    // spinner is showing; the countdown arms automatically once the original finishes loading
    els.lbSlideBtn.classList.add('active');
    toast('原图加载完成后开始播放 · 空格暂停');
  }
}

/* ---------- fullscreen ---------- */

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  // Fullscreen the DOCUMENT, not the lightbox: elements outside the fullscreen
  // element cannot be focused, so lightbox-only fullscreen made the topbar (and the
  // '/' search shortcut) dead until the user pressed f again.
  else document.documentElement.requestFullscreen().catch(() => toast('浏览器拒绝了全屏请求'));
}
document.addEventListener('fullscreenchange', () => {
  els.lbFsBtn.classList.toggle('active', !!document.fullscreenElement);
});

/* ---------- lightbox action buttons ---------- */

els.lightbox.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'close') closeLightbox();
  else if (act === 'info') { lb.infoVisible = !lb.infoVisible; els.lbInfo.hidden = !lb.infoVisible; btn.classList.toggle('active', lb.infoVisible); if (lb.infoVisible) renderInfo(); }
  else if (act === 'fav') { const c = cur(); if (c) toggleFav(c.k); }
  else if (act === 'slide') toggleSlide();
  else if (act === 'thumbs') { lb.stripVisible = !lb.stripVisible; LS.set('strip', lb.stripVisible); els.lbStrip.hidden = !lb.stripVisible; btn.classList.toggle('active', lb.stripVisible); }
  else if (act === 'fs') toggleFullscreen();
});
els.lbPrev.addEventListener('click', () => nav(-1));
els.lbNext.addEventListener('click', () => nav(1));
els.lightbox.addEventListener('click', (e) => {
  if (e.target === els.lightbox) closeLightbox();
});

/* ============================== Keyboard ============================== */

document.addEventListener('keydown', (e) => {
  const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName || '');

  if (!els.helpModal.hidden) {
    if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); closeHelp(); }
    return;
  }
  if (!els.statsModal.hidden) {
    if (e.key === 'Escape' || e.key === 'y' || e.key === 'Y') { e.preventDefault(); closeStats(); }
    return;
  }
  if (lb.open) {
    switch (e.key) {
      case 'Escape': e.preventDefault(); closeLightbox(); break;
      case 'ArrowRight': e.preventDefault(); nav(1); break;
      case 'ArrowLeft': e.preventDefault(); nav(-1); break;
      case 'Home': e.preventDefault(); jumpTo(0); break;
      case 'End': e.preventDefault(); jumpTo(view.length - 1); break;
      case ' ': e.preventDefault(); toggleSlide(); break;
      case 'i': case 'I': els.lightbox.querySelector('[data-act="info"]').click(); break;
      case 't': case 'T': els.lightbox.querySelector('[data-act="thumbs"]').click(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 's': case 'S': { const c = cur(); if (c) toggleFav(c.k); break; }
      case '+': case '=': zoomTo(lb.scale * 1.3); break;
      case '-': case '_': zoomTo(lb.scale / 1.3); break;
      case '0': zoomTo(1); break;
      case '1': { const fit = fitSize(); zoomTo(fit.nw / fit.w); break; }
    }
    return;
  }
  if (inInput) {
    if (e.key === 'Escape') { els.search.value = ''; state.q = ''; applyState(true); els.search.blur(); }
    return;
  }
  if (e.key === '/') { e.preventDefault(); els.search.focus(); }
  else if (e.key === '?') { e.preventDefault(); openHelp(); }
  else if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); openStats(); }
  else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); randomPhoto(); }
  else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); playFromStart(); }
  else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    if (favs.size === 0) { toast('还没有收藏 · 在照片上点星标即可收藏'); return; }
    state.onlyFav = !state.onlyFav; LS.set('onlyFav', state.onlyFav); applyState(true);
  }
  else if (e.key === 'Escape' && state.q) { state.q = ''; els.search.value = ''; applyState(true); }
  else if (e.key === 'Escape' && hasActiveFilters()) { resetAll(); }
});

/* ============================== Help / theme / misc UI ============================== */

function openHelp() {
  els.helpModal.hidden = false;
  document.body.classList.add('modal-open');
  renderStats();
  syncSlideMs();
  els.helpClose.focus();
}
function closeHelp() { els.helpModal.hidden = true; document.body.classList.remove('modal-open'); }
els.helpBtn.addEventListener('click', openHelp);
els.helpClose.addEventListener('click', closeHelp);
els.helpModal.addEventListener('click', (e) => { if (e.target === els.helpModal) closeHelp(); });

/* ============================== Statistics panel ==============================
   Two sources side by side:
     本次会话 — measured in this page (STATS), works in file:// mode too
     服务器累计 — GET /__stats, the aggregate the server has been recording since it
                  started (includes every browser that reported to it)
   Budgets mirror build/events-test.js so "slow" means the same thing everywhere. */
const STATS_BUDGET = { 'click:card': 250, 'click:close': 250, 'filter.apply': 600, 'photo.paint': 400, 'photo.loaded': 400 };
let statsTimer = null;

function statsRowHtml(r, cols) {
  const budget = STATS_BUDGET[r.key.split(' ')[0]] || STATS_BUDGET[r.key];
  const slow = budget && r.mean > budget;
  const cells = cols.map((c) => `<td${c.dim ? ' class="dim"' : ''}>${c.v}</td>`).join('');
  return `<tr><td title="${r.key}">${r.key}</td>${cells}</tr>`;
}

function renderStatsPanel() {
  const rows = STATS.rows();
  const t = STATS.totals();

  els.statsSummary.innerHTML = [
    ['采样事件', t.n],
    ['总体均值', t.mean + ' ms'],
    ['事件种类', t.keys],
    ['最慢单次', t.worst + ' ms' + (t.worstKey ? ' · ' + t.worstKey : '')],
  ].map(([k, v]) => `<span>${k}<b>${v}</b></span>`).join('');

  const body = els.statsTable.tBodies[0];
  body.replaceChildren();
  if (!rows.length) {
    body.innerHTML = '<tr><td class="empty" colspan="6">本次会话还没有带延迟的埋点 · 点击卡片或切换筛选即可产生数据</td></tr>';
  } else {
    for (const r of rows) {
      const tr = document.createElement('tr');
      const budget = STATS_BUDGET[r.key.split(' ')[0]] || STATS_BUDGET[r.key];
      tr.innerHTML = `<td>${r.key}</td><td>${r.n}</td><td${budget && r.mean > budget ? ' class="slow"' : ''}>${r.mean} ms</td>` +
        `<td>${r.median}</td><td class="dim">${r.p95}</td><td class="dim">${r.max}</td>`;
      body.appendChild(tr);
    }
  }

  els.statsNote.textContent = `本次会话共 ${t.n} 次采样,总体均值 ${t.mean} ms。均值受解码/磁盘负载影响,对比时看中位与 p95 更稳。`;
}

async function renderServerStats() {
  const body = els.statsServerTable.tBodies[0];
  if (location.protocol === 'file:') {
    body.innerHTML = '<tr><td class="empty" colspan="5">file:// 模式没有服务器累计数据 · 用 start-gallery.cmd 启动后可用</td></tr>';
    return;
  }
  try {
    const res = await fetch('/__stats', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const events = Array.isArray(data.events) ? data.events : [];
    body.replaceChildren();
    if (!events.length) {
      body.innerHTML = '<tr><td class="empty" colspan="5">服务器启动后还没有收到带延迟的埋点</td></tr>';
      return;
    }
    for (const e of events) {
      const tr = document.createElement('tr');
      const tot = e.total || { n: 0, mean: 0, min: 0, max: 0 };
      tr.innerHTML = `<td>${e.event}</td><td>${tot.n}</td><td>${tot.mean} ms</td><td class="dim">${tot.min}</td><td class="dim">${tot.max}</td>`;
      body.appendChild(tr);
    }
  } catch {
    body.innerHTML = '<tr><td class="empty" colspan="5">取不到 /__stats(服务未启动或版本较旧)</td></tr>';
  }
}

function refreshStats() { renderStatsPanel(); renderServerStats(); }

function openStats() {
  els.statsModal.hidden = false;
  document.body.classList.add('modal-open');
  refreshStats();
  els.statsClose.focus();
  clearInterval(statsTimer);                       // live view while it stays open
  statsTimer = setInterval(() => { if (!els.statsModal.hidden) refreshStats(); }, 3000);
}
function closeStats() {
  els.statsModal.hidden = true;
  document.body.classList.remove('modal-open');
  clearInterval(statsTimer); statsTimer = null;
}
els.statsBtn.addEventListener('click', openStats);
els.statsClose.addEventListener('click', closeStats);
els.statsRefresh.addEventListener('click', refreshStats);
els.statsModal.addEventListener('click', (e) => { if (e.target === els.statsModal) closeStats(); });
els.statsCopy.addEventListener('click', () => {
  const rows = STATS.rows();
  const t = STATS.totals();
  const md = [
    '| 事件 | 次数 | 均值 | 中位 | p95 | 最大 |',
    '|---|---:|---:|---:|---:|---:|',
    ...rows.map((r) => `| \`${r.key}\` | ${r.n} | ${r.mean} ms | ${r.median} | ${r.p95} | ${r.max} |`),
    '',
    `本次会话总体均值 ${t.mean} ms(${t.n} 次采样)`,
  ].join('\n');
  copyText(md, '已复制统计表(Markdown)');
});

/* Read-only view for the test suite. */
window.__galleryStats = () => ({ rows: STATS.rows(), totals: STATS.totals(), open: !els.statsModal.hidden });

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
}
els.themeBtn.addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  LS.set('theme', state.theme);
  applyTheme();
});

els.search.addEventListener('input', debounce(() => {
  state.q = els.search.value;
  applyState(true);
}, 150));
els.searchClear.addEventListener('click', () => {
  els.search.value = ''; state.q = ''; applyState(true); els.search.focus();
});
els.sortSel.addEventListener('change', () => { state.sort = els.sortSel.value; LS.set('sort', state.sort); applyState(true); });
els.orientSel.addEventListener('change', () => { state.orient = els.orientSel.value; LS.set('orient', state.orient); applyState(true); });
els.camSel.addEventListener('change', () => { state.cam = els.camSel.value; LS.set('cam', state.cam); applyState(true); });
els.density.addEventListener('input', () => {
  state.density = Number(els.density.value);
  LS.set('density', state.density);
  layoutRows();
  renderGrid();
});
els.clearFilters.addEventListener('click', () => { resetAll(); });

/* --- convenience buttons --- */
els.randomBtn.addEventListener('click', randomPhoto);
els.playBtn.addEventListener('click', playFromStart);
els.resetBtn.addEventListener('click', resetAll);
els.favChip.addEventListener('click', () => {
  if (favs.size === 0) { toast('还没有收藏 · 在照片上点星标即可收藏'); return; }
  state.onlyFav = !state.onlyFav;
  LS.set('onlyFav', state.onlyFav);
  applyState(true);
});
els.yearSel.addEventListener('change', () => {
  state.year = els.yearSel.value;
  LS.set('year', state.year);
  applyState(true);
});
els.copyListBtn.addEventListener('click', () => {
  if (!view.length) { toast('当前视图为空'); return; }
  const lines = view.map(p => 'H:\\HDownload\\Flickr\\' + p.f.split('/').join('\\'));
  copyText(lines.join('\r\n'), `已复制 ${view.length} 个文件路径`);
});
els.slideMsRow.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ms]');
  if (!b) return;
  state.slideMs = Number(b.dataset.ms);
  LS.set('slideMs', state.slideMs);
  syncSlideMs();
  toast('幻灯片间隔 ' + (state.slideMs / 1000) + ' 秒');
});

let toTopTick = false;
window.addEventListener('scroll', () => {
  if (toTopTick) return;
  toTopTick = true;
  requestAnimationFrame(() => {
    els.toTop.hidden = window.scrollY < 1200;
    toTopTick = false;
  });
}, { passive: true });
els.toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

/* stage resize → keep pan tidy */
new ResizeObserver(debounce(() => { if (lb.open && lb.scale > 1.02) clampPan(); }, 80)).observe(els.lbStage);

/* ============================== Diagnostics ==============================
   Read-only snapshot for the test suite (build/events-test.js) and for --debug
   logging. Plain values only — never live objects, never mutations. */
window.__galleryState = () => {
  const im = frontImg();
  const p = cur() || {};
  const shown = (im && im.currentSrc) ? im.currentSrc.split('/').pop() : '';
  return {
    photos: view.length, idx: lb.idx, key: p.k || null, file: (p.f || '').split('/').pop() || null,
    displayed: lb.displayedKey, pending: lb.pendingKey, front: lb.front,
    open: lb.open, loading: !els.spinner.hidden, scale: Number(lb.scale.toFixed(3)),
    tx: Number(lb.tx.toFixed(1)), ty: Number(lb.ty.toFixed(1)),
    frontShown: Boolean(im && im.classList.contains('show')),
    frontSrc: safeDecode(shown),
    slideWanted, slideArmed: !els.lbProgress.hidden, infoVisible: lb.infoVisible,
    stripVisible: lb.stripVisible, favs: favs.size,
  };
};

/* ============================== Interaction telemetry ============================== */
document.addEventListener('click', (e) => {
  const el = e.target.closest('button, .chip, .ctl, [data-act], .card, .strip-item');
  if (!el) return;
  const target = el.id || el.dataset.act || (el.classList && el.classList[0]) || el.tagName.toLowerCase();
  // latency: event → next painted frame (UI responsiveness for every click)
  const clickT0 = PERF.now();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    WEBLOG.send('info', 'click', { target: target, ms: Math.round(PERF.now() - clickT0) });
  }));
}, true);
window.addEventListener('error', (e) => {
  WEBLOG.send('error', 'js.error', { msg: String((e && e.message) || 'unknown'), src: String((e && e.filename) || '').split('/').pop() });
});
window.addEventListener('unhandledrejection', (e) => {
  WEBLOG.send('error', 'js.rejection', { msg: String((e && e.reason && e.reason.message) || e.reason || 'unknown') });
});

/* ============================== Content protection ==============================
   Remote mode only: block the common "save image" entry points and stamp a
   watermark. (A browser cannot prevent screenshots; these stop casual saving.) */
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('img')) { e.preventDefault(); toast('右键已禁用 · 仅限在线浏览'); }
});
document.addEventListener('dragstart', (e) => { if (e.target.tagName === 'IMG') e.preventDefault(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && /^[suSU]$/.test(e.key)) {
    e.preventDefault();
    toast('保存已禁用 · 仅限在线浏览');
  }
});
if (SOURCE_BASE) {
  document.body.classList.add('remote');
  const wm = document.createElement('div');
  wm.className = 'lb-watermark';
  wm.textContent = '© 风景画廊 · 仅限在线浏览';
  els.lbStage.appendChild(wm);
}

/* ============================== Boot ============================== */

applyTheme();
buildChips();
buildCamSel();
buildYearSel();
buildStats();
els.sortSel.value = state.sort;
els.orientSel.value = state.orient;
els.yearSel.value = state.year;
els.density.value = String(state.density);
applyState(false);
syncFavUI();

// Idle-time warm-up: once boot settles, pre-fetch the SMALL previews of the
// first photos of the current view, so random access / early paging always has
// an instant transitional frame. Runs only when the browser is truly idle.
idle(() => {
  for (const p of view.slice(0, 8)) warmPreview(p.k);
}, 2500);

WEBLOG.send('info', 'page.ready', { photos: PHOTOS.length, ms: Math.round((window.performance && performance.now ? performance.now() : 0)) });

// deep link: #p=<key>
const hashM = /^#p=(.+)$/.exec(location.hash || '');
if (hashM) {
  const idx = view.findIndex(p => p.k === decodeURIComponent(hashM[1]));
  if (idx >= 0) openLightbox(idx);
}
})();
