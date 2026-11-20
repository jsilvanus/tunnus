/**
 * Minimal ISO/IEC 18004 QR Code generator (Byte mode, Error Correction Level M, Versions 1-10)
 * rendered as an SVG string. Zero external dependencies.
 */

// Version 1..10 capacities in bytes for Error Correction Level M (ISO 18004 Table 7)
const CAP_M = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
// Total codewords per version (V1..V10)
const TOTAL_CW = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
// EC codewords per block and block counts for Level M: [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]
const EC_M = [
  null,
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
];

const ALIGN_POS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// GF(256) with primitive polynomial 0x11d
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

/** @param {number} a @param {number} b */
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

/** @param {number} degree */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** @param {number[]} data @param {number} ecLen */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(data.length + ecLen).fill(0);
  for (let i = 0; i < data.length; i++) res[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return res.slice(data.length);
}

/**
 * Encode a UTF-8 string into a QR Code boolean matrix (true = dark module).
 * @param {string} text
 * @returns {boolean[][]}
 */
export function encodeQrMatrix(text) {
  const bytes = Buffer.from(text, 'utf8');
  let version = 1;
  while (version <= 10 && bytes.length > CAP_M[version]) version++;
  if (version > 10) throw new Error('QR payload too long');

  const ecInfo = /** @type {number[]} */ (EC_M[version]);
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = ecInfo;
  const dataCap = g1Blocks * g1Data + g2Blocks * g2Data;

  // Build bit stream: Mode 0100 (byte), char count (8 bits for v1..9, 16 bits for v10)
  /** @type {number[]} */
  const bits = [];
  /** @param {number} val @param {number} len */
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = dataCap * 8;
  const term = Math.min(4, maxBits - bits.length);
  pushBits(0, term);
  while (bits.length % 8 !== 0) bits.push(0);

  /** @type {number[]} */
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }
  const pads = [0xec, 0x11];
  for (let i = 0; data.length < dataCap; i++) data.push(pads[i % 2]);

  // Split into blocks and compute RS error correction
  /** @type {number[][]} */
  const dataBlocks = [];
  /** @type {number[][]} */
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < g1Blocks + g2Blocks; i++) {
    const len = i < g1Blocks ? g1Data : g2Data;
    const block = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  // Interleave data and EC codewords
  /** @type {number[]} */
  const codewords = [];
  const maxDataLen = Math.max(g1Data, g2Data);
  for (let i = 0; i < maxDataLen; i++) {
    for (const b of dataBlocks) if (i < b.length) codewords.push(b[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of ecBlocks) codewords.push(b[i]);
  }

  const size = version * 4 + 17;
  /** @type {(boolean | null)[][]} */
  const grid = Array.from({ length: size }, () => Array(size).fill(null));
  /** @type {boolean[][]} */
  const fixed = Array.from({ length: size }, () => Array(size).fill(false));

  /** @param {number} r @param {number} c @param {boolean} dark */
  const setFixed = (r, c, dark) => {
    grid[r][c] = dark;
    fixed[r][c] = true;
  };

  // Finder patterns + separators
  const drawFinder = (/** @type {number} */ r0, /** @type {number} */ c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark =
          inOuter &&
          (dr === 0 ||
            dr === 6 ||
            dc === 0 ||
            dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFixed(r, c, dark);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Alignment patterns
  const pos = ALIGN_POS[version];
  for (const r of pos) {
    for (const c of pos) {
      if (fixed[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFixed(r + dr, c + dc, dark);
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (!fixed[6][i]) setFixed(6, i, i % 2 === 0);
    if (!fixed[i][6]) setFixed(i, 6, i % 2 === 0);
  }

  // Dark module + reserve format info
  setFixed(size - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!fixed[8][i]) setFixed(8, i, false);
    if (!fixed[i][8]) setFixed(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!fixed[8][size - 1 - i]) setFixed(8, size - 1 - i, false);
    if (i < 7 && !fixed[size - 1 - i][8]) setFixed(size - 1 - i, 8, false);
  }
  // Reserve version info for v >= 7
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        setFixed(i, size - 11 + j, false);
        setFixed(size - 11 + j, i, false);
      }
    }
  }

  // Place data bits in zig-zag
  let bitIdx = 0;
  const totalBits = TOTAL_CW[version] * 8;
  let up = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (const c of [right, right - 1]) {
        if (!fixed[r][c]) {
          let dark = false;
          if (bitIdx < totalBits) {
            const cw = codewords[bitIdx >>> 3] ?? 0;
            dark = Boolean((cw >>> (7 - (bitIdx & 7))) & 1);
            bitIdx++;
          }
          grid[r][c] = dark;
        }
      }
    }
    up = !up;
  }

  // Evaluate mask patterns 0..7 and pick lowest penalty
  /** @type {((r: number, c: number) => boolean)[]} */
  const maskFns = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  let bestMask = 0;
  let bestScore = Infinity;
  let bestMatrix = /** @type {boolean[][]} */ ([]);

  for (let m = 0; m < 8; m++) {
    const mat = grid.map((row, r) =>
      row.map((val, c) => (fixed[r][c] ? Boolean(val) : Boolean(val) !== maskFns[m](r, c))),
    );
    applyFormatAndVersion(mat, size, version, m);
    const score = penalty(mat, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = m;
      bestMatrix = mat;
    }
  }
  void bestMask;
  return bestMatrix;
}

/**
 * Write 15-bit BCH format info (Level M = 00) and 18-bit Golay version info (v >= 7).
 * @param {boolean[][]} mat
 * @param {number} size
 * @param {number} version
 * @param {number} mask
 */
function applyFormatAndVersion(mat, size, version, mask) {
  const fmtData = (0b00 << 3) | mask;
  let rem = fmtData << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  const fmt = ((fmtData << 10) | rem) ^ 0x5412;

  for (let i = 0; i < 6; i++) {
    const bit = Boolean((fmt >>> i) & 1);
    mat[8][size - 1 - i] = bit;
    mat[i][8] = bit;
  }
  mat[8][size - 7] = Boolean((fmt >>> 6) & 1);
  mat[7][8] = Boolean((fmt >>> 6) & 1);
  mat[8][size - 8] = Boolean((fmt >>> 7) & 1);
  mat[8][8] = Boolean((fmt >>> 7) & 1);
  mat[8][7] = Boolean((fmt >>> 8) & 1);
  mat[size - 7][8] = Boolean((fmt >>> 8) & 1);
  for (let i = 9; i < 15; i++) {
    const bit = Boolean((fmt >>> i) & 1);
    mat[8][14 - i] = bit;
    mat[size - 15 + i][8] = bit;
  }

  if (version >= 7) {
    let vRem = version << 12;
    for (let i = 17; i >= 12; i--) {
      if ((vRem >>> i) & 1) vRem ^= 0x1f25 << (i - 12);
    }
    const ver = (version << 12) | vRem;
    for (let i = 0; i < 18; i++) {
      const bit = Boolean((ver >>> i) & 1);
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      mat[r][c] = bit;
      mat[c][r] = bit;
    }
  }
}

/** @param {boolean[][]} mat @param {number} size */
function penalty(mat, size) {
  let score = 0;
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (mat[r][c] === mat[r][c - 1]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (mat[r][c] === mat[r - 1][c]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = mat[r][c];
      if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) score += 3;
    }
  }
  return score;
}

/**
 * Render a QR code as a crisp SVG data URL (`data:image/svg+xml;base64,...`).
 * @param {string} text
 * @returns {string}
 */
export function qrDataUrl(text) {
  const mat = encodeQrMatrix(text);
  const quiet = 4;
  const total = mat.length + quiet * 2;
  const rects = [];
  for (let r = 0; r < mat.length; r++) {
    for (let c = 0; c < mat.length; c++) {
      if (mat[r][c]) rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="200" height="200" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
