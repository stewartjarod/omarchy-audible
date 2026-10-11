import QtQuick
import Quickshell
import Quickshell.Io
import "StatsModel.js" as Stats

// Local listening history: per-day wall seconds and book seconds, in
// ~/.local/state/jarod-audible/listening.json. The Service calls tick() once a second while
// something plays. The file is written at most every 30 s, and at once when playback pauses or stops.
// All the arithmetic lives in StatsModel.js; this file is only state and I/O.
Item {
  id: root

  property var service: null

  readonly property string filePath: service ? service.stateDir + "/listening.json" : ""
  readonly property bool playing: service ? service.playing === true : false

  // day -> {wallSec, bookSec, perBook}. Mutated in place by tick(); `revision` tells bindings to re-read.
  property var logData: ({})
  property int revision: 0
  property bool loaded: false
  property bool dirty: false
  property real lastTickMs: 0

  // Playback paused or stopped: the next tick starts a fresh interval, and the log is written now.
  onPlayingChanged: {
    if (!playing) {
      lastTickMs = 0
      flush()
    }
  }

  // Called once a second from the Service's position timer while playing (HOOK(stats)).
  function tick() {
    if (!service || !playing) {
      lastTickMs = 0
      return
    }
    var now = Date.now()
    var start = lastTickMs > 0 ? lastTickMs : now - Stats.NOMINAL_TICK_MS
    lastTickMs = now
    Stats.addInterval(logData, start, now, service.asin, service.speed)
    dirty = true
    revision++
    if (loaded && !saveTimer.running) saveTimer.start()
  }

  // Write at most once per 30 s while there is something new to write.
  Timer {
    id: saveTimer
    interval: 30000
    repeat: false
    onTriggered: root.save()
  }

  function flush() {
    if (!dirty || !loaded) return
    saveTimer.stop()
    save()
  }

  function save() {
    if (!dirty || !loaded || !service) return
    Stats.prune(logData, Stats.dayKey(Date.now()))
    var body = Stats.serialize(logData)
    dirty = false
    service.run(["mkdir", "-p", service.stateDir], function() { file.setText(body) })
  }

  // Shown on the window and in the popup: how many days (and which day) the book is at this pace.
  function forecastFor(asin, remainingSec) {
    return Stats.bookForecast(logData, asin, Stats.dayKey(Date.now()), remainingSec)
  }

  // Short hint for the popup, e.g. "finish by Fri". Empty when there is no date to show.
  function finishHint(asin, remainingSec) {
    var today = Stats.dayKey(Date.now())
    return Stats.finishBy(Stats.bookForecast(logData, asin, today, remainingSec).forecast, today)
  }

  FileView {
    id: file
    path: root.filePath
    onLoaded: root.adopt(String(file.text()))
    onLoadFailed: root.adopt("")
  }

  // The file may load after ticks have already happened (a fresh start with playback resumed),
  // so the saved days and the in-memory days are added together.
  function adopt(text) {
    if (root.loaded) return   // a second `loaded` must not add the file onto memory again
    var parsed = Stats.parseLog(text)
    if (!parsed.ok && service) {
      // Keep the unreadable file beside the new one instead of silently overwriting it.
      service.run(["cp", "-f", root.filePath, root.filePath + ".bad"], null)
    }
    logData = Stats.mergeLogs(parsed.log, logData)
    loaded = true
    revision++
    if (dirty && !saveTimer.running) saveTimer.start()
  }

  Component.onCompleted: file.reload()   // as Service does: do not rely on the FileView preloading
  Component.onDestruction: flush()
}
