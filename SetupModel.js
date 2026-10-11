.pragma library

// Pure setup logic for jarod.audible: decides what the user needs to do next,
// parses the audible CLI's output, and plans the CLI install. No QML, no I/O.

var PINNED_TAG = "v0.1.0-alpha.8"
var PINNED_ARCH = "x86_64"
var RELEASE_BASE = "https://github.com/mkb79/audible-rs/releases/download/"
var SUMS_NAME = "SHA256SUMS" // assumed release checksum file name; verify against the release page

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
    steps: _steps(state)
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
      out.message = "Complete the sign-in in your browser, on the page that opened. We're waiting for it to finish; this can take a few minutes. If no page opened, use the link below. An error page at the end can still mean it worked: we confirm by checking your account."
      out.secondary = [{ id: "cancel", label: "Cancel sign-in" }]
    } else {
      out.title = "Sign in to Audible"
      out.message = "Connect your Audible account once. A sign-in page opens in your browser; finish there and come back. We confirm the sign-in by checking your account, so an odd message from the browser isn't a failure."
      out.primary = _action("login", "Sign in to Audible", !!busy)
    }
  } else if (state === "locked") {
    if (secretFound) {
      out.title = "Unlock your saved login"
      out.message = "Your Audible login is saved, but it needs your Audible password once before it can sync. Type it below; it goes straight into your system keyring and is never written to a file or shown here."
      out.primary = _action("store-password", "Save password", !!busy, "password")
      out.secondary = [{ id: "remove-password", label: "Remove saved password" }]
    } else {
      out.title = "Unlock your saved login"
      out.message = "Your Audible login is saved, but it's locked and this machine has no keyring tool (secret-tool, from libsecret) to unlock it with. Install libsecret to save your password here, or remove the saved login and sign in again."
      out.primary = _action("remove-password", "Remove saved password", !!busy)
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
  installPlan: installPlan,
  verifySums: verifySums,
  PINNED_TAG: PINNED_TAG,
  STEPS: STEPS
}
