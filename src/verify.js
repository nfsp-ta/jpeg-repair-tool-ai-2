'use strict';
const { spawnSync } = require('node:child_process');

/**
 * Cheap structural check of a JPEG (no decoder needed): SOI first, EOI last, every header segment's length lands on another marker, and inside the
 * entropy-coded data every 0xFF is followed by 0x00 (stuffing), a restart marker, or the final EOI. Returns null when fine, else a reason.
 * (A damaged file fails at the first header segment: the quantisation table contains 0x0A bytes that got an extra CR.)
 */
function jpegStructure(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 'no SOI';
  let p = 2, inScan = false, sawSos = false;
  while (p < b.length) {
    if (inScan) {                                                // entropy-coded data: FF is followed by 00 (stuffing) or a restart marker
      if (b[p] !== 0xff) { p++; continue; }
      const n = b[p + 1];
      if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { p += 2; continue; }
      if (n === 0xff) { p++; continue; }                         // fill byte
      inScan = false;                                            // a real marker ends this scan (EOI, or the next segment of a multi-scan file)
    }
    if (b[p] !== 0xff) return `no marker at byte ${p}`;
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }                           // fill byte
    if (m === 0xd9) return sawSos ? null : 'EOI before any scan';       // data after the EOI (a second image, maker data) is legitimate in some camera files
    if (p + 4 > b.length) return 'segment runs past the end';
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2) return `bad segment length at byte ${p}`;
    p += 2 + len;
    if (m === 0xda) { inScan = true; sawSos = true; }
  }
  return 'no EOI at the end';
}

let imagemagick;
/** Full decode with ImageMagick if it is installed (warnings count as errors). Returns null when fine, a reason when not, undefined when ImageMagick is missing. */
function deepCheck(file) {
  if (imagemagick === undefined) imagemagick = spawnSync('convert', ['-version']).status === 0 ? 'convert' : false;
  if (!imagemagick) return undefined;
  const r = spawnSync(imagemagick, [file, '-regard-warnings', 'null:'], { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || 'decode failed').trim().split('\n')[0].slice(0, 160);
}

module.exports = { jpegStructure, deepCheck };
