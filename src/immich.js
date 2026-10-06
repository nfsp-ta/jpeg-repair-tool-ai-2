'use strict';
// Upload repaired gallery originals to Immich (https://immich.app) instead of writing them to a mirrored folder.
// Dependency-free: uses the fetch/FormData/Blob built into Node >= 20.
//
// Gallery layout: ROOT/<gallery>/[Dir_N/...]/<file>. The first-tier folder is the album; Dir_N folders are not galleries.
// File names: <id>[_thumb|_preview]_<name>_<ext><32 hex>_ext<ext>   e.g. 11373_2013-03-06_21_13_12_jpge7d4...d0_extjpg
// Only originals (no _thumb/_preview) are uploaded, named <name>.<ext>; Immich makes its own thumbnails.
const fs = require('node:fs');
const path = require('node:path');
const { unmangle } = require('./unmangle');
const { jpegStructure } = require('./verify');

const DEFAULT_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic'];

/** Parse a gallery file name. Returns null if it does not follow the convention. */
function parseName(file) {
  const m = /^(\d+)_(thumb_|preview_)?(.+)_ext([a-z0-9]+)$/i.exec(file);
  if (!m) return null;
  const [, id, tag, rest, ext] = m;
  const tail = new RegExp(`^(.+)_${ext}([0-9a-f]{32})$`, 'i').exec(rest);
  if (!tail) return null;
  return { id: Number(id), kind: tag ? tag.slice(0, -1) : 'original', name: tail[1], ext: ext.toLowerCase(), guid: tail[2].toLowerCase() };
}

/** A date embedded in the name (2013-03-06_21_13_12 or 20161203_150425), as local time; null if there is none. */
function dateFromName(name) {
  const m = /(\d{4})-?(\d{2})-?(\d{2})[_-](\d{2})_?(\d{2})_?(\d{2})/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < 1990 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return new Date(y, mo - 1, d, h, mi, s);
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.isFile()) yield p;
  }
}

/**
 * Decide what to upload. Returns { items, skipped } where items are { file, album, filename, guid, id } (ordered by album, then id)
 * and skipped counts files left out by reason (thumbnails, previews, unwanted extension, unrecognised name, not in a gallery).
 */
function plan(root, { exts = DEFAULT_EXTS } = {}) {
  const want = new Set(exts.map((e) => e.toLowerCase()));
  const items = []; const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep);
    if (rel.length < 2) { skip('not inside a gallery folder'); continue; }
    const p = parseName(rel[rel.length - 1]);
    if (!p) skip('unrecognised name');
    else if (p.kind !== 'original') skip(p.kind);
    else if (!want.has(p.ext)) skip(`extension .${p.ext}`);
    else items.push({ file, album: rel[0], filename: `${p.name}.${p.ext}`, guid: p.guid, id: p.id });
  }
  items.sort((a, b) => (a.album < b.album ? -1 : a.album > b.album ? 1 : a.id - b.id));
  return { items, skipped };
}

/** Minimal Immich API client. `fetchFn` is injectable for tests. */
function client({ url, apiKey, fetchFn = fetch }) {
  const base = url.replace(/\/+$/, '') + '/api';
  async function call(method, route, { json, form } = {}) {
    const res = await fetchFn(base + route, {
      method, body: form || (json && JSON.stringify(json)),
      headers: { 'x-api-key': apiKey, accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) },
    });
    if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  return {
    albums: () => call('GET', '/albums'),
    createAlbum: (albumName) => call('POST', '/albums', { json: { albumName } }),
    addToAlbum: (id, ids) => call('PUT', `/albums/${id}/assets`, { json: { ids } }),
    uploadAsset({ data, filename, guid, created, modified }) {
      const form = new FormData();
      form.set('deviceAssetId', `jpegfix2-${guid}`);       // stable per source file, so a re-run reports duplicates instead of re-uploading
      form.set('deviceId', 'jpegfix2');
      form.set('fileCreatedAt', created.toISOString());
      form.set('fileModifiedAt', modified.toISOString());
      form.set('assetData', new Blob([data]), filename);
      return call('POST', '/assets', { form });
    },
  };
}

/**
 * Repair each planned file in memory and upload it; as soon as a gallery's files are done (items are ordered by album), add them to an
 * album named after its folder, so an interrupted run still leaves finished albums behind. Nothing is written to disk and the input
 * files are never modified. A JPEG that fails the structure check is not uploaded.
 * Returns counts: created, duplicate, bad (failed verification), failed (API error).
 */
async function upload(items, api, { log = () => {}, dryRun = false } = {}) {
  const tally = { created: 0, duplicate: 0, bad: 0, failed: 0 };
  let existing, album = null, ids = [];
  const flush = async () => {
    if (!ids.length) return;
    existing = existing || new Map((await api.albums()).map((a) => [a.albumName, a.id]));
    const id = existing.get(album) || (await api.createAlbum(album)).id;
    existing.set(album, id);
    await api.addToAlbum(id, ids);        // assets already in the album are reported per-asset and ignored
    log(`album "${album}": ${ids.length} assets`);
    ids = [];
  };
  for (const [n, it] of items.entries()) {
    const label = `[${n + 1}/${items.length}] ${it.album}/${it.filename}`;
    if (it.album !== album) { await flush().catch((e) => log(`FAILED album "${album}": ${e.message}`)); album = it.album; }
    const data = unmangle(fs.readFileSync(it.file));
    if (data[0] === 0xff && data[1] === 0xd8) {
      const why = jpegStructure(data);
      if (why) { tally.bad++; log(`${label} BAD: ${why}`); continue; }
    }
    if (dryRun) { tally.created++; log(`${label} ${data.length} bytes`); continue; }
    try {
      const when = dateFromName(it.filename) || fs.statSync(it.file).mtime;
      const r = await api.uploadAsset({ data, filename: it.filename, guid: it.guid, created: when, modified: when });
      tally[r.status === 'duplicate' ? 'duplicate' : 'created']++;
      ids.push(r.id);
      log(`${label} ${r.status}`);
    } catch (e) { tally.failed++; log(`${label} FAILED: ${e.message}`); }
  }
  await flush().catch((e) => log(`FAILED album "${album}": ${e.message}`));
  return tally;
}

module.exports = { parseName, dateFromName, plan, client, upload, DEFAULT_EXTS };
