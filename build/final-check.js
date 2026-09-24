'use strict';
/* Final consistency check: data.js keys vs on-disk assets. */
const fs = require('fs');
const path = require('path');

const dataSrc = fs.readFileSync(path.resolve(__dirname, '..', 'data.js'), 'utf8');
const keys = [...dataSrc.matchAll(/"k":"([a-z0-9]+)"/g)].map(m => m[1]);
const uniq = new Set(keys);
console.log('data.js photos:', keys.length, '| unique keys:', uniq.size);
if (uniq.size !== keys.length) {
  const seen = new Set(); const dup = [];
  for (const k of keys) { if (seen.has(k)) dup.push(k); seen.add(k); }
  console.log('duplicates:', dup.join(', '));
}

for (const kind of ['thumbs', 'preview']) {
  const dir = path.resolve(__dirname, '..', 'assets', kind);
  const onDisk = new Set(fs.readdirSync(dir).filter(f => f.endsWith('.webp')).map(f => f.replace(/\.webp$/, '')));
  const missing = [...uniq].filter(k => !onDisk.has(k));
  const extra = [...onDisk].filter(k => !uniq.has(k));
  console.log(`${kind}: on-disk=${onDisk.size}, missing=${missing.length}, extra=${extra.length}`);
  if (missing.length) console.log(`  missing samples: ${missing.slice(0, 10).join(', ')}`);
  if (extra.length) console.log(`  extra samples: ${extra.slice(0, 10).join(', ')}`);
}
