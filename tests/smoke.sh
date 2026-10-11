#!/usr/bin/env bash
# Live smoke test for jarod.audible.
#
# Run by hand in the desktop session, AFTER the shell has reloaded the plugin (a shell restart).
# It asks the running shell over IPC, opens and closes the library and a book's details page, and
# reads the shell log for QML warnings or errors that mention this plugin.
#
# It never plays or downloads audio, never installs anything, never signs in, and never changes the
# Audible account. The only audible command it runs is a read: `library list --limit 1`, to get one
# real ASIN for the details check.
#
# Exit status: 0 when every check passes, 1 when any check fails.
#
# Usage:  tests/smoke.sh            (OMARCHY_PATH defaults to /usr/share/omarchy)

set -u

OMARCHY_PATH="${OMARCHY_PATH:-/usr/share/omarchy}"
SHELL_DIR="$OMARCHY_PATH/shell"
PLUGIN_RE='jarod\.audible|jarod-audible'
fails=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }

for tool in qs jq timeout audible; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'FAIL  required command not found: %s\n' "$tool"
    exit 1
  fi
done
if [ ! -f "$SHELL_DIR/shell.qml" ]; then
  printf 'FAIL  omarchy shell not found at %s (set OMARCHY_PATH)\n' "$SHELL_DIR"
  exit 1
fi

TMP=$(mktemp -d) || exit 1
cleanup() {
  if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then
    find "${TMP:?}" -mindepth 1 -delete
    rmdir "${TMP:?}"
  fi
}
trap cleanup EXIT

# IPC into the running shell, same form omarchy-shell uses: qs ipc -p <shell dir> call -- <target> <fn> [args]
ipc() {
  timeout --kill-after=1s 5s qs ipc -n -p "$SHELL_DIR" call -- jarod.audible "$@" 2>&1
}
status_field() {
  printf '%s' "$1" | jq -r "$2" 2>/dev/null
}

# ---------------------------------------------------------------- 1. status
status=$(ipc status)
if printf '%s' "$status" | jq -e . >/dev/null 2>&1; then
  pass "status returns valid JSON"
  state=$(status_field "$status" '.state')
  ready=$(status_field "$status" '.ready')
  if [ "$state" = "ready" ] && [ "$ready" = "true" ]; then
    pass "status state is ready"
  else
    fail "status state is '$state' (ready=$ready); expected ready. Log says: $(status_field "$status" '.log')"
  fi
else
  fail "status is not valid JSON: $(printf '%s' "$status" | head -c 300)"
  state=""
fi

# A ready state with no playback has nothing else to check on the audio side; the library and details
# checks need a real ASIN from the library.
asin=$(audible library list -o json --limit 1 2>/dev/null | jq -r '.result[0].asin // empty' 2>/dev/null)
if [ -z "$asin" ]; then
  fail "could not read one ASIN with audible library list (is the account synced?)"
fi

# ---------------------------------------------------------------- 2. library open / close
if ipc openLibrary >/dev/null; then
  sleep 1
  if [ "$(status_field "$(ipc status)" '.libraryOpen')" = "true" ]; then
    pass "openLibrary: library is open"
  else
    fail "openLibrary was accepted but status.libraryOpen is not true"
  fi
else
  fail "openLibrary IPC call failed"
fi

# ---------------------------------------------------------------- 3. details open / close
if [ -n "$asin" ]; then
  if ipc openDetail "$asin" >/dev/null; then
    sleep 1
    detail=$(status_field "$(ipc status)" '.detailAsin')
    if [ "$detail" = "$asin" ]; then
      pass "openDetail: details page is open for one library book"
    else
      fail "openDetail was accepted but status.detailAsin is '$detail', expected the requested ASIN"
    fi
  else
    fail "openDetail IPC call failed"
  fi
fi

if ipc closeLibrary >/dev/null; then
  sleep 1
  s=$(ipc status)
  if [ "$(status_field "$s" '.libraryOpen')" = "false" ] && [ -z "$(status_field "$s" '.detailAsin')" ]; then
    pass "closeLibrary: library and details are closed"
  else
    fail "closeLibrary was accepted but the library or details are still open"
  fi
else
  fail "closeLibrary IPC call failed"
fi

# ---------------------------------------------------------------- 4. shell log
# qs log covers the running shell instance, so the whole log is judged. That includes load-time QML
# errors from the restart, which is why this check should run soon after the restart.
sleep 1
if qs log -p "$SHELL_DIR" > "$TMP/log" 2>/dev/null && [ -s "$TMP/log" ]; then
  problems=$(grep -iE 'warn|error|typeerror|referenceerror|cannot assign|is not a function' "$TMP/log" \
    | grep -E "$PLUGIN_RE" || true)
  if [ -z "$problems" ]; then
    pass "shell log has no QML warnings or errors from jarod.audible"
  else
    fail "shell log has QML warnings or errors from jarod.audible:"
    printf '%s\n' "$problems" | head -n 20 | sed 's/^/        /'
  fi
else
  fail "could not read the shell log with qs log (is the shell running?)"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "smoke: all checks passed"
  exit 0
fi
echo "smoke: $fails check(s) failed"
exit 1
