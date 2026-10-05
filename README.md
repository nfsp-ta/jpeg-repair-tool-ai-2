# jpeg-repair-tool-ai-2

Undo a very specific kind of file damage: **a text-mode (ASCII) file transfer that inserted a `0x0D` byte before every `0x0A` byte** (LF → CRLF) in binary files such as JPEGs, PNGs and GIFs.

The fix is exact and needs no search: remove one `0x0D` that directly precedes each `0x0A`.

```
node bin/jpegfix2.js diagnose some-file         # inserted-cr / deleted-cr / clean-or-unknown
node bin/jpegfix2.js fix damaged out.jpg        # one file
node bin/jpegfix2.js recover ROOT --out DIR     # a whole tree, mirrored into DIR (ROOT is never modified; JPEGs get ".jpg" appended)
node bin/jpegfix2.js verify DIR [--deep]        # structure check of every .jpg; --deep also fully decodes with ImageMagick if installed
node bin/jpegfix2.js hashmatch CLEAN_DIR DIR    # how many repaired files are byte-identical to known-clean files
npm test                                        # node --test, no dependencies (Node >= 20)
```

## Why this repository exists

It replaces [`jpeg-repair-tool-ai`](../jpeg-repair-tool-ai) (kept for reference only). That project was built on a **wrong diagnosis**: the damage was described as "every `0x0D` byte was deleted", which is how a different test file (`IMAG0705_bad.jpg`) really is damaged. The damaged forum gallery it was meant for is damaged the opposite way. Months of search machinery (beam search over missing bytes, row-shift correction, sibling-reference cascades) were designed for the wrong problem; the real one is solved by a loop over the bytes.

The lesson worth keeping: **look at the real data first**. One look at the bytes of a real damaged file (`0d 0a` pairs where a clean file has `0a`) would have shown it. The numbers that identify the damage are cheap to compute (`diagnose`):

| | clean JPEG | real damaged gallery file | `IMAG0705_bad.jpg` (the test pair) |
|---|---|---|---|
| lone `0x0A` (LF not preceded by CR) | ~1 per 270 bytes | **none** | all of them |
| `0x0D 0x0A` pairs | almost none | one for every LF | none |
| lone `0x0D` | ~1 per 300 bytes | ~1 per 300 bytes (unchanged) | none |

## Result on the forum gallery (12,607 files, 4,284 pictures)

- Every JPEG parses after the fix and decodes with no warnings in ImageMagick (12,501 of 12,501; 400 of 400 sampled damaged files fail it as a control). An independent entropy-level check (every block decodes and the scan ends exactly at the end of the file) passed for all 11,627 files whose encoding it supports (the rest: 703 with restart markers, 109 progressive, 61 non-4:2:0, 1 other; these pass ImageMagick).
- **544 recovered files are byte-identical (SHA-256) to the clean copies in the Wayback Machine** (thumbnails, previews and originals), which is proof of exactness. For the other files exactness cannot be proven without a clean copy, but a single wrongly removed byte would misalign the whole JPEG entropy stream and be detected.
- All 42 recovered PNGs have every chunk CRC-32 valid (exact). 4 of them (thumbnails of GIFs) still fail to decode in ImageMagick with a zlib error, but their checksums verify, so the data is exactly what was stored: those files were already broken at the source. 2 files are empty in the original too.
- The converter was **blind** (it added a CR even where one already preceded the LF), which is why the inversion is exact. A converter that skipped existing CRs would leave original `CR LF` pairs ambiguous.

## Notes

- Never modifies its input. `recover` refuses an output directory inside the input directory; files are written to `*.part` and renamed.
- `.php` files are copied unchanged (text, where CRLF is legitimate); change with `--skip-ext`.
- `tools/copy-tree.sh` is a resumable copy that never overwrites (uses `gio copy`: about 15 files/s from an SMB share mounted by gvfs vs about 1 file/s for plain `cp` over the FUSE path; writing back to the share is slower, about 1-3 files/s).
- If a file shows the *opposite* damage (`diagnose` says `deleted-cr`), this tool cannot fix it; that is the problem the old repository's search was built for.
