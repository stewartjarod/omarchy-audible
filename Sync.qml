import QtQuick
import Quickshell.Io
import "SyncModel.js" as SyncModel

// Keeps the listening position in step with Audible. Owned by Service (one instance per shell).
//   PULL (on by default, setting syncPullFromAudible): reads the phone's last position in the
//     background. Never seeks a book on its own: a clearly-ahead phone position becomes `offer`,
//     which the popup and the details page show. Accepting it seeks (loaded book) or sets the
//     start position for the next start (book not loaded).
//   PUSH (on by default, setting savePositionToAudible): writes our position to Audible on pause,
//     at most every 3 minutes while playing, and when playback stops. This is the only write the
//     plugin ever makes to the Audible account (PUT /1.0/lastpositions/<asin>). Before each write it
//     re-reads Audible's position and refuses when another device wrote one after this computer last
//     played the book, so it never moves your phone backwards (SyncModel.pushRefusal).
// Everything is asynchronous. A failed call only sets `status` and backs off; it never blocks playback.
Item {
  id: root

  property var service: null

  readonly property var mode: SyncModel.pushMode(service ? service.settings : ({}))
  readonly property bool pullOn: !service || !service.settings || service.settings.syncPullFromAudible !== false

  property var phone: ({})        // asin -> { positionSec, updatedAt, exists, fetchedAt }
  property var accepted: ({})     // asin -> seconds, accepted while the book was not loaded
  property var dismissed: ({})    // asin -> seconds, offers the user already accepted
  property var lastSent: ({})     // asin -> seconds last written to Audible
  property var acrs: ({})         // asin -> content id Audible wants with a write (cached for good)
  property var pushed: ({})       // asin -> the integer position_ms last written (to spot our own echo)
  property bool pushBusy: false
  property var lastSeen: ({ asin: "", pos: 0 })
  property var offer: null        // { asin, position, label } | null
  property string status: ""      // last plain-English line, for the popup and the log
  property int pullFailures: 0
  property real pullNextMs: 0
  property int pushFailures: 0
  property real pushNextMs: 0
  property real lastPushMs: 0

  // ---- own state file (never Service's state.json) ---------------------------
  readonly property string stateFilePath: service ? service.stateDir + "/sync.json" : ""

  FileView {
    id: stateFile
    printErrors: false
    path: root.stateFilePath
    onLoaded: root.loadState(String(stateFile.text()))
  }

  function loadState(text) {
    try {
      var s = JSON.parse(text)
      if (s.accepted && typeof s.accepted === "object") accepted = s.accepted
      if (s.lastSent && typeof s.lastSent === "object") lastSent = s.lastSent
      if (s.acrs && typeof s.acrs === "object") acrs = s.acrs
      if (s.pushed && typeof s.pushed === "object") pushed = s.pushed
    } catch (e) { }
  }

  function saveSoon() { saveTimer.restart() }
  Timer {
    id: saveTimer
    interval: 800
    onTriggered: {
      if (!root.service) return
      var body = JSON.stringify({ version: 1, accepted: root.accepted, lastSent: root.lastSent, acrs: root.acrs, pushed: root.pushed })
      root.service.ensureStateDir(function() { stateFile.setText(body) })
    }
  }

  // ---- triggers from the Service ----------------------------------------------
  Connections {
    target: root.service
    ignoreUnknownSignals: true

    function onBooksChanged() { root.pullLibrary() }
    function onResumeChanged() { root.onProgress() }
    function onAsinChanged() { root.recompute() }
    function onHasBookChanged() {
      if (root.service && !root.service.hasBook) root.flush()
      root.onProgress()
    }
  }

  // ---- PULL -------------------------------------------------------------------
  function prefetch(a) {
    if (!pullOn || !service || !service.ready || !a) return
    pullAsins([a])
  }

  function prefetchCurrent() {
    if (!service) return
    prefetch(service.hasBook ? service.asin : service.lastAsin)
  }

  function pullLibrary() {
    if (!pullOn || !service || !service.ready) return
    pullAsins(SyncModel.pullCandidates(service.books, service.localAsins, service.lastAsin))
  }

  function pullAsins(list) {
    var now = Date.now()
    if (now < pullNextMs) return
    var want = []
    for (var i = 0; i < list.length; i++) {
      var p = phone[list[i]]
      if (!p || SyncModel.needsPull(p.fetchedAt, now)) want.push(list[i])
    }
    if (want.length === 0) return
    var batches = SyncModel.chunk(want, SyncModel.PULL_BATCH)
    for (var b = 0; b < batches.length; b++) runPull(batches[b])
  }

  function runPull(asins) {
    if (!service) return
    var stamp = Date.now()
    service.run(SyncModel.buildPullRequest(asins), function(code, out, err) {
      var r = code === 0 ? SyncModel.parseLastPositions(out) : { ok: false, positions: {}, error: SyncModel.friendlyError(err || out) }
      if (!r.ok) {
        pullFailures++
        pullNextMs = Date.now() + SyncModel.backoffMs(pullFailures)
        status = r.error
        return
      }
      pullFailures = 0
      pullNextMs = 0
      var next = Object.assign({}, phone)
      for (var i = 0; i < asins.length; i++) {
        var rec = r.positions[asins[i]]
        next[asins[i]] = rec ? Object.assign({}, rec, { fetchedAt: stamp })
                             : { positionSec: 0, updatedAt: 0, exists: false, fetchedAt: stamp }
      }
      phone = next
      recompute()
    })
  }

  // The offer for the book that matters now: the loaded one, else the one we would continue.
  function recompute() {
    var a = service ? (service.hasBook ? service.asin : service.lastAsin) : ""
    var p = a ? phone[a] : null
    if (!p || !p.exists || dismissed[a] === p.positionSec) { offer = null; return }
    var book = service.bookFor(a)
    var loaded = service.hasBook && service.asin === a
    var dur = loaded && service.duration > 0 ? service.duration : (book ? book.runtimeSec : 0)
    var d = SyncModel.decide(p, SyncModel.localBaseline(service.resume[a], book), { durationSec: dur })
    if (d.state !== "phone-ahead") { offer = null; return }
    offer = { asin: a, position: p.positionSec, label: SyncModel.formatPosition(p.positionSec, loaded ? service.chapters : []) }
  }

  // Called by the user (Enter in the popup, or the details page button). Never called automatically.
  function accept(a) {
    var p = phone[a]
    if (!p || !p.exists || !service) return
    var label = SyncModel.formatPosition(p.positionSec, service.hasBook && service.asin === a ? service.chapters : [])
    var d = Object.assign({}, dismissed)
    d[a] = p.positionSec
    dismissed = d
    if (service.hasBook && service.asin === a) {
      service.seekTo(p.positionSec)
    } else {
      var acc = Object.assign({}, accepted)
      acc[a] = p.positionSec
      accepted = acc
      saveSoon()
    }
    offer = null
    status = "Resumed from your phone at " + label + "."
  }

  // Start position for a book that is not loaded: an accepted offer wins once, then a clearly-ahead
  // phone position. Reads cache only; never waits on the network. Called from Service.resumePosition.
  function startOverride(a, localPos) {
    if (!service || !a) return localPos
    if (accepted[a] !== undefined) {
      var acc = Object.assign({}, accepted)
      var sec = acc[a]
      delete acc[a]
      accepted = acc
      saveSoon()
      return sec
    }
    var p = phone[a]
    if (!p || !p.exists) return localPos
    var book = service.bookFor(a)
    var d = SyncModel.decide(p, SyncModel.localBaseline(service.resume[a], book), { durationSec: book ? book.runtimeSec : 0 })
    return d.state === "phone-ahead" ? p.positionSec : localPos
  }

  // ---- PUSH -------------------------------------------------------------------
  function onProgress() {
    recompute()
    maybePush(false)
  }

  // When this computer last played the book (the resume entry's time), or 0 when it never has.
  function listenedAt(a) {
    var r = service && service.resume ? service.resume[a] : null
    return r ? Number(r.updatedAt) || 0 : 0
  }

  function maybePush(force) {
    if (!mode.push || !service || pushBusy) return
    var a = service.hasBook ? service.asin : ""
    var pos = service.hasBook ? service.position : 0
    if (a === "") return
    lastSeen = { asin: a, pos: pos }
    if (listenedAt(a) <= 0) return   // nothing played here yet: wait for the first saved position
    var st = SyncModel.shouldPush({
      pushOn: true, hasBook: true, playing: service.playing, paused: service.paused || force,
      positionSec: pos, sentSec: lastSent[a], nowMs: Date.now(), lastPushMs: lastPushMs, nextAllowedMs: pushNextMs
    })
    if (!st.send) return
    lastPushMs = Date.now()
    sendLive(a, pos)
  }

  // Called when playback stops: write the last position we saw, without waiting for the interval.
  function flush() {
    if (!mode.push || pushBusy || !lastSeen.asin || !(lastSeen.pos > 0)) return
    var sent = lastSent[lastSeen.asin]
    if (sent !== undefined && Math.abs(lastSeen.pos - sent) < 5) return
    if (listenedAt(lastSeen.asin) <= 0 || Date.now() < pushNextMs) return
    sendLive(lastSeen.asin, lastSeen.pos)
  }

  function failPush(msg) {
    pushFailures++
    pushNextMs = Date.now() + SyncModel.backoffMs(pushFailures)
    status = msg
    pushBusy = false
  }

  // One guarded write (SyncModel.pushPosition does the steps; this applies the result). Never blocks
  // playback; any failure only sets `status` and backs off.
  function sendLive(a, pos) {
    if (!service || pushBusy) return
    pushBusy = true
    SyncModel.pushPosition(function(request, cb) { service.run(request, cb) }, {
      asin: a, positionSec: pos, listenedAtMs: listenedAt(a), acr: acrs[a] || "", pushedMs: pushed[a]
    }, function(res) {
      var ac = Object.assign({}, acrs)
      if (res.acr) ac[a] = res.acr; else delete ac[a]
      acrs = ac
      if (res.remote) {
        var next = Object.assign({}, phone)
        next[a] = Object.assign({}, res.remote, { fetchedAt: Date.now() })
        phone = next
      }
      if (res.outcome === "failed") { saveSoon(); failPush(res.error); return }
      if (res.outcome === "refused") {
        pushNextMs = Date.now() + SyncModel.backoffMs(1)
        status = "Audible has a newer spot from another device, so this computer left it alone."
        pushBusy = false
        saveSoon()
        recompute()
        return
      }
      pushFailures = 0
      pushNextMs = 0
      var ls = Object.assign({}, lastSent)
      ls[a] = pos
      lastSent = ls
      var ps = Object.assign({}, pushed)
      ps[a] = res.positionMs
      pushed = ps
      var ph = Object.assign({}, phone)
      ph[a] = { positionSec: pos, positionMs: res.positionMs, updatedAt: Date.now(), exists: true, fetchedAt: Date.now() }
      phone = ph
      saveSoon()
      status = "Position saved to Audible."
      pushBusy = false
      recompute()
    })
  }
}
