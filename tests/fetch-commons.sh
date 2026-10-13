#!/usr/bin/env bash
# Fetch the shell's Commons/ and Ui/ sources from upstream Omarchy at a given ref, into
# .omarchy-ref/<ref>/. tests/tokens.js then checks against them, so you can ask
# "will my plugin still work on the NEXT Omarchy?" without installing it.
#
#   tests/fetch-commons.sh [REF]      REF: a tag (v4.0.4), a branch, or "default" (the upstream
#                                     development branch, whatever it is called; the default)
#   OMARCHY_COMMONS=$(tests/fetch-commons.sh) node tests/tokens.js
#
# Prints the Commons directory on the last line of stdout; errors go to stderr with a non-zero exit.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
URL=https://github.com/basecamp/omarchy.git
REF=${1:-default}
if [ "$REF" = default ]; then
  REF=$(git ls-remote --symref "$URL" HEAD | awk '/^ref:/{sub("refs/heads/", "", $2); print $2; exit}')
  [ -n "$REF" ] || { echo "fetch-commons: could not resolve the upstream default branch" >&2; exit 1; }
fi
DEST="$ROOT/.omarchy-ref/$REF"
if [ ! -d "$DEST/.git" ]; then
  mkdir -p "$DEST"
  git clone -q --depth 1 --filter=blob:none --sparse --branch "$REF" "$URL" "$DEST" >&2
  git -C "$DEST" sparse-checkout set shell/Commons shell/Ui >&2
fi
[ -d "$DEST/shell/Commons" ] || { echo "fetch-commons: no shell/Commons at $REF" >&2; exit 1; }
echo "$DEST/shell/Commons"
