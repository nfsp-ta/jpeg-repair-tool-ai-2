'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { unmangle, mangle, classify } = require('../src/unmangle');
const { jpegStructure } = require('../src/verify');

test('unmangle removes exactly one CR before each LF', () => {
  assert.deepStrictEqual([...unmangle(Buffer.from([1, 0x0d, 0x0a, 2]))], [1, 0x0a, 2]);
  assert.deepStrictEqual([...unmangle(Buffer.from([0x0d, 0x0d, 0x0a]))], [0x0d, 0x0a]);       // an original CR LF pair survives
  assert.deepStrictEqual([...unmangle(Buffer.from([0x0d, 5, 0x0d]))], [0x0d, 5, 0x0d]);        // lone CRs are untouched
  assert.deepStrictEqual([...unmangle(Buffer.alloc(0))], []);
});

test('unmangle(mangle(x)) === x for random data, including CR LF and CR CR LF runs', () => {
  for (let t = 0; t < 200; t++) {
    const x = crypto.randomBytes(200 + t);
    for (let i = 0; i < x.length; i++) if (Math.random() < 0.15) x[i] = Math.random() < 0.5 ? 0x0d : 0x0a;   // many CR/LF, in all combinations
    assert.ok(unmangle(mangle(x)).equals(x));
  }
});

test('the input buffer is not modified', () => {
  const b = Buffer.from([1, 0x0d, 0x0a, 2]); const copy = Buffer.from(b); unmangle(b); assert.ok(b.equals(copy));
});

test('classify tells the two damage types apart', () => {
  const clean = crypto.randomBytes(20000);
  assert.strictEqual(classify(clean).kind, 'clean-or-unknown');
  assert.strictEqual(classify(mangle(clean)).kind, 'inserted-cr');
  assert.strictEqual(classify(Buffer.from(clean.filter((b) => b !== 0x0d))).kind, 'deleted-cr');
});

test('jpegStructure flags a header whose quantisation table got extra CRs, and accepts the repaired one', () => {
  // minimal JPEG-shaped bytes: SOI, DQT (length 67, 64 values incl. 0x0a), SOS, a little scan data, EOI
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64, 0x0a)]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const good = Buffer.concat([Buffer.from([0xff, 0xd8]), dqt, sos, Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]), Buffer.from([0xff, 0xd9])]);
  assert.strictEqual(jpegStructure(good), null);
  assert.notStrictEqual(jpegStructure(mangle(good)), null);
  assert.strictEqual(jpegStructure(unmangle(mangle(good))), null);
});

test('jpegStructure accepts a multi-scan (progressive-style) stream and restart markers, rejects a stray marker', () => {
  const hdr = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x03, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x01, 0x02]);                            // a table between two scans
  const multi = Buffer.concat([hdr, sos, Buffer.from([1, 0xff, 0x00, 2, 0xff, 0xd0, 3]), dht, sos, Buffer.from([4, 5]), Buffer.from([0xff, 0xd9])]);
  assert.strictEqual(jpegStructure(multi), null);
  const stray = Buffer.concat([hdr, sos, Buffer.from([1, 0xff, 0x07, 2]), Buffer.from([0xff, 0xd9])]);   // FF 07 is not valid in the data
  assert.notStrictEqual(jpegStructure(stray), null);
});
