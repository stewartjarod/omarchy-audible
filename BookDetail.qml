import QtQuick
import qs.Commons
import qs.Ui
import "LibraryModel.js" as Lib

// Details page for one book, shown inside the library window: cover, facts, your progress, the
// publisher's summary, and clear buttons (Play / Continue / Listen again, Download or Delete download,
// Mark finished, More in this series). Keyboard first: Enter does the highlighted button, Left/Right/Tab
// move between buttons, and P, D, X, M, S are shortcuts; Esc or Backspace goes back.
Item {
  id: root

  property var book: null            // the live Book (the library re-reads it as data changes)
  property var service: null
  property string note: ""           // one line of feedback from the last action
  property int focusIndex: 0

  signal backRequested()
  signal activated(string id)        // play | toggle | download | remove | finish | unfinish | series

  readonly property color background: Color.menu.background
  readonly property color foreground: Color.menu.text
  readonly property color border: Color.menu.border
  readonly property color selectedBackground: Color.menu.selectedBackground
  readonly property color selectedText: Color.menu.selectedText
  readonly property color muted: Color.muted
  readonly property color accent: Color.accent
  readonly property color urgent: Color.urgent
  readonly property string fontFamily: Style.font.menuFamily
  readonly property int cornerRadius: Style.cornerRadius

  // ---- what is true about this book right now
  readonly property string asin: book ? book.asin : ""
  readonly property bool isLocal: !!service && !!service.localAsins && service.localAsins[asin] === true
  readonly property var dl: (service && service.downloads && service.downloads[asin]) ? service.downloads[asin] : null
  readonly property bool isCurrent: !!service && service.hasBook === true && service.asin === asin
  readonly property real resumeSec: (service && service.resume && service.resume[asin]) ? Number(service.resume[asin].position) || 0 : 0
  readonly property real speed: service && Number(service.speed) > 0 ? Number(service.speed) : 1
  readonly property real mb: book ? Math.max(1, (Number(book.runtimeSec) || 0) * 16000 / 1048576) : 0

  // HOOK(discover): Up next, wishlist and "More like this" (see Queue.qml, Catalog.qml)
  readonly property var catalog: service && service.catalog ? service.catalog : null
  readonly property var queueApi: service && service.queue ? service.queue : null
  readonly property bool notOwned: !!book && book.inLibrary === false
  readonly property bool inWish: !!catalog && notOwned && catalog.inWishlist(asin)
  readonly property bool inQueue: !!queueApi && asin !== "" && queueApi.has(asin)
  readonly property var similar: catalog && asin !== "" ? catalog.similarFor(asin) : []
  readonly property bool similarBusy: !!catalog && asin !== "" && catalog.similarPending(asin)
  property int stripFocus: -1          // -1: the buttons have focus; 0..n-1: a "More like this" book
  property string localNote: ""        // feedback from Up next actions
  readonly property string writeNote: catalog ? catalog.writeNote : ""

  readonly property var acts: book && !notOwned
    ? Lib.detailActions(book, { local: isLocal, dl: dl, isCurrent: isCurrent, isPlaying: isCurrent && service.playing === true, resumeSec: resumeSec, mb: mb })
    : null
  readonly property var facts: book ? Lib.detailFacts(book) : []
  readonly property bool inSeries: !!book && !!book.series && !!book.series.title

  readonly property var buttons: {
    if (notOwned) {
      return [inWish
        ? { id: "wish-remove", label: "Remove from wishlist", enabled: true, primary: true, key: "W" }
        : { id: "wish-add", label: "Add to wishlist", enabled: true, primary: true, key: "W" }]
    }
    if (!acts) return []
    var list = [
      { id: acts.primary.id, label: acts.primary.label, enabled: acts.primary.enabled, primary: true, key: "P" },
      { id: acts.download.id, label: acts.download.label, enabled: acts.download.enabled, primary: false, key: acts.download.id === "remove" ? "X" : "D" },
      { id: acts.finish.id, label: acts.finish.label, enabled: acts.finish.enabled, primary: false, key: "M" }
    ]
    if (inSeries) list.push({ id: "series", label: "More in " + book.series.title, enabled: true, primary: false, key: "S" })
    var off = service ? service.phoneOffer : null   // HOOK(sync): resume from the phone position
    if (off && off.asin === book.asin) list.splice(1, 0, { id: "phone", label: "Resume from phone: " + off.label, enabled: true, primary: false, key: "R" })
    list.push({ id: inQueue ? "queue-remove" : "queue-add", label: inQueue ? "Remove from Up next" : "Add to Up next", enabled: true, primary: false, key: "U" })
    list.push({ id: "queue-next", label: "Play next", enabled: !isCurrent && book.listenable !== false, primary: false, key: "N" })
    return list
  }

  // The one line under the buttons: a write waiting for confirmation, Up next feedback, Library notes, or the hint.
  readonly property bool hintIsNote: writeNote !== "" || localNote !== "" || note !== ""
  readonly property string hintText: writeNote !== "" ? writeNote
    : (localNote !== "" ? localNote
      : (note !== "" ? note
        : (acts ? acts.hint : (notOwned ? "Not in your library. Add it to your wishlist to keep track of it." : ""))))

  // "46% · 5h 28m left at 1.7x"
  readonly property string progressText: {
    if (!book) return ""
    if (book.finished) return book.playCount > 1 ? "Finished · listened " + book.playCount + " times" : "Finished"
    var total = Number(book.runtimeSec) || 0
    var pct = Math.round(Number(book.percentComplete) || 0)
    var done = resumeSec > 0 ? resumeSec : total * pct / 100
    if (done <= 0 || total <= 0) return "Not started"
    var left = Math.max(0, total - done) / speed
    return Math.round(100 * done / total) + "% · " + Lib.formatRuntime(left) + " left" + (speed !== 1 ? " at " + (Math.round(speed * 100) / 100) + "x" : "")
  }
  readonly property real progressFraction: book ? Lib.progressFraction({ percentComplete: book.finished ? 100 : book.percentComplete, resumeSec: resumeSec, runtimeSec: book.runtimeSec }) : 0

  onAsinChanged: {
    focusIndex = 0
    stripFocus = -1
    localNote = ""
    if (catalog) {
      catalog.cancelWrite()
      catalog.ensureDetail(asin)
      catalog.ensureSims(asin)
    }
  }
  onButtonsChanged: if (focusIndex >= buttons.length) focusIndex = 0

  function move(dir) {
    var n = buttons.length
    if (n === 0) return
    var i = focusIndex
    for (var step = 0; step < n; step++) {
      i = (i + dir + n) % n
      if (buttons[i].enabled) { focusIndex = i; return }
    }
  }

  function activate(i) {
    var b = buttons[i]
    if (b && b.id === "phone") { if (service && book) service.acceptPhonePosition(book.asin); return }   // HOOK(sync)
    if (b && b.enabled && b.id !== "none") runButton(b.id)
  }

  function runButton(id) {
    if (id === "wish-add" || id === "wish-remove") {
      // Guarded: the first press explains, the second press on the same book does it (Catalog.requestWrite).
      if (catalog) catalog.requestWrite(id === "wish-add" ? "add" : "remove", asin, book ? book.title : "")
      return
    }
    if (id === "queue-add") { if (queueApi) localNote = queueApi.add(asin); return }
    if (id === "queue-remove") { if (queueApi) localNote = queueApi.remove(asin); return }
    if (id === "queue-next") { if (queueApi) localNote = queueApi.playNext(asin); return }
    activated(id)
  }

  // Opens another book's details (the Library keeps a way back to this one).
  function openSimilar(i) {
    var s = similar[i]
    if (s && s.asin) activated("open:" + s.asin)
  }

  function moveStrip(dir) {
    var n = Math.min(similar.length, 6)
    if (n === 0) return
    stripFocus = Math.max(0, Math.min(n - 1, stripFocus + dir))
  }

  function fire(id) {
    for (var i = 0; i < buttons.length; i++) if (buttons[i].id === id) { activate(i); return }
  }

  // Returns true when the key was used (the details page is modal for the keyboard).
  function handleKey(event) {
    var k = event.key
    var t = (event.text || "").toLowerCase()
    if (k === Qt.Key_Escape || k === Qt.Key_Backspace) {
      if (catalog && catalog.writeAsin !== "") { catalog.cancelWrite(); return true }
      if (stripFocus >= 0) { stripFocus = -1; return true }
      backRequested()
      return true
    }
    if (stripFocus >= 0) {
      if (k === Qt.Key_Left) { moveStrip(-1); return true }
      if (k === Qt.Key_Right) { moveStrip(1); return true }
      if (k === Qt.Key_Up) { stripFocus = -1; return true }
      if (k === Qt.Key_Return || k === Qt.Key_Enter) { openSimilar(stripFocus); return true }
    } else if (k === Qt.Key_Down && similar.length > 0) {
      stripFocus = 0
      return true
    }
    if (k === Qt.Key_Left || k === Qt.Key_Backtab) { move(-1); return true }
    if (k === Qt.Key_Right || k === Qt.Key_Tab) { move(1); return true }
    if (k === Qt.Key_Return || k === Qt.Key_Enter) { activate(focusIndex); return true }
    if (event.modifiers & (Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier)) return true
    if (t === "p") { if (acts) fire(acts.primary.id) }
    else if (t === "d") fire("download")
    else if (t === "x") fire("remove")
    else if (t === "m") { fire("finish"); fire("unfinish") }
    else if (t === "s") fire("series")
    else if (t === "r") fire("phone")   // HOOK(sync)
    else if (t === "u") fire(inQueue ? "queue-remove" : "queue-add")
    else if (t === "n") fire("queue-next")
    else if (t === "w" && notOwned) fire(inWish ? "wish-remove" : "wish-add")
    return true
  }

  // ---------------------------------------------------------------------- drawing
  Rectangle { anchors.fill: parent; color: root.background }
  MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons }   // swallow clicks meant for the grid

  Item {
    anchors.fill: parent
    anchors.margins: Style.space(28)

    Text {
      id: backLink
      anchors.left: parent.left
      anchors.top: parent.top
      textFormat: Text.PlainText
      text: "‹ Back  (Esc)"
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      MouseArea { anchors.fill: parent; anchors.margins: -Style.space(6); cursorShape: Qt.PointingHandCursor; onClicked: root.backRequested() }
    }

    Row {
      id: body
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: backLink.bottom
      anchors.topMargin: Style.space(18)
      anchors.bottom: legend.top
      anchors.bottomMargin: Style.space(14)
      spacing: Style.space(28)

      // ---- cover
      Item {
        id: coverCol
        width: Math.min(Style.space(300), body.width * 0.34)
        height: parent.height

        Rectangle {
          id: coverFrame
          width: parent.width
          height: parent.width
          color: Util.alpha(root.foreground, 0.08)

          Text {
            anchors.centerIn: parent
            visible: cover.status !== Image.Ready
            text: root.book && root.book.title ? root.book.title.charAt(0).toUpperCase() : ""
            color: root.muted
            opacity: 0.6
            font.family: root.fontFamily
            font.pixelSize: Style.font.displayLarge
          }
          Image {
            id: cover
            anchors.fill: parent
            source: root.book && root.book.coverUrl ? root.book.coverUrl : ""
            asynchronous: true
            cache: true
            smooth: true
            fillMode: Image.PreserveAspectCrop
            sourceSize: Qt.size(Style.space(600), Style.space(600))
          }
        }

        Rectangle {
          anchors.left: coverFrame.left
          anchors.top: coverFrame.bottom
          anchors.topMargin: Style.space(6)
          width: coverFrame.width
          height: Style.space(4)
          color: Util.alpha(root.foreground, 0.12)
          Rectangle { width: parent.width * root.progressFraction; height: parent.height; color: root.accent }
        }
      }

      // ---- text and actions
      Column {
        id: info
        width: body.width - coverCol.width - body.spacing
        height: parent.height
        spacing: Style.space(10)

        Text {
          width: parent.width
          text: root.book ? root.book.title : ""
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          maximumLineCount: 3
          elide: Text.ElideRight
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.display
          font.bold: true
        }

        Text {
          width: parent.width
          visible: text !== ""
          text: root.book && root.book.subtitle ? root.book.subtitle : ""
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          maximumLineCount: 2
          elide: Text.ElideRight
          color: Util.alpha(root.foreground, 0.7)
          font.family: root.fontFamily
          font.pixelSize: Style.font.heading
        }

        // facts
        Column {
          width: parent.width
          spacing: Style.space(3)
          Repeater {
            model: root.facts
            Row {
              required property var modelData
              width: info.width
              spacing: Style.space(12)
              Text {
                width: Style.space(96)
                text: parent.modelData.label
                textFormat: Text.PlainText
                color: root.muted
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
              Text {
                width: parent.width - Style.space(96) - parent.spacing
                text: parent.modelData.value
                textFormat: Text.PlainText
                elide: Text.ElideRight
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
            }
          }
        }

        // your progress, and whether it is on this computer
        Text {
          width: parent.width
          text: root.notOwned ? "Not in your library" : root.progressText + "   ·   " + (root.isLocal ? "Downloaded" : (root.dl && root.dl.state === "downloading" ? "Downloading…" : "Not downloaded"))
          textFormat: Text.PlainText
          elide: Text.ElideRight
          color: root.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
          topPadding: Style.space(4)
        }

        // ---- buttons
        Flow {
          id: buttonRow
          width: parent.width
          spacing: Style.space(10)

          Repeater {
            model: root.buttons

            BorderSurface {
              id: btn
              required property int index
              required property var modelData

              readonly property bool focused: root.focusIndex === index
              readonly property bool on: modelData.enabled && modelData.id !== "none"

              width: label.implicitWidth + Style.space(32)
              height: Style.space(38)
              opacity: on ? 1 : 0.45
              color: focused && on ? (modelData.primary ? Util.alpha(root.accent, 0.28) : root.selectedBackground)
                : (modelData.primary && on ? Util.alpha(root.accent, 0.12) : "transparent")
              borderSpec: Border.flat(focused && on ? root.accent : Util.alpha(root.foreground, modelData.primary ? 0.6 : 0.34), Style.normalBorderWidth)
              radius: 0

              Text {
                id: label
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: (btn.modelData.id === "play" || btn.modelData.id === "toggle" ? "▶  " : "") + btn.modelData.label
                color: btn.focused && btn.on ? root.accent : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: btn.modelData.primary
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                enabled: btn.on
                cursorShape: Qt.PointingHandCursor
                onEntered: root.focusIndex = btn.index
                onClicked: root.activate(btn.index)
              }
            }
          }
        }

        Text {
          width: parent.width
          visible: text !== ""
          text: root.hintText
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          color: root.hintIsNote ? root.foreground : root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
        }

        // ---- more like this (catalog suggestions; Down enters the strip, Enter opens a book)
        Column {
          id: similarBox
          width: parent.width
          visible: root.similar.length > 0 || root.similarBusy
          spacing: Style.space(6)

          Text {
            width: parent.width
            text: root.similar.length > 0 ? "More like this" : "More like this: looking..."
            textFormat: Text.PlainText
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true
          }

          Row {
            spacing: Style.space(10)
            Repeater {
              model: root.similar.slice(0, 6)

              Item {
                id: sim
                required property int index
                required property var modelData
                readonly property bool focused: root.stripFocus === index

                width: Style.space(96)
                height: Style.space(146)

                Rectangle {
                  anchors.fill: parent
                  color: sim.focused ? root.selectedBackground : "transparent"
                  border.width: sim.focused ? Style.normalBorderWidth : 0
                  border.color: root.accent
                }

                Rectangle {
                  id: simCover
                  x: Style.space(4)
                  y: Style.space(4)
                  width: parent.width - Style.space(8)
                  height: width
                  color: Util.alpha(root.foreground, 0.08)
                  Image {
                    anchors.fill: parent
                    source: sim.modelData.coverUrl ? sim.modelData.coverUrl : ""
                    asynchronous: true
                    cache: true
                    smooth: true
                    fillMode: Image.PreserveAspectCrop
                    sourceSize: Qt.size(Style.space(200), Style.space(200))
                  }
                }

                Text {
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.top: simCover.bottom
                  anchors.topMargin: Style.space(4)
                  anchors.leftMargin: Style.space(4)
                  anchors.rightMargin: Style.space(4)
                  text: sim.modelData.title
                  textFormat: Text.PlainText
                  wrapMode: Text.Wrap
                  maximumLineCount: 2
                  elide: Text.ElideRight
                  color: sim.focused ? root.selectedText : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                MouseArea {
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onEntered: root.stripFocus = sim.index
                  onClicked: root.openSimilar(sim.index)
                }
              }
            }
          }
        }

        // ---- summary
        Flickable {
          id: summaryFlick
          width: parent.width
          height: Math.max(Style.space(60), info.height - y)
          contentWidth: width
          contentHeight: summary.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          visible: summary.text !== ""

          Text {
            id: summary
            width: summaryFlick.width
            text: root.book && root.book.description ? root.book.description : ""
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.foreground
            opacity: 0.85
            lineHeight: 1.15
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }
        }
      }
    }

    Text {
      id: legend
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      textFormat: Text.PlainText
      elide: Text.ElideRight
      text: root.notOwned
        ? "Enter do it  ·  W wishlist  ·  Down more like this  ·  Esc back"
        : "Enter do it  ·  ←/→ choose  ·  P play  ·  D download  ·  X delete  ·  M finished" + (root.inSeries ? "  ·  S series" : "") + "  ·  U up next  ·  N play next  ·  Down more like this  ·  Esc back"
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }
  }
}
