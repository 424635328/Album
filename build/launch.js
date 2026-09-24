'use strict';
/* Gallery launcher with folder selection.
 *
 *   start-gallery.cmd                     → interactive menu (choose a folder)
 *   start-gallery.cmd "D:\Photos"         → open that folder directly
 *   start-gallery.cmd "D:\Photos" --rebuild
 *
 * Folders are remembered in  folders.json  next to this gallery:
 *   { "default": "...", "folders": [ { "name": "...", "path": "...", "count": 123 } ] }
 * You can edit that file by hand at any time; the launcher also updates it
 * automatically whenever you open a folder.
 *
 * CLI:  node launch.js [folder] [--rebuild] [--no-open] [--port N] [--list]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const log = require('./logger');

const GALLERY = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(GALLERY, 'folders.json');
const DEFAULT_SRC = 'H:\\HDownload\\Flickr';

const argv = process.argv.slice(2);
// Split flags from positional args, making sure a flag's VALUE (e.g. the 8422 in
// "--port 8422") is never mistaken for a folder path.
const VALUE_FLAGS = new Set(['--port']);
const flags = [];
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    flags.push(a);
    if (VALUE_FLAGS.has(a) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) i++;
  } else {
    positional.push(a);
  }
}
const flagVal = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const REBUILD = flags.includes('--rebuild');
const NO_OPEN = flags.includes('--no-open');
const PORT = flagVal('--port', '');
const LIST_ONLY = flags.includes('--list');

/* ------------------------------------------------------------------ helpers */
function countImages(dir) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jpe?g)$/i.test(e.name)) n++;
    }
  };
  walk(dir);
  return n;
}
function slugFor(src) {
  const base = path.basename(src).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'set';
  const hash = crypto.createHash('md5').update(src.toLowerCase()).digest('hex').slice(0, 6);
  return base.slice(0, 24) + '-' + hash;
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/* Graphical folder picker (Windows native dialog via PowerShell — no extra deps).
   The result is passed through a UTF-8 file so non-ASCII paths survive intact.
   Set GALLERY_PICK_FAKE=<path> to bypass the dialog (used by automated tests). */
function pickFolderDialog(title) {
  if (process.env.GALLERY_PICK_FAKE) return process.env.GALLERY_PICK_FAKE;
  const outFile = path.join(os.tmpdir(), 'gallery-pick-' + process.pid + '.txt');
  try { fs.unlinkSync(outFile); } catch { /* not there */ }
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dlg.Description = '" + (title || '选择要浏览的图片文件夹') + "'",
    '$dlg.ShowNewFolderButton = $true',
    'if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    "  [System.IO.File]::WriteAllText('" + outFile.replace(/'/g, "''") + "', $dlg.SelectedPath, [System.Text.Encoding]::UTF8)",
    '}',
  ].join('\n');
  try {
    // -STA is required by the WinForms dialog; powershell.exe always exists on Windows
    spawnSync('powershell', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, timeout: 600000 });
  } catch { /* fall through to manual input */ }
  try {
    const picked = fs.readFileSync(outFile, 'utf8').trim();
    fs.unlinkSync(outFile);
    if (picked && isDir(picked)) return picked;
  } catch { /* cancelled or unavailable */ }
  return null;
}

/* ------------------------------------------------------------------- config */
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (c && Array.isArray(c.folders)) return c;
  } catch { /* first run or hand-edited badly */ }
  return {
    _help: '在这里增删条目即可。name 是菜单里显示的名字,path 是图片文件夹(支持任意路径)。',
    default: DEFAULT_SRC,
    folders: [{ name: 'Flickr 风景集(默认)', path: DEFAULT_SRC }],
  };
}
function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
    log.debug('launch', 'saved config:', CONFIG_FILE);
  } catch (e) { log.warn('launch', 'cannot save config: ' + e.message); }
}
function rememberFolder(cfg, src) {
  const norm = path.resolve(src);
  const hit = cfg.folders.find(f => path.resolve(f.path).toLowerCase() === norm.toLowerCase());
  if (hit) {
    hit.path = norm;
    hit.lastUsed = new Date().toISOString();
  } else {
    cfg.folders.push({ name: path.basename(norm) || norm, path: norm, lastUsed: new Date().toISOString() });
  }
  saveConfig(cfg);
}

/* ------------------------------------------------------------------- launch */
function start(src) {
  // The default Flickr folder keeps the ORIGINAL root layout (data.js + assets\),
  // which is already built — so it starts instantly instead of rebuilding into sets\.
  const isDefault = path.resolve(src).toLowerCase() === path.resolve(DEFAULT_SRC).toLowerCase();
  const dataset = isDefault ? '' : slugFor(src);
  const setDir = dataset ? path.join(GALLERY, 'sets', dataset) : GALLERY;
  const dataFile = path.join(setDir, 'data.js');
  const total = countImages(src);

  console.log('');
  console.log('  图片文件夹 : ' + src);
  console.log('  数据集     : ' + (dataset || '(默认布局:根目录 data.js)'));
  console.log('  图片数量   : ' + total + ' 张 (jpg/jpeg,含子文件夹)');
  console.log('');
  if (total === 0) { console.error('\n[启动失败] 该文件夹内没有找到 jpg/jpeg 图片\n'); process.exit(1); }

  if (REBUILD || !fs.existsSync(dataFile)) {
    console.log(REBUILD ? '  按要求重新构建数据集…' : '  首次查看此文件夹 → 生成缩略图与预览(每张约 1 秒,请稍候)…');
    console.log('');
    const buildArgs = [path.join(__dirname, 'build.js'), '--src', src];
    if (dataset) buildArgs.push('--dataset', dataset);
    const r = spawnSync(process.execPath, buildArgs, { stdio: 'inherit', cwd: __dirname });
    if (r.status !== 0) { console.error('\n[启动失败] 构建失败(退出码 ' + r.status + ')\n'); process.exit(1); }
    console.log('\n  数据集已就绪: ' + dataFile);
  } else {
    console.log('  使用已构建的数据集(加 --rebuild 可强制重建)');
  }

  console.log('  启动画廊服务…\n');
  const srvArgs = [path.join(__dirname, 'server.js'), '--src', src];
  if (dataset) srvArgs.push('--dataset', dataset);
  if (NO_OPEN) srvArgs.push('--no-open');
  if (PORT) srvArgs.push('--port', String(PORT));
  log.debug('launch', 'server args:', srvArgs.join(' '));
  const child = spawn('node', srvArgs, { stdio: 'inherit', cwd: __dirname });
  child.on('exit', (c) => process.exit(c || 0));
}

/* --------------------------------------------------------------------- menu */
function printFolderList(cfg) {
  console.log('');
  console.log('  ════════════════════════════════════════════════════════════');
  console.log('    风景画廊 · Landscape Gallery — 选择要浏览的文件夹');
  console.log('  ════════════════════════════════════════════════════════════');
  cfg.folders.forEach((f, i) => {
    const ok = isDir(f.path);
    let info = '  (文件夹不存在)';
    if (ok) {
      if (typeof f.count !== 'number') { f.count = countImages(f.path); }
      info = '  ' + f.count + ' 张';
    }
    const idx = String(i + 1).padStart(2, ' ');
    console.log(`   ${idx}) ${(f.name || '').slice(0, 18).padEnd(20)} ${info.padEnd(10)} ${f.path}`);
  });
  console.log('  ────────────────────────────────────────────────────────────');
  console.log('    N) 选择新文件夹…  (弹窗浏览;也可把文件夹拖进本窗口)');
  console.log(`    E) 配置文件位置: ${CONFIG_FILE}`);
  console.log('    Q) 退出');
  console.log('');
}

async function menu(cfg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));
  try {
    for (;;) {
      printFolderList(cfg);
      saveConfig(cfg);                                    // persist cached counts
      const a = (await ask('   请选择 [1-' + cfg.folders.length + ' / N / Q]: ')).trim();

      if (/^q$/i.test(a)) { rl.close(); console.log('  已取消。'); process.exit(0); }

      const n = parseInt(a, 10);
      if (!isNaN(n) && n >= 1 && n <= cfg.folders.length) {
        const f = cfg.folders[n - 1];
        if (!isDir(f.path)) { console.log('\n  ✗ 该文件夹不存在,请检查配置文件或重新选择。\n'); continue; }
        rl.close();
        rememberFolder(cfg, f.path);
        return f.path;
      }

      if (/^[nb]$/i.test(a)) {
        console.log('\n   正在打开文件夹选择窗口…(若没看到,请检查任务栏)\n');
        let p = pickFolderDialog('选择要浏览的图片文件夹');
        if (!p) {
          console.log('   未选择文件夹。也可以直接粘贴路径:');
          const raw = (await ask('   路径(直接回车跳过): ')).trim().replace(/^"|"$/g, '');
          if (!raw) continue;
          p = path.resolve(raw);
          if (!isDir(p)) { console.log('\n  ✗ 路径无效或不是文件夹\n'); continue; }
        }
        if (countImages(p) === 0) { console.log('\n  ✗ 该文件夹里没有 jpg/jpeg 图片\n'); continue; }
        rl.close();
        rememberFolder(cfg, p);
        return p;
      }

      console.log('\n  ✗ 无效的选择,请输入序号或 N/Q\n');
    }
  } finally {
    try { rl.close(); } catch { /* already closed */ }
  }
}

/* --------------------------------------------------------------------- main */
(async () => {
  const cfg = loadConfig();

  if (LIST_ONLY) {
    printFolderList(cfg);
    saveConfig(cfg);
    return;
  }

  if (positional.length) {                                // direct folder (drag & drop)
    const src = path.resolve(positional[0]);
    if (!isDir(src)) { console.error('\n[启动失败] 文件夹不存在: ' + src + '\n'); process.exit(1); }
    rememberFolder(cfg, src);
    start(src);
    return;
  }

  if (!process.stdin.isTTY && !flags.includes('--menu')) {   // non-interactive → default
    console.log('  非交互模式 → 使用默认文件夹: ' + (cfg.default || DEFAULT_SRC));
    const def = cfg.default || DEFAULT_SRC;
    if (!isDir(def)) { console.error('\n[启动失败] 默认文件夹不存在: ' + def + '\n'); process.exit(1); }
    start(def);
    return;
  }

  const chosen = await menu(cfg);
  start(chosen);
})().catch((e) => { console.error('\n[启动失败] ' + e.message + '\n'); process.exit(1); });
