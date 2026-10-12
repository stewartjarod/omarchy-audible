# Audible for Omarchy (`jarod.audible`)

Listen to your Audible audiobooks from the Omarchy top bar. The bar shows the
book, time left, and playback speed. Click it for chapters and progress. A
library window lets you search your books, download them, and pick one to play.

> **Alpha.** This plugin depends on [audible-rs](https://github.com/mkb79/audible-rs),
> which is itself an alpha release. See [Alpha notice](#alpha-notice).

Not affiliated with Audible or Amazon.

## Screenshots

<!-- TODO(screenshots): take these and replace the placeholders. Nothing has been captured yet.
  1. docs/screenshots/bar-playing.png    Bar with a book playing: title, time left, speed.
  2. docs/screenshots/popup-player.png   Bar popup: chapter list, progress bar, key legend.
  3. docs/screenshots/library-grid.png   Library window, grid view with covers and the search line.
  4. docs/screenshots/library-list.png   Library window, list view (press Tab).
  5. docs/screenshots/book-details.png   Details page with Play, Download, Mark finished.
  6. docs/screenshots/setup-install.png  First-run screen: "Let's install the Audible CLI".
  7. docs/screenshots/setup-sign-in.png  First-run screen: "Sign in to Audible".
  8. docs/screenshots/setup-locked.png   First-run screen: "Unlock your saved login" (password field).
-->

_Screenshots are not added yet._

## Requirements

| What | Why | How to get it |
|---|---|---|
| Omarchy with its shell (`omarchy-shell`) | Runs the bar widget, the popups, and the library window | Omarchy itself |
| `mpv` (x86_64 Linux) | Plays the audio and handles the decryption | `omarchy pkg add mpv` |
| `audible` from audible-rs **v0.1.0-alpha.8** | Talks to Audible: sign-in, library list, downloads | The plugin installs it on first run (see below) |
| `secret-tool` (libsecret, backed by gnome-keyring or similar) | **Optional.** Lets you save your Audible file password in the keyring so the book list can sync without asking each time | Install `libsecret` and a keyring service. Without it, you can still use the plugin; you just can't save the password |
| `mpv-mpris` | **Optional.** Lets Omarchy's media widget and other MPRIS tools see the audiobook. Loads by itself when installed | `omarchy pkg add mpv-mpris` |
| `uwsm-app` | **Optional.** When present, mpv starts in its own systemd scope so playback survives a shell restart | Ships with Omarchy's uwsm setup when it is installed |

The pinned audible-rs version lives in `Service.qml` as `pinnedTag`
(currently `v0.1.0-alpha.8`). The plugin only downloads that release. Its
`SHA256SUMS` file is checked before anything is installed.

## Install

```sh
omarchy plugin add https://github.com/stewartjarod/omarchy-audible.git --enable
```

`omarchy plugin add` clones the plugin into `~/.config/omarchy/plugins/jarod.audible`
(the folder name matches the plugin id in `manifest.json`) and enables it. If the
bar widget does not appear, restart the shell with `omarchy restart`.

## Remove

1. **Sign out (optional).** Open the popup and press `x` twice on the "Signed in as ..." row.
   This forgets the login on this computer but leaves the device registered with
   Amazon. To deregister it as well, run `audible account logout` in a terminal
   instead.
2. **Remove the plugin:**

   ```sh
   omarchy plugin remove jarod.audible --yes
   ```

   This also takes it out of the bar. Delete any key binds you added for it
   (for example the media-key binds suggested below, if you copied them into `~/.config/hypr/bindings.lua`).
3. **Delete what it left behind (optional).** The plugin never removes these itself:

   | What | Where |
   |---|---|
   | Plugin state, listening history, queue | `~/.local/state/jarod-audible/` |
   | Downloaded books | `~/.local/share/audible/` |
   | The Audible CLI it installed | `~/.local/bin/audible` and `~/.config/audible/` |
   | The keyring entry holding the login-file password | `secret-tool clear service audible-rs account <name>` (`audible account list` shows `<name>`) |

## First run

The popup walks you through setup one step at a time. A checklist shows what is
done, what you are on, and what is still to do. Each screen has one main action.
Press **Enter** to run it, **Tab** to pick a secondary option, **r** to check
again, and **Esc** to close.

1. **Audible CLI.** The screen says "Let's install the Audible CLI." Enter
   downloads the pinned audible-rs release from GitHub, checks it against
   `SHA256SUMS`, and installs it to `~/.local/bin/audible`. If the checksum does
   not match, nothing is installed.
2. **Audio player (mpv).** If mpv is missing, the screen says "One more piece:
   mpv." Run `omarchy pkg add mpv` in a terminal, then press **r**.
3. **Sign in to Audible.** Enter starts the sign-in. A page opens in your browser
   at a local address on `127.0.0.1`. Finish signing in on Amazon's page. The
   plugin notices when the account appears, so an odd message at the end of the
   browser flow is not a failure. **Tab** then Enter on "Cancel sign-in" stops
   the wait.
4. **Unlock the saved login.** Shown when your login was saved but needs your
   Audible file password once. If `secret-tool` is installed, type the password
   and press Enter; it goes straight into your keyring. Without `secret-tool`,
   the only option is "Remove saved password" and then signing in again.
5. **Sync your library.** Enter downloads your library list. It takes a few seconds.
6. **You're all set.** The library is ready. Open it with **o** from the player
   popup, or click the bar widget.

If the audible-rs version you have differs from the pinned one, the setup screen
says so in one sentence. The plugin still works, but behaviour may differ.

## Using it

### Bar widget

- **Click** the widget to open the player popup (chapters, progress, keys).
- **Scroll** over the widget to change the playback speed. Each notch is one
  "Speed step" (see [Settings](#settings)).

### Player popup

| Key | Action |
|---|---|
| `Space` | Play or pause |
| `Enter` | Jump to the highlighted chapter. With nothing loaded, plays the last book |
| `j` / `k` or `↓` / `↑` | Move the chapter cursor |
| `h` / `l` or `←` / `→` | Back or forward by the skip length |
| `Home` / `End` | First or last chapter |
| `n` / `p` | Next or previous chapter |
| `[` or `-` / `]` or `+` or `=` | Slower or faster (by one speed step) |
| `9` / `0` | Volume down or up for this player only (by the volume step) |
| `m` | Mute or unmute this player |
| `o` | Open the library |
| `Esc` | Close the popup |

### Library window

| Key | Action |
|---|---|
| Arrow keys, `PageUp` / `PageDown` | Move the selection |
| `h` `j` `k` `l` (when the search line is empty) or `Ctrl`+`h` `j` `k` `l` | Move the selection |
| `Enter` | Open the book's details page. For a series, opens the series |
| `Shift`+`Enter` | Play the selected book |
| `Tab` | Switch between grid and list view |
| `/`, or just start typing | Search (title, author, and other fields) |
| `Backspace` | Leave a series view, when the search line is empty |
| `Ctrl`+`F` | Cycle the filter: all, then downloaded, then not downloaded yet |
| `Ctrl`+`G` | Group books into series |
| `Ctrl`+`E` | Show more or fewer rows in "Continue listening" |
| `Ctrl`+`D` | Download the selected book |
| `Ctrl`+`X` | Delete the downloaded copy from this computer (asks first). Your Audible library is not changed |
| `Ctrl`+`M` | Mark the book finished on this computer. `Shift`+`Ctrl`+`M` undoes it |
| `Ctrl`+`S` | Sort by last played or by date added |
| `Ctrl`+`R` | Refresh the library from Audible |
| `Esc` | Clear the search, then leave search, then leave a series view, then close |

The library's bottom line always lists the keys that apply to the current view.

### Details page

Opened from the library with `Enter`.

| Key | Action |
|---|---|
| `Esc` or `Backspace` | Back to the library |
| `←` / `→` or `Tab` / `Shift`+`Tab` | Move between the buttons |
| `Enter` | Press the highlighted button |
| `P` | Play (or resume) |
| `D` | Download |
| `X` | Delete the downloaded copy (asks first) |
| `M` | Mark finished, or unmark it |
| `S` | Open the series, when the book is part of one |

"Mark finished" changes only this plugin's own record on this computer. It does
not change your Audible account.

### Hardware media keys

Omarchy sends the keyboard's Play, Pause, Next, and Previous keys to one
player at a time, and it only sees players that report over MPRIS:

- **Play / Pause** goes to the player that started playing first among those
  playing right now. If nothing is playing, it goes to the player you last
  controlled with those keys. So Spotify or another app can take the key from
  this audiobook.
- **Next / Previous** go to the first player that can skip. This audiobook has
  no next track in its queue, so those keys do not move it between chapters.

Use the keys in the popup and library for chapters and playback. To make the
keyboard's keys reach this player regardless of Spotify, bind dedicated keys to
the plugin in `~/.config/hypr/bindings.lua`, for example:

```lua
o.bind("CTRL + XF86AudioPlay", "Audiobook play/pause", "omarchy-shell -q jarod.audible toggle", { locked = true })
o.bind("CTRL + XF86AudioNext", "Audiobook next chapter", "omarchy-shell -q jarod.audible next", { locked = true })
o.bind("CTRL + XF86AudioPrev", "Audiobook previous chapter", "omarchy-shell -q jarod.audible prev", { locked = true })
```
(This is a suggestion; the plugin does not change your keybindings.)

## Listening features

### Sleep timer

Press `z` in the popup (or click the sleep line) to cycle 15, 30, 45 and 60
minutes, then "end of this chapter", then off. `Z` adds the running preset's
time again. The countdown only runs while the book is playing. For the last 30
seconds the player's volume fades down, then playback **pauses** (it is not
unloaded) and your volume is put back. A desktop notice says it paused. From a
script: `jarod.audible sleep <minutes>`, `sleepChapter`, `sleepCancel`.

### Rewind on resume

After you pause, resuming steps back a little so you catch what you missed:
nothing under 30 seconds, then 3 s, 8 s, 15 s and up to 30 s for long pauses.
It does not apply on the first play of a book, after a seek, or at the end of a
book. Setting: `rewindOnResume`.

### Next book in a series

When a book ends, the next book in its series starts after a 5 second "Up next"
notice, but only if it is **already downloaded**: nothing big downloads by
surprise. Your Up next queue wins over the series order. Setting: `autoAdvance`
(`off` or `downloaded`).

### Notifications

Short desktop notices for a finished download, a finished book, the sleep timer
and the next book. Setting: `notifications`.

### Sound adjustment

`audioFilter`: `normalize` evens out loud and quiet parts, `voice` makes speech
a little clearer. It only affects this player. (Silence trimming is not offered:
it breaks the position and chapter timing, so it was left out.)

### Resume from your phone

When the Audible app (or another device) is ahead of where you are here, the
popup offers "Resume from phone: Chapter 12 · 2h 13m" (press Enter), and the
details page shows a button (`R`). It only reads from Audible and never jumps
by itself. Starting a book that is not loaded uses the phone position if it is
newer. Setting: `syncPullFromAudible` (on by default).

Sending **your** position back to Audible is switched off
(`syncPositionToAudible`) and in dry-run mode (`syncDryRun`): audible-rs has no
documented way to write a position, so the plugin only logs what it would send
and sends nothing. It does not write to your account.

### Listening stats

Press `i` in the popup, or run `jarod.audible toggleStats`, for a window with
your streak, this week, today against your average, time saved by listening
faster, a 14-day chart, a **burn-down** for the loaded book (solid: where you
were; dashed: where you will be at your pace), and a finish estimate for each
book in progress. The estimate needs at least two days of listening and ten
minutes of book; until then it says so instead of guessing. Daily totals are
kept on this computer in `~/.local/state/jarod-audible/listening.json`. The
"Audible says: N h this year" line comes from `audible stats`.

### Up next, wishlist and suggestions

- **Up next:** on a details page press `U` to add or remove a book and `N` to
  play it next. In the library, `Ctrl+U` shows the queue and `Ctrl+Up/Down`
  reorder it. A queued book leaves the queue when it starts.
- **Suggested for you:** one row in the library: the next book in a series
  you are part way through, books by authors and narrators of books you
  finished, then shorter books first. Each tile says why.
- **Wishlist:** `Ctrl+W` shows your Audible wishlist (books you do not own).
  Open one to see its details and similar titles. Adding or removing a wishlist
  item needs two presses of `W` on the details page; there is no buying.
- **More like this:** a strip of similar books on the details page (`Down`
  enters it).

## Settings

Change these in the plugin's settings in Omarchy. The values and their limits
come from the schema in `manifest.json`.

| Key | Label | Default | Allowed | What it does |
|---|---|---|---|---|
| `speedStep` | Speed step | 0.1 | 0.05 to 0.5, step 0.05 | How much one speed key press or scroll notch changes the speed |
| `speedMin` | Slowest speed | 0.5 | 0.25 to 1, step 0.05 | Lowest playback speed |
| `speedMax` | Fastest speed | 3.5 | 1 to 5, step 0.25 | Highest playback speed. Pitch is corrected, so voices stay natural |
| `skipSeconds` | Skip length (seconds) | 30 | 5 to 300, step 5 | How far `h` and `l` (and the arrow keys) jump |
| `volumeStep` | Volume step | 5 | 1 to 25, step 1 | How much `9` and `0` change this player's volume. Your system volume is not touched |
| `maxTitleChars` | Longest title in the bar | 28 | 8 to 80, step 2 | Longer titles are shortened in the bar |
| `downloadQuality` | Download quality | high | `high` or `normal` | `high` is about 128 kbps. `normal` is about half the size, so a book is ready roughly twice as fast, with little difference for speech |
| `libraryScrollRows` | Library scroll speed | 0.5 | 0.1 to 2, step 0.1 | Grid rows one mouse-wheel notch scrolls in the library |
| `libraryTrackpadSpeed` | Library trackpad scroll speed | 2.5 | 0.5 to 10, step 0.5 | How far the library grid moves for a trackpad swipe. A quick swipe is boosted further |
| `rewindOnResume` | Rewind a little when resuming | on | on / off | Go back a few seconds after a pause, more after a longer one |
| `autoAdvance` | Continue to the next book in a series | `downloaded` | `off` or `downloaded` | Start the next downloaded book in a series when one ends |
| `notifications` | Desktop notifications | on | on / off | Notices for downloads, finished books, the sleep timer, up next |
| `audioFilter` | Sound adjustment | `off` | `off`, `normalize`, `voice` | Even out loudness or lift speech clarity (this player only) |
| `syncPullFromAudible` | Pick up where I stopped on my phone | on | on / off | Offer the position from the Audible app. Reads only |
| `syncPositionToAudible` | Save my position to Audible | off | on / off | Not working yet: nothing is sent while it is unconfirmed |
| `syncDryRun` | Dry run | on | on / off | Log what would be sent instead of sending |

## Where things are stored

| What | Where | Notes |
|---|---|---|
| audible-rs binary | `~/.local/bin/audible` | Installed by the plugin, from the pinned release |
| Your Audible account | Managed by audible-rs, in its own config directory | The plugin reads the account list but does not write it |
| Saved password (optional) | Your system keyring, under service `audible-rs` and your account name | Never written to a file, never on a command line, never logged |
| Downloaded books | `~/.local/share/audible/books/` | Encrypted `.aaxc` audio plus a `.voucher` file for each book (see Privacy) |
| Plugin state | `~/.local/state/jarod-audible/state.json` | View mode, sort and filter, volume, speed, last book, resume positions, finished marks |
| Listening history | `~/.local/state/jarod-audible/listening.json` | Seconds listened per day (and per book), for stats and the finish estimate. Stays on this computer |
| Up next queue | `~/.local/state/jarod-audible/queue.json` | The ordered list of queued books |
| Phone sync notes | `~/.local/state/jarod-audible/sync.json` | Which phone positions you accepted (only if you use it) |
| mpv control socket | `$XDG_RUNTIME_DIR/omarchy-audible-mpv.sock` (falls back to `/tmp`) | Exists only while the audiobook player runs |

## Privacy and DRM

- **The plugin never sees your Amazon password.** Sign-in happens on Amazon's
  own page, in your browser. The plugin only sees that the account now exists.
  The one exception is the optional "Unlock the saved login" step: that field
  takes your Audible file password and passes it straight to `secret-tool` on
  standard input. It is not put on a command line, written to a file, or logged.
- **Books are encrypted on disk.** A downloaded book is an encrypted `.aaxc` file.
  The `.voucher` file next to it holds the key and IV needed to decrypt it. That
  voucher is written by audible-rs, as it is for any audible-rs download.
- **No decrypted copy is written.** When you play a book, the plugin reads the
  key and IV from the voucher into memory, and hands them to mpv over its local
  socket as demuxer options. They never appear in a command line. mpv decrypts
  the audio as it plays, and nothing decrypted is saved to disk.
- **Network use is limited.** The plugin talks to Audible through audible-rs,
  and loads cover images from the catalog's image addresses. It downloads
  audible-rs from GitHub once, during install. Sign-in opens Amazon's page in
  your browser; the local callback address is on `127.0.0.1`.

## Troubleshooting

**Nothing shows after a shell restart.** Reopen the bar popup. mpv runs in its
own session, so a book that was playing keeps playing through the restart. If the
popup still shows nothing, play the book again.

**The player says mpv did not start.** Install mpv (`omarchy pkg add mpv`).

**The audiobook will not start, or the socket is stale.** The plugin removes the
old socket before it starts a new mpv, so a stale file is normally harmless. If
the player is stuck, stop only the audiobook's mpv, which owns that socket:

```sh
pkill -f omarchy-audible-mpv.sock
```

Then play the book again.

**"Could not read this book's license file."** The voucher is missing or damaged.
Delete the book with `Ctrl`+`X` and download it again with `Ctrl`+`D`.

**"This title is not available to play with your current plan."** Your
subscription no longer covers this title. It stays in the list, dimmed, and cannot
be played or downloaded.

**The library is empty or out of date.** Press `Ctrl`+`R` in the library. For
more detail, run `audible library sync` in a terminal and read its output.

**"Sync failed" or sign-in keeps coming back.** Run `audible account list` in a
terminal. If it shows no accounts, sign in again from setup. Read the terminal
output for the real error.

**Version notice on the setup screen.** Your `audible` is not the pinned release.
Install `v0.1.0-alpha.8` or update the plugin's `pinnedTag` to match what you have.

**Reset the plugin's own state.** Stop playback, delete
`~/.local/state/jarod-audible/state.json`, and then restart the shell with
`omarchy restart` straight away. A running shell keeps its state in memory and
writes it back after your next change, so the file must be deleted before the
restart. This clears resume positions, finished marks, and view settings. It does
not touch your books, your account, or your saved password.

**If the browser sign-in is blocked.** Amazon sometimes answers the plugin's local sign-in page
with "There was a problem" (its check against automated sign-ins; several attempts in a row make
it likelier). Wait about 30 minutes, or press Tab to "Sign in with a terminal instead". That
opens a terminal window running the CLI's own sign-in: it prints a normal amazon.com address, you
sign in there, and paste back the address you land on. The script then protects the login file
with a random keyring password and the popup carries on by itself (it re-checks every few seconds
and whenever you open it). If you forgot the password you set yourself, "Sign out and start over"
on the unlock screen clears the account so you can sign in again.

**How sign-in handles the login-file password.** The Audible CLI's own prompt for a login-file
password needs a terminal, which the shell does not have. So the plugin signs in with an
unencrypted login file for a few seconds, then encrypts it with a random password (passed
through the environment, never on a command line) and stores that password in your keyring
with `secret-tool`. You never see or type it. If your machine has no `secret-tool`, the login
file stays unencrypted and the setup log says so; install `libsecret` to avoid that.

**Sign out.** In the player popup press **x** twice (or click the "Signed in as ..."
line, then click it again), or run `jarod.audible signOut` over IPC. Playback stops, the
account is removed from the Audible CLI and its login file is deleted, and the setup
screen comes back so you can sign in again (or as someone else). Your downloaded books
stay on disk. Amazon is not told: the device stays registered on your Amazon account
until you remove it there, or run `audible account logout` yourself instead.

**Remove the saved password.** Use "Remove saved password" on the setup screen, or
delete the keyring entry with `secret-tool clear service audible-rs account <name>`.

**Read the shell log.** Run `qs log` and look for lines that mention
`jarod.audible`.

## Known limits

- Linux on x86_64 only. The installer has no other build.
- Audible's API is not public. audible-rs uses its own reading of it, so an
  Audible change can break things until audible-rs and this plugin are updated.
- Uses your default audible-rs account. Multiple accounts are not offered.
- The marketplace is guessed from your system language and defaults to the US.
- Mark finished is local to this computer.
- Hardware media keys may control another player first (see
  [Hardware media keys](#hardware-media-keys)).

## Alpha notice

audible-rs **v0.1.0-alpha.8** is an alpha release by its author, mkb79. It is a
third-party command-line tool that works with Audible's API as the project has
reverse-engineered it. The plugin pins this one release, downloads it only from
the project's GitHub release, and checks it against the published `SHA256SUMS`
before installing. Expect breakage when Audible changes, and expect the upstream
project to change between releases. If you have a different version installed,
the setup screen will tell you.

## Limits of testing

The pure logic is covered by `node --test tests/`. The QML is not run by those
tests. `tests/run-all.sh` runs the tests and a `qmllint` pass. `tests/smoke.sh`
drives a running shell over IPC and must be run by hand in the desktop session.

## Files

| File | What |
|---|---|
| `Service.qml` | The single owner of playback, state, library, and IPC |
| `SetupController.qml`, `SetupModel.js`, `Onboarding.qml` | First-run setup: checks, actions, and screens |
| `PlayerModel.js`, `Panel.qml`, `BarWidget.qml` | Player logic, popup, and bar widget |
| `LibraryModel.js`, `Library.qml`, `BookDetail.qml` | Library logic, window, and details page |
| `manifest.json` | Plugin id, entry points, and settings schema |
| `tests/` | Node tests, `run-all.sh`, `smoke.sh` |
| `fixtures/` | Captured audible-rs and mpv output used by the tests (see its README) |

## License

MIT. See [LICENSE](LICENSE).
