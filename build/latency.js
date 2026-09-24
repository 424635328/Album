'use strict';
/* Event-latency aggregation for the behaviour telemetry.
 *
 * The page reports a numeric `ms` with most events (click = event → next painted
 * frame, photo.loaded = navigation → original ready, filter.apply = filter cost, ...).
 * This module keeps a running mean/min/max/count per event so the server can RECORD
 * the current means instead of only appending raw samples, which is what makes a
 * regression visible in the log without any external analysis.
 *
 * Two windows are kept per event:
 *   window  — since the last summary (what is happening right now)
 *   total   — since the server started (the session mean)
 *
 * Qualifiers: `cached:true/false` is folded into the key, because a prefetch hit and a
 * cold read are different phenomena and averaging them together hides both.
 */

const windows = new Map();   // key → { wN, wSum, wMin, wMax, tN, tSum, tMin, tMax, wInt, tInt }
let dirty = false;

/* Anything above this is a suspend/resume artifact (performance.now() keeps counting
   while the machine sleeps), not latency. Counted separately, never averaged in. */
const MAX_PLAUSIBLE_MS = 60000;

function keyOf(event, data) {
  let k = event;
  if (data && data.cached === true) k += '/预取命中';
  else if (data && data.cached === false) k += '/冷读';
  return k;
}

function observe(event, data) {
  const ms = data && typeof data.ms === 'number' ? data.ms : null;
  if (ms === null || !Number.isFinite(ms) || ms < 0) return;
  const k = keyOf(String(event || 'event'), data);
  let s = windows.get(k);
  if (!s) { s = { wN: 0, wSum: 0, wMin: Infinity, wMax: 0, tN: 0, tSum: 0, tMin: Infinity, tMax: 0, wInt: 0, tInt: 0 }; windows.set(k, s); }
  if (ms > MAX_PLAUSIBLE_MS) { s.wInt += 1; s.tInt += 1; dirty = true; return; }
  s.wN += 1; s.wSum += ms; s.wMin = Math.min(s.wMin, ms); s.wMax = Math.max(s.wMax, ms);
  s.tN += 1; s.tSum += ms; s.tMin = Math.min(s.tMin, ms); s.tMax = Math.max(s.tMax, ms);
  dirty = true;
}

const mean = (sum, n) => (n ? Math.round(sum / n) : 0);

/* Sorted by window count (busiest first) so the summary reads like a hot list. */
function snapshot() {
  return [...windows.entries()]
    .map(([event, s]) => ({
      event,
      window: { n: s.wN, mean: mean(s.wSum, s.wN), min: s.wN ? s.wMin : null, max: s.wMax, interrupted: s.wInt },
      total: { n: s.tN, mean: mean(s.tSum, s.tN), min: s.tN ? s.tMin : null, max: s.tMax, interrupted: s.tInt },
    }))
    .sort((a, b) => b.window.n - a.window.n);
}

/* One compact log line: "click=78(n=42,max=265) photo.loaded/冷读=91(n=12,max=2495)" */
function summaryLine(which = 'window') {
  const rows = snapshot().filter((r) => r[which].n > 0);
  if (!rows.length) return null;
  return rows.map((r) => {
    const w = r[which];
    return `${r.event}=${w.mean}(n=${w.n},max=${w.max}${w.interrupted ? ',中断=' + w.interrupted : ''})`;
  }).join(' ');
}

/* Called after a summary is written: the window restarts, the session total does not. */
function resetWindow() {
  for (const s of windows.values()) { s.wN = 0; s.wSum = 0; s.wMin = Infinity; s.wMax = 0; s.wInt = 0; }
  dirty = false;
}
function isEmpty() { return !windows.size; }
function isDirty() { return dirty; }
function clear() { windows.clear(); dirty = false; }

/* Start the periodic recorder. intervalSec = 0 disables it. */
function startPeriodic(writeLine, intervalSec = 60) {
  if (!intervalSec) return null;
  const t = setInterval(() => {
    if (!dirty) return;
    const line = summaryLine('window');
    if (!line) return;
    writeLine(line);
    resetWindow();
  }, intervalSec * 1000);
  if (t.unref) t.unref();
  return t;
}

module.exports = { observe, snapshot, summaryLine, resetWindow, startPeriodic, isEmpty, isDirty, clear, MAX_PLAUSIBLE_MS };
