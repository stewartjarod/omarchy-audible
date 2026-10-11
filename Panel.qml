import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "PlayerModel.js" as Model

// Audible player popup: time-left readout, whole-book progress with chapter
// ticks and a playhead (click to seek), transport + speed controls, and the
// chapter list. Keyboard-first; every surface shows a key legend.
Panel {
  id: root
  moduleName: "jarod.audible"
  ipcTarget: "jarod.audible"
  manageIpc: false // BarWidget.qml owns the IPC surface for this plugin

  property var service: null
  property var anchorItem: null

  // The bar tracks the widget mounted in its slot (BarWidget.qml), not this
  // nested panel, so the popout coordinator compares against the host widget.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.4)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color hoverFill: Style.hoverFillFor(foreground, Color.accent)
  readonly property color selectedFill: Style.selectedFillFor(foreground, Color.accent)

  // ---- service state (read-only mirror) ------------------------------------

  function svc(name, fallback) {
    var v = service ? service[name] : undefined
    return v === undefined || v === null ? fallback : v
  }

  readonly property bool ready: svc("ready", false) === true
  readonly property bool hasBook: svc("hasBook", false) === true
  readonly property var phoneOffer: svc("phoneOffer", null)   // HOOK(sync)
  function acceptOffer() { if (service && phoneOffer) service.acceptPhonePosition(phoneOffer.asin) }   // HOOK(sync)
  readonly property bool paused: svc("paused", true) === true
  readonly property var chapters: svc("chapters", [])
  readonly property int chapterCount: chapters ? chapters.length : 0
  readonly property real duration: Math.max(0, Number(svc("duration", 0)) || 0)
  readonly property real position: Math.max(0, Number(svc("position", 0)) || 0)
  readonly property real speed: Number(svc("speed", 1)) || 1
  readonly property int currentChapter: Math.max(0, Math.floor(Number(svc("chapterIndex", 0)) || 0))
  readonly property real bookLeft: Math.max(0, Number(svc("timeLeftSec", 0)) || 0)
  readonly property real chapterLeft: Math.max(0, Number(svc("chapterTimeLeftSec", 0)) || 0)
  readonly property real progress: duration > 0 ? Math.min(1, position / duration) : 0
  readonly property int skip: Math.max(1, Math.round(Number(svc("skipSeconds", 30)) || 30))
  readonly property var speedOpts: ({
    step: Number(svc("speedStep", 0.05)) || 0.05,
    min: Number(svc("speedMin", 0.5)) || 0.5,
    max: Number(svc("speedMax", 3)) || 3
  })
  readonly property var chapterTicks: Model.chapterTicks(chapters, duration)
  readonly property var currentChapterObj: chapterCount > 0 && currentChapter < chapterCount ? chapters[currentChapter] : null
  readonly property string chapterName: currentChapterObj ? currentChapterObj.title : ""

  // ---- cursor (chapter list) ----------------------------------------------

  property int cursor: 0
  readonly property int rowH: Style.spacing.popupRowHeight + Style.space(4)
  readonly property int listMaxH: Style.space(200)

  function clampCursor() {
    if (chapterCount <= 0) cursor = 0
    else cursor = Math.max(0, Math.min(chapterCount - 1, cursor))
  }

  function scrollToCursor() {
    if (!chapterFlick) return
    Qt.callLater(function() {
      if (!chapterFlick) return
      var y = root.cursor * root.rowH
      var viewTop = chapterFlick.contentY
      var viewH = chapterFlick.height
      var maxY = Math.max(0, chapterFlick.contentHeight - viewH)
      if (y < viewTop) chapterFlick.contentY = Math.max(0, y)
      else if (y + root.rowH > viewTop + viewH) chapterFlick.contentY = Math.min(maxY, y + root.rowH - viewH)
    })
  }

  function moveCursor(delta) {
    if (chapterCount <= 0) return
    cursor = Math.max(0, Math.min(chapterCount - 1, cursor + delta))
    scrollToCursor()
  }

  function jumpCursor() {
    if (!service || !hasBook || chapterCount <= 0) return
    service.jumpToChapter(cursor)
  }

  onCurrentChapterChanged: {
    cursor = currentChapter
    scrollToCursor()
  }

  onChapterCountChanged: clampCursor()

  onOpenedChanged: {
    if (opened) {
      cursor = currentChapter
      clampCursor()
      scrollToCursor()
      if (service) service.prefetchCurrent()   // HOOK(sync): refresh the phone position in the background
    }
  }

  // ---- commands -----------------------------------------------------------

  readonly property var lastBook: svc("lastBook", null)
  readonly property string pendingStatus: String(svc("pendingStatus", ""))
  readonly property real pendingFraction: Number(svc("pendingFraction", -1))
  // "5h 28m left at 1.7x" for the book we would continue, at the current speed.
  readonly property string continueMeta: {
    if (!lastBook) return ""
    var total = Number(lastBook.runtimeSec) || 0
    var done = Number(lastBook.resumeSec) > 0 ? Number(lastBook.resumeSec) : total * (Number(lastBook.percentComplete) || 0) / 100
    var left = Math.max(0, total - done)
    return left > 0 ? Model.formatDuration(left / (speed > 0 ? speed : 1), "hm") + " left at " + Model.formatSpeed(speed) : ""
  }
  readonly property string continueCover: {
    if (!lastBook || !service) return ""
    var local = service.localAsins && service.localAsins[lastBook.asin]
    return local ? "file://" + service.booksDir + "/" + lastBook.asin + "/" + lastBook.asin + ".cover_500.jpg" : (lastBook.coverUrl || "")
  }

  function togglePlay() {
    if (!service) return
    if (hasBook) service.togglePause()
    else if (lastBook) service.continueLast()
  }
  function seekBy(delta) { if (service && hasBook) service.seekBy(delta) }
  function nextChapter() { if (service && hasBook) service.nextChapter() }
  function prevChapter() { if (service && hasBook) service.prevChapter() }
  function stepSpeed(dir) { if (service) service.stepSpeed(dir) }
  readonly property real volume: Number(svc("volume", 100))
  readonly property bool muted: svc("muted", false) === true
  readonly property int volumeStep: Math.max(1, Math.round(Number(svc("volumeStep", 5)) || 5))
  readonly property int volumeMax: Math.max(100, Math.round(Number(svc("volumeMax", 130)) || 130))
  function stepVolume(dir) { if (service) service.stepVolume(dir) }
  function toggleMute() { if (service) service.toggleMute() }
  function setVolumeFromSlider(v) { if (service) service.setVolume(v) }

  function seekAt(x) {
    if (!service || !hasBook || duration <= 0 || progressTrack.width <= 0) return
    var f = Math.max(0, Math.min(1, x / progressTrack.width))
    service.seekTo(f * duration)
  }

  function openLibrary() {
    root.close()
    if (service) service.openLibrary()
  }

  function openStats() {   // HOOK(stats)
    root.close()
    if (service) service.openStats()
  }

  // "time left: 3h 12m · finish by Fri" under the progress bar, from the listening log (HOOK(stats)).
  readonly property string finishHint: {
    var st = service ? service.stats : null
    var a = svc("asin", "")
    if (!hasBook || !st || !a || bookLeft <= 0) return ""
    var by = st.finishHint(a, bookLeft * speed)
    return "time left: " + Model.formatDuration(bookLeft, "hm") + (by ? " · " + by : "")
  }

  function setSpeedFromSlider(v) {
    if (!service) return
    service.setSpeed(Model.stepSpeed(v, 0, speedOpts))
  }

  // Keys. Plain letters and arrows only; Ctrl/Alt/Meta pass through. Before
  // the book is ready only Esc is taken so Onboarding receives typing.
  function handleKey(event) {
    var k = event.key
    var t = event.text || ""
    if (k === Qt.Key_Escape) { root.close(); event.accepted = true; return }
    if (!root.ready) return
    if (event.modifiers & (Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier)) return

    var handled = true
    if (k === Qt.Key_Space) togglePlay()
    else if (k === Qt.Key_Return || k === Qt.Key_Enter) {
      if (phoneOffer) acceptOffer()   // HOOK(sync): Enter takes the phone offer first
      else if (!hasBook && lastBook) togglePlay()
      else jumpCursor()
    }
    else if (k === Qt.Key_Down || t === "j") moveCursor(1)
    else if (k === Qt.Key_Up || t === "k") moveCursor(-1)
    else if (k === Qt.Key_Left || t === "h") seekBy(-root.skip)
    else if (k === Qt.Key_Right || t === "l") seekBy(root.skip)
    else if (k === Qt.Key_Home) { cursor = 0; scrollToCursor() }
    else if (k === Qt.Key_End) { cursor = Math.max(0, chapterCount - 1); scrollToCursor() }
    else if (t === "n") nextChapter()
    else if (t === "p") prevChapter()
    else if (t === "[" || t === "-" || t === "_") stepSpeed(-1)
    else if (t === "]" || t === "+" || t === "=") stepSpeed(1)
    else if (t === "9") stepVolume(-1)
    else if (t === "0") stepVolume(1)
    else if (t === "m") toggleMute()
    else if (t === "o") openLibrary()
    else if (t === "z") { if (root.service && root.service.listening) root.service.listening.cycleSleep() }  // HOOK(listen)
    else if (t === "Z") { if (root.service && root.service.listening) root.service.listening.addRunningPreset() }  // HOOK(listen)
    else if (t === "i") openStats()   // HOOK(stats)
    else handled = false

    if (handled) event.accepted = true
  }

  // ---- panel body ---------------------------------------------------------

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keys
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(root.ready ? column.implicitHeight : onboarding.implicitHeight, Style.space(640))

    Item {
      id: keys
      anchors.fill: parent
      focus: true
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) { root.handleKey(event) }

      // Setup not finished: the Onboarding flow takes over this surface.
      Onboarding {
        id: onboarding
        anchors.fill: parent
        visible: !root.ready
        service: root.service
        onCloseRequested: root.close()
      }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(10)
        visible: root.ready

        // -- getting a book ready: download / start progress -----------------
        Column {
          width: parent.width
          spacing: Style.space(4)
          visible: root.pendingStatus !== ""

          Text {
            width: parent.width
            text: root.pendingStatus
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            font.bold: true
          }
          Rectangle {
            width: parent.width
            height: Style.space(3)
            radius: height / 2
            color: root.hoverFill

            Rectangle {
              height: parent.height
              radius: parent.radius
              color: Color.accent
              width: root.pendingFraction >= 0 ? parent.width * root.pendingFraction : parent.width * 0.3
              // no percentage yet (waiting / starting): a slim bar that sweeps back and forth
              SequentialAnimation on x {
                running: root.pendingStatus !== "" && root.pendingFraction < 0
                loops: Animation.Infinite
                NumberAnimation { from: 0; to: Style.space(260); duration: 900; easing.type: Easing.InOutQuad }
                NumberAnimation { from: Style.space(260); to: 0; duration: 900; easing.type: Easing.InOutQuad }
              }
            }
          }
        }

        // -- phone offer: Audible has a further position than this computer --
        Item {   // HOOK(sync)
          width: parent.width
          height: phoneOfferButton.height
          visible: root.phoneOffer !== null

          PanelActionButton {
            id: phoneOfferButton
            anchors.horizontalCenter: parent.horizontalCenter
            iconText: root.phoneOffer ? "Resume from phone: " + root.phoneOffer.label + "  (Enter)" : ""
            fontSize: Style.font.body
            fontFamily: root.fontFamily
            foreground: root.foreground
            onClicked: root.acceptOffer()
          }
        }

        // -- header: cover, title, author -----------------------------------
        Row {
          id: header
          width: parent.width
          spacing: Style.space(10)
          visible: root.hasBook

          Rectangle {
            id: coverFrame
            width: Style.space(52)
            height: width
            radius: Style.cornerRadius
            color: root.hoverFill
            clip: true

            Image {
              anchors.fill: parent
              source: root.svc("coverUrl", "")
              asynchronous: true
              fillMode: Image.PreserveAspectCrop
              visible: source !== ""
            }
          }

          Column {
            width: parent.width - coverFrame.width - header.spacing
            anchors.verticalCenter: coverFrame.verticalCenter
            spacing: Style.space(2)

            Text {
              width: parent.width
              text: root.svc("title", "")
              textFormat: Text.PlainText
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
            }
            Text {
              width: parent.width
              text: root.svc("author", "")
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideRight
              visible: text !== ""
            }
          }
        }

        // -- time-left readout ----------------------------------------------
        Row {
          width: parent.width
          visible: root.hasBook

          Column {
            width: parent.width * 0.58
            spacing: 0

            Text {
              id: bigLeft
              text: Model.formatDuration(root.bookLeft, "hm")
              textFormat: Text.PlainText
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
              font.bold: true
            }
            Text {
              text: "left in book at " + Model.formatSpeed(root.speed)
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }
          }

          Column {
            width: parent.width * 0.42
            spacing: 0

            Text {
              width: parent.width
              horizontalAlignment: Text.AlignRight
              text: root.chapterCount > 0 ? "Chapter " + (root.currentChapter + 1) + " of " + root.chapterCount : ""
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }
            Text {
              width: parent.width
              horizontalAlignment: Text.AlignRight
              text: Model.formatDuration(root.chapterLeft, "left")
              textFormat: Text.PlainText
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
            }
          }
        }

        // -- whole-book progress: track, chapter ticks, playhead --------------
        Column {
          width: parent.width
          spacing: Style.space(4)
          visible: root.hasBook

          Item {
            id: progressTrack
            width: parent.width
            height: Style.space(18)

            readonly property real trackH: Style.space(4)
            readonly property real trackY: (height - trackH) / 2

            Rectangle {
              x: 0
              y: progressTrack.trackY
              width: parent.width
              height: progressTrack.trackH
              radius: height / 2
              color: root.selectedFill
            }

            Rectangle {
              x: 0
              y: progressTrack.trackY
              width: parent.width * root.progress
              height: progressTrack.trackH
              radius: height / 2
              color: root.foreground
            }

            Repeater {
              model: root.chapterTicks

              delegate: Rectangle {
                required property real modelData
                x: Math.round(progressTrack.width * modelData)
                y: progressTrack.trackY - Style.space(3)
                width: Math.max(1, Style.space(1))
                height: progressTrack.trackH + Style.space(6)
                color: root.dim
              }
            }

            Rectangle {
              id: playhead
              width: Style.space(4)
              height: Style.space(14)
              radius: width / 2
              x: Math.max(0, Math.min(progressTrack.width - width, progressTrack.width * root.progress - width / 2))
              y: (progressTrack.height - height) / 2
              color: Color.accent
            }

            MouseArea {
              anchors.fill: parent
              cursorShape: Qt.PointingHandCursor
              onPressed: function(mouse) { root.seekAt(mouse.x) }
              onPositionChanged: function(mouse) { if (pressed) root.seekAt(mouse.x) }
            }
          }

          Item {
            width: parent.width
            height: elapsedText.implicitHeight

            Text {
              id: elapsedText
              anchors.left: parent.left
              text: Model.formatDuration(root.position, "clock")
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }
            Text {
              anchors.right: parent.right
              text: Model.formatDuration(root.duration, "clock")
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }
          }
          // time left and when the book finishes at your pace (HOOK(stats))
          Text {
            width: parent.width
            visible: text !== ""
            text: root.finishHint
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
          Item {   // HOOK(stats): listening stats while a book is loaded (the empty state has its own)
            width: parent.width
            height: loadedStatsButton.height
            PanelActionButton {
              id: loadedStatsButton
              anchors.horizontalCenter: parent.horizontalCenter
              iconText: "Listening stats  (i)"
              fontSize: Style.font.bodySmall
              fontFamily: root.fontFamily
              foreground: root.foreground
              onClicked: root.openStats()
            }
          }
        }

        // -- transport ------------------------------------------------------
        Row {
          id: transport
          anchors.horizontalCenter: parent.horizontalCenter
          spacing: Style.space(12)
          visible: root.hasBook

          PanelActionButton {
            iconText: "−" + root.skip
            tooltipText: "Back " + root.skip + "s (h)"
            fontFamily: root.fontFamily
            foreground: root.foreground
            fontSize: Style.font.body
            onClicked: root.seekBy(-root.skip)
          }
          PanelActionButton {
            // Play is a text triangle; pause is drawn, because the pause character falls back to a
            // colour emoji (orange, different size) that made the button visibly change on every toggle.
            iconText: root.paused ? "▶" : ""
            tooltipText: root.paused ? "Play (space)" : "Pause (space)"
            fontFamily: root.fontFamily
            foreground: root.foreground
            fontSize: Style.font.display
            onClicked: root.togglePlay()

            Row {
              anchors.centerIn: parent
              spacing: Style.space(3)
              visible: !root.paused
              Repeater {
                model: 2
                Rectangle {
                  width: Style.space(4)
                  height: Style.font.display * 0.8
                  radius: Style.space(1)
                  color: root.foreground
                }
              }
            }
          }
          PanelActionButton {
            iconText: "+" + root.skip
            tooltipText: "Forward " + root.skip + "s (l)"
            fontFamily: root.fontFamily
            foreground: root.foreground
            fontSize: Style.font.body
            onClicked: root.seekBy(root.skip)
          }
        }

        // -- speed ----------------------------------------------------------
        Column {
          width: parent.width
          spacing: Style.space(4)
          visible: root.hasBook

          Item {
            width: parent.width
            height: speedValue.implicitHeight

            Text {
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              text: "SPEED"
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
            }

            Row {
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(8)

              PanelActionButton {
                iconText: "−"
                tooltipText: "Slower ([ or -)"
                fontFamily: root.fontFamily
                foreground: root.foreground
                fontSize: Style.font.body
                onClicked: root.stepSpeed(-1)
              }
              Text {
                id: speedValue
                width: Style.space(48)
                horizontalAlignment: Text.AlignHCenter
                anchors.verticalCenter: parent.verticalCenter
                text: Model.formatSpeed(root.speed)
                textFormat: Text.PlainText
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.subtitle
                font.bold: true
              }
              PanelActionButton {
                iconText: "+"
                tooltipText: "Faster (] or +)"
                fontFamily: root.fontFamily
                foreground: root.foreground
                fontSize: Style.font.body
                onClicked: root.stepSpeed(1)
              }
            }
          }

          PanelSlider {
            width: parent.width
            bar: root.bar
            value: root.speed
            minimum: root.speedOpts.min
            maximum: root.speedOpts.max
            step: root.speedOpts.step
            onMoved: function(v) { root.setSpeedFromSlider(v) }
            onReleased: function(v) { root.setSpeedFromSlider(v) }
          }

          // -- volume (this app only; the system volume is untouched) -------
          Item {
            width: parent.width
            height: volumeValue.implicitHeight

            Text {
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              text: "VOLUME"
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
            }

            Row {
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(8)

              PanelActionButton {
                iconText: "−"
                tooltipText: "Quieter (9)"
                fontFamily: root.fontFamily
                foreground: root.foreground
                fontSize: Style.font.body
                onClicked: root.stepVolume(-1)
              }
              Text {
                id: volumeValue
                width: Style.space(56)
                horizontalAlignment: Text.AlignHCenter
                anchors.verticalCenter: parent.verticalCenter
                text: Model.formatVolume(root.volume, root.muted)
                textFormat: Text.PlainText
                color: root.muted ? root.dim : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.subtitle
                font.bold: true
              }
              PanelActionButton {
                iconText: "+"
                tooltipText: "Louder (0)"
                fontFamily: root.fontFamily
                foreground: root.foreground
                fontSize: Style.font.body
                onClicked: root.stepVolume(1)
              }
              PanelActionButton {
                iconText: root.muted ? "unmute" : "mute"
                tooltipText: "Mute (m)"
                fontFamily: root.fontFamily
                foreground: root.foreground
                fontSize: Style.font.caption
                onClicked: root.toggleMute()
              }
            }
          }

          PanelSlider {
            width: parent.width
            bar: root.bar
            value: root.muted ? 0 : root.volume
            minimum: 0
            maximum: root.volumeMax
            step: root.volumeStep
            onMoved: function(v) { root.setVolumeFromSlider(v) }
            onReleased: function(v) { root.setVolumeFromSlider(v) }
          }
        }

        // -- chapters -------------------------------------------------------
        Column {
          width: parent.width
          spacing: Style.space(2)
          visible: root.hasBook

          Item {
            width: parent.width
            height: chapterHeader.implicitHeight + Style.space(4)

            PanelSectionHeader {
              id: chapterHeader
              anchors.left: parent.left
              anchors.right: parent.right
              text: "CHAPTERS  ·  " + root.chapterCount
              foreground: root.foreground
              fontFamily: root.fontFamily
            }
          }

          Flickable {
            id: chapterFlick
            width: parent.width
            height: Math.min(root.chapterCount * root.rowH, root.listMaxH)
            contentWidth: width
            contentHeight: chapterColumn.height
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            flickableDirection: Flickable.VerticalFlick
            interactive: contentHeight > height
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            Column {
              id: chapterColumn
              width: chapterFlick.width

              Repeater {
                model: root.chapters

                delegate: Item {
                  id: chapterRow
                  required property var modelData
                  required property int index

                  readonly property bool isCurrent: index === root.currentChapter
                  readonly property bool isCursor: index === root.cursor
                  readonly property real rowProgress: isCurrent ? Model.chapterProgress(modelData, root.position) : 0

                  width: chapterColumn.width
                  height: root.rowH

                  Rectangle {
                    anchors.fill: parent
                    radius: Style.cornerRadius
                    color: chapterRow.isCursor ? root.selectedFill
                      : rowMouse.containsMouse ? root.hoverFill : "transparent"
                  }

                  // Played part of the current chapter.
                  Rectangle {
                    x: 0
                    y: parent.height - Style.space(2)
                    width: parent.width * chapterRow.rowProgress
                    height: Style.space(2)
                    color: root.foreground
                    opacity: 0.6
                  }

                  // Left marker: cursor bar, and a dot on the playing chapter.
                  Rectangle {
                    visible: chapterRow.isCursor
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    width: Style.space(2)
                    height: parent.height - Style.space(10)
                    color: Color.accent
                  }

                  Row {
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.leftMargin: Style.space(10)
                    anchors.rightMargin: Style.space(10)
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Style.space(8)

                    Text {
                      id: rowNum
                      width: Style.space(22)
                      horizontalAlignment: Text.AlignRight
                      anchors.verticalCenter: parent.verticalCenter
                      text: chapterRow.isCurrent ? "▶" : (/^\s*\d/.test(String(chapterRow.modelData.title)) ? "" : String(chapterRow.index + 1))
                      textFormat: Text.PlainText
                      color: chapterRow.isCurrent ? Color.accent : root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                    }

                    Text {
                      id: rowTitle
                      width: Math.max(0, parent.width - rowNum.width - rowLen.width - parent.spacing * 2)
                      anchors.verticalCenter: parent.verticalCenter
                      text: chapterRow.modelData.title
                      textFormat: Text.PlainText
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      font.bold: chapterRow.isCurrent
                      elide: Text.ElideRight
                    }

                    Text {
                      id: rowLen
                      anchors.verticalCenter: parent.verticalCenter
                      text: Model.formatDuration(chapterRow.modelData.length, "hm")
                      textFormat: Text.PlainText
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                    }
                  }

                  MouseArea {
                    id: rowMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onPositionChanged: root.cursor = chapterRow.index
                    onClicked: {
                      root.cursor = chapterRow.index
                      if (root.service) root.service.jumpToChapter(chapterRow.index)
                    }
                  }
                }
              }
            }
          }
        }

        // -- empty state ----------------------------------------------------
        Column {
          width: parent.width
          spacing: Style.space(6)
          visible: root.ready && !root.hasBook

          Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            text: root.lastBook ? "Pick up where you left off" : "Nothing playing"
            textFormat: Text.PlainText
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            font.bold: true
          }
          Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            visible: !root.lastBook
            text: "Pick a book from your library to start listening."
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
          Row {
            width: parent.width
            spacing: Style.space(12)
            visible: root.lastBook !== null

            Image {
              width: Style.space(56)
              height: Style.space(56)
              source: root.continueCover
              fillMode: Image.PreserveAspectCrop
              asynchronous: true
              sourceSize.width: Style.space(112)
              sourceSize.height: Style.space(112)
            }
            Column {
              width: parent.width - Style.space(56) - parent.spacing
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)
              Text {
                width: parent.width
                text: root.lastBook ? root.lastBook.title : ""
                textFormat: Text.PlainText
                elide: Text.ElideRight
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
              }
              Text {
                width: parent.width
                text: root.lastBook ? (root.lastBook.author || "") : ""
                textFormat: Text.PlainText
                elide: Text.ElideRight
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }
              Text {
                width: parent.width
                text: root.continueMeta
                visible: text !== ""
                textFormat: Text.PlainText
                elide: Text.ElideRight
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }
            }
          }
          Item {
            width: parent.width
            height: continueButton.height
            visible: root.lastBook !== null

            PanelActionButton {
              id: continueButton
              anchors.horizontalCenter: parent.horizontalCenter
              iconText: "Continue listening  (Space)"
              fontSize: Style.font.body
              fontFamily: root.fontFamily
              foreground: root.foreground
              onClicked: root.togglePlay()
            }
          }
          Item {
            width: parent.width
            height: browseButton.height

            PanelActionButton {
              id: browseButton
              anchors.horizontalCenter: parent.horizontalCenter
              iconText: "Browse library  (o)"
              fontSize: Style.font.body
              fontFamily: root.fontFamily
              foreground: root.foreground
              onClicked: root.openLibrary()
            }
          }
          Item {
            width: parent.width
            height: statsButton.height

            PanelActionButton {   // HOOK(stats)
              id: statsButton
              anchors.horizontalCenter: parent.horizontalCenter
              iconText: "Listening stats  (i)"
              fontSize: Style.font.body
              fontFamily: root.fontFamily
              foreground: root.foreground
              onClicked: root.openStats()
            }
          }
        }

        PanelSeparator {
          width: parent.width
          foreground: root.foreground
        }

        // -- sleep timer row (z or a click cycles it) -----------------------
        Text {   // HOOK(listen)
          width: parent.width
          visible: root.hasBook
          readonly property bool sleeping: root.service && root.service.listening && root.service.listening.sleepText !== ""
          text: sleeping ? root.service.listening.sleepText + " · z change · Z add more" : "Sleep timer off · z to set"
          textFormat: Text.PlainText
          color: sleeping ? Color.accent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: { if (root.service && root.service.listening) root.service.listening.cycleSleep() }
          }
        }

        // -- key legend -----------------------------------------------------
        Text {
          width: parent.width
          text: root.hasBook
            ? "space play · h/l ±" + root.skip + "s · j/k chapter · ⏎ jump · n/p chapter · [ ] speed · 9 0 volume · m mute · z sleep · o library · i stats · esc"
            : "o library · i stats · esc close"
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
