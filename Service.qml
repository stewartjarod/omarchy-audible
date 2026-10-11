import QtQuick
import Quickshell
import Quickshell.Io
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
  // "normal" is roughly half the download size of "high" (about 64 vs 128 kbps): a faster first listen.
  readonly property string downloadQuality: (settings && settings.downloadQuality === "normal") ? "normal" : "high"
  readonly property real trackpadGain: num("libraryTrackpadSpeed", 2.5)   // library grid: trackpad scroll multiplier
  readonly property real scrollRows: num("libraryScrollRows", 0.5)   // library grid: rows scrolled per wheel notch
  readonly property int volumeStep: Math.round(num("volumeStep", 5))
  readonly property int volumeMax: 130   // mpv's default ceiling (100 = unchanged)

  // ---- paths --------------------------------------------------------------
  readonly property string home: Quickshell.env("HOME")
  readonly property string booksDir: home + "/.local/share/audible/books"
  readonly property string stateDir: home + "/.local/state/jarod-audible"
  readonly property string mpvSock: (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/omarchy-audible-mpv.sock"
  readonly property string pinnedTag: "v0.1.0-alpha.8"

  // ---- player -------------------------------------------------------------
  property bool linked: false
  property bool savePositionOnReply: false
  property bool eofSeen: false
  readonly property bool connected: linked
  property bool idle: true
  property bool paused: false
  property bool loading: false
  property string startingAsin: ""
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

  // What a "play" is waiting on, so the bar and popup can show progress instead of silence.
  readonly property string pendingAsin: pendingPlay !== "" ? pendingPlay : (loading ? startingAsin : "")
  readonly property string pendingStatus: {
    if (pendingAsin === "") return ""
    var b = bookFor(pendingAsin)
    var name = b && b.title ? b.title : "your book"
    var d = downloads[pendingAsin]
    if (pendingPlay !== "") {
      if (d && d.state === "downloading") return "Downloading " + name + " \u00B7 " + Math.round((d.fraction || 0) * 100) + "%"
      if (d && d.state === "queued") return "Waiting to download " + name
      return "Preparing " + name
    }
    return "Starting " + name
  }
  // 0..1 while downloading, else -1 (indeterminate)
  readonly property real pendingFraction: {
    var d = pendingAsin !== "" ? downloads[pendingAsin] : null
    return pendingPlay !== "" && d && d.state === "downloading" ? Math.max(0, Math.min(1, d.fraction || 0)) : -1
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
  property bool groupSeries: true            // library: collapse series (2+ books) into one tile
  property bool continueExpanded: false      // library: "Continue listening" shows one row until expanded
  property string filterMode: "all"     // library view: all | downloaded | cloud
  property var plays: ({})                 // { asin: { count, lastAt } } full listens, kept locally
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

  // run(argv, done(exitCode, stdout, stderr), {line, input, env}) -> Process (env only with line)
  // PATH always includes ~/.local/bin (the shell's own PATH may not).
  function run(argv, done, opts) {
    var o = opts || {}
    var wrapped = ["sh", "-c", "export PATH=\"$HOME/.local/bin:$PATH\"; exec \"$@\"", "sh"].concat(argv)
    // collector-based by default; the line-streaming runner only when a line callback is given
    var p = o.line
      ? cmdLinesComponent.createObject(root, { command: wrapped, done: done || null, line: o.line, input: o.input || "", extraEnv: o.env || null })
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
      if (s.filter === "all" || s.filter === "downloaded" || s.filter === "cloud") filterMode = s.filter
      if (s.plays && typeof s.plays === "object") plays = s.plays
      if (s.group === false) groupSeries = false
      if (s.expandContinue === true) continueExpanded = true
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
      var body = JSON.stringify({ version: 1, viewMode: root.viewMode, sort: root.sortMode, filter: root.filterMode, group: root.groupSeries, expandContinue: root.continueExpanded, plays: root.plays, volume: root.volume, speed: root.speed, resume: root.resume, last: root.lastAsin })
      root.run(["mkdir", "-p", root.stateDir], function() { stateFile.setText(body) })
    }
  }

  function rememberPosition() {
    if (asin === "" || duration <= 0) return
    // At the very end the book is finished; saving that spot would drop you into the credits next time.
    if (position >= duration - 30) return
    var r = {}
    for (var k in resume) r[k] = resume[k]
    r[asin] = { position: position, updatedAt: Date.now() }
    resume = r
    lastAsin = asin
    saveSoon()
    // The open library reads progress live; rebuilding its rows here would jump the scroll.
    if (!libraryOpen) rebuildBooks()
  }

  // ---- finished / play counts ---------------------------------------------
  function setGroupSeries(v) { groupSeries = v === true; saveSoon() }
  function setContinueExpanded(v) { continueExpanded = v === true; saveSoon() }

  function setFilterMode(m) {
    if (m !== "all" && m !== "downloaded" && m !== "cloud") return
    filterMode = m
    saveSoon()
  }

  // A full listen: bump the count, start the book over next time, and take it out of "Continue listening".
  // Called automatically when mpv reaches the end, or by hand (the library's Ctrl+M).
  function markFinished(a) {
    if (!a) return ""
    var now = Date.now()
    // A book Audible already counts as finished is one listen before we add ours.
    var bk = bookFor(a)
    var cur = plays[a] ? Math.max(0, Number(plays[a].count) || 0) : (bk && bk.finished ? 1 : 0)
    if (plays[a] && now - (Number(plays[a].lastAt) || 0) < 30000) return "Already marked."   // double-fire guard
    var p = {}
    for (var k in plays) p[k] = plays[k]
    // remember where you were, so "unmark" can put you back
    p[a] = { count: cur + 1, lastAt: now, prevResume: plays[a] && plays[a].prevResume !== undefined ? plays[a].prevResume : (resume[a] || null) }
    plays = p
    var r = {}
    for (var j in resume) r[j] = resume[j]
    r[a] = { position: 0, updatedAt: now }
    resume = r
    if (hasBook && asin === a && !playing) mpvSend(["stop"])   // no half-state: it is finished, so unload it
    saveSoon()
    rebuildBooks()
    return "Marked finished (" + (cur + 1) + (cur + 1 === 1 ? " listen)" : " listens)")
  }

  function unmarkFinished(a) {
    if (!a || !plays[a]) return "Not marked finished here."
    var n = Math.max(0, (Number(plays[a].count) || 0) - 1)
    var prev = plays[a].prevResume
    var p = {}
    for (var k in plays) if (k !== a) p[k] = plays[k]
    if (n > 0) p[a] = { count: n, lastAt: Number(plays[a].lastAt) || 0, prevResume: prev !== undefined ? prev : null }
    plays = p
    // put you back where you were before it was marked finished
    var r = {}
    for (var j in resume) if (j !== a) r[j] = resume[j]
    if (prev) r[a] = prev
    resume = r
    saveSoon()
    rebuildBooks()
    return n > 0 ? "Now " + n + (n === 1 ? " listen." : " listens.") : "Cleared."
  }

  // Delete the downloaded files and the CLI's record of them (so a later download is not skipped).
  // Returns an error message, or "" when the removal has started.
  function removeDownload(a) {
    if (!/^[A-Z0-9]{10}$/.test(String(a || ""))) return "Not a valid book."
    if (hasBook && asin === a) return "That book is loaded in the player. Open another book first."
    if (!isLocal(a)) return "It is not downloaded."
    run(["audible", "db", "downloads", "remove", "--asin", a, "--with-files", "-y"], function() {
      run(["sh", "-c", "rm -rf -- \"$1/$2\"", "sh", booksDir, a], function() {
        var d = {}
        for (var k in downloads) if (k !== a) d[k] = downloads[k]
        downloads = d
        scanLocal(function() { rebuildBooks() })
      })
    })
    return ""
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

  function relink() {
    mpvLink.active = false
    mpvLink.active = true
    observeTimer.restart()
  }

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
    var props = ["pause", "speed", "chapter-list", "duration", "path", "idle-active", "media-title", "volume", "mute", "eof-reached"]
    for (var i = 0; i < props.length; i++) mpvSend(["observe_property", i + 1, props[i]])
    listening.applyFilters()  // HOOK(listen)
  }

  function onMpvGone() {
    linked = false
    eofSeen = false
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
      if (savePositionOnReply) { savePositionOnReply = false; rememberPosition() }
      return
    }
    if (m.event === "property-change") {
      switch (m.name) {
      case "pause":
        paused = m.data === true
        // Read the real position right now: the 1 Hz poll can be up to a second (more at 2-3x) stale,
        // which showed as the time/progress snapping when you hit play or pause.
        if (paused) savePositionOnReply = true
        mpvSend(["get_property", "time-pos"], 100)
        break
      case "speed": if (typeof m.data === "number") { speed = m.data; saveSoon() } break
      case "chapter-list": rawChapters = Array.isArray(m.data) ? m.data : []; break
      case "duration": duration = typeof m.data === "number" ? m.data : 0; break
      case "path": path = m.data ? String(m.data) : ""; asin = asinFromPath(path); break
      case "idle-active": idle = m.data === true; break
      case "media-title": mediaTitle = m.data ? String(m.data) : ""; break
      // While the sleep timer fades, mpv reports the faded level: keep the user's saved volume.
      case "volume": if (typeof m.data === "number" && !listening.fading) { volume = m.data; saveSoon() } break  // HOOK(listen)
      case "mute": muted = m.data === true; break
      case "eof-reached":
        // The first report after (re)connecting is just the current state, not an event: ignore it, or a
        // Service restart while mpv sits at the end of a book would count another listen.
        if (!eofSeen) { eofSeen = true; break }
        if (m.data === true && asin !== "" && markFinished(asin) !== "Already marked.") listening.bookFinished(asin)  // HOOK(listen)
        break
      }
    } else if (m.event === "file-loaded") {
      loading = false
    } else if (m.event === "end-file" && m.reason === "eof") {
      rememberPosition()
    } else if (m.event === "end-file" && m.reason === "error") {
      loading = false
      setupLog = "mpv could not play that file."
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
      statsLog.tick()  // HOOK(stats)
    }
  }

  // ---- listening history (HOOK(stats)): ListeningLog.qml owns the file, StatsModel.js the maths
  ListeningLog { id: statsLog; service: root }  // HOOK(stats)
  property alias stats: statsLog                // HOOK(stats)

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
    p = phoneSync.startOverride(a, p)   // HOOK(sync)
    if (p <= 0 || (total > 0 && p > total - 60)) return 0
    return p
  }

  // ---- starting mpv ---------------------------------------------------------
  // mpv is a separate, long-lived process (own systemd scope via uwsm-app when available) so playback
  // survives a shell restart. If its socket is not there when a book starts, launch it and wait.
  property bool hasUwsm: false
  property var linkWaiter: null
  property int linkTries: 0

  function launchMpv() {
    var argv = Player.mpvLaunchArgs(mpvSock, { uwsm: hasUwsm, volume: Math.round(volume) })
    // a socket file left by a dead mpv would make the new one fail to bind
    Quickshell.execDetached(["sh", "-c", "export PATH=\"$HOME/.local/bin:$PATH\"; rm -f \"$1\"; shift; exec \"$@\"", "sh", mpvSock].concat(argv))
  }

  function whenLinked(fn) {
    if (linked) { fn(); return }
    linkWaiter = fn
    linkTries = 0
    linkWaitTimer.restart()
    relink()
  }

  Timer {
    id: linkWaitTimer
    interval: 700
    repeat: true
    onTriggered: {
      if (root.linked) {
        stop()
        var f = root.linkWaiter
        root.linkWaiter = null
        if (f) f()
        return
      }
      root.linkTries++
      if (root.linkTries === 2) root.launchMpv()   // two connects failed: no mpv is listening
      if (root.linkTries > 14) {
        stop()
        root.linkWaiter = null
        root.loading = false
        root.setupLog = "mpv did not start. Is it installed?"
        return
      }
      root.relink()
    }
  }

  function startPlayback(a) {
    var file = localFiles[a]
    if (!file) return
    if (hasBook && asin !== a) rememberPosition()
    if (hasBook && asin === a) { resumePlayback(); return }
    loading = true
    startingAsin = a
    var start = Math.max(0, Math.floor(resumePosition(a) - 5))   // back up a few seconds
    // The voucher holds the AAXC key and iv. It is read into memory and handed to mpv over its IPC
    // socket as demuxer options, so it never appears in a command line and no decrypted copy is written.
    run(["cat", String(file).replace(/\.aaxc$/, ".voucher")], function(code, out) {
      var voucher = null
      try { voucher = JSON.parse(out) } catch (e) { }
      var cmds = Player.loadCommands(file, voucher, { start: start, speed: speed, volume: Math.round(volume) })
      if (cmds.length === 0) {
        loading = false
        setupLog = "Could not read this book's license file. Try downloading it again."
        return
      }
      whenLinked(function() {
        for (var i = 0; i < cmds.length; i++) mpvSend(cmds[i])
      })
    })
    lastAsin = a
    saveSoon()
  }

  function play(a) {
    phoneSync.prefetch(a)   // HOOK(sync)
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
      books = Lib.merge(rawBooks, { localAsins: localAsins, downloads: downloads, resume: resume, plays: plays })
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
         "--query", "response_groups=contributors,product_desc,product_attrs,media,listening_status,series,rating",
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
    run(["audible", "download", "--asin", a, "--kind", "audio,chapter,cover", "--quality", downloadQuality, "-o", "json"], function(code, out, err) {
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

  // The CLI prints nothing while downloading when not on a TTY, and writes to <asin>.*.aaxc.part until
  // it finishes, so progress is that file's size against runtime * bitrate.
  Timer {
    interval: 1500
    repeat: true
    running: root.activeDownload !== ""
    onTriggered: {
      var a = root.activeDownload
      if (a === "") return
      root.run(["sh", "-c", "stat -c %s \"$1\"/\"$2\"/\"$2\".*.aaxc.part 2>/dev/null | head -1; true", "sh", root.booksDir, a], function(code, out) {
        var size = Number(String(out).trim())
        var b = root.bookFor(a)
        var expected = b && b.runtimeSec > 0 ? b.runtimeSec * (downloadQuality === "normal" ? 8000 : 16000) : 0
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

  // HOOK(discover): Up next (queue.json, local only) and catalog / wishlist access. See Queue.qml, Catalog.qml.
  Queue { id: queueCtl; svc: root }
  Catalog { id: catalogCtl; svc: root }
  readonly property var queue: queueCtl
  readonly property var catalog: catalogCtl
  readonly property int queueCount: queueCtl.count
  // The asin that should follow currentAsin, or "" (the LISTEN auto-advance reads queueProvider).
  // With no argument it means "after the book that is playing now".
  function queueNext(currentAsin) { return queueCtl.next(currentAsin || root.asin) }
  readonly property var queueProvider: function (currentAsin) { return root.queueNext(currentAsin) }

  Loader {
    id: libraryLoader
    active: root.libraryEverOpened
    source: Qt.resolvedUrl("Library.qml")
    onLoaded: { if (item && "service" in item) item.service = root }
  }

  // Listening stats window (HOOK(stats)): hosted lazily like the library, opened from the popup (i) or IPC.
  property bool statsOpen: false                 // HOOK(stats)
  property bool statsEverOpened: false           // HOOK(stats)
  function openStats() { statsEverOpened = true; statsOpen = true }     // HOOK(stats)
  function closeStats() { statsOpen = false }                           // HOOK(stats)
  function toggleStats() { statsOpen ? closeStats() : openStats() }     // HOOK(stats)
  Loader {                                       // HOOK(stats)
    id: statsLoader
    active: root.statsEverOpened
    source: Qt.resolvedUrl("Stats.qml")
    onLoaded: { if (item && "service" in item) item.service = root }
  }

  // ======================================================================
  // setup probe and actions: see SetupController.qml
  // ======================================================================
  SetupController { id: setupCtl; svc: root }

  // ======================================================================
  // Audible position sync: see Sync.qml
  // ======================================================================
  Sync { id: phoneSync; service: root }   // HOOK(sync)
  readonly property var phoneOffer: phoneSync.offer   // HOOK(sync)
  function acceptPhonePosition(a) { phoneSync.accept(a) }   // HOOK(sync)
  function prefetchCurrent() { phoneSync.prefetchCurrent() }   // HOOK(sync)
  readonly property var setup: setupCtl.setup
  readonly property bool ready: setupCtl.ready
  readonly property string setupBusyId: setupCtl.setupBusyId
  readonly property bool setupBusy: setupCtl.setupBusyId !== ""
  readonly property string loginUrl: setupCtl.loginUrl
  readonly property bool loginWaiting: setupCtl.loginWaiting
  readonly property bool previewing: setupCtl.previewing
  property string setupLog: ""
  function recheck() { setupCtl.recheck() }
  function previewSetup(name) { setupCtl.previewSetup(name) }
  function runSetupAction(id, payload) { setupCtl.runSetupAction(id, payload) }
  function accountName() { return setupCtl.accountName() }
  function signOut() { setupCtl.signOut() }
  // After a sign-out nothing of the old account stays on screen (downloaded files are left alone).
  function clearAccountData() {
    books = []
    libraryError = ""
    if (catalogCtl) catalogCtl.reset()
  }

  // Sleep timer, rewind on resume, auto-advance, notifications, audio filters: see Listening.qml
  readonly property var listening: Listening { service: root; nextProvider: root.queueProvider }  // HOOK(listen) + HOOK(discover)

  // ======================================================================
  // IPC: the only IPC target for this plugin (bar widgets exist once per monitor)
  // ======================================================================
  IpcHandler {
    target: "jarod.audible"

    function status(): string {
      return JSON.stringify({
        state: root.setup ? root.setup.state : "checking",
        ready: root.ready,
        hasBook: root.hasBook, playing: root.playing, paused: root.paused, volume: root.volume, muted: root.muted, plays: root.plays, filter: root.filterMode, pending: root.pendingStatus, pendingFraction: root.pendingFraction, download: root.activeDownload !== "" ? Object.assign({ asin: root.activeDownload }, root.downloads[root.activeDownload] || {}) : null,
        asin: root.asin, title: root.title,
        position: root.position, duration: root.duration, speed: root.speed,
        chapterIndex: root.chapterIndex, chapters: root.chapters.length,
        timeLeftSec: root.timeLeftSec,
        books: root.books.length, local: Object.keys(root.localAsins).length,
        libraryOpen: root.libraryOpen, view: root.viewMode,
        phoneOffer: root.phoneOffer, syncStatus: phoneSync.status, queue: root.queueCount,
        detailAsin: root.libraryOpen && libraryLoader.item && libraryLoader.item.detailAsin ? libraryLoader.item.detailAsin : "", // HOOK(ship): smoke.sh checks the details page (only while the library is open)
        busy: root.setupBusyId, log: root.setupLog,
        libraryLoading: root.libraryLoading, libraryError: root.libraryError
      })
    }
    function toggleLibrary(): void { root.toggleLibrary() }
    function openLibrary(): void { root.openLibrary() }
    function closeLibrary(): void { root.closeLibrary() }
    function toggleStats(): void { root.toggleStats() }    // HOOK(stats)
    function openStats(): void { root.openStats() }        // HOOK(stats)
    function closeStats(): void { root.closeStats() }      // HOOK(stats)
    function popup(): void { root.popupRequested() }
    function play(asin: string): void { root.play(asin) }
    function toggle(): void { root.togglePause() }
    function pause(): void { root.pause() }
    function setSpeed(x: real): void { root.setSpeed(x) }
    function stepSpeed(dir: int): void { root.stepSpeed(dir) }
    function setVolume(v: real): void { root.setVolume(v) }
    function stepVolume(dir: int): void { root.stepVolume(dir) }
    function toggleMute(): void { root.toggleMute() }
    function openDetail(asin: string): void { if (libraryLoader.item && libraryLoader.item.openDetail) libraryLoader.item.openDetail(root.bookFor(asin)) }
    function askRemove(asin: string): void { if (libraryLoader.item && libraryLoader.item.askRemove) libraryLoader.item.askRemove(root.bookFor(asin)) }
    function markFinished(asin: string): string { return root.markFinished(asin) }
    function unmarkFinished(asin: string): string { return root.unmarkFinished(asin) }
    function removeDownload(asin: string): string { return root.removeDownload(asin) }
    function setFilter(mode: string): void { root.setFilterMode(mode) }
    function setGroup(on: bool): void { root.setGroupSeries(on) }
    function setContinueExpanded(on: bool): void { root.setContinueExpanded(on) }
    function openSeries(title: string): void { if (libraryLoader.item && libraryLoader.item.openSeriesView) libraryLoader.item.openSeriesView({ asin: "series:" + title.toLowerCase(), title: title }) }
    function download(asin: string): void { root.download(asin) }
    function seekBy(sec: real): void { root.seekBy(sec) }
    function next(): void { root.nextChapter() }
    function prev(): void { root.prevChapter() }
    function refresh(): void { root.refreshLibrary(); root.scanLocal() }
    function recheck(): void { setupCtl.previewing = false; root.recheck() }
    function signOut(): void { root.signOut() }
    function previewSetup(name: string): void { root.previewSetup(name) }
    function sleep(minutes: int): void { root.listening.sleep(minutes) }  // HOOK(listen)
    function sleepChapter(): void { root.listening.sleepChapter() }  // HOOK(listen)
    function sleepCancel(): void { root.listening.sleepCancel() }  // HOOK(listen)
  }

  Component.onCompleted: {
    stateFile.reload()
    recheck()
  }
}
