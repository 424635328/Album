'use strict';
/* Asset health check: every thumbs/*.webp and preview/*.webp must carry a valid
   RIFF/WEBP header and a plausible size. Corrupt/undersized files are deleted so
   the next build run regenerates them.
   Usage: node verify-assets.js [--delete] */

const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', 'assets');
const DIRS = [path.join(OUT, 'thumbs'), path.join(OUT, 'preview')];
const DELETE = process.argv.includes('--delete');

function checkFile(f) {
  let st;
  try { st = fs.statSync(f); } catch { return 'unreadable'; }
  if (st.size < 120) return 'too-small(' + st.size + 'B)';
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WEBP') return 'bad-magic';
    return null;
  } catch (e) {
    return 'io-error(' + String(e.message).slice(0, 60) + ')';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* noop */ }
  }
}

let total = 0, bad = 0, deleted = 0;
const samples = [];
for (const dir of DIRS) {
  if (!fs.existsSync(dir)) { console.log('[verify] missing dir: ' + dir); continue; }
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.webp')) continue;
    total++;
    const f = path.join(dir, name);
    const err = checkFile(f);
    if (err) {
      bad++;
      if (samples.length < 12) samples.push(`${path.basename(dir)}/${name}: ${err}`);
      if (DELETE) { try { fs.unlinkSync(f); deleted++; } catch { /* noop */ } }
    }
  }
}
console.log(`[verify] checked=${total} bad=${bad} deleted=${deleted}`);
for (const s of samples) console.log('  ' + s);
if (!DELETE && bad > 0) console.log('[verify] re-run with --delete to remove corrupt files');
