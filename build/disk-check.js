'use strict';
/* Drive write-reliability probe.
 * Writes pseudo-random blocks, fsyncs every block, then reads everything back
 * and compares SHA-256 hashes. This catches drives that report writes as
 * successful but never persist the data ("silent write loss").
 *
 * Usage: node disk-check.js [--size MB] [--rounds N] [--dir PATH] [--keep]
 *   --size    megabytes per round (default 256)
 *   --rounds  independent rounds (default 1); more rounds = more confidence
 *   --dir     target directory (default <gallery>/build/.disktest)
 *   --keep    keep the test files instead of deleting them
 *
 * Exit code 0 = drive reliable. Exit code 1 = corruption or IO error detected.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const argNum = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) || d : d; };
const SIZE_MB = Math.max(8, argNum('--size', 256));
const ROUNDS = Math.max(1, argNum('--rounds', 1));
const DIR = argNum('--dir', path.join(__dirname, '.disktest'));
const KEEP = args.includes('--keep');

const BLOCK = 4 * 1024 * 1024;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  let failures = 0;
  const t0 = Date.now();
  for (let round = 1; round <= ROUNDS; round++) {
    const file = path.join(DIR, `disktest-r${round}.bin`);
    const blocks = Math.ceil((SIZE_MB * 1024 * 1024) / BLOCK);
    const hashes = [];
    process.stdout.write(`[disk-check] round ${round}/${ROUNDS}: writing ${SIZE_MB} MB → ${file} … `);
    let fd;
    let wSecs = 1, rSecs = 1, ok = true;
    try {
      fd = fs.openSync(file, 'w');
      const buf = Buffer.alloc(BLOCK);
      const wStart = Date.now();
      for (let b = 0; b < blocks; b++) {
        crypto.randomFillSync(buf);
        hashes.push(sha256(buf));
        fs.writeSync(fd, buf, 0, buf.length);
        fs.fsyncSync(fd);                     // force data to the platter
      }
      wSecs = (Date.now() - wStart) / 1000;
    } catch (e) {
      console.log(`✗ WRITE FAILED: ${e.message}`);
      failures++; ok = false;
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* noop */ }
      continue;
    }
    try { fs.fsyncSync(fd); fs.closeSync(fd); } catch { /* noop */ }

    process.stdout.write(`${(SIZE_MB / wSecs).toFixed(1)} MB/s. Reading back … `);
    let fd2;
    try {
      fd2 = fs.openSync(file, 'r');
      const buf = Buffer.alloc(BLOCK);
      const rStart = Date.now();
      for (let b = 0; b < blocks; b++) {
        const got = fs.readSync(fd2, buf, 0, BLOCK, b * BLOCK);
        if (got !== BLOCK || sha256(buf.subarray(0, got)) !== hashes[b]) {
          console.log(`\n[disk-check] ✗ CORRUPTION at block ${b} of round ${round}`);
          ok = false; failures++;
          break;
        }
      }
      rSecs = (Date.now() - rStart) / 1000;
    } catch (e) {
      console.log(`\n[disk-check] ✗ READ FAILED: ${e.message}`);
      ok = false; failures++;
    }
    try { if (fd2 !== undefined) fs.closeSync(fd2); } catch { /* noop */ }

    if (ok) console.log(`verified OK (read ${(SIZE_MB / rSecs).toFixed(1)} MB/s)`);
    if (!KEEP) { try { fs.unlinkSync(file); } catch { /* noop */ } }
  }
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(failures === 0
    ? `[disk-check] RESULT: reliable — ${ROUNDS} round(s) × ${SIZE_MB} MB in ${mins} min, no corruption detected.`
    : `[disk-check] RESULT: ✗ ${failures} failure(s) in ${mins} min — do NOT trust this drive for writes.`);
  process.exit(failures === 0 ? 0 : 1);
})();
