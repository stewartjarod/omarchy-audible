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

# ------------------------------------------------------------------ writes to the account
# The plugin writes to the Audible account in exactly two places: the position (PUT
# /1.0/lastpositions/<asin>, SyncModel.buildPushRequest) and a wishlist change the user confirmed
# twice (POST/DELETE /1.0/collections/__WISHLIST/items, WishlistModel.addRequest/removeRequest).
# Any other non-GET request in the shipped code fails here.
echo "== only the known writes to the Audible account"
writes=$(grep -n -E '"api",[[:space:]]*"(POST|PUT|PATCH|DELETE)"|"(POST|PUT|PATCH|DELETE)",[[:space:]]*"/1\.0/' *.qml *.js \
  | grep -v -E '^SyncModel\.js:[0-9]+:.*"PUT", "/1\.0/lastpositions/"|^WishlistModel\.js:[0-9]+:.*"(POST|DELETE)", "/1\.0/collections/" \+ WISHLIST_ID \+ "/items"' || true)
if [ -n "$writes" ]; then echo "$writes"; status=1; else echo "none"; fi
if ! grep -q '"PUT", "/1.0/lastpositions/"' SyncModel.js; then echo "SyncModel.js no longer builds the position write"; status=1; fi

# ------------------------------------------------------------------ nothing private in argv
# Any local user can read a process's arguments in /proc/<pid>/cmdline (a marketplace review finding).
# So: every `audible api` call is an ApiRequest.js spec (request on stdin), the only command line
# that may name a book is the download (the CLI has no other way to take it), notifications carry
# no titles, the sign-in address is never opened directly, and mpv's socket is never in /tmp.
echo "== no book ids, positions or secrets in command lines"
argv=$( { grep -n -E '"api",[[:space:]]*"(GET|POST|PUT|PATCH|DELETE)"|"--body"' *.qml *.js
          grep -n -E '"--asin"' *.qml *.js | grep -v -E '^SetupModel\.js:[0-9]+:  var out = \["download", "--asin", a,'
          grep -n -E '"xdg-open",[[:space:]]*[A-Za-z]|\|\|[[:space:]]*"/tmp"' *.qml *.js
          grep -n -E '(^|[^A-Za-z.])notify\(' *.qml | grep -v -E 'function notify\(|notify\("[^"]*", (Ls\.[A-Z_]+|"[^"]*")(, [0-9]+)?\)'; } || true)
if [ -n "$argv" ]; then echo "$argv"; status=1; else echo "none"; fi

# ------------------------------------------------------------------ no text input at all
# A native text input (TextField, TextInput, TextArea, TextEdit, even read-only) reads the clipboard
# whenever another app sets it, without a size limit or deadline, so the shell could be blocked by a
# clipboard owner (a marketplace review finding). The plugin has none: the password for a locked
# login is typed in a terminal (SetupModel.terminalUnlockArgs), and links are plain Text.
echo "== no native text inputs in the shell"
inputs=$(grep -n -E '(^|[^A-Za-z.])(TextField|TextInput|TextArea|TextEdit)[[:space:]]*\{' *.qml || true)
if [ -n "$inputs" ]; then echo "$inputs"; status=1; else echo "none"; fi

# ------------------------------------------------------------------ theme, privacy, tokens
echo "== theme lint (no hard-coded colours, fonts or radii)"
bash tests/theme-lint.sh || status=1

echo "== privacy scan (no home paths, e-mail addresses or secrets committed)"
bash tests/privacy.sh || status=1

echo "== theme tokens exist in the shell (Commons)"
node tests/tokens.js
rc=$?
if [ "$rc" -eq 1 ]; then
  status=1
elif [ "$rc" -eq 2 ] && [ "${REQUIRE_COMMONS:-0}" = 1 ]; then
  echo "tokens: REQUIRE_COMMONS is set but Commons was not found"; status=1
fi

# ------------------------------------------------------------------ marketplace verification
echo "== omarchy plugin validate (the shell's own manifest rules)"
if command -v omarchy >/dev/null 2>&1; then
  omarchy plugin validate . && echo "ok" || status=1
else
  echo "note: omarchy not installed; skipped (the pre-flight below re-checks the listing rules)"
fi

# What the marketplace will say about the committed HEAD: its own security scanner, run unmodified.
# Capabilities we accept knowingly are listed in marketplace-expected.json; a new one fails here.
echo "== marketplace pre-flight (on the committed HEAD)"
MP_SCRIPTS="${MARKETPLACE_SCRIPTS:-}"
[ -n "$MP_SCRIPTS" ] || MP_SCRIPTS=$(ls -d .omarchy-ref/marketplace/*/scripts 2>/dev/null | head -n1 || true)
if [ -n "$MP_SCRIPTS" ] && git rev-parse -q --verify HEAD >/dev/null 2>&1; then
  node tests/marketplace-preflight.mjs --scripts "$MP_SCRIPTS" || status=1
elif [ "${REQUIRE_MARKETPLACE:-0}" = 1 ]; then
  echo "marketplace-preflight: REQUIRE_MARKETPLACE is set but the scanner or a git HEAD is missing"; status=1
else
  echo "skipped: run tests/fetch-marketplace.sh once (needs network); CI always runs it"
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
  done < <(find . -name '*.qml' -not -path './.git/*' -not -path './.omarchy-ref/*' | sort)
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
