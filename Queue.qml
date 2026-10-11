import QtQuick
import Quickshell.Io
import "QueueModel.js" as Q

// "Up next": the books to hear after the current one, in order. Local only: the list lives in
// ~/.local/state/jarod-audible/queue.json and nothing here talks to Audible. A book leaves the queue
// when it starts playing (so auto-advance and "Play" both consume it).
// Instantiated inside Service.qml as `queueCtl` (HOOK(discover)); the Service exposes it as `queue`.
Item {
  id: root

  property var svc: null              // the Service (for stateDir, run(), books, asin)
  property var asins: []              // ordered ASINs
  property bool loaded: false

  // The queue's books that are still ahead of you (queue order). Reads svc.books.
  readonly property var pendingBooks: Q.pending(root.asins, root.svc ? root.svc.books : null)
  readonly property int count: pendingBooks.length

  FileView {
    id: file
    path: root.svc ? root.svc.stateDir + "/queue.json" : ""
    onLoaded: {
      // Edits made before the file arrived are kept: merge them on top of what was saved.
      root.asins = Q.dedupe(root.asins.concat(Q.parseQueue(String(file.text()))))
      root.loaded = true
      root.prune()
    }
    onLoadFailed: root.loaded = true
  }

  function saveSoon() { saveTimer.restart() }
  Timer {
    id: saveTimer
    interval: 600
    onTriggered: {
      if (!root.svc) return
      var body = Q.serialize(root.asins)
      root.svc.run(["mkdir", "-p", root.svc.stateDir], function() { file.setText(body) })
    }
  }

  function setList(list) {
    var next = Q.dedupe(list)
    if (JSON.stringify(next) === JSON.stringify(root.asins)) return
    root.asins = next
    root.saveSoon()
  }

  function has(asin) { return Q.has(root.asins, asin) }

  // The user-facing messages below are what the details page and the library show.
  function add(asin) {
    if (Q.has(root.asins, asin)) return "Already in Up next."
    setList(Q.addToEnd(root.asins, asin))
    return "Added to Up next."
  }

  function playNext(asin) {
    if (!Q.cleanAsin(asin)) return ""
    setList(Q.playNext(root.asins, asin))
    return "This book plays next."
  }

  function remove(asin) {
    if (!Q.has(root.asins, asin)) return "Not in Up next."
    setList(Q.remove(root.asins, asin))
    return "Removed from Up next."
  }

  function moveUp(asin) { setList(Q.moveUp(root.asins, asin)) }
  function moveDown(asin) { setList(Q.moveDown(root.asins, asin)) }
  function clear() { setList(Q.clear()) }

  // Drops finished and unknown books. Skipped while the library is empty (not loaded yet).
  function prune() {
    if (!root.svc || !Array.isArray(root.svc.books) || root.svc.books.length === 0) return
    setList(Q.prune(root.asins, root.svc.books))
  }

  // The asin that should follow `currentAsin` (see QueueModel.next). "" when there is nothing next.
  function next(currentAsin) {
    return Q.next(root.asins, currentAsin, root.svc ? root.svc.books : null)
  }

  // A queued book that starts playing has been heard from; it is no longer "up next".
  Connections {
    target: root.svc
    ignoreUnknownSignals: true
    function onAsinChanged() {
      if (root.svc && root.svc.asin && Q.has(root.asins, root.svc.asin)) root.setList(Q.remove(root.asins, root.svc.asin))
    }
    function onBooksChanged() {
      if (root.loaded) root.prune()
    }
  }
}
