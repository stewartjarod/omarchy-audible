# Changelog

All notable changes to this plugin are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the plugin follows
[Semantic Versioning](https://semver.org/). `manifest.json` holds the current version.

## [Unreleased]

## [0.2.2] - 2026-10-15

### Security
- Other people on the same computer can no longer see which books you listen to, or where you are
  in them, in the list of running programs. Requests to Audible go to audible-rs on its standard
  input instead of its command line; download progress, deleting a book and reading a book's
  license do the same. Notifications no longer name the book. The one exception is a download in
  progress, because audible-rs only takes the book's ID on its command line.
- The sign-in address (it carries the local sign-in server's secret) opens through a page only you
  can read, instead of being passed to the browser on its command line.
- The audiobook player's control socket no longer falls back to `/tmp`.
- audible-rs's data folder (its library database) and the books folder are now readable by you
  only, and files in them that other users could read are tightened.
- Every command the plugin runs uses a fixed PATH, has a deadline, and has a size limit on its
  output.
- The audible-rs download is checked against a SHA-256 pinned in the plugin, instead of the
  release's own checksum file.
- All text from Audible is shown as plain text.

### Changed
- Wishlist changes use the same requests as `audible collections wishlist add|remove`, sent the
  same private way.

## [0.2.1] - 2026-10-14

### Fixed
- The shell no longer has any text input, so it never reads the clipboard. Unlocking a saved login
  now opens a terminal window that asks for the password (not shown as you type) and puts it
  straight into your keyring; the popup notices the unlock by itself. The sign-in link is plain
  text that copies when clicked.

## [0.2.0] - 2026-10-12

### Added
- Your listening position is saved to Audible, so the Audible app on your phone opens where you
  stopped. On by default; the setting `savePositionToAudible` turns it off. It never overwrites a
  newer position written from another device, and it is the only write the plugin makes to your
  Audible account.

### Changed
- The settings `syncPositionToAudible` and `syncDryRun` are retired. `savePositionToAudible`
  replaces them (a saved value of the old keys has no effect).
- Test fixtures use sample data, and the README screenshots show a sample library.

### Fixed
- Signing out now removes this computer from your Amazon account (`audible account logout`). It
  used to leave the device registered. If Amazon cannot be reached, or the login cannot be opened
  (a forgotten password), the login is still removed here and the plugin says the computer stays
  listed until you remove it on Amazon's Manage Your Content and Devices page.
- The first download on a new install could finish without the player ever finding the book. The
  plugin now makes the audible CLI's download settings match the layout the player reads.
- The sign-in password field no longer exists while the popup is closed (a text input in the shell
  reacts to every clipboard change).

## [0.1.1] - 2026-10-11

First public release, listed on the Omarchy plugin marketplace.

### Added
- Audible player in the bar with a popup, a library window (grid and list), book details, a queue,
  listening stats, sleep timer, speed and chapter controls, and "Resume from phone".
- Guided setup: install check, sign-in, saved login, library sync.

### Changed
- The plugin id is `stewartjarod.audible`.
- The state directory is private (mode 0700, files 0600).

[Unreleased]: https://github.com/stewartjarod/omarchy-audible/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/stewartjarod/omarchy-audible/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/stewartjarod/omarchy-audible/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/stewartjarod/omarchy-audible/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/stewartjarod/omarchy-audible/releases/tag/v0.1.1
