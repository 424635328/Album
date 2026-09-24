'use strict';
/* Flickr-Gallery asset builder.
 * Reads originals from H:\HDownload\Flickr (read-only) and writes all derived
 * output next to the gallery website, on the same drive. All locations are
 * derived from __dirname, so the whole gallery folder can be moved freely.
 *
 * Usage: node build.js [--limit N] [--offset N] [--skip-assets] [--force]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { parseExif, fmtExposure, exifToDateISO } = require('./exif');
const log = require('./logger');

const args = process.argv.slice(2);
const argNum = (name, def = null) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
const argVal = (name, def = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const LIMIT = argNum('--limit');
const OFFSET = argNum('--offset', 0);
const SKIP_ASSETS = args.includes('--skip-assets');
const FORCE = args.includes('--force');

/* Source folder and dataset layout
     --src <dir>       photo folder to index        (default H:\HDownload\Flickr)
     --dataset <id>    keep this set's manifest and assets isolated under
                       sets/<id>/ so several folders can be browsed side by side.
                       Without it the legacy root layout is used. */
const SRC = path.resolve(argVal('--src', 'H:\\HDownload\\Flickr'));
const DATASET = argVal('--dataset', '');
const OUT = path.resolve(__dirname, '..');        // website root
const ASSETS = DATASET ? path.join(OUT, 'sets', DATASET, 'assets') : path.join(OUT, 'assets');
const THUMB_DIR = path.join(ASSETS, 'thumbs');
const PREVIEW_DIR = path.join(ASSETS, 'preview');
const DATA_FILE = DATASET ? path.join(OUT, 'sets', DATASET, 'data.js') : path.join(OUT, 'data.js');
const META_CACHE = path.join(__dirname, DATASET ? 'meta-' + DATASET + '.json' : 'meta.json');
const CONCURRENCY = 4;

/* The default Flickr folder has four known albums; any other folder is scanned
   automatically (each sub-folder becomes a "collection"). */
const DEFAULT_SRC = path.resolve('H:\\HDownload\\Flickr');
const COLLECTIONS = [
  { dir: 'Canada', name: 'Canada' },
  { dir: 'SaintKitts', name: 'St. Kitts' },
  { dir: 'Spain', name: 'Spain' },
  { dir: 'USA', name: 'USA' },
];

function walk(dir, out) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (/\.(jpe?g)$/i.test(d.name)) out.push(p);
  }
}

function loadManifests() {
  const map = new Map();
  let dirs;
  try { dirs = fs.readdirSync(SRC); } catch { return map; }
  for (const f of dirs) {
    if (!/^manifest_.*\.jsonl$/i.test(f)) continue;
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o && o.file && o.title) map.set(path.basename(o.file), { title: o.title, id: o.id || null });
      } catch { /* ignore malformed line */ }
    }
  }
  return map;
}

function shortHash(s) {
  return crypto.createHash('md5').update(s).digest('hex').slice(0, 10);
}

// "0788_Dufferin Terrace in fall, Quebec City_55445195114_o.jpg" -> "Dufferin Terrace in fall, Quebec City"
function titleFromFilename(base) {
  let t = base.replace(/\.[^.]+$/, '');
  t = t.replace(/^\d+_/, '');
  t = t.replace(/_\d{8,}_[a-z]+$/i, '');
  return t.trim() || base;
}

// Keys must be globally unique: collection folders each restart their numbering
// at 0001, so the seq alone collides across collections (Canada/0003 vs
// SaintKitts/0003). Prefix with the collection name.
function keyFor(colDir, rel, seq) {
  const prefix = (colDir || 'img').toLowerCase().replace(/[^a-z]/g, '').slice(0, 4) || 'img';
  return seq != null ? `${prefix}${String(seq).padStart(5, '0')}` : `${prefix}h${shortHash(rel)}`;
}

/* Some flaky external drives report successful writes that never persist.
   Verify every asset landed on disk; regenerate up to 3 times otherwise. */
async function ensurePersisted(file, regen) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (fs.statSync(file).size > 100) return;
    } catch { /* missing */ }
    await regen();
  }
  throw new Error('asset did not persist on disk: ' + file);
}

async function genPreview(abs, previewPath) {
  await sharp(abs, { limitInputPixels: false, failOn: 'none' })
    .rotate()
    .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(previewPath);
}

async function genThumb(previewPath, thumbPath) {
  await sharp(previewPath)
    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(thumbPath);
}

async function genLqip(thumbPath) {
  const buf = await sharp(thumbPath)
    .resize({ width: 24, height: 24, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 45 })
    .toBuffer();
  return 'data:image/webp;base64,' + buf.toString('base64');
}

async function processOne(job, noAssets) {
  const { abs, rel, key, manifest, stat } = job;
  const thumbPath = path.join(THUMB_DIR, key + '.webp');
  const previewPath = path.join(PREVIEW_DIR, key + '.webp');

  const meta = await sharp(abs, { limitInputPixels: false, failOn: 'none' }).metadata();
  const ex = parseExif(meta.exif);
  let w = meta.width || 0, h = meta.height || 0;
  const ori = (ex && ex.orientation) || meta.orientation || 1;
  if (ori >= 5 && ori <= 8) { const t = w; w = h; h = t; }

  if (!SKIP_ASSETS && !noAssets) {
    // Single full decode: original -> 2560px preview, then cheap derivations.
    await ensurePersisted(previewPath, () => genPreview(abs, previewPath));
    await ensurePersisted(thumbPath, () => genThumb(previewPath, thumbPath));
    job.lqip = await genLqip(thumbPath);
  } else if (!SKIP_ASSETS && noAssets) {
    // Assets already on disk from an earlier run: recover LQIP from the cheap thumb.
    job.lqip = await genLqip(thumbPath);
  }

  const ts = exifToDateISO(ex);
  return {
    k: key,
    c: job.ci,
    f: rel,
    t: manifest ? manifest.title : titleFromFilename(path.basename(rel)),
    id: manifest ? manifest.id : null,
    w, h,
    b: stat.size,
    ts,
    cam: ex && ex.model ? ((ex.make ? ex.make.replace(/\s+Corporation.*$/i, '').trim() + ' ' : '') + ex.model).trim() : null,
    lens: ex && ex.lens ? ex.lens : null,
    iso: ex && ex.iso ? ex.iso : null,
    fn: ex && ex.fnumber ? 'ƒ/' + (Math.round(ex.fnumber * 10) / 10) : null,
    exp: ex && ex.exposure ? fmtExposure(ex.exposure) : null,
    fl: ex && ex.focal ? (Math.round(ex.focal * 10) / 10) + 'mm' : null,
    lat: ex && ex.gps ? Math.round(ex.gps.lat * 1e6) / 1e6 : null,
    lon: ex && ex.gps ? Math.round(ex.gps.lon * 1e6) / 1e6 : null,
    alt: ex && ex.gpsAlt != null ? Math.round(ex.gpsAlt) : null,
  };
}

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });

  log.debug('build', 'source:', SRC);
  if (DATASET) log.debug('build', 'dataset:', DATASET, '→', path.dirname(DATA_FILE));

  const manifests = loadManifests();
  if (manifests.size) log.debug('build', `manifest entries: ${manifests.size}`);

  // Collections: the four known Flickr albums, or auto-discovered sub-folders
  // (a folder whose images sit directly in the root becomes one collection).
  let cols;
  if (SRC.toLowerCase() === DEFAULT_SRC.toLowerCase()) {
    cols = COLLECTIONS;
  } else {
    cols = [];
    let entries = [];
    try { entries = fs.readdirSync(SRC, { withFileTypes: true }); } catch { /* handled below */ }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$')) continue;
      const files = [];
      walk(path.join(SRC, e.name), files);
      if (files.length) cols.push({ dir: e.name, name: e.name });
    }
    if (!cols.length) {
      const files = [];
      walk(SRC, files);
      if (files.length) cols.push({ dir: '.', name: path.basename(SRC) });
    }
    // also index loose images sitting next to those folders
    const rootFiles = [];
    try {
      for (const e of entries) if (e.isFile() && /\.(jpe?g)$/i.test(e.name)) rootFiles.push(e.name);
    } catch { /* noop */ }
    if (rootFiles.length && cols.some(c => c.dir === '.')) { /* already covered */ }
    else if (rootFiles.length) cols.unshift({ dir: '.', name: '根目录' });
    log.debug('build', 'discovered collections:', cols.map(c => c.name).join(', ') || '(none)');
  }

  let jobs = [];
  let ci = 0;
  for (const col of cols) {
    const root = col.dir === '.' ? SRC : path.join(SRC, col.dir);
    if (!fs.existsSync(root)) { log.warn('build', `skip missing collection ${col.dir}`); continue; }
    const files = [];
    walk(root, files);
    files.sort();
    for (const abs of files) {
      const inner = path.relative(root, abs).split(path.sep).join('/');
      const rel = col.dir === '.' ? inner : col.dir + '/' + inner;
      const base = path.basename(abs);
      const seqM = /^(\d+)_/.exec(base);
      const key = keyFor(col.dir, rel, seqM ? Number(seqM[1]) : null);
      jobs.push({ abs, rel, key, ci, manifest: manifests.get(base) || null, stat: fs.statSync(abs) });
    }
    ci++;
  }
  jobs.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  // Some albums contain files sharing the same numeric prefix (e.g. two photos
  // both named 0001_...). Detect collisions and switch those to hash keys.
  {
    const used = new Set();
    for (const job of jobs) {
      if (used.has(job.key)) {
        const prefix = job.key.match(/^[a-z]+/)[0].slice(0, 4);
        job.key = prefix + 'x' + shortHash(job.rel);
        while (used.has(job.key)) job.key = prefix + 'x' + shortHash(job.rel + job.key);
      }
      used.add(job.key);
    }
  }
  if (OFFSET > 0) jobs = jobs.slice(OFFSET);
  if (LIMIT) jobs.length = Math.min(jobs.length, LIMIT);
  log.info('build', `images to process: ${jobs.length}`);

  let metaCache = {};
  if (fs.existsSync(META_CACHE)) {
    try { metaCache = JSON.parse(fs.readFileSync(META_CACHE, 'utf8')); } catch { metaCache = {}; }
    for (const k of Object.keys(metaCache)) {
      if (!/^[a-z]{2,4}(\d{5}|h[0-9a-f]{10}|x[0-9a-f]{10})$/.test(k)) delete metaCache[k]; // drop corrupt/stale keys
    }
  }

  const photos = [];
  const failed = [];
  let done = 0, skipped = 0, idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const cached = metaCache[job.k];
      const thumbOk = SKIP_ASSETS || (!FORCE && fs.existsSync(path.join(THUMB_DIR, job.k + '.webp')));
      const previewOk = SKIP_ASSETS || (!FORCE && fs.existsSync(path.join(PREVIEW_DIR, job.k + '.webp')));
      const haveAssets = thumbOk && previewOk;
      if (cached && cached.b === job.stat.size && haveAssets && !FORCE) {
        photos.push(cached.p);
        skipped++;
      } else {
        try {
          // Existing assets + missing cache entry (interrupted run): re-extract metadata only.
          const rec = await processOne(job, haveAssets && !SKIP_ASSETS);
          rec.lq = job.lqip || (cached && cached.p && cached.p.lq) || null;
          photos.push(rec);
          metaCache[job.k] = { b: job.stat.size, p: rec };
        } catch (e) {
          failed.push({ f: job.rel, err: String(e && e.message || e).slice(0, 200) });
          log.error('build', `FAILED ${job.rel}: ${e.message}`);
        }
      }
      done++;
      if (done % 25 === 0 || done === jobs.length) {
        const rate = done / ((Date.now() - t0) / 1000);
        const eta = rate > 0 ? Math.round((jobs.length - done) / rate) : 0;
        log.debug('build', `${done}/${jobs.length} done (${skipped} cached, ${failed.length} failed) — ${rate.toFixed(2)}/s, ETA ${Math.floor(eta / 60)}m${eta % 60}s`);
        if (done % 500 === 0 && done < jobs.length) {
          log.info('build', `进度 ${done}/${jobs.length} (${Math.round((100 * done) / jobs.length)}%) — ${rate.toFixed(1)}/s, 预计还需 ${Math.ceil((jobs.length - done) / rate / 60)} 分钟`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length || 1) }, worker));

  photos.sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));

  const usedCols = [];
  const colIdx = new Map();
  for (const p of photos) {
    const dirName = p.f.split('/')[0];
    if (!colIdx.has(dirName)) {
      colIdx.set(dirName, usedCols.length);
      usedCols.push(COLLECTIONS.find(c => c.dir === dirName) || { dir: dirName, name: dirName });
    }
    p.c = colIdx.get(dirName);
  }

  const data = {
    generated: new Date().toISOString(),
    collections: usedCols.map(c => ({ id: c.dir, name: c.name })),
    photos: photos.map(p => {
      const o = { k: p.k, c: p.c, f: p.f, t: p.t, w: p.w, h: p.h, b: p.b, lq: p.lq };
      if (p.id) o.id = p.id;
      if (p.ts) o.ts = p.ts;
      if (p.cam) o.cam = p.cam;
      if (p.lens) o.lens = p.lens;
      if (p.iso) o.iso = p.iso;
      if (p.fn) o.fn = p.fn;
      if (p.exp) o.exp = p.exp;
      if (p.fl) o.fl = p.fl;
      if (p.lat != null) { o.lat = p.lat; o.lon = p.lon; if (p.alt != null) o.alt = p.alt; }
      return o;
    }),
  };

  fs.writeFileSync(DATA_FILE,
    '/* generated by build/build.js — do not edit */\nwindow.GALLERY_DATA = ' + JSON.stringify(data) + ';\n');
  const slim = {};
  for (const [k, v] of Object.entries(metaCache)) {
    if (!k || k === 'undefined' || !v || !v.p) continue;
    slim[k] = { b: v.b, p: v.p };
  }
  fs.writeFileSync(META_CACHE, JSON.stringify(slim));
  fs.writeFileSync(path.join(__dirname, 'failed.json'), JSON.stringify(failed, null, 2));

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log.info('build', `完成:${photos.length} 张,缓存命中 ${skipped},失败 ${failed.length},耗时 ${secs}s`);
  log.debug('build', `data.js size: ${(fs.statSync(DATA_FILE).size / 1048576).toFixed(2)} MB`);
}

main().catch((e) => { log.error('build', 'FATAL', e && e.stack || e); process.exit(1); });
