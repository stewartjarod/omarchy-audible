#!/usr/bin/env bash
# Fetch the marketplace's verification scripts (omacom/omarchy-plugin-marketplace, scripts/ only) into
# .omarchy-ref/marketplace/<ref>/. tests/marketplace-preflight.mjs runs the REAL Automated Security
# Baseline from there against your committed HEAD, so you see locally what the marketplace will say.
#
#   tests/fetch-marketplace.sh [REF]      (default: the repository's default branch)
#   Prints the scripts directory on the last line of stdout; errors go to stderr, non-zero exit.
#
# The fetched files are only ever read and run by tests/marketplace-preflight.mjs, which never executes
# plugin code. Treat them as untrusted input from the network like any dependency: pass a tag/SHA in CI.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
URL=https://github.com/omacom/omarchy-plugin-marketplace.git
REF=${1:-default}
if [ "$REF" = default ]; then
  REF=$(git ls-remote --symref "$URL" HEAD | awk '/^ref:/{sub("refs/heads/", "", $2); print $2; exit}')
  [ -n "$REF" ] || { echo "fetch-marketplace: could not resolve the default branch" >&2; exit 1; }
fi
DEST="$ROOT/.omarchy-ref/marketplace/$REF"
if [ ! -d "$DEST/.git" ]; then
  mkdir -p "$DEST"
  git clone -q --depth 1 --filter=blob:none --sparse --branch "$REF" "$URL" "$DEST" >&2
  git -C "$DEST" sparse-checkout set scripts >&2
fi
[ -f "$DEST/scripts/security-baseline-scanner.mjs" ] || { echo "fetch-marketplace: no scanner at $REF" >&2; exit 1; }
echo "$DEST/scripts"
