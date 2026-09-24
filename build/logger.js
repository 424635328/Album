'use strict';
/* Minimal leveled logger used by every gallery tool.
 *
 *   Levels   error < warn < info < debug
 *   Default  info   (clean: what is happening, nothing chatty)
 *   Debug    per-item progress, cache hits, hot-reload events, routing details
 *
 * Enable verbose output with any of:
 *     --debug | --verbose | -v        (command line)
 *     GALLERY_LOG=debug               (environment)
 * Suppress everything but failures:
 *     --quiet | -q                    or  GALLERY_LOG=error
 *
 * Output format:  [2026-09-23 23:10:45.123] [INFO ] [server] message
 * Colors are used only when stdout is a real terminal (and NO_COLOR is unset).
 *
 * File sink: attachFile(dir) mirrors the same records to a rotating log file, so a
 * detached server (started by start-gallery.cmd, console long gone) still keeps the
 * browser telemetry — including every client-side latency event — on disk.
 * Rotation: one file per day, split at 4 MB, newest 5 kept. Never throws: a broken
 * sink silently degrades to console-only.
 */
const fs = require('fs');
const path = require('path');
const util = require('util');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const NAMES = ['error', 'warn', 'info', 'debug'];
const COLORS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const KEEP_FILES = 5;

function parseLevel(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--quiet') || argv.includes('-q')) return 'error';
  if (argv.includes('--debug') || argv.includes('--verbose') || argv.includes('-v')) return 'debug';
  const fromEnv = String(env.GALLERY_LOG || '').toLowerCase();
  if (LEVELS[fromEnv] !== undefined) return fromEnv;
  return 'info';
}

let current = parseLevel();
const colorize = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/* ------------------------------- file sink ------------------------------- */

let sinkDir = null, sinkBase = 'gallery';
let stream = null, streamPath = null, streamDay = '', streamBytes = 0, streamPart = 0;
const queue = [];
let flushTimer = null;

const dayKey = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

function pruneOldFiles() {
  try {
    const files = fs.readdirSync(sinkDir).filter((f) => f.startsWith(sinkBase + '-') && f.endsWith('.log')).sort();
    while (files.length > KEEP_FILES) {
      const victim = path.join(sinkDir, files.shift());
      if (victim !== streamPath) { try { fs.unlinkSync(victim); } catch { /* in use */ } }
    }
  } catch { /* non-fatal */ }
}

function openStream() {
  if (!fs.existsSync(sinkDir)) fs.mkdirSync(sinkDir, { recursive: true });
  const day = dayKey();
  if (day !== streamDay) streamPart = 0;
  if (stream && day === streamDay && streamBytes < MAX_FILE_BYTES) return;
  if (stream) { try { stream.end(); } catch { /* ignore */ } stream = null; streamPart++; }
  streamDay = day;
  streamBytes = 0;
  streamPath = path.join(sinkDir, `${sinkBase}-${day}${streamPart ? '-' + streamPart : ''}.log`);
  try {
    streamBytes = fs.existsSync(streamPath) ? fs.statSync(streamPath).size : 0;
    if (streamBytes >= MAX_FILE_BYTES) { streamPart++; return openStream(); }
    stream = fs.createWriteStream(streamPath, { flags: 'a' });
    stream.on('error', () => { try { stream.destroy(); } catch { /* ignore */ } stream = null; });
  } catch { stream = null; }
  pruneOldFiles();
}

function flushNow() {
  flushTimer = null;
  if (!queue.length) return;
  if (!stream) openStream();
  if (!stream) { queue.length = 0; return; }         // sink unusable → console-only
  const chunk = queue.join('');
  queue.length = 0;
  streamBytes += Buffer.byteLength(chunk);
  try { stream.write(chunk); } catch { /* ignore */ }
}

function enqueue(line) {
  queue.push(line);
  if (queue.length >= 64) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushNow();
    return;
  }
  if (!flushTimer) flushTimer = setTimeout(flushNow, 250);
}

function attachFile(dir, base = 'gallery') {
  try {
    sinkDir = dir;
    sinkBase = base;
    streamPart = 0;
    streamDay = '';
    openStream();
    return streamPath;
  } catch { sinkDir = null; return null; }
}

process.on('exit', () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!streamPath || !queue.length) return;
  try { fs.appendFileSync(streamPath, queue.join('')); queue.length = 0; } catch { /* ignore */ }
});

/* --------------------------------- emit --------------------------------- */

function emit(level, mod, args) {
  if (LEVELS[level] > LEVELS[current]) return;
  const head = `[${stamp()}] [${level.toUpperCase().padEnd(5)}] [${mod}]`;
  if (sinkDir) enqueue(util.format(head, ...args) + '\n');
  const write = level === 'error' || level === 'warn' ? console.error : console.log;
  if (colorize) write(`${COLORS[level]}${head}${RESET}`, ...args);
  else write(head, ...args);
}

module.exports = {
  setLevel(level) { if (LEVELS[level] !== undefined) current = level; },
  getLevel() { return current; },
  isDebug() { return current === 'debug'; },
  parseLevel,
  attachFile,
  logFilePath() { return streamPath; },
  flush() { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } flushNow(); },
  levels: NAMES,
  error: (mod, ...a) => emit('error', mod, a),
  warn: (mod, ...a) => emit('warn', mod, a),
  info: (mod, ...a) => emit('info', mod, a),
  debug: (mod, ...a) => emit('debug', mod, a),
};
