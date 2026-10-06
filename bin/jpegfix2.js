#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { unmangle, classify } = require('../src/unmangle');
const { jpegStructure, deepCheck } = require('../src/verify');

const USAGE = `jpegfix2 - undo the "CR inserted before every LF" damage (text-mode transfer) in binary files

  jpegfix2 diagnose FILE...                    which damage does each file have? (inserted-cr / deleted-cr / clean-or-unknown)
  jpegfix2 fix IN OUT                          repair one file (IN is never modified)
  jpegfix2 recover ROOT --out DIR [--skip-ext php,htm]
                                               repair every file under ROOT into a mirrored tree under DIR (ROOT is never modified).
                                               JPEGs get ".jpg" appended. Files with the given extensions are copied unchanged.
  jpegfix2 immich ROOT [--url URL] [--dry-run] [--ext jpg,png,gif]
                                               repair the ORIGINAL pictures under ROOT in memory and upload them to Immich, one album per first-level
                                               folder (Dir_N subfolders are merged). Thumbnails/previews are skipped. API key: env IMMICH_API_KEY,
                                               server: --url or env IMMICH_URL. Both may be set in a .env file in the current directory. Re-running is safe (Immich reports duplicates).
  jpegfix2 verify DIR [--deep]                 check every .jpg under DIR (structure; --deep also fully decodes with ImageMagick if installed)
  jpegfix2 hashmatch CLEAN_DIR DIR             count repaired files that are byte-identical (SHA-256) to known-clean files (proof of exactness)
`;

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.isFile()) yield p;
  }
}
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
function opt(args, name) { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; }

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'diagnose': {
    for (const f of args) { const c = classify(fs.readFileSync(f)); console.log(`${path.basename(f).slice(0, 50).padEnd(50)} ${c.kind.padEnd(18)} bytes=${c.bytes} CR-LF pairs=${c.crlf} lone CR=${c.loneCr} lone LF=${c.loneLf}`); }
    break;
  }
  case 'fix': {
    const [inp, out] = args; if (!inp || !out) { console.error(USAGE); process.exit(2); }
    if (path.resolve(inp) === path.resolve(out)) { console.error('refusing to overwrite the input'); process.exit(2); }
    const fixed = unmangle(fs.readFileSync(inp)); fs.writeFileSync(out, fixed);
    console.log(`${path.basename(inp)}: ${fixed.length} bytes` + (isJpeg(fixed) ? `, structure ${jpegStructure(fixed) || 'ok'}` : ''));
    break;
  }
  case 'recover': {
    const root = args[0], outDir = opt(args, 'out'); if (!root || !outDir) { console.error(USAGE); process.exit(2); }
    const skip = new Set((opt(args, 'skip-ext') || 'php').split(',').map((s) => s.trim().toLowerCase()));
    const fullRoot = path.resolve(root); if (path.resolve(outDir).startsWith(fullRoot + path.sep) || path.resolve(outDir) === fullRoot) { console.error('--out must not be inside ROOT'); process.exit(2); }
    const tally = {}; const rows = [];
    for (const f of walk(fullRoot)) {
      const rel = path.relative(fullRoot, f); const raw = fs.readFileSync(f);
      const ext = path.extname(f).slice(1).toLowerCase(); let data = raw, status;
      if (skip.has(ext)) status = 'copied unchanged';
      else { data = unmangle(raw); status = isJpeg(data) ? (jpegStructure(data) || 'jpeg ok') : 'inverted (not a JPEG)'; }
      const dest = path.join(outDir, rel + (!skip.has(ext) && isJpeg(data) ? '.jpg' : ''));
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest + '.part', data); fs.renameSync(dest + '.part', dest);
      tally[status] = (tally[status] || 0) + 1; rows.push(`${rel}\t${status}\t${data.length}`);
    }
    fs.writeFileSync(path.join(outDir, 'recover-report.tsv'), rows.join('\n') + '\n');
    console.log(`${rows.length} files written to ${outDir}`); for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
    break;
  }
  case 'immich': {
    const immich = require('../src/immich');
    try { process.loadEnvFile(); } catch { /* no .env in the current directory (or Node < 20.12): use the real environment */ }
    const root = args[0]; if (!root) { console.error(USAGE); process.exit(2); }
    const dryRun = args.includes('--dry-run'), url = opt(args, 'url') || process.env.IMMICH_URL, apiKey = process.env.IMMICH_API_KEY;
    if (!dryRun && (!url || !apiKey)) { console.error('need --url (or IMMICH_URL) and IMMICH_API_KEY'); process.exit(2); }
    const { items, skipped } = immich.plan(path.resolve(root), { exts: opt(args, 'ext') ? opt(args, 'ext').split(',') : undefined });
    console.log(`${items.length} originals to upload; skipped: ${JSON.stringify(skipped)}`);
    immich.upload(items, dryRun ? null : immich.client({ url, apiKey }), { log: console.log, dryRun }).then((t) => {
      console.log(`${t.created} ${dryRun ? 'would be uploaded' : 'created'}, ${t.duplicate} duplicate, ${t.bad} failed verification, ${t.failed} failed`);
      process.exit(t.bad || t.failed ? 1 : 0);
    });
    break;
  }
  case 'verify': {
    const dir = args[0]; if (!dir) { console.error(USAGE); process.exit(2); } const deep = args.includes('--deep');
    let n = 0, bad = 0, deepUnavailable = false;
    for (const f of walk(dir)) {
      if (!f.endsWith('.jpg')) continue; n++;
      let why = jpegStructure(fs.readFileSync(f));
      if (!why && deep) { const d = deepCheck(f); if (d === undefined) deepUnavailable = true; else why = d; }
      if (why) { bad++; if (bad <= 20) console.log(`BAD ${path.relative(dir, f)}: ${why}`); }
    }
    console.log(`${n} JPEGs checked${deep ? ' (deep)' : ''}, ${bad} bad${deepUnavailable ? ' (ImageMagick not installed, deep check skipped)' : ''}`);
    process.exit(bad ? 1 : 0);
  }
  case 'hashmatch': {
    const [cleanDir, dir] = args; if (!cleanDir || !dir) { console.error(USAGE); process.exit(2); }
    const clean = new Map(); for (const f of walk(cleanDir)) clean.set(sha(fs.readFileSync(f)), path.basename(f));
    let tried = 0, hits = 0; for (const f of walk(dir)) { tried++; if (clean.has(sha(fs.readFileSync(f)))) hits++; }
    console.log(`${clean.size} clean files; ${tried} files checked; ${hits} byte-identical to a clean file`);
    break;
  }
  default: console.error(USAGE); process.exit(2);
}
