'use strict';
/* Event-latency statistics from the gallery log files.
 *
 *   node log-stats.js                    print the table for logs/*.log
 *   node log-stats.js --record           also write latency-report.md (project root)
 *   node log-stats.js --json             machine-readable output
 *   node log-stats.js --dir <dir>        another log directory
 *   node log-stats.js --event click      only events whose key contains this text
 *
 * Every client telemetry line carries a numeric `ms`; this turns them into n / mean /
 * median / p95 / max per event so a regression is visible as a number rather than as a
 * feeling. `click` is reported per target, and `photo.loaded` / `photo.paint` are split
 * by prefetch hit vs cold read — averaging those together would hide both behaviours.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DIR = path.resolve(argVal('--dir', path.join(__dirname, '..', 'logs')));
/* Samples above a minute are suspend/resume artifacts, not latency — see build/latency.js.
   They are counted and excluded, never averaged in. */
const MAX_PLAUSIBLE_MS = 60000;
const RECORD = args.includes('--record');
const AS_JSON = args.includes('--json');
const ONLY = argVal('--event', '');
const REPORT = path.join(__dirname, '..', 'latency-report.md');

function keyFor(event, data) {
  if (event === 'click' && data && data.target) return 'click:' + data.target;
  if (data && data.cached === true) return event + ' (预取命中)';
  if (data && data.cached === false) return event + ' (冷读)';
  return event;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function collect() {
  const files = fs.existsSync(DIR)
    ? fs.readdirSync(DIR).filter((f) => f.endsWith('.log')).sort().map((f) => path.join(DIR, f))
    : [];
  const groups = new Map();
  let scanned = 0, used = 0, skipped = 0;

  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      scanned++;
      const m = /\[client\]\s+([\w.]+)\s*(\{.*\})?\s*$/.exec(line);
      if (!m) continue;
      const event = m[1];
      let data = null;
      if (m[2]) { try { data = JSON.parse(m[2]); } catch { data = null; } }
      const ms = data && typeof data.ms === 'number' ? data.ms : null;
      if (ms === null || !Number.isFinite(ms)) continue;
      const key = keyFor(event, data);
      if (ONLY && !key.includes(ONLY)) continue;
      let g = groups.get(key);
      if (!g) { g = { key, samples: [], interrupted: 0 }; groups.set(key, g); }
      if (ms > MAX_PLAUSIBLE_MS) { g.interrupted++; skipped++; continue; }
      g.samples.push(ms);
      used++;
    }
  }

  const rows = [...groups.values()].filter((g) => g.samples.length).map((g) => {
    const s = g.samples.slice().sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    return {
      key: g.key, n: s.length, interrupted: g.interrupted,
      mean: Math.round(sum / s.length),
      median: percentile(s, 50), p95: percentile(s, 95), min: s[0], max: s[s.length - 1],
    };
  }).sort((a, b) => b.n - a.n || b.mean - a.mean);

  return { files: files.map((f) => path.basename(f)), scanned, used, skipped, rows };
}

function pad(s, w) { return String(s).padEnd(w); }
function lpad(s, w) { return String(s).padStart(w); }

function printTable(res) {
  console.log(`\n=== 事件延迟统计 (${res.files.join(', ') || '无日志文件'}) ===`);
  console.log(`扫描 ${res.scanned} 行, 取到 ${res.used} 个带 ms 的埋点` +
    (res.skipped ? `,其中 ${res.skipped} 个判为中断样本(>60s,机器休眠/唤醒产物)已排除\n` : '\n'));
  if (!res.rows.length) { console.log('没有可用样本。先跑一遍 test-gallery.cmd 或正常浏览一会儿。\n'); return; }
  const w = Math.max(24, ...res.rows.map((r) => r.key.length));
  console.log(pad('事件', w) + lpad('次数', 6) + lpad('均值', 7) + lpad('中位', 7) + lpad('p95', 7) + lpad('最小', 7) + lpad('最大', 7) + lpad('中断', 6));
  console.log('-'.repeat(w + 47));
  for (const r of res.rows) {
    console.log(pad(r.key, w) + lpad(r.n, 6) + lpad(r.mean, 7) + lpad(r.median, 7) + lpad(r.p95, 7) + lpad(r.min, 7) + lpad(r.max, 7) + lpad(r.interrupted || '', 6));
  }
  const agg = (pick) => {
    const rows = res.rows.filter(pick);
    const n = rows.reduce((a, r) => a + r.n, 0);
    const sum = rows.reduce((a, r) => a + r.mean * r.n, 0);
    return { n, mean: n ? Math.round(sum / n) : 0 };
  };
  const ui = agg((r) => r.key.startsWith('click:'));
  const load = agg((r) => r.key.startsWith('photo.loaded'));
  const loadHit = agg((r) => r.key.startsWith('photo.loaded (预取命中)'));
  const loadCold = agg((r) => r.key.startsWith('photo.loaded (冷读)'));
  console.log('-'.repeat(w + 47));
  if (ui.n) console.log(pad('交互响应合计(click:*)', w) + lpad(ui.n, 6) + lpad(ui.mean, 7) + '   ← 用户按下按钮的感受');
  if (load.n) console.log(pad('原图就绪合计(photo.loaded)', w) + lpad(load.n, 6) + lpad(load.mean, 7));
  if (loadHit.n && loadCold.n) console.log(pad('  ├ 预取命中', w) + lpad(loadHit.n, 6) + lpad(loadHit.mean, 7) + '   ← 翻页手感');
  if (loadHit.n && loadCold.n) console.log(pad('  └ 冷读', w) + lpad(loadCold.n, 6) + lpad(loadCold.mean, 7) + '   ← 受磁盘/解码限制');
  console.log('\n注:thumb.slow / page.firstPaint 是里程碑与异常检测指标,不和交互延迟一起平均。');
  console.log('    样本含测试套件驱动的高负载会话,与日常浏览不可直接比较;要日常基线请清空 logs 后正常使用一段时间再统计。\n');
}

function writeReport(res) {
  const stamp = new Date().toLocaleString('sv-SE').replace('T', ' ');
  const lines = [];
  lines.push('# 事件延迟报告(自动生成)');
  lines.push('');
  lines.push(`生成时间:${stamp}   来源:${res.files.join(', ') || '(无)'}   样本:${res.used} 条带 ms 的埋点`);
  lines.push('');
  lines.push('| 事件 | 次数 | 均值 | 中位 | p95 | 最小 | 最大 | 中断样本 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of res.rows) {
    lines.push(`| \`${r.key}\` | ${r.n} | **${r.mean} ms** | ${r.median} | ${r.p95} | ${r.min} | ${r.max} | ${r.interrupted || ''} |`);
  }
  const aggMd = (pick) => {
    const rows = res.rows.filter(pick);
    const n = rows.reduce((a, r) => a + r.n, 0);
    const sum = rows.reduce((a, r) => a + r.mean * r.n, 0);
    return { n, mean: n ? Math.round(sum / n) : 0 };
  };
  const uiMd = aggMd((r) => r.key.startsWith('click:'));
  const hitMd = aggMd((r) => r.key.startsWith('photo.loaded (预取命中)'));
  const coldMd = aggMd((r) => r.key.startsWith('photo.loaded (冷读)'));
  lines.push('');
  lines.push('## 聚合(已排除中断样本)');
  lines.push('');
  if (uiMd.n) lines.push('- **交互响应合计(click:*):' + uiMd.mean + ' ms**(n=' + uiMd.n + ') — 用户按下按钮的感受');
  if (hitMd.n) lines.push('- **翻页手感(预取命中):' + hitMd.mean + ' ms**(n=' + hitMd.n + ')');
  if (coldMd.n) lines.push('- **冷读原图就绪:' + coldMd.mean + ' ms**(n=' + coldMd.n + ') — 受外置硬盘与解码限制');
  lines.push('- 中断样本 ' + res.skipped + ' 个(>60s)已剔除并单独计数');
  lines.push('');
  lines.push('> `thumb.slow` 与 `page.firstPaint` 是里程碑/异常检测指标,不与交互延迟合并平均。');
  lines.push('');
  lines.push('## 解读');
  lines.push('');
  lines.push('- `click:*` 是页面内测量(事件 → 下一帧绘制完成),不受测试脚本往返影响,是最可信的交互指标。');
  lines.push('- `photo.loaded (预取命中)` 与 `(冷读)` 必须分开看:前者代表翻页手感,后者受外置硬盘与解码速度限制。');
  lines.push('- 样本里包含测试套件驱动的高负载会话;要得到日常基线,清空 `logs\\` 后正常浏览一段时间再重新生成。');
  lines.push('- **中断样本**(>60s)是机器休眠/唤醒的产物(`performance.now()` 跨休眠继续计时),已从均值中剔除并单独计数。');
  lines.push('- 重新生成:`node build\\log-stats.js --record`');
  lines.push('');
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
  return REPORT;
}

const res = collect();
if (AS_JSON) console.log(JSON.stringify(res, null, 2));
else {
  printTable(res);
  if (RECORD) console.log(`已写入报告: ${writeReport(res)}\n`);
}
