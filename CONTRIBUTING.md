# Contributing

## Commits: Conventional Commits

Every commit's first line is `<type>(<scope>)<!>: <subject>`:

| Type | Use for | Version bump |
|---|---|---|
| `feat` | a new capability for users | minor |
| `fix` | a bug fix | patch |
| `perf`, `refactor` | code changes with no new behaviour | none (patch if shipped) |
| `docs`, `test`, `style`, `build`, `ci`, `chore` | everything else | none |

A `!` after the type, or a `BREAKING CHANGE:` line in the body, marks a breaking change (settings
renamed or removed, a changed IPC name, a moved state file). While the version is `0.x`, a breaking
change bumps the minor number; from `1.0.0` it bumps the major.

Turn on the check once per clone: `git config core.hooksPath .githooks`.

## Versions

`manifest.json` holds the version; there is no other copy. To release:

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` heading.
2. Set `version` in `manifest.json` to `X.Y.Z`.
3. Commit as `chore(release): X.Y.Z`, tag it `vX.Y.Z`, and push the commit and the tag.
4. Ask the marketplace to verify that exact commit (a `[Verify]` issue with the full commit SHA).
   Verification belongs to one commit, so do not push to `master` while a request is open.

`tests/release.test.js` fails when the manifest version is not valid SemVer or does not match the
newest released section of the changelog.

## Checks

`tests/run-all.sh` runs everything that works without the desktop. It must pass before a push.
