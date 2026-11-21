// A compact QR code encoder (ISO/IEC 18004): byte mode, error correction level L, M, Q or H (M unless asked), versions
// 1 to 40, all eight masks scored and the best one kept. Written for Troya's share cards; no dependencies, no network.
//   qrMatrix("https://troya.codes/agent?ref=abc123") → { size, version, ecl, mask, align, dark(x, y) }
//   qrMatrix(link, { ecl: "H" }) → the same at level H (about 30% of the symbol may be lost), room for a logo in the middle
// At level M a text up to 213 bytes gets the same symbol as before (versions 1 to 10); longer text now takes a bigger version.

// level → [format bits, EC codewords per block by version, blocks by version] (ISO/IEC 18004 table 9; index 0 unused)
const LEVELS = {
  L: [1, [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25]],
  M: [0, [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]],
  Q: [3, [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68]],
  H: [2, [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]],
};
// alignment pattern centres (row and column) of a version
function alignOf(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2, out = [6];
  for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}
// all codewords a version holds (data and EC): the modules left once the function patterns are drawn, in bytes
function totalOf(ver) {
  let bits = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; bits -= (25 * n - 10) * n - 55; if (ver >= 7) bits -= 36; }
  return bits >>> 3;
}
// [total codewords, EC codewords per block, blocks] of a version at a level
const shape = (ver, lv) => [totalOf(ver), LEVELS[lv][1][ver], LEVELS[lv][2][ver]];
// how many bytes fit: mode (4 bits) and length (8 bits up to version 9, 16 after) come first
const capacity = (ver, lv) => { const [total, ec, blocks] = shape(ver, lv); return (total - ec * blocks) - (ver < 10 ? 2 : 3); };

/* ---------- GF(256) and Reed–Solomon ---------- */
function gmul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}
function rsDivisor(deg) {
  const r = new Array(deg).fill(0);
  r[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < deg; j++) { r[j] = gmul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; }
    root = gmul(root, 2);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    div.forEach((c, i) => { r[i] ^= gmul(c, f); });
  }
  return r;
}

/* ---------- data codewords ---------- */
function codewords(bytes, ver, lv) {
  const [total, ecLen, blocks] = shape(ver, lv);
  const capBits = (total - ecLen * blocks) * 8;
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4);                                       // byte mode
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capBits - bits.length));      // terminator
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // split into blocks (short ones first), add EC to each, then interleave
  const shortLen = Math.floor(total / blocks), shorts = blocks - (total % blocks), div = rsDivisor(ecLen);
  const out = [], bl = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const n = shortLen - ecLen + (i < shorts ? 0 : 1);
    const dat = data.slice(k, k + n);
    k += n;
    const ecc = rsRemainder(dat, div);
    if (i < shorts) dat.push(0);
    bl.push(dat.concat(ecc));
  }
  for (let i = 0; i < bl[0].length; i++) for (let j = 0; j < bl.length; j++) if (i !== shortLen - ecLen || j >= shorts) out.push(bl[j][i]);
  return out;
}

/* ---------- the symbol ---------- */
export function qrMatrix(text, { ecl = "M" } = {}) {
  const lv = String(ecl).toUpperCase();
  if (!LEVELS[lv]) throw new Error("Unknown QR error correction level.");
  const bytes = [...new TextEncoder().encode(String(text))];
  let ver = 1;
  while (ver <= 40 && capacity(ver, lv) < bytes.length) ver++;
  if (ver > 40) throw new Error("Text too long for a QR code here.");
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }        // timing
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {                             // finders + separators
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = alignOf(ver), last = al.length - 1;
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const format = (mask) => {                       // L = 01, M = 00, Q = 11, H = 10, then the mask
    const data = (LEVELS[lv][0] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const b = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, b(i));
    set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
    set(8, size - 8, true);                        // the dark module
  };
  format(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const d = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, d); set(b, a, d);
    }
  }

  // codewords in the zigzag, two columns at a time, skipping the vertical timing column
  const cw = codewords(bytes, ver, lv);
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!fn[y][x] && bit < cw.length * 8) { mod[y][x] = ((cw[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1; bit++; }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const flip = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; };
  const penalty = () => {
    let p = 0, dark = 0;
    const line = (get) => {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b <= size; b++) {
          if (b < size && get(a, b) === get(a, b - 1)) { run++; continue; }
          if (run >= 5) p += run - 2;
          run = 1;
        }
        for (let b = 0; b + 11 <= size; b++) {    // 1:1:3:1:1 with four light modules on one side
          const s = Array.from({ length: 11 }, (_, k) => get(a, b + k));
          const f = [1, 0, 1, 1, 1, 0, 1].every((v, k) => s[k] === !!v), g = [1, 0, 1, 1, 1, 0, 1].every((v, k) => s[k + 4] === !!v);
          if ((f && !s[7] && !s[8] && !s[9] && !s[10]) || (g && !s[0] && !s[1] && !s[2] && !s[3])) p += 40;
        }
      }
    };
    line((a, b) => mod[a][b]);
    line((a, b) => mod[b][a]);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (mod[y][x]) dark++;
      if (x < size - 1 && y < size - 1) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3; }
    }
    return p + Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    flip(m); format(m);
    const p = penalty();
    if (p < bestP) { bestP = p; best = m; }
    flip(m);
  }
  flip(best); format(best);
  return { size, version: ver, ecl: lv, mask: best, align: al, dark: (x, y) => x >= 0 && y >= 0 && x < size && y < size && mod[y][x] };
}
