# fixtures

Real output captured 2026-10-09 from audible-rs 0.1.0-alpha.8 and mpv 0.41 on the author's
machine, except where marked SYNTHETIC. Do not edit. Scrub titles before publishing this repo.

| File | What |
|---|---|
| account-list.json | `audible account list -o json`, one encrypted account, password_source=command |
| account-list-empty.json | same, no accounts (stdout); `account-list-empty.err` is the stderr hint text |
| locked-out.json / locked-err.txt | `audible library list -o json` stdout/stderr (exit 1) when the account's password_source is `prompt` (locked) |
| unsynced-out.json | SYNTHETIC: `library list` result for a synced-never account (empty result) |
| library-list.json | `audible library list -o json --limit 15` (basic fields only) |
| library-api.json | trimmed `audible api GET /1.0/library` with response groups; 40 books incl. in-progress, series, a non-listenable title |
| version.txt | `audible --version` |
| login-server-output.txt | stdout of `audible account login server` (token is a placeholder) |
| mpv-chapter-list.json | mpv IPC reply to `get_property chapter-list` (12 chapters, "Managing Oneself") |
