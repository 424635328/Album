'use strict';
/* Post-dropout file verification for the gallery project.
 *
 *   node verify-files.js                          structural check of every source file
 *   node verify-files.js --record                 ... and write build/file-manifest.json
 *   node verify-files.js --check                  compare against the manifest
 *   node verify-files.js --since "2026-09-24 08:55" [--until "..."]   only files written in a window
 *
 * Why: this USB drive silently loses writes while it flaps (UASPStor resets the device,
 * NTFS reports "failed to flush the transaction log"). A write can return success, read
 * back from the page cache, and still never reach the disk — that is how .gitattributes
 * disappeared once. So after every dropout window, run this.
 *
 * Checks are structural, per file type, chosen to catch the failure modes that actually
 * happen: a truncated tail (syntax / closing tag / brace balance), a zero-filled region
 * (NUL bytes, invalid UTF-8), or a vanished file (missing from the manifest).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(__dirname, 'file-manifest.json');
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const RECORD = args.includes('--record');
const CHECK = args.includes('--check');
const WITH_ASSETS = args.includes('--assets');   // include assets/ (RIFF header self-check)
const SINCE = argVal('--since', '');
const UNTIL = argVal('--until', '');

/* Directories whose contents are derived, disposable or enormous. assets/ is included
   only with --assets, where only the header of each WebP is read (no decode). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'sets', 'logs', '.disktest', ...(WITH_ASSETS ? [] : ['assets'])]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hasNul = (buf) => buf.includes(0);

function checkFile(abs, buf) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const ext = path.extname(abs).toLowerCase();
  const problems = [];
  const notes = [];

  if (buf.length === 0) problems.push('文件为空');
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico'].includes(ext) && hasNul(buf)) problems.push('包含 NUL 字节(零填充/损坏特征)');

  const text = buf.toString('utf8');
  if (buf.length && text.includes('\uFFFD') && !/[\uFFFD]/.test(String.fromCharCode(...[]))) {
    // U+FFFD in a text file means the bytes were not valid UTF-8
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico'].includes(ext)) problems.push('UTF-8 解码出现替换字符(字节损坏)');
  }

  switch (ext) {
    case '.js': {
      try { new vm.Script(text, { filename: rel }); } catch (e) { problems.push('语法错误: ' + e.message.split('\n')[0]); }
      if (text && !text.endsWith('\n')) notes.push('结尾无换行');
      break;
    }
    case '.html': {
      if (!/<\/html>\s*$/i.test(text)) problems.push('结尾缺少 </html>(疑似被截断)');
      for (const id of ['statsModal', 'statsBtn', 'lightbox', 'grid']) {
        if (!text.includes(id)) problems.push(`缺少关键元素 #${id}`);
      }
      break;
    }
    case '.css': {
      const open = (text.match(/\{/g) || []).length, close = (text.match(/\}/g) || []).length;
      if (open !== close) problems.push(`花括号不配对: { ${open} } ${close}(疑似被截断)`);
      if (text && !text.endsWith('\n')) notes.push('结尾无换行');
      break;
    }
    case '.json': {
      try { JSON.parse(text); } catch (e) { problems.push('JSON 解析失败: ' + e.message.split('\n')[0]); }
      break;
    }
    case '.cmd': case '.bat': {
      if (!text.includes('@echo off') && !text.includes('REM') && text.length > 40) notes.push('未见 @echo off');
      if (!buf.includes(0x0D)) problems.push('无 CR:应为 CRLF(cmd.exe 对 LF-only 容错有限)');
      break;
    }
    case '.ps1': {
      const bom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
      if (!bom) notes.push('缺少 UTF-8 BOM(PowerShell 5.1 读中文可能乱码)');
      if (!buf.includes(0x0D)) problems.push('无 CR:应为 CRLF');
      const tail = text.trimEnd().slice(-1);
      if (tail !== '}') notes.push(`结尾不是 } 而是 "${tail}"(请确认文件完整)`);
      break;
    }
    case '.md': {
      if (text && !text.endsWith('\n')) notes.push('结尾无换行');
      break;
    }
    case '.webp': {
      /* RIFF declares its own total length, so a truncated or zero-filled write is
         detectable without decoding: diag-reload.js rewrote one thumb, and this is the
         check that proves such a rewrite landed complete. */
      if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
        problems.push('不是有效的 WebP(RIFF/WEBP 头损坏)');
      } else {
        const declared = buf.readUInt32LE(4) + 8;
        if (declared !== buf.length) problems.push(`RIFF 声明 ${declared} 字节,实际 ${buf.length} 字节(截断)`);
        const chunk = buf.readUInt32LE(16), end = 20 + chunk + (chunk % 2);
        if (end > buf.length) problems.push(`VP8 块越界(${end} > ${buf.length},截断)`);
      }
      break;
    }
    case '.png': case '.jpg': case '.jpeg': {
      if (buf.length > 12 && ext === '.png' && buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') problems.push('PNG 签名不正确');
      if (buf.length > 4 && (ext === '.jpg' || ext === '.jpeg') && buf[0] !== 0xFF && buf[1] !== 0xD8) problems.push('JPEG 缺少 SOI 标记');
      if (buf.length > 4 && (ext === '.jpg' || ext === '.jpeg') && !(buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9)) problems.push('JPEG 缺少 EOI 标记(截断)');
      break;
    }
    default: break;
  }
  return { rel, size: buf.length, sha256: sha256(buf), problems, notes };
}

(function main() {
  let files = walk(ROOT).filter((f) => f !== MANIFEST);   // never hash the manifest itself
  if (SINCE) {
    const from = new Date(SINCE).getTime();
    const to = UNTIL ? new Date(UNTIL).getTime() : Date.now();
    files = files.filter((f) => {
      const t = fs.statSync(f).mtime.getTime();
      return t >= from && t <= to;
    });
    console.log(`\n=== 只校验修改时间在 ${SINCE} ~ ${UNTIL || '现在'} 的文件 ===`);
  }

  const results = [];
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(f); } catch (e) { results.push({ rel: path.relative(ROOT, f), size: -1, sha256: '', problems: ['读取失败: ' + e.message], notes: [] }); continue; }
    results.push(checkFile(f, buf));
  }
  results.sort((a, b) => a.rel.localeCompare(b.rel));

  const bad = results.filter((r) => r.problems.length);
  const noted = results.filter((r) => !r.problems.length && r.notes.length);

  console.log(`\n检查 ${results.length} 个文件(范围:${WITH_ASSETS ? '源码 + assets' : '源码'};已排除 sets/logs/node_modules/.git)`);
  if (bad.length) {
    console.log(`\n✗ ${bad.length} 个文件有问题:`);
    for (const r of bad) console.log(`  ${r.rel}\n     - ${r.problems.join('\n     - ')}`);
  } else {
    console.log('✓ 结构校验全部通过(无截断 / 无 NUL / 语法与结尾标记正常)');
  }
  if (noted.length) {
    console.log(`\n提示(${noted.length} 项,非错误):`);
    for (const r of noted) console.log(`  ${r.rel}: ${r.notes.join('; ')}`);
  }

  if (CHECK) {
    if (!fs.existsSync(MANIFEST)) {
      console.log('\n--check: 还没有清单,先跑一次 --record。');
    } else {
      const old = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      const changed = [], missing = [];
      for (const [rel, rec] of Object.entries(old.files)) {
        const cur = results.find((r) => r.rel === rel);
        if (!cur) { missing.push(rel); continue; }
        if (cur.sha256 !== rec.sha256) changed.push(`${rel} (${rec.size} → ${cur.size} 字节)`);
      }
      console.log(`\n=== 与清单比对(${old.generated}) ===`);
      console.log(missing.length ? `✗ 清单里有但磁盘上缺失(${missing.length}):\n  ${missing.join('\n  ')}` : '✓ 没有文件消失');
      console.log(changed.length ? `• 内容变化的文件(${changed.length}):\n  ${changed.join('\n  ')}` : '• 没有文件内容变化');
    }
  }

  if (RECORD) {
    const manifest = {
      generated: new Date().toISOString(),
      root: ROOT,
      files: Object.fromEntries(results.filter((r) => !r.problems.length).map((r) => [r.rel, { size: r.size, sha256: r.sha256 }])),
    };
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`\n已写入清单: ${MANIFEST}(${Object.keys(manifest.files).length} 个文件)`);
  }

  if (bad.length) process.exitCode = 1;
})();
