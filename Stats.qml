import Quickshell
import QtQuick
import QtQuick.Shapes
import qs.Commons
import "StatsModel.js" as Stats
import "PlayerModel.js" as Player

// Listening stats window: a regular toplevel (like Library.qml), not a layer surface.
// Shows the streak, this week, today against your average, the last 14 days, the burn-down for one
// book with its forecast, the books in progress, and Audible's own yearly total.
// Every number comes from StatsModel.js via service.stats (the ListeningLog). Keyboard first.
Item {
  id: root

  property var service: null
  property bool opened: false
  property int refreshes: 0          // bumped on open so the bindings re-read the clock
  property int selectedIndex: -1     // -1: the loaded (or last) book; 0..n-1: a row in "In progress"
  property string audibleLine: "Checking Audible..."

  // ------------------------------------------------------------ data
  readonly property int rev: (service && service.stats ? service.stats.revision : 0) + refreshes
  readonly property var log: service && service.stats ? service.stats.logData : ({})
  readonly property string today: Stats.dayKey(rev >= 0 ? Date.now() : 0)
  readonly property var summary: rev >= 0 ? Stats.summarize(log, today) : null
  readonly property bool hasLog: summary !== null && summary.allWallSec > 0
  readonly property real maxDayWall: {
    var m = 1
    var days = summary ? summary.days : []
    for (var i = 0; i < days.length; i++) m = Math.max(m, days[i].wallSec)
    return m
  }

  // Books in progress: started or listened, not finished, playable; most recent first.
  readonly property var inProgress: {
    var out = []
    var src = service ? service.books : []
    for (var i = 0; i < src.length; i++) {
      var b = src[i]
      if (b.finished || !b.listenable) continue
      if (!(b.lastListenedAt > 0 || b.percentComplete > 0)) continue
      out.push(b)
    }
    out.sort(function (x, y) { return (y.lastListenedAt || 0) - (x.lastListenedAt || 0) || (y.percentComplete || 0) - (x.percentComplete || 0) })
    return out.slice(0, 5)
  }

  readonly property string hasAsin: service ? (service.hasBook ? service.asin : service.lastAsin) : ""
  readonly property string focusAsin: {
    if (selectedIndex >= 0 && selectedIndex < inProgress.length) return inProgress[selectedIndex].asin
    return hasAsin
  }
  readonly property var focusBook: service && focusAsin !== "" ? service.bookFor(focusAsin) : null

  // Content seconds left for a book: the loaded book from the player, others from the library.
  function remainingFor(asin) {
    if (!service || !asin) return 0
    if (service.hasBook && asin === service.asin && service.duration > 0)
      return Math.max(0, service.duration - service.position)
    var b = service.bookFor(asin)
    if (!b || b.finished) return 0
    return b.remainingSec > 0 ? b.remainingSec : (b.runtimeSec || 0)
  }

  readonly property real focusRemaining: remainingFor(focusAsin)
  readonly property var burn: rev >= 0 && focusAsin !== "" ? Stats.burnDown(log, focusAsin, today, focusRemaining) : null
  readonly property string burnStart: burn && burn.actual.length ? burn.actual[0].day : today
  readonly property string burnEnd: burn && burn.projection.length ? burn.projection[burn.projection.length - 1].day : today
  readonly property int burnSpan: Math.max(1, Stats.dayDiff(burnStart, burnEnd))
  readonly property real burnTop: burn && burn.actual.length ? Math.max(1, burn.actual[0].remainingSec) : 1

  // Audible's own numbers for the current year, shown as one line.
  function fmt(sec) {
    return sec > 0 ? Player.formatDuration(sec, "hm") : "none"
  }

  function speedText() {
    return service ? Player.formatSpeed(service.speed) : "1x"
  }

  function rowText(b) {
    var rem = remainingFor(b.asin)
    var sp = service && service.speed > 0 ? service.speed : 1
    var f = Stats.bookForecast(log, b.asin, today, rem).forecast
    var by = Stats.finishBy(f, today)
    return Player.formatDuration(rem / sp, "hm") + " left at " + speedText() + (by ? "  ·  " + by : "")
  }

  // ------------------------------------------------------------ actions
  function open() {
    if (root.opened) return
    root.opened = true
    root.selectedIndex = -1
    root.refreshes++
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    root.refreshAudible()
  }

  function close() {
    if (!root.opened) return
    root.opened = false
    if (root.service && root.service.statsOpen && typeof root.service.closeStats === "function")
      root.service.closeStats()
  }

  // Opening through the Service sets statsOpen; Esc or the window manager clears it again.
  readonly property bool wanted: service ? service.statsOpen === true : false
  onWantedChanged: { if (wanted) open(); else close() }

  function refreshAudible() {
    if (!service) return
    root.audibleLine = "Checking Audible..."
    service.run(["audible", "stats", "-o", "json"], function (code, out) {
      if (code !== 0) {
        root.audibleLine = "Audible's own total is not available right now."
        return
      }
      var p = Stats.parseAudibleStats(out)
      if (!p.ok) {
        root.audibleLine = "Audible's own total is not available right now."
        return
      }
      var yr = new Date().getFullYear()
      root.audibleLine = Stats.audibleSays(Stats.yearMinutes(p, yr), yr, yr)
    })
  }

  function move(d) {
    var n = inProgress.length
    if (n === 0) return
    selectedIndex = Math.max(-1, Math.min(n - 1, selectedIndex + d))
  }

  function playAsin(a) {
    if (!service || !a) return
    service.play(a)
    root.close()
  }

  function handleKey(event) {
    var k = event.key
    var t = event.text || ""
    if (event.modifiers & (Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier)) return
    if (k === Qt.Key_Escape) root.close()
    else if (k === Qt.Key_Down || t === "j") root.move(1)
    else if (k === Qt.Key_Up || t === "k") root.move(-1)
    else if (k === Qt.Key_Return || k === Qt.Key_Enter) root.playAsin(root.focusAsin)
    else if (t === "r") root.refreshAudible()
    else return
    event.accepted = true
  }

  // ------------------------------------------------------------ burn-down geometry
  // Points for a list of {day, remainingSec}, mapped into a w x h box: x by calendar day, y by remaining.
  function burnPath(list, w, h) {
    var out = []
    if (!burn || !list || list.length === 0 || w <= 0 || h <= 0) return out
    for (var i = 0; i < list.length; i++) {
      var x = Stats.dayDiff(burnStart, list[i].day) / burnSpan * w
      var y = h - (list[i].remainingSec / burnTop) * h
      out.push(Qt.point(x, y))
    }
    return out
  }

  readonly property color ink: Color.menu.text
  readonly property color dim: Qt.alpha(Color.menu.text, 0.6)
  readonly property color faint: Qt.alpha(Color.menu.text, 0.35)
  readonly property string fontFamily: Style.font.family

  // ------------------------------------------------------------ window
  // A regular toplevel: Hyprland tiles it like any other app.
  FloatingWindow {
    id: panel
    title: "Listening stats"
    visible: root.opened
    color: Color.menu.background
    implicitWidth: Style.space(960)
    implicitHeight: Style.space(760)
    minimumSize: Qt.size(Style.space(560), Style.space(480))
    onVisibleChanged: if (!visible && root.opened) root.close()

    Item {
      id: keyCatcher
      anchors.fill: parent
      focus: true
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function (event) { root.handleKey(event) }

      Flickable {
        id: scroller
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: legend.top
        anchors.margins: Style.space(20)
        clip: true
        contentWidth: width
        contentHeight: body.height

        Column {
          id: body
          width: scroller.width
          spacing: Style.space(20)

          // -- header ------------------------------------------------------
          Column {
            width: parent.width
            spacing: Style.space(2)
            Text {
              text: "Listening"
              textFormat: Text.PlainText
              color: root.ink
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
            }
            Text {
              width: parent.width
              text: root.audibleLine
              textFormat: Text.PlainText
              elide: Text.ElideRight
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }

          // -- headline numbers -------------------------------------------
          Row {
            id: tileRow
            width: parent.width
            spacing: Style.space(10)
            readonly property real tileWidth: (width - 3 * spacing) / 4

            Repeater {
              model: root.summary ? [
                { big: root.summary.streak > 0 ? root.summary.streak + (root.summary.streak === 1 ? " day" : " days") : "none yet", small: "streak, 5+ minutes a day" },
                { big: root.fmt(root.summary ? root.summary.week.wallSec : 0), small: "this week (last 7 days)" },
                { big: root.fmt(root.summary ? root.summary.today.wallSec : 0), small: "today, average " + root.fmt(root.summary ? root.summary.average.wallSec : 0) + " a day" },
                { big: root.fmt(root.summary ? root.summary.savedMonthSec : 0), small: "saved by listening faster (30 days)" }
              ] : []

              delegate: Rectangle {
                required property var modelData
                width: tileRow.tileWidth
                height: tileText.implicitHeight + Style.space(24)
                radius: Style.cornerRadius
                color: "transparent"
                border.width: 1
                border.color: root.faint

                Column {
                  id: tileText
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.top: parent.top
                  anchors.margins: Style.space(12)
                  spacing: Style.space(4)
                  Text {
                    width: parent.width
                    text: modelData.big
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    color: root.ink
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.heading
                    font.bold: true
                  }
                  Text {
                    width: parent.width
                    text: modelData.small
                    textFormat: Text.PlainText
                    wrapMode: Text.WordWrap
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }
              }
            }
          }

          // -- last 14 days -----------------------------------------------
          Column {
            width: parent.width
            spacing: Style.space(8)
            Text {
              text: "Last 14 days"
              textFormat: Text.PlainText
              color: root.ink
              font.family: root.fontFamily
              font.pixelSize: Style.font.subtitle
              font.bold: true
            }
            Row {
              id: bars
              width: parent.width
              height: Style.space(140)
              Repeater {
                model: root.summary ? root.summary.days : []
                delegate: Item {
                  required property var modelData
                  width: bars.width / 14
                  height: bars.height

                  Rectangle {
                    anchors.bottom: dayLabel.top
                    anchors.bottomMargin: Style.space(6)
                    anchors.horizontalCenter: parent.horizontalCenter
                    width: Math.max(4, parent.width - Style.space(10))
                    height: modelData.wallSec > 0 ? Math.max(3, (parent.height - Style.space(30)) * modelData.wallSec / root.maxDayWall) : 0
                    radius: Style.space(2)
                    color: modelData.day === root.today ? Color.accent : root.faint
                  }
                  Text {
                    id: dayLabel
                    anchors.bottom: parent.bottom
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: modelData.dow
                    textFormat: Text.PlainText
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }
              }
            }
            Text {
              width: parent.width
              visible: !root.hasLog
              text: "Nothing logged yet. Listen for a few minutes and the bars fill in."
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }

          // -- burn-down for one book --------------------------------------
          Column {
            width: parent.width
            spacing: Style.space(6)
            Text {
              width: parent.width
              text: root.focusBook ? "Burn-down: " + root.focusBook.title : "Burn-down"
              textFormat: Text.PlainText
              elide: Text.ElideRight
              color: root.ink
              font.family: root.fontFamily
              font.pixelSize: Style.font.subtitle
              font.bold: true
            }
            Text {
              width: parent.width
              visible: root.burn !== null
              text: root.burn ? Stats.forecastSentence(root.burn.forecast, root.today) + (root.burn.forecast.days !== null ? "." : "") : ""
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              color: root.ink
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
            Item {
              id: burnBox
              width: parent.width
              height: Style.space(180)
              visible: root.focusAsin !== ""

              Rectangle {
                anchors.fill: parent
                radius: Style.cornerRadius
                color: "transparent"
                border.width: 1
                border.color: root.faint
              }

              Shape {
                id: burnShape
                anchors.fill: parent
                anchors.margins: Style.space(12)
                preferredRendererType: Shape.CurveRenderer

                ShapePath {
                  strokeColor: root.ink
                  strokeWidth: 2
                  fillColor: "transparent"
                  capStyle: ShapePath.RoundCap
                  PathPolyline { path: root.burnPath(root.burn ? root.burn.actual : [], burnShape.width, burnShape.height) }
                }
                ShapePath {
                  strokeColor: Color.accent
                  strokeWidth: 2
                  fillColor: "transparent"
                  strokeStyle: ShapePath.DashLine
                  dashPattern: [4, 4]
                  capStyle: ShapePath.RoundCap
                  PathPolyline { path: root.burnPath(root.burn ? root.burn.projection : [], burnShape.width, burnShape.height) }
                }
              }

              Text {
                anchors.left: parent.left
                anchors.top: parent.top
                anchors.margins: Style.space(12)
                text: root.focusRemaining > 0 ? "left: " + root.fmt(root.focusRemaining) : "finished"
                textFormat: Text.PlainText
                color: root.ink
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }
              Text {
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                anchors.margins: Style.space(12)
                text: root.burn && root.burn.forecast.date ? "done " + Stats.shortDate(root.burn.forecast.date) : ""
                textFormat: Text.PlainText
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                anchors.centerIn: parent
                visible: root.focusRemaining > 0 && root.burn !== null && root.burn.projection.length === 0
                text: "Listen for a few days to see a forecast."
                textFormat: Text.PlainText
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }
            }
            Text {
              width: parent.width
              visible: root.focusAsin !== ""
              text: "solid: where you were · dashed: where you will be at your pace"
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          // -- in progress --------------------------------------------------
          Column {
            width: parent.width
            spacing: Style.space(4)
            Text {
              text: "In progress"
              textFormat: Text.PlainText
              color: root.ink
              font.family: root.fontFamily
              font.pixelSize: Style.font.subtitle
              font.bold: true
            }
            Repeater {
              model: root.inProgress
              delegate: Rectangle {
                required property var modelData
                required property int index
                width: body.width
                height: Style.space(40)
                radius: Style.cornerRadius
                color: index === root.selectedIndex ? Color.menu.selectedBackground : "transparent"

                Row {
                  anchors.fill: parent
                  anchors.leftMargin: Style.space(12)
                  anchors.rightMargin: Style.space(12)
                  spacing: Style.space(12)
                  Text {
                    width: parent.width * 0.5 - Style.space(6)
                    anchors.verticalCenter: parent.verticalCenter
                    text: modelData.title
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    color: index === root.selectedIndex ? Color.menu.selectedText : root.ink
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                  Text {
                    width: parent.width * 0.5 - Style.space(6)
                    anchors.verticalCenter: parent.verticalCenter
                    horizontalAlignment: Text.AlignRight
                    text: root.rowText(modelData)
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    color: index === root.selectedIndex ? Color.menu.selectedText : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }
                }
                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.selectedIndex = index
                  onDoubleClicked: root.playAsin(modelData.asin)
                }
              }
            }
            Text {
              width: parent.width
              visible: root.inProgress.length === 0
              text: "Nothing in progress. Start a book and it shows up here with its time left."
              textFormat: Text.PlainText
              wrapMode: Text.WordWrap
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }
        }
      }

      // -- key legend -----------------------------------------------------
      Text {
        id: legend
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: Style.space(20)
        text: "up/down choose a book · enter play it · r refresh from Audible · esc close"
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }
}
