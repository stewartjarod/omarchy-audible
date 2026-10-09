# jarod.audible: contract

Omarchy shell plugin: listen to Audible books from the bar. Dev dir: `~/Projects/jarod-audible`
(moved to `~/.config/omarchy/plugins/jarod.audible` at integration time).

**Hard rule for everyone building here:** work ONLY inside `~/Projects/jarod-audible`. Never write
under `~/.config/omarchy/plugins/`, never run `omarchy-shell`/`omarchy plugin`/`rescanPlugins`,
never touch `shell.json` or the live shell. Each plugin reload leaks ~127 MB in the user's live
shell. Verify with `node --test tests/` and `/usr/lib/qt6/bin/qmllint <file>` only
(qmllint will complain about unresolved `qs.*` imports; syntax errors are what matter).
Do not run `audible` commands that change anything. Do not print or log the voucher key/iv,
or any password.

## Files and owners

| File | Owner |
|---|---|
| `manifest.json`, `Service.qml`, `CONTRACT.md`, `fixtures/` | integrator (me) |
| `SetupModel.js`, `Onboarding.qml`, `tests/setup.test.js` | agent A (onboarding) |
| `LibraryModel.js`, `Library.qml`, `tests/library.test.js` | agent B (library) |
| `PlayerModel.js`, `Panel.qml`, `BarWidget.qml`, `tests/player.test.js` | agent C (player) |

JS models are **pure** (no QML imports, no I/O, no `Qt.*`). Write them with `.pragma library` at
the top so QML can `import "X.js" as X`, and export as plain top-level functions. For `node --test`
the same file must also be loadable as CommonJS: end each file with

```js
if (typeof module !== "undefined") module.exports = { fnA, fnB }
```

(`.pragma library` is a comment to node, so the same file works for both.)

## Theme and UI rules (all QML)

- Colours ONLY from `import qs.Commons` tokens: `Color.foreground/background/accent/urgent/muted`,
  `Color.popups.*` (popup), `Color.menu.*` (fullscreen overlay: `background, text, border, scrim,
  selectedBackground, selectedText`). Sizes from `Style.space(n)`, `Style.font.*`,
  `Style.spacing.*`, `Style.cornerRadius`, `Style.gapsOut`. Never hard-code a colour, a pixel
  font size, or a font family (`Style.font.menuFamily` / `bar.fontFamily`).
- Use `qs.Ui` primitives where they fit: `KeyboardPanel` (popup), `PanelKeyCatcher` (keys),
  `BorderSurface`, `PanelSlider`, `TextField`, `PanelActionButton`, `PanelHero`.
- Keyboard-first: everything reachable without the mouse; show a one-line key legend at the bottom
  of every surface. Mouse still works.
- Study these as the style reference before writing: `/usr/share/omarchy/shell/Ui/KeyboardPanel.qml`,
  `Ui/PanelKeyCatcher.qml`, `plugins/emojis/Emojis.qml` (fullscreen overlay + type-to-filter),
  `~/.config/omarchy/plugins/jarod.protonvpn/Panel.qml` (popup + key handling),
  `plugins/services/media/BarWidget.qml` (bar widget).
- Every QML surface component declares `property var service: null` and reads/writes ONLY through
  the Service API below.

## Service API (`Service.qml`, integrator-owned)

One Service instance per shell. All surfaces get it as `service`.

**Setup**
- `setup` (var): result of `SetupModel.detect(probe)` (see below). `ready` (bool): `setup.ready`.
- `setupBusy` (bool), `setupLog` (string, last human-readable progress line), `setupInput` unused.
- `runSetupAction(id, payload)`: ids are `install-audible`, `login`, `store-password`
  (payload = `{password}`), `remove-password`, `sync`, `recheck`, `cancel`.
- `loginUrl` (string): the local sign-in URL while a login is in progress (else "").

**Player** (read-only)
`hasBook, playing, paused, loading (bool)`, `asin, title, subtitle, author (string)`,
`coverUrl (string; file:// path if downloaded else https)`, `position, duration (seconds, real)`,
`speed (real)`, `chapters` = `PlayerModel.normalizeChapters(...)` output, `chapterIndex (int)`,
`timeLeftSec` (book remaining at current speed), `chapterTimeLeftSec` (same, current chapter),
`speedMin, speedMax, speedStep, skipSeconds` (from settings).

**Player commands**
`play(asin)` (downloads first if needed), `togglePause()`, `pause()`, `resume()`,
`seekBy(sec)`, `seekTo(sec)`, `jumpToChapter(i)`, `nextChapter()`, `prevChapter()`,
`setSpeed(x)`, `stepSpeed(dir)` (dir = +1/-1; uses `PlayerModel.stepSpeed`), `stop()`.

**Library**
- `books` (array of Book, merged with local state via `LibraryModel.merge`), `libraryLoading`,
  `libraryError` (string), `localAsins` (object `{asin: true}`), `downloads` (object
  `{asin: {state: "queued"|"downloading"|"done"|"failed", fraction: 0..1, error: ""}}`),
  `resume` (object `{asin: {position, updatedAt}}`).
- `refreshLibrary()`, `download(asin)`, `cancelDownload(asin)`, `isLocal(asin)`.
- `viewMode` ("grid" | "list", persisted), `setViewMode(m)`.
- `libraryOpen` (bool), `openLibrary()`, `closeLibrary()`, `toggleLibrary()`,
  `popupRequested` signal (Service asks the bar widget to open its popup).

## Book object (`LibraryModel.normalize`)

```
{ asin, title, subtitle, authors: [str], author: "A, B", narrators: [str],
  coverUrl: "https://...", runtimeSec, series: {title, sequence}|null,
  percentComplete: 0..100, remainingSec, finished: bool, listenable: bool,
  releaseDate, purchaseDate,
  // added by merge(books, local):
  local: bool, download: {state,fraction}|null, resumeSec: number, lastListenedAt: ms|0 }
```

Source: `fixtures/library-api.json` (real `audible api GET /1.0/library` output, trimmed). Quirks seen:
`listening_status.percent_complete` is 0..100; a book can have `finished_at_timestamp` set while
`is_finished` is false (finished = is_finished true or percent >= 99; finished_at is stale and ignored; list
under "Continue" only if not finished); `is_listenable: false` titles exist (borrowed/lapsed
subscription: not playable or downloadable, show but dim and block); `series[].sequence` may be "";
`product_images` is `{ "500": url }`, prefer the largest key; authors/narrators are `[{asin,name}]`.

## SetupModel.js (agent A)

```
detect(probe) -> {
  state: "no-audible"|"no-player"|"no-helper"|"no-account"|"locked"|"unsynced"|"ready",
  ready: bool, title: str, message: str (plain, friendly, one or two sentences),
  primary: {id, label, input?: "password"} | null,   // ONE main action
  secondary: [{id, label}],
  steps: [{id, label, status: "done"|"current"|"todo"}]   // fixed order below
}
```

Probe (all fields always present; Service builds it by running commands):

```
{ audible: {found, version}, mpv: {found}, helper: {found}, secretTool: {found},
  accounts: <parseAccountList result>, library: {ok, count, error},
  busy: str|"" /* id of action currently running */, login: {url, waiting} }
```

State priority = order above. Steps (labels are the user's checklist): `audible` "Audible CLI",
`player` "Audio player (mpv)", `helper` "Playback helper", `account` "Sign in to Audible",
`password` "Unlock the saved login", `library` "Sync your library".
Actions: `no-audible` -> primary `install-audible`; `no-player`/`no-helper` -> no primary, message
says exactly what to install (`omarchy pkg add mpv` for mpv; helper: "put audible-play on your PATH");
`no-account` -> primary `login` (while `login.waiting`: no primary, message tells them to finish in
the browser, secondary `cancel`); `locked` -> if `secretTool.found`: primary
`store-password` with `input: "password"`, secondary `remove-password`; else primary
`remove-password` only; `unsynced` -> primary `sync`; `ready` -> null. When `busy` is set, `primary`
keeps its id but add `busy: true` and label like "Syncing...". The unlocked login must NEVER be
described as "failed"; be reassuring.

Also export (all pure, all tested against `fixtures/`):
- `parseAccountList(stdout, stderr) -> {ok, accounts: [{name, authFile, passwordSource, marketplaces, defaultMp, isDefault}], error, locked: bool}`
  (JSON envelope `{error,warnings,result}`; empty `result` = no accounts. Locked is detected from
  `error.message` containing "is locked", see `fixtures/locked-out.json`. `account list` itself does
  NOT report locked; the locked signal normally comes from a failing `library list`, so also export
  `parseLibraryProbe(stdout, stderr, exitCode) -> {ok, count, error, locked}`.)
- `parseLoginUrl(line) -> string|null` (extract `http://127.0.0.1:<port>/<token>/` from the sign-in
  server's stdout, see `fixtures/login-server-output.txt`).
- `passwordSourceArgs(accountName) -> string[]` for
  `audible account password source command --command "secret-tool lookup service audible-rs account <name>"`
  and `keyringStoreArgs(accountName) -> string[]` for `secret-tool store --label=... service audible-rs account <name>`
  (the password is fed on stdin by the Service; it must never appear in args).
- `installPlan(tag, arch) -> {asset, url, sumsUrl, binDir: "~/.local/bin"}` for the pinned release
  `v0.1.0-alpha.8` asset `audible-0.1.0-alpha.8-x86_64-unknown-linux-musl.tar.gz`
  (from `https://github.com/mkb79/audible-rs/releases/download/<tag>/<asset>`; arch x86_64 only,
  others return `{error}`), and `verifySums(sumsText, asset, sha256hex) -> bool`.

## Onboarding.qml (agent A)

An `Item` that shows `service.setup`: the friendly title/message, the `steps` checklist (done / current
/ todo glyphs), the primary action as a focused button (Enter runs it), secondary actions below, a
masked password field when `primary.input === "password"` (Enter submits; clear the field afterwards;
`blocked` the key catcher while editing so typing works), the login URL as selectable text while
waiting, and `service.setupLog` as a muted line. Fills its parent; works at popup width (~360 px)
and in the fullscreen overlay. Emits `closeRequested()` for Esc. `r` re-checks (`recheck`).

## LibraryModel.js (agent B)

Pure functions, all tested against `fixtures/library-api.json`:
`parseApiPage(jsonText) -> {books, error}`, `normalize(item) -> Book`,
`merge(books, local) -> books` (local = `{localAsins, downloads, resume}` as on the Service),
`filter(books, query) -> books` (case-insensitive, diacritics-insensitive, multi-token AND across
title/subtitle/authors/narrators/series; rank: title-prefix > title-word-prefix > title-contains >
author > others; stable),
`sections(books, {query, now}) -> [{id, title, books}]` (no query: `continue` = in-progress, not
finished, newest `lastListenedAt` first then highest percent; `downloaded`; `all` = everything else
by purchaseDate desc. A book appears in exactly ONE section. With a query: a single `results`
section ranked, empty -> `[]`),
`moveSelection({index, count, columns, dx, dy}) -> index` (clamped grid/list navigation, no wrap),
`formatMeta(book) -> str` ("Author · 7h 42m · 24%"), `formatRuntime(sec) -> str`.

## Library.qml (agent B)

Fullscreen overlay modeled on `plugins/emojis/Emojis.qml`: `Item` root with a `PanelWindow`
using `Color.menu.*`. Interface (so the shell can summon it as an overlay OR the Service can host it):
`property var service`, `property var shell`, `property bool opened`, `function open(payloadJson)`,
`function close()`. Open on `service.libraryOpen` too (keep both in sync; closing sets
`service.closeLibrary()`).
Shows: search field focused by default (type to filter), "Continue listening" first, then
Downloaded, then All, as sections of either a **cover grid** (cover `Image` with `asynchronous: true`,
title + author under it, a thin progress bar from `percentComplete`/`resumeSec`, download state badge)
or a **list** (one dense row per book). `Tab` toggles grid/list (`service.setViewMode`), arrow keys /
hjkl move (hjkl only when the search field is empty or Ctrl is held; plain letters type), `Enter`
plays (`service.play(asin)`), `d` (with Ctrl) download only, `Esc` clears the query first, then
closes, `/` or any letter focuses search. Non-listenable books are dimmed and Enter shows why in a
one-line status. Currently playing book is marked. If `!service.ready`, show `Onboarding` instead
(same window). Footer key legend. Scroll the selection into view.

## PlayerModel.js (agent C)

Pure functions, tested:
`formatDuration(sec, style)` styles `"hm"` ("7h 42m", "42m", "<1m"), `"clock"` ("1:02:03", "42:07"),
`"left"` ("42m left"); `timeLeft(duration, position, speed) -> sec` (clamped, speed <= 0 treated as 1);
`normalizeChapters(mpvChapterList, duration) -> [{index, title, start, end, length}]`
(see `fixtures/mpv-chapter-list.json`; empty list -> one synthetic chapter spanning the book);
`chapterIndexAt(chapters, position) -> int`; `chapterProgress(chapter, position) -> 0..1`;
`stepSpeed(speed, dir, {step, min, max}) -> real` (snaps to the step grid, clamps, no float noise
like 1.2000000000000002; round to 2 decimals); `clampSpeed(x, min, max)`;
`formatSpeed(x) -> "1.5x"` (no trailing zeros: "2x", "2.25x");
`chapterTicks(chapters, duration) -> [fraction]` (boundaries between chapters, excluding 0 and 1);
`seekTarget(position, delta, duration) -> sec` (clamped);
`barLabel({title, position, duration, speed, playing, hasBook, setupReady}, {maxTitle}) -> {text, tooltip}`
(text like `Managing Oneself · 42m left · 2x` while a book is loaded, "Audible" icon-only text when not
ready or nothing loaded; truncate the title with an ellipsis at `maxTitle` chars).

## Panel.qml (agent C)

Bar popup built on `KeyboardPanel` (see `Ui/KeyboardPanel.qml`; protonvpn `Panel.qml` is the
usage example): `property var service`, `property var hostWidget`, `property var bar`,
`property Item anchorItem`, `opened`, `open()`, `close()`, `toggle()`, `closeForPopoutSwitch()`,
`popoutSwitchClosing` (same lifecycle surface as protonvpn). When `!service.ready` it shows
`Onboarding { service: ... }`. Otherwise: cover + title/author header; a large **time-left** readout
(book, at current speed) with the chapter's time left smaller; a whole-book progress bar with chapter
tick marks and a playhead (click to seek); play/pause and -/+skip buttons; a speed row
(`service.speedMin..speedMax`, shows `formatSpeed`, `[`/`]` or `-`/`+` step it); the chapter list
(scrollable, current chapter marked and kept in view, per-chapter length). Keys: `Space` play/pause,
`h`/`l` or Left/Right seek by `skipSeconds`, `j`/`k` or Down/Up move the chapter cursor, `Enter` jump
to the cursor chapter, `n`/`p` next/prev chapter, `[` `]` speed down/up, `o` open the library
(`service.openLibrary()`), `Esc` close. If no book is loaded: a friendly empty state with `o` to browse.
Key legend row at the bottom.

## BarWidget.qml (agent C)

`BarWidget` from `qs.Ui` (see `plugins/services/media/BarWidget.qml` and protonvpn `BarWidget.qml`).
`moduleName: "jarod.audible"`. Get the service with
`readonly property var service: bar?.shell?.serviceFor("jarod.audible") ?? null` (be null-safe: the
service may be null for a moment). Shows a book glyph (use an `OpticalGlyph`/`Text` with the nerd-font
book icon `󰂺` in `bar.fontFamily`, `Style.font.body`, colour `bar.barForeground`), and, when a book is
loaded, the `PlayerModel.barLabel` text (use it for the tooltip too). Click toggles the popup; scroll
changes speed (`service.stepSpeed`); middle click play/pause; right click opens the library. Dim the glyph
when paused, show `Color`'s urgent colour dot/glyph if `!service.ready`. Instantiate `Panel.qml` through
a `Loader` exactly like protonvpn's BarWidget (bar-widget lifecycle: `open/close/togglePanel/opened`,
`injectPanel`). The Service (not the widget) owns the IPC target and the library overlay, since the
bar is instantiated once per monitor.
Also connect `service.popupRequested` to open this widget's popup (only the instance on the focused
output should react; keep it simple: react if `opened` is false).

## Fixtures

See `fixtures/README.md`. Nothing in `fixtures/` may be edited by agents. If a fixture seems wrong
or missing, say so in your final report instead of inventing data.

## Corrections (integrator, after agents were briefed)

- `service.resume` is the resume-positions **object**. The command is `service.resumePlayback()`
  (the contract text above said `resume()`; do not call that). `pause()` is as written.
- The bar widget must push its `settings` into the Service: `service.applySettings(root.settings)`
  (call it on `onSettingsChanged` and when the service becomes non-null).
- The Service hosts `Library.qml` itself through a Loader (no overlay manifest kind), so the library's
  window must open/close from `service.libraryOpen`.
