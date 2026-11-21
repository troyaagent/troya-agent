// Square coin logos (21 Nov audit, 3-08): every site shows a coin's logo in a square or a circle, so the image of a launch
// from X or Telegram is centre-cropped to a square (side = its shorter edge), at most 1024 px, before it is stored and
// written on chain for good. The same rule as the web form's shrink() in launch-create.js, so all three paths agree.
// A 2400 × 1200 picture used to be stored as 1024 × 512, and every board then cut its own middle out of it.
// The project has no image library: PNG goes through icons.mjs's decoder and encoder, JPEG (baseline and progressive,
// 8-bit, grey or YCbCr) is decoded below. What cannot be read here (WebP, GIF, CMYK, a photo turned by its EXIF) is kept
// exactly as it came, as before.
import { _test as icons } from "./icons.mjs";

const { pngDecode, pngEncode, resize } = icons;
export const LOGO_SIDE = 1024;               // the web form's limit too
const LOGO_BYTES = 1024 * 1024;              // the logo store's limit (robinhood.mjs saveLogo)
const MAX_PIXELS = 12_000_000;               // a bigger picture is not decoded (it would hold ~100 MB)

/**
 * → { buf, type, square } where square is true when the image is now a centre square of at most 1024 px (re-encoded as a
 * PNG, or the original bytes when it already was one), false when it could not be read and is returned unchanged.
 */
export async function squareLogo(buf, type) {
  const t = type === "image/jpg" ? "image/jpeg" : type;
  let pic = null;
  try { pic = t === "image/png" ? await pngDecode(buf) : t === "image/jpeg" ? jpegDecode(buf) : null; } catch { pic = null; }
  if (!pic || !pic.w || !pic.h) return { buf, type: t, square: false };
  const side = Math.min(pic.w, pic.h);
  // already a square that fits: the original bytes, never re-encoded (no quality lost)
  if (pic.w === pic.h && side <= LOGO_SIDE && buf.length <= LOGO_BYTES) return { buf, type: t, square: true, side };
  const sx = Math.floor((pic.w - side) / 2), sy = Math.floor((pic.h - side) / 2);
  // a PNG of a photo is large: 1024 px first, then smaller until it fits the 1 MB store (512 px RGB always does)
  for (const target of [LOGO_SIDE, 768, 512, 384]) {
    const n = Math.min(side, target);
    const out = pngEncode(resize(pic, sx, sy, side, side, n, n));
    if (out.length <= LOGO_BYTES) return { buf: out, type: "image/png", square: true, side: n };
  }
  return { buf, type: t, square: false };
}

/* ---------- JPEG, full size ---------- */
// natural (row-major) index of each coefficient in zig-zag order
const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
// the inverse DCT as two passes of 8 × 8 products: IDCT[x * 8 + u] = C(u) / 2 · cos((2x + 1) u π / 16)
const IDCT = (() => { const m = new Float64Array(64); for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) m[x * 8 + u] = (u ? 1 : Math.SQRT1_2) / 2 * Math.cos(((2 * x + 1) * u * Math.PI) / 16); return m; })();
const clamp8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/** → { w, h, rgba } or null for anything this decoder does not read (it never guesses). */
export function jpegDecode(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const qt = [], dcT = [], acT = [];
  let f = null, ri = 0, adobe = -1, scans = 0, p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) { p++; continue; }
    const m = buf[p + 1];
    if (m === 0xff) { p++; continue; }
    p += 2;
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xd9) break;
    const len = buf.readUInt16BE(p), seg = buf.subarray(p + 2, p + len);
    p += len;
    if (m === 0xdb) {
      for (let i = 0; i < seg.length;) {
        const pq = seg[i] >> 4, q = new Float64Array(64);
        for (let k = 0; k < 64; k++) q[ZZ[k]] = pq ? seg.readUInt16BE(i + 1 + k * 2) : seg[i + 1 + k];
        qt[seg[i] & 15] = q;
        i += 1 + 64 * (pq ? 2 : 1);
      }
    } else if (m === 0xc4) {
      for (let i = 0; i < seg.length;) {
        const tc = seg[i] >> 4, th = seg[i] & 15, counts = seg.subarray(i + 1, i + 17);
        let n = 0; for (const c of counts) n += c;
        (tc ? acT : dcT)[th] = huffTable(counts, seg.subarray(i + 17, i + 17 + n));
        i += 17 + n;
      }
    } else if (m === 0xdd) ri = seg.readUInt16BE(0);
    else if (m === 0xe1 && seg.toString("latin1", 0, 4) === "Exif" && exifRotated(seg.subarray(6))) return null;   // a turned photo: kept as it is
    else if (m === 0xee && seg.toString("latin1", 0, 5) === "Adobe") adobe = seg[11];
    else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      if (f || seg[0] !== 8) return null;
      const H = seg.readUInt16BE(1), W = seg.readUInt16BE(3), n = seg[5];
      if (!W || !H || (n !== 1 && n !== 3) || W * H > MAX_PIXELS) return null;   // CMYK and friends stay as they are
      const comps = [];
      for (let i = 0; i < n; i++) comps.push({ id: seg[6 + i * 3], h: seg[7 + i * 3] >> 4, v: seg[7 + i * 3] & 15, tq: seg[8 + i * 3], pred: 0 });
      if (comps.some((c) => c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4)) return null;
      const hmax = Math.max(...comps.map((c) => c.h)), vmax = Math.max(...comps.map((c) => c.v));
      const mcuX = Math.ceil(W / (8 * hmax)), mcuY = Math.ceil(H / (8 * vmax));
      for (const c of comps) {
        c.bw = mcuX * c.h; c.bh = mcuY * c.v;                                     // the block grid, padded to whole MCUs
        c.cbw = Math.ceil(Math.ceil((W * c.h) / hmax) / 8); c.cbh = Math.ceil(Math.ceil((H * c.v) / vmax) / 8);   // the blocks that carry the picture
        c.cw = Math.ceil((W * c.h) / hmax); c.ch = Math.ceil((H * c.v) / vmax);   // the component's own size in pixels
        c.coef = new Int32Array(c.bw * c.bh * 64);
      }
      f = { W, H, comps, hmax, vmax, mcuX, mcuY, progressive: m === 0xc2 };
    } else if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return null;   // lossless or arithmetic coding
    else if (m === 0xda) {
      if (!f) return null;
      const ns = seg[0], sc = [];
      for (let i = 0; i < ns; i++) {
        const c = f.comps.find((x) => x.id === seg[1 + i * 2]);
        if (!c) return null;
        sc.push({ c, dc: dcT[seg[2 + i * 2] >> 4], ac: acT[seg[2 + i * 2] & 15] });
      }
      const ss = seg[1 + ns * 2], se = seg[2 + ns * 2], ah = seg[3 + ns * 2] >> 4, al = seg[3 + ns * 2] & 15;
      p = scan(buf, p, f, sc, { ri, ss, se, ah, al });
      scans++;
    }
  }
  if (!f || !scans || f.comps.some((c) => !qt[c.tq])) return null;
  const { W, H, comps, hmax, vmax } = f;
  // each component as a plane of pixels: dequantise, inverse DCT, +128
  const tmp = new Float64Array(64);
  for (const c of comps) {
    const q = qt[c.tq], pw = c.bw * 8, plane = new Uint8ClampedArray(pw * c.bh * 8);
    for (let by = 0; by < c.cbh; by++) for (let bx = 0; bx < c.cbw; bx++) {
      const o = (by * c.bw + bx) * 64;
      for (let v = 0; v < 8; v++) for (let x = 0; x < 8; x++) {
        let s = 0; for (let u = 0; u < 8; u++) s += c.coef[o + v * 8 + u] * q[v * 8 + u] * IDCT[x * 8 + u];
        tmp[v * 8 + x] = s;
      }
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        let s = 0; for (let v = 0; v < 8; v++) s += tmp[v * 8 + x] * IDCT[y * 8 + v];
        plane[(by * 8 + y) * pw + bx * 8 + x] = s + 128;
      }
    }
    c.plane = plane; c.pw = pw; c.coef = null;
  }
  // subsampled chroma is interpolated between sample centres (libjpeg's "fancy upsampling"), never shown as 2-pixel steps
  const at = (c, x, y) => {
    if (c.h === hmax && c.v === vmax) return c.plane[y * c.pw + x];
    const fx = Math.max(0, Math.min(c.cw - 1, ((x + 0.5) * c.h) / hmax - 0.5)), fy = Math.max(0, Math.min(c.ch - 1, ((y + 0.5) * c.v) / vmax - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(c.cw - 1, x0 + 1), y1 = Math.min(c.ch - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    const g = (xx, yy) => c.plane[yy * c.pw + xx];
    return (g(x0, y0) * (1 - tx) + g(x1, y0) * tx) * (1 - ty) + (g(x0, y1) * (1 - tx) + g(x1, y1) * tx) * ty;
  };
  const rgb = comps.length === 3 && (adobe === 0 || (comps[0].id === 82 && comps[1].id === 71 && comps[2].id === 66));
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (comps.length === 1) out[o] = out[o + 1] = out[o + 2] = clamp8(at(comps[0], x, y));
    else {
      const Y = at(comps[0], x, y), cb = at(comps[1], x, y), cr = at(comps[2], x, y);
      if (rgb) { out[o] = clamp8(Y); out[o + 1] = clamp8(cb); out[o + 2] = clamp8(cr); }
      else { out[o] = clamp8(Y + 1.402 * (cr - 128)); out[o + 1] = clamp8(Y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)); out[o + 2] = clamp8(Y + 1.772 * (cb - 128)); }
    }
    out[o + 3] = 255;
  }
  return { w: W, h: H, rgba: out };
}

function huffTable(counts, symbols) {
  const max = new Int32Array(18).fill(-1), min = new Int32Array(17), ptr = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) { ptr[l] = k; min[l] = code; code += counts[l - 1]; k += counts[l - 1]; if (counts[l - 1]) max[l] = code - 1; code <<= 1; }
  return { max, min, ptr, sym: symbols };
}
function nextMarker(buf, p) {
  while (p + 1 < buf.length) { if (buf[p] === 0xff) { const n = buf[p + 1]; if (n !== 0 && n !== 0xff && !(n >= 0xd0 && n <= 0xd7)) return p; } p++; }
  return buf.length;
}
// One scan into each component's coefficients: baseline, or one progressive pass (DC first / refine, AC first / refine,
// the steps of ITU T.81 G.1.2). A marker met inside the data reads as zero bits, so a cut-off file still ends.
function scan(buf, start, f, sc, { ri, ss, se, ah, al }) {
  let pos = start, bits = 0, nbits = 0, marker = false, eobrun = 0, state = 0, next = 0, run = 0;
  const bit = () => {
    if (!nbits) {
      if (marker || pos >= buf.length) return 0;
      const b = buf[pos];
      if (b === 0xff) { if (buf[pos + 1] === 0) pos += 2; else { marker = true; return 0; } } else pos++;
      bits = b; nbits = 8;
    }
    return (bits >> --nbits) & 1;
  };
  const recv = (s) => { let v = 0; for (let i = 0; i < s; i++) v = (v << 1) | bit(); return v; };
  const ext = (s) => { const v = recv(s); return v < 1 << (s - 1) ? v - (1 << s) + 1 : v; };
  const dec = (t) => { if (!t) throw new Error("no Huffman table"); let code = 0; for (let l = 1; l <= 16; l++) { code = (code << 1) | bit(); if (code <= t.max[l]) return t.sym[t.ptr[l] + code - t.min[l]]; } throw new Error("bad Huffman code"); };
  const baseline = (s, o) => {
    const c = s.c, t = dec(s.dc);
    c.pred += t ? ext(t) : 0;
    c.coef[o] = c.pred;
    for (let k = 1; k < 64;) {
      const rs = dec(s.ac), r = rs >> 4, sz = rs & 15;
      if (!sz) { if (r !== 15) break; k += 16; continue; }
      k += r;
      if (k > 63) break;
      c.coef[o + ZZ[k]] = ext(sz); k++;
    }
  };
  const dcFirst = (s, o) => { const t = dec(s.dc); s.c.pred += t ? ext(t) : 0; s.c.coef[o] = s.c.pred * (1 << al); };
  const dcRefine = (s, o) => { if (bit()) s.c.coef[o] |= 1 << al; };
  const acFirst = (s, o) => {
    if (eobrun > 0) { eobrun--; return; }
    for (let k = ss; k <= se;) {
      const rs = dec(s.ac), r = rs >> 4, sz = rs & 15;
      if (!sz) { if (r < 15) { eobrun = recv(r) + (1 << r) - 1; break; } k += 16; continue; }
      k += r;
      if (k > 63) break;
      s.c.coef[o + ZZ[k]] = ext(sz) * (1 << al); k++;
    }
  };
  const acRefine = (s, o) => {
    const coef = s.c.coef;
    for (let k = ss; k <= se;) {
      const z = o + ZZ[k], sign = coef[z] < 0 ? -1 : 1;
      if (state === 0) {
        const rs = dec(s.ac), sz = rs & 15;
        run = rs >> 4;
        if (!sz) { if (run < 15) { eobrun = recv(run) + (1 << run); state = 4; } else { run = 16; state = 1; } }
        else { if (sz !== 1) throw new Error("bad AC refinement"); next = ext(sz); state = run ? 2 : 3; }
        continue;
      }
      if (coef[z]) coef[z] += sign * (bit() << al);
      else if (state === 1 || state === 2) { if (--run === 0) state = state === 2 ? 3 : 0; }
      else if (state === 3) { coef[z] = next * (1 << al); state = 0; }
      k++;
    }
    if (state === 4 && --eobrun === 0) state = 0;
  };
  const one = (s, o) => (!f.progressive ? baseline : ss === 0 ? (ah ? dcRefine : dcFirst) : ah ? acRefine : acFirst)(s, o);
  // an AC pass carries one component; a baseline or DC scan with one component also walks its own blocks only
  const single = sc.length === 1, total = single ? sc[0].c.cbw * sc[0].c.cbh : f.mcuX * f.mcuY;
  for (const s of sc) s.c.pred = 0;
  for (let m = 0; m < total; m++) {
    if (ri && m && m % ri === 0) {   // restart interval: realign on the RSTn marker, predictions and runs start again
      nbits = 0; marker = false; eobrun = 0; state = 0;
      while (pos + 1 < buf.length && !(buf[pos] === 0xff && buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7)) pos++;
      pos += 2;
      for (const s of sc) s.c.pred = 0;
    }
    if (single) { const s = sc[0], c = s.c; one(s, (Math.floor(m / c.cbw) * c.bw + (m % c.cbw)) * 64); }
    else {
      const mx = m % f.mcuX, my = Math.floor(m / f.mcuX);
      for (const s of sc) { const c = s.c; for (let v = 0; v < c.v; v++) for (let hh = 0; hh < c.h; hh++) one(s, ((my * c.v + v) * c.bw + mx * c.h + hh) * 64); }
    }
  }
  return nextMarker(buf, pos);
}
// EXIF orientation other than 1: a browser turns such a photo, a crop made here would not be
function exifRotated(t) {
  if (t.length < 8) return false;
  const le = t.toString("latin1", 0, 2) === "II", u16 = (i) => (le ? t.readUInt16LE(i) : t.readUInt16BE(i)), u32 = (i) => (le ? t.readUInt32LE(i) : t.readUInt32BE(i));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return false;
  for (let i = 0, n = u16(ifd); i < n; i++) { const e = ifd + 2 + i * 12; if (e + 12 > t.length) break; if (u16(e) === 0x0112) return u16(e + 8) > 1; }
  return false;
}
