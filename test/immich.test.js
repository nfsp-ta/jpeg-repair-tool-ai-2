'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mangle } = require('../src/unmangle');
const { parseName, dateFromName, plan, client, upload } = require('../src/immich');

const G = 'c6102be18229fc491bc3a47045b81b7c';

test('parseName tells originals from thumbnails and previews, and recovers the real file name', () => {
  assert.deepStrictEqual(parseName(`11373_2013-03-06_21_13_12_jpg${G}_extjpg`), { id: 11373, kind: 'original', name: '2013-03-06_21_13_12', ext: 'jpg', guid: G });
  assert.strictEqual(parseName(`11375_preview_IMG_1_jpg${G}_extjpg`).kind, 'preview');
  assert.strictEqual(parseName(`11376_thumb_IMG_1_jpg${G}_extjpg`).kind, 'thumb');
  assert.strictEqual(parseName(`11617_IMG_1443_png${G}_extpng`).name, 'IMG_1443');
  assert.strictEqual(parseName('index.php'), null);
  assert.strictEqual(parseName(`1_a_jpg${G}_extpng`), null);       // extension must agree on both sides
});

test('dateFromName understands both timestamp styles', () => {
  assert.deepStrictEqual(dateFromName('2013-03-06_21_13_12'), new Date(2013, 2, 6, 21, 13, 12));
  assert.deepStrictEqual(dateFromName('20161203_150425'), new Date(2016, 11, 3, 15, 4, 25));
  assert.strictEqual(dateFromName('IMG_1443'), null);
});

function gallery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-test-'));
  const put = (rel, bytes) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), bytes); };
  const png = Buffer.from([0x89, 0x50, 0x0a, 0x1a, 0x0a, 0x0d, 0x0a, 7]);
  put(`Cars/Dir_1/10_a_png${G}_extpng`, mangle(png));
  put(`Cars/Dir_1/11_thumb_a_png${G}_extpng`, mangle(png));
  put(`Cars/Dir_2/12_preview_b_png${G}_extpng`, mangle(png));
  put(`Cars/Dir_2/13_b_png${G}_extpng`, mangle(png));
  put(`Cars/Dir_2/14_doc_pdf${G}_extpdf`, 'x');
  put('Cars/index.php', 'x');
  put('stray.txt', 'x');
  return { root, png };
}

test('plan keeps only originals, merges Dir_N into the gallery, and reports what it skipped', () => {
  const { root } = gallery();
  const { items, skipped } = plan(root);
  assert.deepStrictEqual(items.map((i) => [i.album, i.filename]), [['Cars', 'a.png'], ['Cars', 'b.png']]);
  assert.deepStrictEqual(skipped, { 'extension .pdf': 1, 'unrecognised name': 1, 'not inside a gallery folder': 1, thumb: 1, preview: 1 });
});

test('upload repairs in memory, sends the original bytes, groups into one album, and leaves the input alone', async () => {
  const { root, png } = gallery();
  const before = fs.readFileSync(path.join(root, `Cars/Dir_1/10_a_png${G}_extpng`));
  const calls = []; let n = 0;
  const fetchFn = async (url, init) => {
    calls.push([init.method, url.replace('http://immich/api', ''), init]);
    const json = url.endsWith('/albums') && init.method === 'GET' ? [] : url.endsWith('/albums') ? { id: 'A1' } : url.endsWith('/assets') ? { id: `S${++n}`, status: 'created' } : [];
    return { ok: true, json: async () => json, text: async () => '' };
  };
  const t = await upload(plan(root).items, client({ url: 'http://immich/', apiKey: 'k', fetchFn }));
  assert.deepStrictEqual(t, { created: 2, duplicate: 0, bad: 0, failed: 0 });
  const up = calls.filter((c) => c[1] === '/assets');
  assert.strictEqual(up.length, 2);
  assert.strictEqual(up[0][2].headers['x-api-key'], 'k');
  const file = up[0][2].body.get('assetData');
  assert.strictEqual(file.name, 'a.png');
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(png));
  assert.deepStrictEqual(JSON.parse(calls.find((c) => c[0] === 'PUT')[2].body), { ids: ['S1', 'S2'] });
  assert.ok(fs.readFileSync(path.join(root, `Cars/Dir_1/10_a_png${G}_extpng`)).equals(before));
});

test('a JPEG that still fails the structure check after repair is not uploaded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-test-'));
  fs.mkdirSync(path.join(root, 'G'));
  fs.writeFileSync(path.join(root, 'G', `1_x_jpg${G}_extjpg`), Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 5]));
  const t = await upload(plan(root).items, client({ url: 'http://immich', apiKey: 'k', fetchFn: async () => { throw new Error('must not be called'); } }));
  assert.deepStrictEqual(t, { created: 0, duplicate: 0, bad: 1, failed: 0 });
});
