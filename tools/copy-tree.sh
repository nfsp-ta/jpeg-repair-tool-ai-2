#!/bin/bash
# Resumable copy of a directory tree, using `gio copy` (much faster than plain cp over a gvfs/SMB FUSE path).
# Never modifies the source and never overwrites: the destination is listed ONCE (per-file existence checks over a network mount cost
# ~0.4 s each), directories are created up front, and only files that are missing are copied. A file that already exists at the
# destination with a DIFFERENT size is reported and left alone. Safe to re-run or stop at any time (copies go to .part.* first).
#   tools/copy-tree.sh <source dir> <destination dir> [parallel jobs=6]
set -e
src=${1%/}; dest=${2%/}; jobs=${3:-6}
[ -d "$src" ] && [ -n "$dest" ] || { sed -n '2,8p' "$0"; exit 1; }
mkdir -p "$dest"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
(cd "$src" && find . -type d -print0) | xargs -0 -I{} mkdir -p "$dest/{}"
find "$dest" -name '.part.*' -delete 2>/dev/null || true
(cd "$dest" && find . -type f -printf '%P\t%s\n') | sort > "$tmp/existing"
(cd "$src" && find . -type f ! -name '.part.*' -printf '%P\t%s\n') | sort > "$tmp/source"
awk -F'\t' 'NR==FNR { have[$1]=$2; next } { if (!($1 in have)) print $1; else if (have[$1] != $2) print "DIFFERENT SIZE, left alone: " $1 > "/dev/stderr" }' "$tmp/existing" "$tmp/source" | tr '\n' '\0' > "$tmp/todo"
echo "source $(wc -l < "$tmp/source") files, already at destination $(wc -l < "$tmp/existing"), to copy $(tr -cd '\0' < "$tmp/todo" | wc -c)"
copy_one() {
  local rel=$1 d tmpf
  d="$dest/$(dirname "$rel")"; tmpf="$d/.part.$(basename "$rel")"
  if gio copy "$src/$rel" "$tmpf" 2>/dev/null && [ "$(stat -c%s "$src/$rel")" = "$(stat -c%s "$tmpf")" ]; then mv "$tmpf" "$dest/$rel"; else rm -f "$tmpf"; echo "FAILED: $rel" >&2; fi
}
export -f copy_one; export src dest
xargs -0 -P "$jobs" -I{} bash -c 'copy_one "$1"' _ {} < "$tmp/todo"
echo "done: destination now has $(find "$dest" -type f | wc -l) files"
