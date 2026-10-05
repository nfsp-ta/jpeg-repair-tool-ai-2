'use strict';
// The damage: a text-mode transfer converted every LF (0x0A) to CRLF (0x0D 0x0A), i.e. it inserted a 0x0D before every 0x0A.
// Original 0x0D bytes are untouched. The converter was "blind": it added a CR even where one already preceded the LF
// (an original CR LF pair became CR CR LF), so the inversion is exact: remove ONE 0x0D that directly precedes each 0x0A.

/** Undo the LF -> CRLF conversion. Returns a new Buffer; the input is never modified. */
function unmangle(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;       // drop the inserted CR
    out[n++] = buf[i];
  }
  return out.subarray(0, n);
}

/** The damage itself (used only for tests and simulations): insert a 0x0D before every 0x0A. */
function mangle(buf) {
  const out = [];
  for (const b of buf) { if (b === 0x0a) out.push(0x0d); out.push(b); }
  return Buffer.from(out);
}

/** Count CR/LF patterns, to tell which kind of damage a file has. */
function stats(buf) {
  let cr = 0, lf = 0, crlf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d) { cr++; if (buf[i + 1] === 0x0a) crlf++; }
    else if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) lf++;      // only LFs that are not preceded by a CR
  }
  const loneLf = lf, loneCr = cr - crlf;
  return { bytes: buf.length, cr, crlf, loneCr, loneLf };
}

/**
 * Classify a binary file (JPEG, PNG, ...) by its CR/LF pattern:
 *  - "inserted-cr": there are CR LF pairs and no lone LF at all (every LF got a CR): the damage this tool undoes.
 *  - "deleted-cr":  there are lone LFs and no CR at all (all CRs were deleted): a different damage, not fixed here.
 *  - "clean-or-unknown": anything else (an undamaged binary file has lone LFs and lone CRs).
 */
function classify(buf) {
  const s = stats(buf);
  if (s.bytes < 2000) return { ...s, kind: 'too-small-to-tell' };
  if (s.loneLf === 0 && s.crlf > 0) return { ...s, kind: 'inserted-cr' };
  if (s.cr === 0 && s.loneLf > 0) return { ...s, kind: 'deleted-cr' };
  return { ...s, kind: 'clean-or-unknown' };
}

module.exports = { unmangle, mangle, stats, classify };
