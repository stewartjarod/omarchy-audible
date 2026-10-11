# fixtures

Output captured from audible-rs 0.1.0-alpha.8 and mpv 0.41 (except where marked SYNTHETIC) and used by
`tests/`. Do not hand-edit captured files; re-capture instead.

Scrubbing rules applied before this repo was made public:

- The Audible account label is replaced with `example` (it was the owner's account name).
- Catalog data is kept as-is: titles, authors, narrators, series and catalog URLs (`/pd/...`) are public.
- No account ids, device or customer ids, tokens, signed URLs, emails or local paths are present.
  Re-check with `grep -rniE "jarod|/home/|token|customer|device" fixtures/` before adding new captures.
- `login-server-output.txt` contains a placeholder token, not a real sign-in token.

| File | What |
|---|---|
| account-list.json | `audible account list -o json`, one encrypted account (name `example`), password_source=command |
| account-list-empty.json | same, no accounts (stdout); `account-list-empty.err` is the stderr hint text |
| no-account-list.json / .err | `audible account list -o json` on a clean HOME (no accounts): stdout envelope and stderr hint |
| no-account-library.json / .err | `audible library list -o json --limit 1` on a clean HOME (exit 1): "no account configured" |
| no-account-sync.err | `audible library sync` on a clean HOME (exit 1, empty stdout): "no account configured" |
| locked-out.json / locked-err.txt | `audible library list -o json` stdout/stderr (exit 1) when the account's password_source is `prompt` (locked); account name `example` |
| unsynced-out.json | SYNTHETIC: `library list` result for a synced-never account (empty result) |
| library-list.json | `audible library list -o json --limit 15` (basic fields only) |
| library-api.json | trimmed `audible api GET /1.0/library` with response groups; 40 books incl. in-progress, series, a non-listenable title |
| version.txt | `audible --version` |
| login-server-output.txt | stdout of `audible account login server` (token is a placeholder) |
| mpv-chapter-list.json | mpv IPC reply to `get_property chapter-list` (12 chapters, "Managing Oneself") |
