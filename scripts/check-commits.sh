#!/usr/bin/env bash
# Runs the commit-msg hook over every commit in a range. Local hooks can be skipped
# (--no-verify, a fresh clone); CI runs this so a bad commit message cannot land.
#
#   scripts/check-commits.sh origin/main..HEAD
set -u
range=${1:?usage: scripts/check-commits.sh <rev-range>}
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
bad=0
while IFS= read -r sha; do
  git log -1 --format=%B "$sha" > "$tmp"
  if ! sh "$root/.githooks/commit-msg" "$tmp" 2>/dev/null; then
    printf 'bad commit message: %s %s\n' "$(git log -1 --format='%h' "$sha")" "$(git log -1 --format=%s "$sha")" >&2
    bad=1
  fi
done < <(git rev-list --reverse "$range")
[ "$bad" -eq 0 ] && echo "check-commits: every commit in $range follows Conventional Commits"
exit "$bad"
