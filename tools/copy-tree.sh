#!/bin/bash
# Resumable copy of a directory tree, using `gio copy` (much faster than plain cp over a gvfs/SMB FUSE path: ~15 files/s vs ~1 file/s).
# Never modifies the source. Files already present at the destination with the same size are skipped, so it is safe to re-run.
# A file that exists at the destination with a DIFFERENT size is reported and left alone (never overwritten).
#   tools/copy-tree.sh <source dir> <destination dir> [parallel jobs=6]
set -e
src=${1%/}; dest=${2%/}; jobs=${3:-6}
[ -d "$src" ] && [ -n "$dest" ] || { sed -n '2,7p' "$0"; exit 1; }
mkdir -p "$dest"
copy_one() {
  local f=$1 rel d t
  rel=${f#"$src"/}; d="$dest/$(dirname "$rel")"; t="$dest/$rel"
  mkdir -p "$d"
  if [ -e "$t" ]; then
    [ "$(stat -c%s "$f")" = "$(stat -c%s "$t")" ] || echo "DIFFERENT SIZE, left alone: $rel" >&2
    return 0
  fi
  local tmp="$d/.part.$(basename "$rel")"
  if gio copy "$f" "$tmp" 2>/dev/null && [ "$(stat -c%s "$f")" = "$(stat -c%s "$tmp")" ]; then mv "$tmp" "$t"; else rm -f "$tmp"; echo "FAILED: $rel" >&2; fi
}
export -f copy_one; export src dest
find "$src" -type f ! -name '*.part' -print0 | xargs -0 -P "$jobs" -I{} bash -c 'copy_one "$1"' _ {}
echo "source: $(find "$src" -type f ! -name '*.part' | wc -l) files; destination now: $(find "$dest" -type f | wc -l) files"
