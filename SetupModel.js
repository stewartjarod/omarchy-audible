.pragma library

// Pure setup logic for stewartjarod.audible: decides what the user needs to do next,
// parses the audible CLI's output, and plans the CLI install. No QML, no I/O.

var PINNED_TAG = "v0.1.0-alpha.8"
var PINNED_ARCH = "x86_64"
var RELEASE_BASE = "https://github.com/mkb79/audible-rs/releases/download/"
var SUMS_NAME = "SHA256SUMS" // checked against the v0.1.0-alpha.8 release: 5 assets, this exact name

var ACCOUNT_RE = /^[A-Za-z0-9._@-]{1,64}$/
var LOGIN_URL_RE = /http:\/\/127\.0\.0\.1:(\d{1,5})\/[A-Za-z0-9_-]+\/?/

// Step order is the user's checklist. The index of the current state's step
// is the first one not yet done; everything before it is done, after it todo.
var STEPS = [
  { id: "audible", label: "Audible CLI" },
  { id: "player", label: "Audio player (mpv)" },
  { id: "account", label: "Sign in to Audible" },
  { id: "password", label: "Unlock the saved login" },
  { id: "library", label: "Sync your library" }
]

var STATE_STEP = {
  "no-audible": 0,
  "no-player": 1,
  "no-account": 2,
  "locked": 3,
  "unsynced": 4,
  "ready": 5
}

var BUSY_LABELS = {
  "install-audible": "Installing...",
  "login": "Starting sign-in...",
  "store-password": "Saving...",
  "remove-password": "Removing...",
  "sign-out": "Signing out...",
  "sync": "Syncing..."
}

function _str(v) { return typeof v === "string" ? v : "" }

function _firstLine(s) {
  var t = _str(s).trim()
  var i = t.indexOf("\n")
  return (i < 0 ? t : t.slice(0, i)).trim()
}

function _isLockedText(s) { return /\bis locked\b/.test(_str(s)) }

function _parseJson(text) {
  try { return JSON.parse(text) } catch (e) { return undefined }
}

function _isObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v) }

// The CLI envelope's `error` is either null, a string, or {message}.
function _errorMessage(e) {
  if (e === null || e === undefined || e === "") return ""
  if (typeof e === "string") return e.trim()
  if (_isObject(e)) return _str(e.message).trim() || "Unknown error"
  return "Unknown error"
}

function _marketplaces(v) {
  if (Array.isArray(v)) return v.map(_str).filter(Boolean).join(",")
  return _str(v)
}

// `audible account list -o json` -> {ok, accounts, error, locked}
function parseAccountList(stdout, stderr) {
  var out = _str(stdout).trim()
  var err = _str(stderr)
  var env = out ? _parseJson(out) : undefined

  if (!_isObject(env)) {
    if (/no accounts configured/i.test(err)) return { ok: true, accounts: [], error: "", locked: false }
    if (_isLockedText(err) || _isLockedText(out)) return { ok: false, accounts: [], error: _firstLine(err), locked: true }
    return {
      ok: false, accounts: [], locked: false,
      error: _firstLine(out) || _firstLine(err) || "Could not read the account list"
    }
  }

  var msg = _errorMessage(env.error)
  if (msg) return { ok: false, accounts: [], error: msg, locked: _isLockedText(msg) }

  var result = env.result === null || env.result === undefined ? [] : env.result
  if (!Array.isArray(result)) return { ok: false, accounts: [], error: "Unexpected account list output", locked: false }

  var accounts = []
  for (var i = 0; i < result.length; i++) {
    var item = result[i]
    if (!_isObject(item)) continue
    var name = _str(item.name)
    if (!name) continue
    accounts.push({
      name: name,
      authFile: _str(item.auth_file),
      passwordSource: _str(item.password_source),
      marketplaces: _marketplaces(item.marketplaces),
      defaultMp: _str(item.default_mp),
      isDefault: item.default === "*" || item.default === true
    })
  }
  return { ok: true, accounts: accounts, error: "", locked: false }
}

// `audible library list -o json` -> {ok, count, error, locked}
// A locked account (password_source = prompt) makes this exit 1 with an
// error envelope; that is the normal locked signal.
function parseLibraryProbe(stdout, stderr, exitCode) {
  var out = _str(stdout).trim()
  var err = _str(stderr)
  var n = exitCode === null || exitCode === undefined ? 0 : Number(exitCode)
  if (!isFinite(n)) n = 1
  var env = out ? _parseJson(out) : undefined

  if (!_isObject(env)) {
    return {
      ok: false, count: 0, locked: _isLockedText(err) || _isLockedText(out),
      error: _firstLine(err) || _firstLine(out) || ("audible exited with code " + n)
    }
  }

  var msg = _errorMessage(env.error)
  if (msg) return { ok: false, count: 0, error: msg, locked: _isLockedText(msg) }

  if (n !== 0) return { ok: false, count: 0, error: _firstLine(err) || ("audible exited with code " + n), locked: _isLockedText(err) }
  if (!Array.isArray(env.result)) return { ok: false, count: 0, error: "Unexpected library output", locked: false }
  return { ok: true, count: env.result.length, error: "", locked: false }
}

// Extracts the local sign-in URL from the sign-in server's output. The
// browser login's exit code is not used for success; the account list is.
function parseLoginUrl(line) {
  if (typeof line !== "string") return null
  var m = line.match(LOGIN_URL_RE)
  if (!m) return null
  if (parseInt(m[1], 10) > 65535) return null
  var url = m[0]
  if (url.charAt(url.length - 1) !== "/") url += "/"
  return url
}

function _checkAccount(name) {
  if (typeof name !== "string" || !ACCOUNT_RE.test(name)) throw new Error("invalid account name")
  return name
}

// Argv (without the program name) for `audible account password source command`.
function passwordSourceArgs(accountName) {
  var n = _checkAccount(accountName)
  return [
    "account", "password", "source", "command",
    "-a", n,
    "--command", "secret-tool lookup service audible-rs account " + n
  ]
}

// Argv (without the program name) for `secret-tool store`. The Service writes
// the password to stdin; it is never part of the args.
function keyringStoreArgs(accountName) {
  var n = _checkAccount(accountName)
  return ["store", "--label=audible-rs " + n, "service", "audible-rs", "account", n]
}

// Argv (without the program name) to sign out properly: the CLI deregisters this computer's device
// with Amazon, then deletes the account and its auth file locally. It needs the network and a login
// the CLI can open, so signing out tries this first and falls back to signOutArgs below.
function deregisterArgs(accountName) {
  var n = _checkAccount(accountName)
  return ["account", "logout", "-a", n, "--yes"]
}

// Seconds the deregistering sign-out may take before the plugin gives up and uses the local fallback.
var DEREGISTER_TIMEOUT_SEC = 40

// Argv (without the program name) for the local-only fallback: drops the account from the CLI's
// config and deletes its auth file, so the next sign-in starts clean (no name clash). It does NOT
// deregister the device with Amazon (used when offline or when the login cannot be opened, for
// example a forgotten password); downloaded books are untouched.
function signOutArgs(accountName) {
  var n = _checkAccount(accountName)
  return ["account", "remove", n, "--yes", "--delete-auth-file"]
}

// Where the player looks for books: <booksDir>/<ASIN>/<ASIN>.*. The CLI only puts files there when
// its download settings say so, and a fresh CLI install defaults to <Title> files in a "downloads"
// folder, which the player never finds. This is the layout the plugin needs.
var DOWNLOAD_FILENAME_MODE = "custom"
var DOWNLOAD_FILENAME_TEMPLATE = "%asin%/%asin%"

// Argv (with the program name) for a script that makes the CLI's download settings match that layout.
// Idempotent: a setting that already has the right value is not written. The directory is a
// positional argument, never part of the script text. Exit status is non-zero if a write fails.
function downloadSettingsArgs(booksDir) {
  var d = _str(booksDir)
  if (d === "" || d.charAt(0) !== "/") throw new Error("the books directory must be an absolute path")
  var script =
    'dir="$1"; rc=0\n' +
    'want() { [ "$(audible config get "$1" 2>/dev/null)" = "$2" ] || audible config set "$1" "$2" >/dev/null 2>&1 || rc=1; }\n' +
    'want settings.default.download_dir "$dir"\n' +
    'want settings.default.filename_mode "$2"\n' +
    'want settings.default.filename_template "$3"\n' +
    'exit $rc'
  return ["sh", "-c", script, "sh", d, DOWNLOAD_FILENAME_MODE, DOWNLOAD_FILENAME_TEMPLATE]
}

// Argv (without the program name) to download one book. force re-fetches even when the CLI's database
// says the book is already downloaded (used when that record points at files that are gone).
function downloadArgs(asin, quality, force) {
  var a = _str(asin)
  if (!/^[A-Za-z0-9]{10}$/.test(a)) throw new Error("not a valid ASIN")
  var q = quality === "normal" ? "normal" : "high"
  var out = ["download", "--asin", a, "--kind", "audio,chapter,cover", "--quality", q]
  if (force) out.push("--force")
  out.push("-o", "json")
  return out
}

// A name for a new account: the login name, cleaned to what the CLI accepts.
function accountNameFor(user) {
  var n = _str(user).replace(/[^A-Za-z0-9._@-]/g, "").slice(0, 64)
  return n === "" ? "audible" : n
}

// The guided sign-in that runs in a terminal window (the fallback when the browser page is blocked
// or does not work). It has a real terminal, so the CLI's own prompts work: the sign-in prints a
// normal amazon.com address and asks for the address you land on. Afterwards the login file is
// protected with a random keyring password so the popup never needs one. Positional args: $1 account
// name, $2 marketplace. Nothing secret is on a command line.
var TERMINAL_LOGIN_SCRIPT = [
  'export PATH="$HOME/.local/bin:$PATH"',
  'name="$1"; mp="$2"',
  'pause() { echo; printf "Press Enter to close "; read -r _; }',
  'echo "Sign in to Audible (account: $name)"; echo',
  'audible account login --external --plain -m "$mp" --name "$name" || { echo; echo "Sign-in did not finish. Close this and try again from the Audible popup."; pause; exit 1; }',
  'if ! command -v secret-tool >/dev/null 2>&1; then',
  '  echo; echo "Signed in. This machine has no keyring tool (libsecret), so the login file is not password protected."; pause; exit 0',
  'fi',
  'pw=$(head -c 24 /dev/urandom | base64 | tr -d "=+/\\n")',
  'if AUDIBLE_NEW_AUTH_PASSWORD="$pw" audible account password set -a "$name" \\',
  '   && printf %s "$pw" | secret-tool store --label="audible-rs $name" service audible-rs account "$name" \\',
  '   && audible account password source command -a "$name" --command "secret-tool lookup service audible-rs account $name"; then',
  '  echo; echo "Signed in. Your login is protected by your keyring; you will not be asked for a password."',
  'else',
  '  echo; echo "Signed in, but could not protect the login file. The Audible popup will ask you to unlock it."',
  'fi',
  'pause'
].join("\n")

function terminalLoginArgs(accountName, marketplace) {
  var n = _checkAccount(accountName)
  var mp = _str(marketplace)
  if (!/^[a-z]{2}$/.test(mp)) throw new Error("invalid marketplace")
  return ["sh", "-c", TERMINAL_LOGIN_SCRIPT, "sh", n, mp]
}

// The unlock for a saved login that is locked: runs in a terminal window, so the shell never holds a
// text input (one would read the clipboard whenever another app sets it). The password is read from
// the terminal with echo off and piped to secret-tool, so it is never on a command line, in a file or
// in the shell. Then the CLI is pointed at the keyring. recheckPoll notices the unlock. $1 account name.
var TERMINAL_UNLOCK_SCRIPT = [
  'export PATH="$HOME/.local/bin:$PATH"',
  'name="$1"',
  'pause() { echo; printf "Press Enter to close "; read -r _; }',
  'trap \'stty echo 2>/dev/null\' EXIT INT TERM',
  'echo "Unlock your saved Audible login (account: $name)"; echo',
  'echo "Type the password of your Audible login file. It is not shown, and it goes straight into your keyring."',
  'printf "Password: "; stty -echo 2>/dev/null; IFS= read -r pw; stty echo 2>/dev/null; echo',
  'if [ -z "$pw" ]; then echo; echo "Nothing typed, so nothing was saved."; pause; exit 1; fi',
  'if printf %s "$pw" | secret-tool store --label="audible-rs $name" service audible-rs account "$name" \\',
  '   && audible account password source command -a "$name" --command "secret-tool lookup service audible-rs account $name"; then',
  '  pw=; echo; echo "Saved. The Audible popup unlocks by itself in a few seconds. If it still asks, the password was wrong: try again."',
  'else',
  '  pw=; echo; echo "Could not save it to the keyring. Close this and try again from the Audible popup."',
  'fi',
  'pause'
].join("\n")

function terminalUnlockArgs(accountName) {
  var n = _checkAccount(accountName)
  return ["sh", "-c", TERMINAL_UNLOCK_SCRIPT, "sh", n]
}

function installPlan(tag, arch) {
  if (arch !== PINNED_ARCH) return { error: "Only " + PINNED_ARCH + " is supported right now." }
  var t = tag || PINNED_TAG
  if (t !== PINNED_TAG) return { error: "Only " + PINNED_TAG + " is pinned for this plugin." }
  var asset = "audible-" + t.replace(/^v/, "") + "-" + PINNED_ARCH + "-unknown-linux-musl.tar.gz"
  return {
    asset: asset,
    url: RELEASE_BASE + t + "/" + asset,
    sumsUrl: RELEASE_BASE + t + "/" + SUMS_NAME,
    binDir: "~/.local/bin"
  }
}

// sha256sum-format check: every line naming `asset` must carry sha256hex, and
// at least one must exist.
function verifySums(sumsText, asset, sha256hex) {
  if (typeof sumsText !== "string" || typeof asset !== "string" || typeof sha256hex !== "string") return false
  var want = sha256hex.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(want)) return false
  var found = false
  var lines = sumsText.split(/\r?\n/)
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (!m) continue
    if (m[2].trim().replace(/^\.\//, "") !== asset) continue
    found = true
    if (m[1].toLowerCase() !== want) return false
  }
  return found
}

function _action(id, label, probeBusy, input) {
  var a = { id: id, label: label }
  if (input) a.input = input
  if (probeBusy) {
    a.busy = true
    a.label = BUSY_LABELS[id] || label
  }
  return a
}

function _steps(state) {
  var cur = STATE_STEP[state]
  return STEPS.map(function (s, i) {
    var status = state === "ready" || i < cur ? "done" : (i === cur ? "current" : "todo")
    return { id: s.id, label: s.label, status: status }
  })
}

// A plain sentence when the installed audible CLI is not the pinned release, else null.
// installedVersionText is `audible --version` output ("audible 0.1.0-alpha.8"); pinnedTag is "v0.1.0-alpha.8".
var VERSION_RE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/

function versionNotice(installedVersionText, pinnedTag) {
  var installedText = _firstLine(installedVersionText)
  var pinned = _str(pinnedTag).trim().replace(/^v/, "")
  if (!installedText || !pinned) return null
  var m = installedText.match(VERSION_RE)
  var installed = m ? m[1] : "a version we could not read"
  if (m && installed === pinned) return null
  return "Built and tested with audible-rs " + pinned + "; you have " + installed + ", which may behave differently."
}

// Decides the single next step from a probe (see CONTRACT.md).
function detect(probe) {
  var p = probe || {}
  var accounts = _isObject(p.accounts) ? p.accounts : {}
  var lib = _isObject(p.library) ? p.library : {}
  var login = _isObject(p.login) ? p.login : {}
  var busy = _str(p.busy)
  var loginWaiting = !!login.waiting
  var secretFound = !!(p.secretTool && p.secretTool.found)
  var accountList = accounts.ok === true && Array.isArray(accounts.accounts) ? accounts.accounts : []
  var hasAccount = accountList.length > 0
  var locked = !!accounts.locked || !!lib.locked

  var state
  if (!(p.audible && p.audible.found)) state = "no-audible"
  else if (!(p.mpv && p.mpv.found)) state = "no-player"
  else if (locked) state = "locked"
  else if (!hasAccount) state = "no-account"
  else if (lib.ok !== true || lib.count === 0) state = "unsynced"
  else state = "ready"

  var out = {
    state: state,
    ready: state === "ready",
    title: "",
    message: "",
    primary: null,
    secondary: [],
    steps: _steps(state),
    // non-null when the installed audible CLI is not the pinned release (see versionNotice)
    notice: p.audible && p.audible.found ? versionNotice(p.audible.version, p.pinned) : null
  }

  if (state === "no-audible") {
    out.title = "Let's install the Audible CLI"
    out.message = busy === "install-audible"
      ? "Downloading the Audible CLI. It is checked against its published checksum before it is installed."
      : "This plugin talks to Audible through the audible command-line tool. It is one download from the project's GitHub release, checked against its checksum before it goes in ~/.local/bin."
    out.primary = _action("install-audible", "Install Audible CLI", !!busy)
  } else if (state === "no-player") {
    out.title = "One more piece: mpv"
    out.message = "mpv plays the audio, and it isn't installed yet. Run `omarchy pkg add mpv` in a terminal, then press r to check again."
  } else if (state === "no-account") {
    if (loginWaiting) {
      out.title = "Finish signing in in your browser"
      out.message = "Complete the sign-in in your browser, on the page that opened. We're waiting for it to finish; this can take a few minutes. If no page opened, use the link below. An error page at the end can still mean it worked: we confirm by checking your account. If Amazon says \"There was a problem\", it is blocking automated sign-ins for a while: wait about 30 minutes, or sign in with a terminal instead."
      out.secondary = [{ id: "cancel", label: "Cancel sign-in" }, { id: "login-terminal", label: "Sign in with a terminal instead" }]
    } else {
      out.title = "Sign in to Audible"
      out.message = "Connect your Audible account once. A sign-in page opens in your browser; finish there and come back. We confirm the sign-in by checking your account, so an odd message from the browser isn't a failure."
      out.primary = _action("login", "Sign in to Audible", !!busy)
      out.secondary = [{ id: "login-terminal", label: "Sign in with a terminal instead" }]
    }
  } else if (state === "locked") {
    if (secretFound) {
      out.title = "Unlock your saved login"
      out.message = "Your Audible login is saved, but it needs your Audible password once before it can sync. A terminal window asks for it and puts it straight into your system keyring; it is never written to a file or shown here. This page updates by itself once it is saved."
      out.primary = _action("store-password", "Unlock in a terminal", !!busy)
      out.secondary = [{ id: "sign-out", label: "Forgot it? Sign out and start over" }, { id: "remove-password", label: "Remove saved password" }]
    } else {
      out.title = "Unlock your saved login"
      out.message = "Your Audible login is saved, but it's locked and this machine has no keyring tool (secret-tool, from libsecret) to unlock it with. Install libsecret to save your password here, or remove the saved login and sign in again."
      out.primary = _action("remove-password", "Remove saved password", !!busy)
      out.secondary = [{ id: "sign-out", label: "Sign out and start over" }]
    }
  } else if (state === "unsynced") {
    out.title = "Sync your library"
    out.message = busy === "sync"
      ? "Downloading your library list. This can take a moment on a slow connection."
      : "You're signed in. Next, download your library list from Audible. It only takes a few seconds."
    if (lib.error && busy !== "sync") out.message += " Last try said: " + _str(lib.error) + "."
    out.primary = _action("sync", "Sync library", !!busy)
  } else {
    out.title = "You're all set"
    out.message = "Your library is ready. Pick a book to start listening."
  }

  return out
}

if (typeof module !== "undefined") module.exports = {
  detect: detect,
  parseAccountList: parseAccountList,
  parseLibraryProbe: parseLibraryProbe,
  parseLoginUrl: parseLoginUrl,
  passwordSourceArgs: passwordSourceArgs,
  keyringStoreArgs: keyringStoreArgs,
  signOutArgs: signOutArgs,
  deregisterArgs: deregisterArgs,
  DEREGISTER_TIMEOUT_SEC: DEREGISTER_TIMEOUT_SEC,
  downloadSettingsArgs: downloadSettingsArgs,
  downloadArgs: downloadArgs,
  DOWNLOAD_FILENAME_MODE: DOWNLOAD_FILENAME_MODE,
  DOWNLOAD_FILENAME_TEMPLATE: DOWNLOAD_FILENAME_TEMPLATE,
  accountNameFor: accountNameFor,
  terminalLoginArgs: terminalLoginArgs,
  terminalUnlockArgs: terminalUnlockArgs,
  installPlan: installPlan,
  verifySums: verifySums,
  versionNotice: versionNotice,
  PINNED_TAG: PINNED_TAG,
  STEPS: STEPS
}
