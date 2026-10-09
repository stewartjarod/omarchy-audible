import QtQuick
import Quickshell
import Quickshell.Io
import "SetupModel.js" as Setup
import "LibraryModel.js" as Lib
import "PlayerModel.js" as Player

// jarod.audible service: the single owner of playback (mpv over IPC), the
// Audible CLI, local state and the library overlay. Bar widgets are instantiated
// once per monitor, so everything stateful lives here and the widgets stay thin.
Item {
  id: root

  // ---- settings (pushed in by the bar widget from shell.json) -------------
  property var settings: ({})
  function applySettings(s) { settings = s || ({}) }
  function num(name, fallback) {
    var v = Number(settings ? settings[name] : undefined)
    return isFinite(v) && v > 0 ? v : fallback
  }
  readonly property real speedStep: num("speedStep", 0.1)
  readonly property real speedMin: num("speedMin", 0.5)
  readonly property real speedMax: Math.max(speedMin, num("speedMax", 3.5))
  readonly property int skipSeconds: Math.round(num("skipSeconds", 30))
  readonly property int volumeStep: Math.round(num("volumeStep", 5))
  readonly property int volumeMax: 130   // mpv's default ceiling (100 = unchanged)

  // ---- paths --------------------------------------------------------------
  readonly property string home: Quickshell.env("HOME")
  readonly property string booksDir: home + "/.local/share/audible/books"
  readonly property string stateDir: home + "/.local/state/jarod-audible"
  readonly property string mpvSock: (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/omarchy-audible-mpv.sock"
  readonly property string pinnedTag: "v0.1.0-alpha.8"

  // ---- setup / onboarding -------------------------------------------------
  property var setup: ({ ready: false, state: "checking", title: "Checking your setup...", message: "", primary: null, secondary: [], steps: [] })
  readonly property bool ready: setup && setup.ready === true
  property string setupBusyId: ""
  readonly property bool setupBusy: setupBusyId !== ""
  property string setupLog: ""
  property string loginUrl: ""
  property bool loginWaiting: false
  property var lastProbe: null
  property var loginProc: null

  // ---- player -------------------------------------------------------------
  property bool linked: false
  readonly property bool connected: linked
  property bool idle: true
  property bool paused: false
  property bool loading: false
  property string path: ""
  property string mediaTitle: ""
  property real position: 0
  property real duration: 0
  property real speed: 1.0
  property real volume: 100   // mpv's per-app volume (not the system volume)
  property bool muted: false
  property var rawChapters: []
  property string asin: ""

  readonly property bool hasBook: path !== "" && !idle
  readonly property bool playing: hasBook && !paused
  readonly property var chapters: Player.normalizeChapters(rawChapters, duration)
  readonly property int chapterIndex: Player.chapterIndexAt(chapters, position)
  readonly property real timeLeftSec: Player.timeLeft(duration, position, speed)
  readonly property real chapterTimeLeftSec: {
    var c = chapters && chapters[chapterIndex]
    return c ? Player.timeLeft(c.end, position, speed) : 0
  }
  readonly property var currentBook: bookFor(asin)
  readonly property string title: currentBook ? currentBook.title : mediaTitle
  readonly property string subtitle: currentBook ? (currentBook.subtitle || "") : ""
  readonly property string author: currentBook ? (currentBook.author || "") : ""
  readonly property string coverUrl: {
    if (asin === "") return ""
    if (localAsins[asin]) return "file://" + booksDir + "/" + asin + "/" + asin + ".cover_500.jpg"
    return currentBook ? (currentBook.coverUrl || "") : ""
  }

  // ---- library ------------------------------------------------------------
  property var rawBooks: []
  property var books: []
  property bool libraryLoading: false
  property string libraryError: ""
  property var localAsins: ({})
  property var localFiles: ({})
  property var downloads: ({})
  property var resume: ({})
  property string viewMode: "grid"
  property string sortMode: "recent"
  property bool libraryOpen: false
  property bool libraryEverOpened: false
  property string pendingPlay: ""
  property var downloadQueue: []
  property string activeDownload: ""

  signal popupRequested()

  // ======================================================================
  // helpers
  // ======================================================================
  Component { id: cmdComponent; Cmd {} }
  Component { id: cmdLinesComponent; CmdLines {} }

  // run(argv, done(exitCode, stdout, stderr), {line, input}) -> Process
  // PATH always includes ~/.local/bin (the shell's own PATH may not).
  function run(argv, done, opts) {
    var o = opts || {}
    var wrapped = ["sh", "-c", "export PATH=\"$HOME/.local/bin:$PATH\"; exec \"$@\"", "sh"].concat(argv)
    // collector-based by default; the line-streaming runner only when a line callback is given
    var p = o.line
      ? cmdLinesComponent.createObject(root, { command: wrapped, done: done || null, line: o.line, input: o.input || "" })
      : cmdComponent.createObject(root, { command: wrapped, done: done || null, input: o.input || "" })
    if (!p) return null
    p.running = true
    return p
  }

  function bookFor(a) {
    if (!a) return null
    for (var i = 0; i < books.length; i++) if (books[i].asin === a) return books[i]
    return null
  }

  function asinFromPath(p) {
    var m = /\/([A-Z0-9]{10})\/[A-Z0-9]{10}\.[^/]*$/.exec(String(p || ""))
    return m ? m[1] : ""
  }

  function isLocal(a) {
    return localAsins[a] === true && !(downloads[a] && downloads[a].state === "downloading")
  }

  function withKey(obj, key, value) {
    var n = {}
    for (var k in obj) n[k] = obj[k]
    n[key] = value
    return n
  }

  // ======================================================================
  // state file
  // ======================================================================
  property bool stateLoaded: false

  FileView {
    id: stateFile
    path: root.stateDir + "/state.json"
    onLoaded: root.loadState(String(stateFile.text()))
    onLoadFailed: root.stateLoaded = true
  }

  function loadState(text) {
    try {
      var s = JSON.parse(text)
      if (s.viewMode === "grid" || s.viewMode === "list") viewMode = s.viewMode
      if (s.sort === "recent" || s.sort === "added") sortMode = s.sort
      if (Number(s.volume) >= 0) volume = Player.clampVolume(Number(s.volume), 0, volumeMax)
      if (Number(s.speed) > 0) speed = Player.clampSpeed(Number(s.speed), speedMin, speedMax)
      if (s.resume && typeof s.resume === "object") resume = s.resume
      if (s.last && typeof s.last === "string") lastAsin = s.last
    } catch (e) { }
    stateLoaded = true
    rebuildBooks()
  }

  property string lastAsin: ""
  // The book to offer when nothing is loaded ("pick up where you left off").
  readonly property var lastBook: lastAsin !== "" ? bookFor(lastAsin) : null
  function continueLast() { if (lastAsin !== "") play(lastAsin) }

  function saveSoon() { saveTimer.restart() }
  Timer {
    id: saveTimer
    interval: 1500
    onTriggered: {
      var body = JSON.stringify({ version: 1, viewMode: root.viewMode, sort: root.sortMode, volume: root.volume, speed: root.speed, resume: root.resume, last: root.lastAsin })
      root.run(["mkdir", "-p", root.stateDir], function() { stateFile.setText(body) })
    }
  }

  function rememberPosition() {
    if (asin === "" || duration <= 0) return
    var r = {}
    for (var k in resume) r[k] = resume[k]
    r[asin] = { position: position, updatedAt: Date.now() }
    resume = r
    lastAsin = asin
    saveSoon()
    // The open library reads progress live; rebuilding its rows here would jump the scroll.
    if (!libraryOpen) rebuildBooks()
  }

  function setSortMode(m) {
    if (m !== "recent" && m !== "added") return
    sortMode = m
    saveSoon()
  }

  function setViewMode(m) {
    if (m !== "grid" && m !== "list") return
    viewMode = m
    saveSoon()
  }

  // ======================================================================
  // mpv over IPC
  // ======================================================================
  // A Quickshell Socket never retries after a failed connect, and `connected` does not signal a
  // successful one. So: build a brand-new Socket until mpv answers (the first line it sends
  // marks us linked), then register the property observers.
  Component {
    id: mpvSocketComponent
    Socket {
      path: root.mpvSock
      connected: true
      parser: SplitParser {
        splitMarker: "\n"
        onRead: function(line) { root.onMpvLine(String(line)) }
      }
      onConnectedChanged: if (!connected) root.onMpvGone()
    }
  }
  Loader { id: mpvLink; sourceComponent: mpvSocketComponent; active: true }

  Timer {
    interval: 2000
    repeat: true
    running: true
    onTriggered: {
      if (root.linked) return
      mpvLink.active = false
      mpvLink.active = true
      observeTimer.restart()
    }
  }
  Timer { id: observeTimer; interval: 400; onTriggered: root.onMpvConnected() }

  function mpvSend(command, requestId) {
    var sock = mpvLink.item
    if (!sock) return false
    var o = { command: command }
    if (requestId) o.request_id = requestId
    sock.write(JSON.stringify(o) + "\n")
    sock.flush()
    return true
  }

  function onMpvConnected() {
    var props = ["pause", "speed", "chapter-list", "duration", "path", "idle-active", "media-title", "volume", "mute"]
    for (var i = 0; i < props.length; i++) mpvSend(["observe_property", i + 1, props[i]])
  }

  function onMpvGone() {
    linked = false
    idle = true
    path = ""
    asin = ""
    paused = false
    loading = false
  }

  function onMpvLine(line) {
    var m
    try { m = JSON.parse(line) } catch (e) { return }
    if (!linked) linked = true
    if (m.request_id === 100) {
      if (typeof m.data === "number") position = m.data
      return
    }
    if (m.event === "property-change") {
      switch (m.name) {
      case "pause": paused = m.data === true; if (paused) rememberPosition(); break
      case "speed": if (typeof m.data === "number") { speed = m.data; saveSoon() } break
      case "chapter-list": rawChapters = Array.isArray(m.data) ? m.data : []; break
      case "duration": duration = typeof m.data === "number" ? m.data : 0; break
      case "path": path = m.data ? String(m.data) : ""; asin = asinFromPath(path); break
      case "idle-active": idle = m.data === true; break
      case "media-title": mediaTitle = m.data ? String(m.data) : ""; break
      case "volume": if (typeof m.data === "number") { volume = m.data; saveSoon() } break
      case "mute": muted = m.data === true; break
      }
    } else if (m.event === "file-loaded") {
      loading = false
    } else if (m.event === "end-file" && m.reason === "eof") {
      rememberPosition()
    }
  }

  // time-pos changes constantly; poll it instead of observing
  Timer {
    id: posTimer
    property int ticks: 0
    interval: 1000
    repeat: true
    running: root.connected && root.hasBook
    onTriggered: {
      root.mpvSend(["get_property", "time-pos"], 100)
      if (root.playing && ++ticks % 15 === 0) root.rememberPosition()
    }
  }

  // ---- player commands ----------------------------------------------------
  function pause() { mpvSend(["set_property", "pause", true]) }
  function resumePlayback() { mpvSend(["set_property", "pause", false]) }
  function togglePause() {
    if (hasBook) mpvSend(["cycle", "pause"])
    else if (lastAsin !== "") play(lastAsin)
    else openLibrary()
  }
  function seekBy(sec) { mpvSend(["seek", sec, "relative"]) }
  function seekTo(sec) { mpvSend(["seek", Math.max(0, Math.min(sec, duration)), "absolute"]) }
  function jumpToChapter(i) {
    if (i >= 0 && i < chapters.length) mpvSend(["set_property", "chapter", i])
  }
  function nextChapter() { jumpToChapter(Math.min(chapterIndex + 1, chapters.length - 1)) }
  function prevChapter() {
    // like most players: first press restarts the chapter, a second one goes back
    var c = chapters[chapterIndex]
    if (c && position - c.start > 3) jumpToChapter(chapterIndex)
    else jumpToChapter(Math.max(chapterIndex - 1, 0))
  }
  function setSpeed(x) {
    var s = Player.clampSpeed(Number(x), speedMin, speedMax)
    speed = s
    mpvSend(["set_property", "speed", s])
    saveSoon()
  }
  function stepSpeed(dir) {
    setSpeed(Player.stepSpeed(speed, dir, { step: speedStep, min: speedMin, max: speedMax }))
  }
  function setVolume(v) {
    var x = Player.clampVolume(Number(v), 0, volumeMax)
    volume = x
    mpvSend(["set_property", "volume", x])
    if (x > 0 && muted) mpvSend(["set_property", "mute", false])
    saveSoon()
  }
  function stepVolume(dir) {
    setVolume(Player.stepVolume(volume, dir, { step: volumeStep, min: 0, max: volumeMax }))
  }
  function toggleMute() { mpvSend(["cycle", "mute"]) }

  function stop() {
    rememberPosition()
    mpvSend(["stop"])
  }

  // Where to start a book: our own saved position, else Audible's percent. A finished book, or one
  // saved within the last minute, starts over instead of dropping you at the credits.
  function resumePosition(a) {
    var r = resume[a]
    var b = bookFor(a)
    var total = b && b.runtimeSec > 0 ? b.runtimeSec : 0
    var p = 0
    if (r && typeof r.position === "number") p = r.position
    else if (b && !b.finished && b.percentComplete > 0 && b.runtimeSec > 0) p = b.runtimeSec * b.percentComplete / 100
    if (p <= 0 || (total > 0 && p > total - 60)) return 0
    return p
  }

  function startPlayback(a) {
    var file = localFiles[a]
    if (!file) return
    if (hasBook && asin !== a) rememberPosition()
    if (hasBook && asin === a) { resumePlayback(); return }
    loading = true
    var start = Math.max(0, Math.floor(resumePosition(a) - 5))   // back up a few seconds
    run(["audible-play", file, "--start", String(start), "--speed", String(speed), "--volume", String(Math.round(volume))], function(code, out, err) {
      if (code !== 0) {
        loading = false
        setupLog = "Could not start playback: " + String(err || out).split("\n")[0]
      }
    })
    lastAsin = a
    saveSoon()
  }

  function play(a) {
    var b = bookFor(a)
    if (b && b.listenable === false) {
      setupLog = "This title is not available to play with your current plan."
      return
    }
    if (isLocal(a)) { startPlayback(a); return }
    pendingPlay = a
    download(a)
  }

  // ======================================================================
  // library: API list, local scan, downloads
  // ======================================================================
  function rebuildBooks() {
    try {
      books = Lib.merge(rawBooks, { localAsins: localAsins, downloads: downloads, resume: resume })
    } catch (e) { books = rawBooks }
  }

  property int libraryRetries: 0
  Timer { id: libraryRetry; interval: 5000; onTriggered: root.refreshLibrary() }

  function refreshLibrary() {
    if (libraryLoading) return
    libraryLoading = true
    libraryError = ""
    run(["audible", "api", "GET", "/1.0/library",
         "--query", "num_results=1000",
         "--query", "response_groups=contributors,product_desc,product_attrs,media,listening_status,series",
         "--query", "sort_by=-PurchaseDate", "-o", "json"],
      function(code, out, err) {
        libraryLoading = false
        if (code !== 0) {
          libraryError = String(err || out).split("\n")[0] || "Could not load your library"
          if (libraryRetries++ < 3) libraryRetry.restart()
          return
        }
        var res = Lib.parseApiPage(out)
        if (res.error) {
          libraryError = String(res.error)
          if (libraryRetries++ < 3) libraryRetry.restart()
          return
        }
        libraryRetries = 0
        rawBooks = res.books
        rebuildBooks()
      })
  }

  function scanLocal(then) {
    run(["sh", "-c", "find \"$1\" -maxdepth 2 -name '*.aaxc' 2>/dev/null; true", "sh", booksDir], function(code, out) {
      var asins = {}, files = {}
      var lines = String(out).split("\n")
      for (var i = 0; i < lines.length; i++) {
        var a = asinFromPath(lines[i])
        if (a) { asins[a] = true; files[a] = lines[i] }
      }
      localAsins = asins
      localFiles = files
      rebuildBooks()
      if (typeof then === "function") then()
    })
  }

  function download(a) {
    if (downloads[a] && (downloads[a].state === "queued" || downloads[a].state === "downloading")) return
    downloads = withKey(downloads, a, { state: "queued", fraction: 0, error: "" })
    downloadQueue = downloadQueue.concat([a])
    rebuildBooks()
    pumpDownloads()
  }

  function cancelDownload(a) {
    downloadQueue = downloadQueue.filter(function(x) { return x !== a })
    var d = {}
    for (var k in downloads) if (k !== a) d[k] = downloads[k]
    downloads = d
    if (pendingPlay === a) pendingPlay = ""
    rebuildBooks()
  }

  function pumpDownloads() {
    if (activeDownload !== "" || downloadQueue.length === 0) return
    var a = downloadQueue[0]
    downloadQueue = downloadQueue.slice(1)
    activeDownload = a
    downloads = withKey(downloads, a, { state: "downloading", fraction: 0, error: "" })
    rebuildBooks()
    run(["audible", "download", "--asin", a, "--kind", "audio,chapter,cover", "-o", "json"], function(code, out, err) {
      activeDownload = ""
      if (code === 0) {
        downloads = withKey(downloads, a, { state: "done", fraction: 1, error: "" })
        scanLocal(function() {
          if (pendingPlay === a) { pendingPlay = ""; startPlayback(a) }
          pumpDownloads()
        })
      } else {
        var msg = String(err || out).split("\n")[0] || "Download failed"
        downloads = withKey(downloads, a, { state: "failed", fraction: 0, error: msg })
        if (pendingPlay === a) pendingPlay = ""
        setupLog = msg
        rebuildBooks()
        pumpDownloads()
      }
    })
  }

  // The CLI prints nothing while downloading when not on a TTY, so progress is the
  // growing file size against runtime * 128 kbps (the "high" quality default).
  Timer {
    interval: 1500
    repeat: true
    running: root.activeDownload !== ""
    onTriggered: {
      var a = root.activeDownload
      if (a === "") return
      root.run(["sh", "-c", "stat -c %s \"$1\"/\"$2\"/\"$2\".*.aaxc 2>/dev/null | head -1; true", "sh", root.booksDir, a], function(code, out) {
        var size = Number(String(out).trim())
        var b = root.bookFor(a)
        var expected = b && b.runtimeSec > 0 ? b.runtimeSec * 16000 : 0
        if (!(size > 0) || !(expected > 0) || root.activeDownload !== a) return
        root.downloads = root.withKey(root.downloads, a, { state: "downloading", fraction: Math.min(0.99, size / expected), error: "" })
        if (!root.libraryOpen) root.rebuildBooks()   // the open library reads downloads live
      })
    }
  }

  // ---- library overlay ----------------------------------------------------
  function openLibrary() {
    libraryEverOpened = true
    rebuildBooks()   // catch up on anything skipped while it was closed
    libraryOpen = true
    if (ready) { if (rawBooks.length === 0) refreshLibrary(); scanLocal() }
  }
  function closeLibrary() { libraryOpen = false }
  function toggleLibrary() { libraryOpen ? closeLibrary() : openLibrary() }

  Loader {
    id: libraryLoader
    active: root.libraryEverOpened
    source: Qt.resolvedUrl("Library.qml")
    onLoaded: { if (item && "service" in item) item.service = root }
  }

  // ======================================================================
  // setup probe and actions
  // ======================================================================
  function emptyProbe() {
    return {
      audible: { found: false, version: "" }, mpv: { found: false }, helper: { found: false }, secretTool: { found: false },
      accounts: Setup.parseAccountList("", ""), library: Setup.parseLibraryProbe("", "", 127),
      busy: "", login: { url: "", waiting: false }
    }
  }

  function rerenderSetup() {
    if (!lastProbe) return
    var p = {}
    for (var k in lastProbe) p[k] = lastProbe[k]
    p.busy = setupBusyId
    p.login = { url: loginUrl, waiting: loginWaiting }
    var wasReady = ready
    setup = Setup.detect(p)
    if (ready && !wasReady) { refreshLibrary(); scanLocal() }
  }

  function recheck() {
    var probe = emptyProbe()
    run(["sh", "-c", "for c in audible mpv audible-play secret-tool; do command -v \"$c\" >/dev/null 2>&1 && echo \"$c\"; done; true"], function(code, out) {
      var have = {}
      String(out).split("\n").forEach(function(l) { if (l) have[l.trim()] = true })
      probe.audible.found = have["audible"] === true
      probe.mpv.found = have["mpv"] === true
      probe.helper.found = have["audible-play"] === true
      probe.secretTool.found = have["secret-tool"] === true
      if (!probe.audible.found) { lastProbe = probe; rerenderSetup(); return }
      var pending = 3
      var finish = function() { if (--pending === 0) { lastProbe = probe; rerenderSetup() } }
      run(["audible", "--version"], function(c, o) { probe.audible.version = String(o).trim(); finish() })
      run(["audible", "account", "list", "-o", "json"], function(c, o, e) { probe.accounts = Setup.parseAccountList(o, e); finish() })
      run(["audible", "library", "list", "-o", "json", "--limit", "1"], function(c, o, e) { probe.library = Setup.parseLibraryProbe(o, e, c); finish() })
    })
  }

  function busyWith(id, logLine) {
    setupBusyId = id
    setupLog = logLine || ""
    rerenderSetup()
  }
  function doneBusy(logLine) {
    setupBusyId = ""
    setupLog = logLine || ""
    recheck()
  }

  function argvFor(args, bin) {
    var a = (args || []).slice()
    return a.length > 0 && a[0] === bin ? a : [bin].concat(a)
  }

  function marketplaceGuess() {
    var lang = String(Quickshell.env("LANG") || "")
    var m = /_([A-Z]{2})/.exec(lang)
    var map = { US: "us", GB: "uk", CA: "ca", AU: "au", DE: "de", FR: "fr", ES: "es", IT: "it", JP: "jp", IN: "in", BR: "br" }
    return m && map[m[1]] ? map[m[1]] : "us"
  }

  property bool previewing: false

  // Show an onboarding state without touching anything (for screenshots/demos). Any action
  // while previewing just restores the real state, so a stray Enter cannot install or log in.
  function previewSetup(name) {
    if (!lastProbe) return
    var p = {}
    for (var k in lastProbe) p[k] = lastProbe[k]
    var none = '{"error":null,"result":[],"warnings":[]}'
    var locked = '{"error":{"message":"account \\"jarod\\" is locked (password_source = prompt) \u2014 unlock it with `audible account unlock -a jarod`"},"result":null,"warnings":[]}'
    p.busy = ""
    p.login = { url: "", waiting: false }
    var log = ""
    if (name === "no-audible") { p.audible = { found: false, version: "" }; p.accounts = Setup.parseAccountList("", ""); p.library = Setup.parseLibraryProbe("", "", 127) }
    else if (name === "no-player") p.mpv = { found: false }
    else if (name === "no-helper") p.helper = { found: false }
    else if (name === "no-account" || name === "login") {
      p.accounts = Setup.parseAccountList(none, ""); p.library = Setup.parseLibraryProbe("", "", 1)
      if (name === "login") { p.login = { url: "http://127.0.0.1:39457/0123456789abcdef/", waiting: true }; log = "Sign in to Amazon in the browser window that just opened." }
    }
    else if (name === "locked") p.library = Setup.parseLibraryProbe(locked, "", 1)
    else if (name === "unsynced" || name === "syncing") {
      p.library = Setup.parseLibraryProbe(none, "", 0)
      if (name === "syncing") { p.busy = "sync"; log = "Syncing your library... 120 of 237" }
    }
    else { previewing = false; recheck(); return }
    previewing = true
    setupLog = log
    setup = Setup.detect(p)
  }

  function runSetupAction(id, payload) {
    if (previewing) { previewing = false; setupLog = ""; recheck(); return }
    switch (id) {
    case "recheck": setupLog = ""; recheck(); break
    case "install-audible": installAudible(); break
    case "login": startLogin(); break
    case "cancel": cancelLogin(); break
    case "store-password": storePassword(payload ? String(payload.password || "") : ""); break
    case "remove-password":
      Quickshell.execDetached(["xdg-terminal-exec", "sh", "-c",
        "export PATH=\"$HOME/.local/bin:$PATH\"; audible account password remove; echo; read -r -p 'Press Enter to close' _"])
      setupLog = "Finish in the terminal that just opened, then press r to re-check."
      break
    case "sync": syncLibrary(); break
    }
  }

  function installAudible() {
    var plan = Setup.installPlan(pinnedTag, "x86_64")
    if (!plan || plan.error) { setupLog = String((plan && plan.error) || "No download available for this machine"); return }
    busyWith("install-audible", "Downloading the Audible CLI and checking its checksum...")
    var script = "set -e; d=$(mktemp -d); trap 'rm -rf \"$d\"' EXIT; cd \"$d\"; " +
      "curl -fsSL -o \"$1\" \"$2\"; curl -fsSL -o SHA256SUMS \"$3\"; " +
      "sha256sum -c SHA256SUMS --ignore-missing >/dev/null; tar -xzf \"$1\"; " +
      "install -Dm755 ./*/audible \"$HOME/.local/bin/audible\""
    run(["sh", "-c", script, "sh", plan.asset, plan.url, plan.sumsUrl], function(code, out, err) {
      doneBusy(code === 0 ? "Installed. Checking everything again..." : "The download did not verify: " + String(err).split("\n")[0])
    })
  }

  function startLogin() {
    if (loginWaiting) return
    loginWaiting = true
    loginUrl = ""
    var opened = false
    busyWith("", "Starting the sign-in page...")
    loginProc = run(["audible", "account", "login", "server", "-m", marketplaceGuess(), "--timeout", "900"],
      function(code, out, err) {
        // the exit code is not a reliable success signal; recheck decides
        loginWaiting = false
        loginProc = null
        loginUrl = ""
        setupLog = ""
        recheck()
      },
      { line: function(l) {
          var u = Setup.parseLoginUrl(l)
          if (u && !opened) {
            opened = true
            loginUrl = u
            Quickshell.execDetached(["xdg-open", u])
            setupLog = "Sign in to Amazon in the browser window that just opened."
            rerenderSetup()
          }
        } })
    rerenderSetup()
    loginPoll.restart()
  }

  function cancelLogin() {
    if (loginProc) loginProc.signal(15)
    loginWaiting = false
    loginUrl = ""
    setupLog = ""
    recheck()
  }

  // while the sign-in page is open, notice a finished login by the account appearing
  Timer {
    id: loginPoll
    interval: 3000
    repeat: true
    running: root.loginWaiting
    onTriggered: root.run(["audible", "account", "list", "-o", "json"], function(c, o, e) {
      var acc = Setup.parseAccountList(o, e)
      if (acc.ok && acc.accounts.length > 0 && root.loginWaiting) {
        if (root.loginProc) root.loginProc.signal(15)
        root.loginWaiting = false
        root.loginUrl = ""
        root.setupLog = "Signed in."
        root.recheck()
      }
    })
  }

  function accountName() {
    var a = lastProbe && lastProbe.accounts && lastProbe.accounts.accounts
    if (!a || a.length === 0) return ""
    for (var i = 0; i < a.length; i++) if (a[i].isDefault) return a[i].name
    return a[0].name
  }

  function storePassword(password) {
    var name = accountName()
    if (name === "" || password === "") { setupLog = "Type your Audible file password first."; return }
    busyWith("store-password", "Saving it to your keyring...")
    // password goes to secret-tool on stdin only, never in argv or logs
    run(argvFor(Setup.keyringStoreArgs(name), "secret-tool"), function(code, out, err) {
      if (code !== 0) { doneBusy("The keyring would not take it: " + String(err).split("\n")[0]); return }
      run(argvFor(Setup.passwordSourceArgs(name), "audible"), function(c2, o2, e2) {
        doneBusy(c2 === 0 ? "Saved. Your login unlocks automatically now." : "Saved to the keyring, but could not point Audible at it: " + String(e2).split("\n")[0])
      })
    }, { input: password })
  }

  function syncLibrary() {
    busyWith("sync", "Syncing your library...")
    run(["audible", "library", "sync"], function(code, out, err) {
      doneBusy(code === 0 ? "Library synced." : "Sync failed: " + String(err || out).split("\n")[0])
    }, { line: function(l) { if (l.trim() !== "") setupLog = l.trim().slice(0, 90) } })
  }

  // ======================================================================
  // IPC: the only IPC target for this plugin (bar widgets exist once per monitor)
  // ======================================================================
  IpcHandler {
    target: "jarod.audible"

    function status(): string {
      return JSON.stringify({
        state: root.setup ? root.setup.state : "checking",
        ready: root.ready,
        hasBook: root.hasBook, playing: root.playing, paused: root.paused, volume: root.volume, muted: root.muted,
        asin: root.asin, title: root.title,
        position: root.position, duration: root.duration, speed: root.speed,
        chapterIndex: root.chapterIndex, chapters: root.chapters.length,
        timeLeftSec: root.timeLeftSec,
        books: root.books.length, local: Object.keys(root.localAsins).length,
        libraryOpen: root.libraryOpen, view: root.viewMode,
        busy: root.setupBusyId, log: root.setupLog,
        libraryLoading: root.libraryLoading, libraryError: root.libraryError
      })
    }
    function toggleLibrary(): void { root.toggleLibrary() }
    function openLibrary(): void { root.openLibrary() }
    function closeLibrary(): void { root.closeLibrary() }
    function popup(): void { root.popupRequested() }
    function play(asin: string): void { root.play(asin) }
    function toggle(): void { root.togglePause() }
    function pause(): void { root.pause() }
    function setSpeed(x: real): void { root.setSpeed(x) }
    function stepSpeed(dir: int): void { root.stepSpeed(dir) }
    function setVolume(v: real): void { root.setVolume(v) }
    function stepVolume(dir: int): void { root.stepVolume(dir) }
    function toggleMute(): void { root.toggleMute() }
    function seekBy(sec: real): void { root.seekBy(sec) }
    function next(): void { root.nextChapter() }
    function prev(): void { root.prevChapter() }
    function refresh(): void { root.refreshLibrary(); root.scanLocal() }
    function recheck(): void { root.previewing = false; root.recheck() }
    function previewSetup(name: string): void { root.previewSetup(name) }
  }

  Component.onCompleted: {
    stateFile.reload()
    recheck()
  }
}
