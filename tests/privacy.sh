#!/usr/bin/env bash
# Privacy scan: nothing that identifies the author's machine or accounts may be committed. Plugins get
# published and verified by the marketplace, and fixtures captured from a real session leak easily.
# Fails on: /home/<user>/ paths, e-mail addresses (except noreply@, example.* and git@github.com), and long token-like
# strings assigned to token/secret/password/key names. Excludes tests/privacy.sh itself and .git.
#   Escape hatch: `privacy-ok: <why>` on the same line.
# Re-check captured fixtures before adding them: tests/fixtures/ is scanned too.
set -u
ROOT=${1:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$ROOT" || exit 1
mapfile -t FILES < <(find . \( -path ./.git -o -path ./node_modules -o -path ./.omarchy-ref -o -path ./scratch \) -prune -o -type f -not -name '*.png' -not -name 'privacy.sh' -print | sort)
status=0
scan() { # label ERE
  local hits
  hits=$(grep -nHIE -- "$2" "${FILES[@]}" 2>/dev/null | grep -v 'privacy-ok' | grep -vE "${3:-^\$a}" || true)
  if [ -n "$hits" ]; then printf 'privacy: %s\n' "$1"; printf '%s\n' "$hits" | sed 's/^\.\//    /'; status=1; fi
}
scan "absolute home path" '/home/[A-Za-z0-9._-]+/|/Users/[A-Za-z0-9._-]+/'
scan "e-mail address" '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' 'noreply@|@example\.|ci@example|git@github\.com'
scan "token-like secret" '(token|secret|passwd|password|api[_-]?key)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9+/_-]{24,}["'"'"']'
[ "$status" -eq 0 ] && echo "privacy: ${#FILES[@]} file(s), clean"
exit "$status"
