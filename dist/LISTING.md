# Marketplace listing for stewartjarod.audible (omarket)

This note is for whoever submits the plugin to plugins.omarchy.org. The draft
entry is `dist/catalog-entry.draft.json`. Nothing here has been submitted or
published.

## How omarket consumes a listing

- `omarket` reads `catalog.json` and reduces each entry to the fields it uses
  (`build_index` in the omarket script): `id` must match `^[A-Za-z0-9._-]{1,200}$`;
  `name`, `description`, `author`, `category`, `kind`, `tags`, `license`, `repo`,
  `repositoryLayout`, `installAvailable`, and `installNote` are read as given.
- `trust` is derived by the marketplace, not by the submitter: `verified` when
  `verificationStatus` is `verified`; `stale` when only the snapshot is verified
  and upstream has moved; otherwise `unreviewed`.
- `omarket install <id>` runs `omarchy plugin add` against the GitHub URL, checks
  out the verified commit (`listingValidatedCommit`), validates it again, and
  enables it. It refuses an `unreviewed` listing unless `--allow-unverified` is
  given.

## What must be true before submitting

1. The repo is public on GitHub, and the commit to verify is pushed. Right now the
   work exists only as local commits in the scratch clone, so nothing can be
   verified yet.
2. `manifest.json` `id` is `stewartjarod.audible` and matches the folder name that
   `omarchy plugin add` creates. Checked: schemaVersion 1, entryPoints `Service.qml`
   and `BarWidget.qml` exist at the repo root, license `MIT` with a `LICENSE` file.
3. `README.md` is at the repo root (done). It documents the install command, the
   requirements (mpv, the pinned audible-rs alpha, optional secret-tool and
   mpv-mpris), privacy, and the alpha notice.
4. The `id` is not already taken on the marketplace. This was NOT checked:
   `catalog.json` was not fetched, per the scope of this task.
5. `tests/run-all.sh` passes on the commit being submitted.

## Open items for the submitter

- Fill the placeholders in the draft: author, repo URL, repositoryLayout.
- Confirm the `kind` string the marketplace expects. The draft uses
  `service, bar-widget`, copied from the manifest's `kinds` array.
- The live smoke test (`tests/smoke.sh`) has not been run against a shell that
  loaded this exact commit. Run it after installing the listed version.
