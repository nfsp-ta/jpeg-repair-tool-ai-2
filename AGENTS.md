# AGENTS.md - jpeg-repair-tool-ai-2

Guidance for AI coding agents working in this repository.

## What this is
A tiny dependency-free Node (>= 20) tool that undoes "CR inserted before every LF" damage (a text-mode transfer) in binary files. See README.md for the evidence and results. The fix is exact: remove one `0x0D` that directly precedes each `0x0A` (`src/unmangle.js`).

## Rules
- Plain Node, CommonJS, **no runtime dependencies**. The owner is not comfortable with Python: do not add Python tooling.
- Never modify input files; always write to a new path. `recover` must keep refusing an output directory inside the input directory.
- Do not commit forum images or any real gallery data. Tests use synthetic bytes only.
- Run `npm test` before committing.
- Diagnose before fixing: use `diagnose` on real files before assuming which damage a set of files has. The predecessor repository (`../jpeg-repair-tool-ai`, archived) assumed the opposite damage and built a large search machinery that was not needed.

## Layout
- `src/unmangle.js` (inversion, the damage simulator used by tests, CR/LF statistics, classification), `src/verify.js` (JPEG structure walker that accepts multi-scan files and trailing data after EOI; optional ImageMagick deep check), `bin/jpegfix2.js` (CLI), `test/` (node:test), `tools/copy-tree.sh`.

## Data (outside the repository)
- Damaged gallery: `smb://truenas.local/backup/2TB/Documents/Web Pages/NFSPMotorsports.com/Web Page - 20170503/forum/mgal_data/albums`; local copy `/home/ashley/jpegfix-data/albums`; recovered output `/home/ashley/jpegfix-data/recovered` and on the share next to `albums` as `albums_recovered`.
- File names look like `SEQ_[thumb_|preview_]NAME_EXT<32 hex>_extjpg` (no real extension); a picture is three consecutive sequence numbers: original, thumbnail, preview. The old repo's `Gallery.cs` groups them.
