#!/usr/bin/env bash
# Theme lint: a plugin must take every colour, font and corner shape from the shell's theme tokens
# (qs.Commons: Color, Style), or it will look wrong under some Omarchy themes (light themes, square
# vs rounded corners, different fonts). This fails on anything that bypasses the tokens.
#
# Escape hatch for a deliberate exception (a brand logo, a fixed status LED):
#   put `// theme-ok: <why>` on the SAME line.
#
# Usage: tests/theme-lint.sh [DIR]   (default: the plugin root; tests/ and .git/ are skipped)
# Exit: 0 clean, 1 violations.

set -u
ROOT=${1:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$ROOT" || exit 1

mapfile -t FILES < <(find . \( -path ./tests -o -path ./.git -o -path ./node_modules -o -path ./.omarchy-ref \) -prune -o \
  -type f \( -name '*.qml' -o -name '*.js' \) -print | sort)
[ "${#FILES[@]}" -eq 0 ] && { echo "theme-lint: no files"; exit 0; }

status=0
# check <label> <hint> <ERE> [allowed-ERE]   (lines matching allowed-ERE are not violations)
check() {
  local label=$1 hint=$2 re=$3 allow=${4:-'^$a'} hits
  hits=$(grep -nHE -- "$re" "${FILES[@]}" 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' \
    | grep -v 'theme-ok' \
    | grep -vE -- "$allow" || true)
  if [ -n "$hits" ]; then
    printf 'theme-lint: %s\n  fix: %s\n' "$label" "$hint"
    printf '%s\n' "$hits" | sed 's/^\.\//    /'
    status=1
  fi
}

check "hard-coded hex colour" \
  "use Color.foreground/background/accent/urgent/muted or a surface token (Color.popups.*, Color.menu.*)" \
  "[\"']#[0-9a-fA-F]{3,8}[\"']"
check "colour built from numbers (Qt.rgba/hsla/hsva/color)" \
  "derive from a token: Util.alpha(Color.foreground, 0.4)" \
  'Qt\.(rgba|hsla|hsva|color)\('
check "named colour" \
  "use a Color token ('transparent' is the only literal allowed)" \
  '\b[cC]olor[[:space:]]*:[[:space:]]*"[a-zA-Z]+"' \
  '[cC]olor[[:space:]]*:[[:space:]]*"transparent"'
check "numeric font size" \
  "use Style.font.* sizes, scaled with Style.space(n)" \
  '\b(pixelSize|pointSize)[[:space:]]*[:=][[:space:]]*[0-9]'
check "hard-coded font family" \
  "use Style.font.family / Style.font.menuFamily / bar.fontFamily" \
  '\b(font\.)?family[[:space:]]*:[[:space:]]*"'
check "numeric corner radius" \
  "use Style.cornerRadius (Omarchy themes can be fully square); circles: radius: width / 2" \
  '\bradius[[:space:]]*:[[:space:]]*[1-9]'
check "Qt Quick Controls style / system palette" \
  "these ignore the shell theme; use qs.Ui primitives" \
  'SystemPalette|\bMaterial\.|\bUniversal\.|import QtQuick\.Controls\.(Material|Universal|Fusion|Imagine|Basic)'

if [ "$status" -eq 0 ]; then
  echo "theme-lint: ${#FILES[@]} file(s), clean"
fi
exit "$status"
