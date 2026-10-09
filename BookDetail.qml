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

  readonly property var acts: book
    ? Lib.detailActions(book, { local: isLocal, dl: dl, isCurrent: isCurrent, isPlaying: isCurrent && service.playing === true, resumeSec: resumeSec, mb: mb })
    : null
  readonly property var facts: book ? Lib.detailFacts(book) : []
  readonly property bool inSeries: !!book && !!book.series && !!book.series.title

  readonly property var buttons: {
    if (!acts) return []
    var list = [
      { id: acts.primary.id, label: acts.primary.label, enabled: acts.primary.enabled, primary: true, key: "P" },
      { id: acts.download.id, label: acts.download.label, enabled: acts.download.enabled, primary: false, key: acts.download.id === "remove" ? "X" : "D" },
      { id: acts.finish.id, label: acts.finish.label, enabled: acts.finish.enabled, primary: false, key: "M" }
    ]
    if (inSeries) list.push({ id: "series", label: "More in " + book.series.title, enabled: true, primary: false, key: "S" })
    return list
  }

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

  onAsinChanged: focusIndex = 0
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
    if (b && b.enabled && b.id !== "none") activated(b.id)
  }

  function fire(id) {
    for (var i = 0; i < buttons.length; i++) if (buttons[i].id === id) { activate(i); return }
  }

  // Returns true when the key was used (the details page is modal for the keyboard).
  function handleKey(event) {
    var k = event.key
    var t = (event.text || "").toLowerCase()
    if (k === Qt.Key_Escape || k === Qt.Key_Backspace) { backRequested(); return true }
    if (k === Qt.Key_Left || k === Qt.Key_Backtab) { move(-1); return true }
    if (k === Qt.Key_Right || k === Qt.Key_Tab) { move(1); return true }
    if (k === Qt.Key_Return || k === Qt.Key_Enter) { activate(focusIndex); return true }
    if (event.modifiers & (Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier)) return true
    if (t === "p") { if (acts) fire(acts.primary.id) }
    else if (t === "d") fire("download")
    else if (t === "x") fire("remove")
    else if (t === "m") { fire("finish"); fire("unfinish") }
    else if (t === "s") fire("series")
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
          text: root.progressText + "   ·   " + (root.isLocal ? "Downloaded" : (root.dl && root.dl.state === "downloading" ? "Downloading…" : "Not downloaded"))
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
          text: root.note !== "" ? root.note : (root.acts ? root.acts.hint : "")
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          color: root.note !== "" ? root.foreground : root.muted
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
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
      text: "Enter do it  ·  ←/→ choose  ·  P play  ·  D download  ·  X delete  ·  M finished" + (root.inSeries ? "  ·  S series" : "") + "  ·  Esc back"
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }
  }
}
