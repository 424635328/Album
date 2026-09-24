'use strict';
// Minimal zero-dependency EXIF (TIFF) reader — extracts only the tags the gallery surfaces.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function parseExif(buf) {
  try {
    if (!buf || buf.length < 8) return null;
    // sharp hands us the APP1 payload: "Exif\0\0" followed by the TIFF structure.
    if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'Exif') buf = buf.subarray(6);
    if (buf.length < 8) return null;
    const bo = buf.readUInt16BE(0);
    const little = bo === 0x4949;
    if (!little && bo !== 0x4d4d) return null;
    const r16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const r32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const rs32 = (o) => (little ? buf.readInt32LE(o) : buf.readInt32BE(o));
    if (r16(2) !== 42) return null;

    function entries(off) {
      const map = new Map();
      if (off + 2 > buf.length) return map;
      const n = r16(off);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > buf.length) break;
        const tag = r16(e);
        const type = r16(e + 2);
        const count = r32(e + 4);
        const size = (TYPE_SIZE[type] || 1) * count;
        let vo;
        if (size <= 4) vo = e + 8;
        else {
          vo = r32(e + 8);
          if (vo < 0 || vo + size > buf.length) continue;
        }
        map.set(tag, { type, count, vo });
      }
      return map;
    }
    const ascii = (en) => {
      let end = en.vo;
      const lim = Math.min(en.vo + en.count, buf.length);
      while (end < lim && buf[end] !== 0) end++;
      const s = buf.toString('utf8', en.vo, end).trim();
      return s || null;
    };
    const shorts = (en) => { const a = []; for (let i = 0; i < en.count; i++) a.push(r16(en.vo + i * 2)); return a; };
    const rationals = (en, signed) => {
      const a = [];
      for (let i = 0; i < en.count; i++) {
        const o = en.vo + i * 8;
        const num = signed ? rs32(o) : r32(o);
        const den = signed ? rs32(o + 4) : r32(o + 4);
        a.push(den === 0 ? 0 : num / den);
      }
      return a;
    };

    const ifd0 = entries(r32(4));
    const out = {};
    const makeEn = ifd0.get(0x010f), modelEn = ifd0.get(0x0110), dtEn = ifd0.get(0x0132);
    if (makeEn && makeEn.type === 2) out.make = ascii(makeEn);
    if (modelEn && modelEn.type === 2) out.model = ascii(modelEn);
    if (dtEn && dtEn.type === 2) out.dateTime = ascii(dtEn);
    const oriEn = ifd0.get(0x0112);
    if (oriEn && oriEn.type === 3) { const v = shorts(oriEn)[0]; if (v >= 1 && v <= 8) out.orientation = v; }

    const exifPtr = ifd0.get(0x8769);
    if (exifPtr && exifPtr.type === 4) {
      const ex = entries(r32(exifPtr.vo));
      const t = (tag) => ex.get(tag);
      const et = t(0x829a);
      if (et && et.type === 5) { const v = rationals(et)[0]; if (v > 0) out.exposure = v; }
      const fn = t(0x829d);
      if (fn && (fn.type === 5 || fn.type === 10)) { const v = rationals(fn, fn.type === 10)[0]; if (v > 0) out.fnumber = v; }
      const isoT = t(0x8827);
      if (isoT && (isoT.type === 3 || isoT.type === 4)) { const v = isoT.type === 3 ? shorts(isoT)[0] : r32(isoT.vo); if (v > 0) out.iso = v; }
      const dto = t(0x9003), dtDig = t(0x9004);
      if (dto && dto.type === 2) out.dateTimeOriginal = ascii(dto);
      else if (dtDig && dtDig.type === 2) out.dateTimeOriginal = ascii(dtDig);
      const ot = t(0x9011) || t(0x9010);
      if (ot && ot.type === 2) { const s = ascii(ot); if (s && /^[+-]\d{2}:\d{2}$/.test(s)) out.tzOffset = s; }
      const fl = t(0x920a);
      if (fl && (fl.type === 5 || fl.type === 10)) { const v = rationals(fl, fl.type === 10)[0]; if (v > 0) out.focal = v; }
      const lm = t(0xa434);
      if (lm && lm.type === 2) out.lens = ascii(lm);
    }

    const gpsPtr = ifd0.get(0x8825);
    if (gpsPtr && gpsPtr.type === 4) {
      const gps = entries(r32(gpsPtr.vo));
      const dms = (tag) => {
        const en = gps.get(tag);
        if (!en || en.type !== 5 || en.count !== 3) return null;
        const a = rationals(en);
        return a[0] + a[1] / 60 + a[2] / 3600;
      };
      const latRefE = gps.get(0x0001), lonRefE = gps.get(0x0003);
      const latRef = latRefE && latRefE.type === 2 ? ascii(latRefE) : null;
      const lonRef = lonRefE && lonRefE.type === 2 ? ascii(lonRefE) : null;
      let lat = dms(0x0002), lon = dms(0x0004);
      if (lat != null && latRef === 'S') lat = -lat;
      if (lon != null && lonRef === 'W') lon = -lon;
      if (lat != null && lon != null && (lat !== 0 || lon !== 0)) out.gps = { lat, lon };
      const altE = gps.get(0x0006);
      if (altE && altE.type === 5) { const v = rationals(altE)[0]; if (isFinite(v)) out.gpsAlt = v; }
    }
    return Object.keys(out).length ? out : null;
  } catch (e) {
    return null;
  }
}

function fmtExposure(sec) {
  if (!sec || sec <= 0) return null;
  if (sec >= 1) return (Math.round(sec * 10) / 10) + 's';
  const d = Math.round(1 / sec);
  return d > 0 ? `1/${d}s` : sec.toFixed(4) + 's';
}

function exifToDateISO(ex) {
  const raw = (ex && (ex.dateTimeOriginal || ex.dateTime)) || null;
  if (!raw) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!m) return null;
  let s = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  if (ex.tzOffset && ex.dateTimeOriginal) s += ex.tzOffset;
  return s;
}

module.exports = { parseExif, fmtExposure, exifToDateISO };
