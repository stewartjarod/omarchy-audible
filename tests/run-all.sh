#!/usr/bin/env bash
# Runs every check that works without the desktop:
#   1. node --test tests/*.test.js (all pure-model tests)
#   2. qmllint over every .qml   (fails only on real errors; known noise is filtered)
# The live checks are NOT here: they need the running shell. See tests/smoke.sh.
#
# Usage: tests/run-all.sh           Exit 0 when everything passes, 1 otherwise.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd) || exit 1
cd "$ROOT" || exit 1

TMP=$(mktemp -d) || exit 1
cleanup() {
  if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then
    find "${TMP:?}" -mindepth 1 -delete
    rmdir "${TMP:?}"
  fi
}
trap cleanup EXIT

status=0

# ------------------------------------------------------------------ duplicate handlers
# A second `onXChanged` on the same root item breaks the whole file at load time ("Property value set
# multiple times"); qmllint does not catch it, and the popup then refuses to open.
echo "== duplicate root signal handlers"
dups=$(for f in *.qml; do grep -o -E '^  on[A-Z][A-Za-z]*(Changed)?:|^  on[A-Z][A-Za-z]*(Changed)?\b' "$f" | sed 's/:$//' | sort | uniq -d | sed "s|^|$f: |"; done)
if [ -n "$dups" ]; then echo "$dups"; status=1; else echo "none"; fi

# ------------------------------------------------------------------ downloads go through the check
# A download started anywhere else would skip the download-settings check and could save files where
# the player never finds them (the "I can't play it" bug). Only Service.qml's runDownload may build it,
# and it must use Setup.downloadArgs.
echo "== downloads only via Setup.downloadArgs"
bad=$(grep -n -E '"download",[[:space:]]*"--asin"' *.qml || true)
if [ -n "$bad" ]; then echo "$bad"; status=1; else echo "none"; fi
if ! grep -q 'Setup.downloadArgs' Service.qml || ! grep -q 'ensureDownloadSettings(function' Service.qml; then
  echo "Service.qml no longer checks the download settings before downloading"; status=1
fi

# ------------------------------------------------------------------ one write to the account
# The only call the plugin may make that changes anything on the Audible account is the position
# write (PUT /1.0/lastpositions/<asin>), built in SyncModel.buildPushRequest. Any other non-GET
# `audible api` call in the shipped code fails here.
echo "== only one write to the Audible account"
writes=$(grep -n -E '"api",[[:space:]]*"(POST|PUT|PATCH|DELETE)"|"(POST|PUT|PATCH|DELETE)",[[:space:]]*"/1\.0/' *.qml *.js | grep -v '"PUT", "/1.0/lastpositions/"' || true)
if [ -n "$writes" ]; then echo "$writes"; status=1; else echo "none"; fi
if ! grep -q '"PUT", "/1.0/lastpositions/"' SyncModel.js; then echo "SyncModel.js no longer builds the position write"; status=1; fi

# ------------------------------------------------------------------ no always-present text input
# A text input that exists all the time listens to clipboard changes inside the shell, even with the
# popup closed (a marketplace review finding). The one password field must be created by a Loader
# (sourceComponent) that is active only while the popup is open on the step that needs it.
echo "== text inputs only inside Onboarding's Loader"
inputs=$(grep -n -E '^[[:space:]]*(TextField|TextInput|TextArea)[[:space:]]*\{' *.qml | grep -v '^Onboarding.qml:' || true)
if [ -n "$inputs" ]; then echo "$inputs"; status=1; else echo "none"; fi
if ! grep -q 'sourceComponent: TextField' Onboarding.qml || ! grep -q 'active: root.shown && root.needsPassword' Onboarding.qml; then
  echo "Onboarding.qml's password field is no longer created only when needed"; status=1
fi
if grep -n -E '^[[:space:]]*(TextField|TextInput|TextArea)[[:space:]]*\{' Onboarding.qml | grep -q .; then
  echo "Onboarding.qml has a text input outside the Loader"; status=1
fi

# ------------------------------------------------------------------ node
# The files are listed (not the directory): older Node versions (22, as on CI) treat a directory
# argument as a module to load, and then run nothing.
echo "== node --test tests/*.test.js"
if node --test --test-reporter=spec tests/*.test.js > "$TMP/node.out" 2>&1; then
  grep -E '^ℹ (tests|pass|fail) ' "$TMP/node.out"
else
  grep -E '^✖|^ℹ (tests|pass|fail) ' "$TMP/node.out" | head -n 40
  # nothing recognisable (the runner itself failed to start): show the raw end of the output
  grep -qE '^✖|^ℹ (tests|pass|fail) ' "$TMP/node.out" || tail -n 15 "$TMP/node.out"
  echo "node tests FAILED"
  status=1
fi

# ------------------------------------------------------------------ qmllint
QMLLINT="${QMLLINT:-/usr/lib/qt6/bin/qmllint}"
if [ ! -x "$QMLLINT" ]; then
  QMLLINT=$(command -v qmllint 2>/dev/null || true)
fi
if [ -z "$QMLLINT" ]; then
  echo "== qmllint: not found (set QMLLINT or install qt6 tools)"
  status=1
else
  echo "== qmllint over every .qml"
  # Known noise from running outside the Omarchy shell (qs.* modules are not on the lint path)
  # and from qmllint's stricter style checks. Anything else reported as Error or Warning fails.
  # QMLLINT_ERRORS_ONLY=1 (set by CI) counts only `Error:` lines and syntax problems (qmllint reports
  # those as `Warning: ... [syntax]`). A machine without Qt's QML modules and Quickshell cannot resolve
  # the imports, which makes every file warn, so the other warnings are ignored there.
  LEVELS='^(Error|Warning):'
  if [ "${QMLLINT_ERRORS_ONLY:-}" = "1" ]; then LEVELS='^Error:|\[syntax\]'; fi
  NOISE='Unqualified access|Failed to import qs\.|importing module "qs\.|Did you add all imports|is used but it is not resolved|inheritance cycle|not found on type "QObject"|unknown grouped property scope|is missing required property'
  : > "$TMP/lint.real"
  count=0
  while IFS= read -r f; do
    count=$((count + 1))
    "$QMLLINT" "$f" > "$TMP/lint.one" 2>&1
    grep -E "$LEVELS" "$TMP/lint.one" | grep -vE "$NOISE" | sed "s|^|$f: |" >> "$TMP/lint.real" || true
  done < <(find . -name '*.qml' -not -path './.git/*' | sort)
  if [ -s "$TMP/lint.real" ]; then
    echo "qmllint: real problems in $(wc -l < "$TMP/lint.real") place(s) across $count file(s):"
    sed 's/^/  /' "$TMP/lint.real"
    status=1
  else
    echo "qmllint: $count file(s), no real errors"
  fi
fi

echo
if [ "$status" -eq 0 ]; then
  echo "run-all: passed"
else
  echo "run-all: FAILED"
fi
exit "$status"
