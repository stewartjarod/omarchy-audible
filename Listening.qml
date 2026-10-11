import QtQuick
import Quickshell
import "ListeningModel.js" as Ls
import "LibraryModel.js" as Lib

// Everyday listening features, driven by Service (one instance per shell, no visuals):
// sleep timer with a fade and pause, rewind on resume, auto-advance to the next downloaded
// book in a series, desktop notifications and audio filters. Surfaces read `sleepText` and
// call `cycleSleep()`; Service calls the hook functions below.
Item {
  id: root
  property var service: null

  // Set this to a function(asin) -> asin string from a play queue. A non-empty answer wins over
  // the series rule (it still must be downloaded). Null means no queue.
  property var nextProvider: null

  readonly property var cfg: service && service.settings ? service.settings : ({})
  readonly property bool rewindOn: cfg.rewindOnResume !== false
  readonly property bool notifyOn: cfg.notifications !== false
  readonly property string advanceMode: cfg.autoAdvance === "off" ? "off" : "downloaded"
  readonly property string filterMode: cfg.audioFilter === "normalize" || cfg.audioFilter === "voice" ? cfg.audioFilter : "off"

  // ---- sleep timer -------------------------------------------------------------
  property var sleepTimer: null          // see ListeningModel.js for the shapes
  property bool fading: false            // true while the volume is being ramped down
  property string sleepText: ""          // "Sleep in 12 min" etc, "" when off
  property string sleptAsin: ""          // the book a sleep pause ended; its end is not auto-advanced

  readonly property int fadeSec: Ls.FADE_SEC

  function currentChapterEnd() {
    var c = service && service.chapters ? service.chapters[service.chapterIndex] : null
    return c && c.end > 0 ? c.end : 0
  }

  function refreshText() {
    var rem = sleepTimer && service ? Ls.sleepRemainingSec(sleepTimer, service.position, service.speed) : 0
    sleepText = Ls.sleepLabel(sleepTimer, rem)
  }

  // Put the user's own (saved) volume back on mpv. Never writes service.volume.
  function restoreVolume() {
    fading = false
    if (service) service.mpvSend(["set_property", "volume", service.volume])
  }

  // IPC sleep(minutes): a running time timer gets the minutes added; otherwise a fresh timer starts.
  function sleep(minutes) {
    if (fading) restoreVolume()
    sleepTimer = Ls.sleepAddMinutes(sleepTimer, minutes)
    refreshText()
  }

  // "Z" in the popup: add the running preset's time again (the same as tapping it twice).
  function addRunningPreset() {
    var m = Ls.sleepRunningPreset(sleepTimer)
    if (m > 0) sleep(m)
  }

  // A fresh preset from the cycle (replaces whatever was running).
  function setPreset(minutes) {
    if (fading) restoreVolume()
    sleepTimer = Ls.sleepAddMinutes(null, minutes)
    refreshText()
  }

  // IPC sleepChapter(): pause at the end of the chapter that is playing now.
  function sleepChapter() {
    if (fading) restoreVolume()
    var t = Ls.sleepChapterTimer(currentChapterEnd())
    if (!t) { if (service) service.setupLog = "No chapter to stop at yet."; return }
    sleepTimer = t
    refreshText()
  }

  // IPC sleepCancel()
  function sleepCancel() {
    if (fading) restoreVolume()
    sleepTimer = null
    refreshText()
  }

  // "z" in the popup, or a click on the sleep row: 15, 30, 45, 60, end of chapter, off.
  function cycleSleep() {
    var c = Ls.nextSleepChoice(sleepTimer)
    if (c === 0) sleepCancel()
    else if (c === "chapter") sleepChapter()
    else setPreset(c)
  }

  function finishSleep() {
    var wasPlaying = service && service.playing
    sleptAsin = service ? service.asin : ""
    // Pause first, then bring the volume back: otherwise the faded level jumps to full for a moment.
    if (service && wasPlaying) service.pause()
    restoreVolume()
    sleepTimer = null
    if (wasPlaying) notify("Sleep timer", "Playback paused. Your place is saved.")
    refreshText()
  }

  // One tick per second: count down while playing, then fade or pause.
  function tick() {
    if (!sleepTimer || !service) return
    sleepTimer = Ls.sleepTick(sleepTimer, service.playing, 1)
    if (Ls.sleepChapterOvershot(sleepTimer, service.position, service.speed)) {
      // The listener jumped past the chapter: stop at the end of the chapter they are in now.
      sleepTimer = Ls.sleepChapterTimer(currentChapterEnd())
      if (!sleepTimer) { restoreVolume(); refreshText(); return }
    }
    var rem = Ls.sleepRemainingSec(sleepTimer, service.position, service.speed)
    if (Ls.isSleepDue(sleepTimer, rem)) { finishSleep(); return }
    if (rem <= fadeSec) {
      fading = true
      service.mpvSend(["set_property", "volume", Ls.fadeVolume(service.volume, rem, fadeSec)])
    } else if (fading) {
      restoreVolume()
    }
    refreshText()
  }

  Timer {
    id: sleepTick
    interval: 1000
    repeat: true
    running: root.sleepTimer !== null
    onTriggered: root.tick()
  }

  // ---- rewind on resume ----------------------------------------------------------
  // A pause only counts when it came after playing this session and was on the same book.
  property real pausedAtMs: 0
  property real pausedPos: 0
  property string pausedAsin: ""
  property bool sawPlaying: false

  Connections {
    target: root.service
    function onPausedChanged() { root.onPauseChanged() }
    // startPlayback sets loading before any mpv command: a (re)load must never be rewound on top
    // of its own start-5-seconds offset.
    function onLoadingChanged() {
      if (root.service && root.service.loading) { root.pausedAtMs = 0; root.pausedAsin = "" }
    }
  }

  function onPauseChanged() {
    var s = root.service
    if (!s) return
    if (s.paused) {
      if (root.sawPlaying && root.pausedAtMs === 0 && s.hasBook) {
        root.pausedAtMs = Date.now()
        root.pausedPos = s.position
        root.pausedAsin = s.asin
      }
      return
    }
    root.sleptAsin = ""   // resumed after a sleep pause: the book's real end may auto-advance again
    var was = root.pausedAtMs
    var sameBook = root.pausedAsin !== "" && root.pausedAsin === s.asin
    root.pausedAtMs = 0
    root.pausedAsin = ""
    root.sawPlaying = true
    if (was <= 0 || !sameBook || !s.hasBook) return
    // The user moved while paused (seek or chapter jump): respect that spot, no rewind.
    if (Math.abs(s.position - root.pausedPos) > 2) return
    if (s.duration > 0 && s.position >= s.duration - 1) return
    var back = Ls.rewindSeconds((Date.now() - was) / 1000, root.rewindOn)
    if (back > 0) s.seekBy(-back)
  }

  // ---- notifications -------------------------------------------------------------
  function notify(title, body, expireMs) {
    if (!notifyOn) return
    Quickshell.execDetached(Ls.notifyArgs(title, body, expireMs))
  }

  function titleOf(asin) {
    var b = service ? service.bookFor(asin) : null
    return b && b.title ? b.title : "Your book"
  }

  property var notifiedDone: ({})

  Connections {
    target: root.service
    function onDownloadsChanged() { root.checkDownloads() }
  }

  // Once per book, and only for downloads that finish during this session.
  function checkDownloads() {
    var d = service ? service.downloads : null
    if (!d) return
    for (var a in d) {
      if (d[a] && d[a].state === "done" && !notifiedDone[a]) {
        notifiedDone[a] = true
        notify("Download finished", titleOf(a) + " is ready to listen to offline.")
      }
    }
  }

  // ---- finished and auto-advance ---------------------------------------------------
  // Called by Service after a book reaches its end (not for a manual "mark finished").
  property string upNextAsin: ""
  property string upNextFrom: ""

  Timer {
    id: upNextTimer
    interval: 5000
    repeat: false
    onTriggered: root.startUpNext()
  }

  function bookFinished(asin) {
    if (!service || !asin) return
    notify("Finished", titleOf(asin))
    if (sleptAsin === asin) { sleptAsin = ""; return }
    var provider = typeof nextProvider === "function" ? String(nextProvider(asin) || "") : ""
    var pick = Ls.nextInSeries(Lib, service.books, asin, {
      autoAdvance: advanceMode,
      isLocal: function (a) { return service.isLocal(a) },
      provider: provider
    })
    if (!pick) return
    upNextFrom = asin
    upNextAsin = pick.asin
    notify("Up next", Ls.upNextBody(titleOf(pick.asin)), 5000)
    upNextTimer.restart()
  }

  function startUpNext() {
    var a = upNextAsin
    upNextAsin = ""
    if (!service || a === "") return
    // The listener started something else in the meantime: leave it alone.
    if (service.asin !== "" && service.asin !== upNextFrom) return
    if (!service.isLocal(a)) return   // never a surprise download
    service.play(a)
  }

  // ---- audio filters -------------------------------------------------------------
  // Applied on mpv connect (Service calls this) and whenever the setting changes.
  function applyFilters() {
    if (!service) return
    var cmds = Ls.affCommands(filterMode)
    for (var i = 0; i < cmds.length; i++) service.mpvSend(cmds[i])
  }

  onFilterModeChanged: applyFilters()

  // A volume ramp left behind by a shell restart must not be saved as the user's level.
  Component.onDestruction: { if (fading) restoreVolume() }
}
