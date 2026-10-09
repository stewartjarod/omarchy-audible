import Quickshell
import QtQuick
import qs.Commons
import qs.Ui
import "LibraryModel.js" as Lib

// Fullscreen library overlay: pick the audiobook to play.
// Layout: search line, status line, sectioned body (cover grid or dense list), key legend.
// Data flows only through `service`; all filtering, sectioning and navigation live in LibraryModel.js.
Item {
  id: root

  property var service: null
  property var shell: null
  property bool opened: false

  // ------------------------------------------------------------ service state
  readonly property bool ready: root.service ? !!root.service.ready : false
  // Which books to show: all | downloaded (on this computer) | cloud (not downloaded yet).
  readonly property string statusFilter: (root.service && root.service.filterMode) ? root.service.filterMode : "all"
  onStatusFilterChanged: root.rebuild()
  readonly property string filterLabel: statusFilter === "downloaded" ? "Downloaded"
    : (statusFilter === "cloud" ? "Not downloaded" : "")
  function cycleFilter() {
    if (!root.service || typeof root.service.setFilterMode !== "function") return
    var next = root.statusFilter === "all" ? "downloaded" : (root.statusFilter === "downloaded" ? "cloud" : "all")
    root.service.setFilterMode(next)
    root.statusText = next === "all" ? "Showing every book."
      : (next === "downloaded" ? "Showing only books downloaded to this computer." : "Showing books that are not downloaded yet.")
  }

  // Removing a download needs a second press (Ctrl+X again, or click the badge again within 4 s).
  property string confirmRemoveAsin: ""
  Timer { id: confirmTimer; interval: 4000; onTriggered: root.confirmRemoveAsin = "" }

  function removeBook(book) {
    if (!book || !root.service) return
    if (!root.isLocal(book.asin)) { root.statusText = "That book is not downloaded."; return }
    if (root.confirmRemoveAsin === book.asin) {
      confirmTimer.stop()
      root.confirmRemoveAsin = ""
      var err = root.service.removeDownload(book.asin)
      root.statusText = err !== "" ? err : "Removed “" + book.title + "” from this computer. You can download it again any time."
      return
    }
    var mb = Math.max(1, Math.round((Number(book.runtimeSec) || 0) * 16000 / 1048576))
    root.confirmRemoveAsin = book.asin
    confirmTimer.restart()
    root.statusText = "Remove “" + book.title + "” from this computer (about " + mb + " MB)? Press Ctrl+X again to confirm. Your place and listen count are kept."
  }

  function markFinishedBook(book, undo) {
    if (!book || !root.service) return
    root.statusText = (undo ? root.service.unmarkFinished(book.asin) : root.service.markFinished(book.asin))
  }

  // The badge on a tile: download a book that is not here yet, or remove one that is.
  function badgeAction(book) {
    if (!book) return
    root.selectAsin(book.asin)
    if (root.isLocal(book.asin)) root.removeBook(book)
    else root.downloadBook(book)
  }

  readonly property string sortMode: (root.service && root.service.sortMode) ? root.service.sortMode : "recent"
  onSortModeChanged: root.rebuild()
  readonly property var books: (root.service && Array.isArray(root.service.books)) ? root.service.books : []
  readonly property bool loading: root.service ? !!root.service.libraryLoading : false
  readonly property string libraryError: root.service && root.service.libraryError ? String(root.service.libraryError) : ""
  readonly property bool isGrid: !(root.service && root.service.viewMode === "list")

  // ------------------------------------------------------------ local UI state
  property string query: ""
  property bool searching: false
  property string statusText: ""
  property string selectedAsin: ""
  property var rows: []
  property var cursor: ({ row: -1, col: 0 })
  property var bookByAsin: ({})

  // ------------------------------------------------------------ tokens
  property color background: Color.menu.background
  property color foreground: Color.menu.text
  property color border: Color.menu.border
  property color scrim: Color.menu.scrim
  property color selectedBackground: Color.menu.selectedBackground
  property color selectedText: Color.menu.selectedText
  property color muted: Color.muted
  property color accent: Color.accent
  property color urgent: Color.urgent
  property color placeholderFill: Util.alpha(Color.menu.text, 0.08)
  property var borderSpec: Border.surfaceSpec("menu", "border", border, Math.max(1, Style.space(2)))
  readonly property int cornerRadius: Style.cornerRadius
  property string fontFamily: Style.font.menuFamily
  property int contentMargin: Style.spacing.panelPadding
  property int contentSpacing: Style.spacing.md

  // ------------------------------------------------------------ sizes
  property int coverSize: Style.space(132)
  property int coverPx: Style.space(264)     // decode size: 2x for HiDPI, bounded memory
  property int thumbSize: Style.space(38)
  property int titleHeight: Math.ceil(Style.font.body * 1.4 * 2)
  property int cellWidth: coverSize + Style.space(20)
  property int cellHeight: Style.space(10) + coverSize + Style.space(8) + Style.space(3) + Style.space(6)
    + titleHeight + Math.ceil(Style.font.caption * 1.8) + Style.space(10)
  property int listRowHeight: Math.max(Style.space(46), Math.ceil(Style.font.title * 3.1))
  property int sectionHeaderHeight: Math.max(Style.space(32), Math.ceil(Style.font.title * 2.4))
  property int lineHeight: Math.max(Style.space(30), Math.ceil(Style.font.heading * 1.8))
  property int columns: root.isGrid ? Math.max(1, Math.floor(resultView.width / root.cellWidth)) : 1

  // ------------------------------------------------------------ public interface
  function open(payloadJson) {
    if (root.opened) return
    root.opened = true
    root.query = ""
    root.searching = false
    root.statusText = ""
    root.selectedAsin = ""
    try {
      var payload = payloadJson ? JSON.parse(payloadJson) : {}
      if (payload && typeof payload.query === "string") root.query = payload.query
    } catch (e) { /* ignore malformed payload */ }
    root.rebuild()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    if (root.service) {
      if (!root.service.libraryOpen && typeof root.service.openLibrary === "function")
        root.service.openLibrary()
      if (root.ready && root.books.length === 0 && !root.loading && typeof root.service.refreshLibrary === "function")
        root.service.refreshLibrary()
    }
  }

  function close() {
    if (!root.opened) return
    root.opened = false
    if (root.service && root.service.libraryOpen && typeof root.service.closeLibrary === "function")
      root.service.closeLibrary()
  }

  // ------------------------------------------------------------ data helpers
  function downloadFor(asin) {
    var all = root.service ? root.service.downloads : null
    return (all && all[asin]) ? all[asin] : null
  }

  function isLocal(asin) {
    var local = root.service ? root.service.localAsins : null
    if (local && local[asin]) return true
    var dl = root.downloadFor(asin)
    return !!dl && dl.state === "done"
  }

  function resumeFor(asin) {
    var all = root.service ? root.service.resume : null
    var r = (all && all[asin]) ? all[asin] : null
    var pos = r ? Number(r.position) : 0
    return isFinite(pos) && pos > 0 ? pos : 0
  }

  function isPlaying(asin) {
    return !!root.service && !!root.service.hasBook && root.service.asin === asin
  }

  // ------------------------------------------------------------ rows and cursor
  function rebuild() {
    var map = {}
    for (var i = 0; i < root.books.length; i++) map[root.books[i].asin] = root.books[i]
    root.bookByAsin = map
    var secs = Lib.sections(root.books, { query: root.query, sort: root.sortMode, status: root.statusFilter })
    var built = Lib.buildRows(secs, root.columns)
    root.rows = built
    root.cursor = root.selectedAsin ? Lib.cursorOf(built, root.selectedAsin) : Lib.firstCursor(built)
    root.selectedAsin = Lib.asinAt(built, root.cursor)
    root.scrollToCursor()
  }

  function setQuery(text) {
    root.query = text
    root.statusText = ""
    root.selectedAsin = ""
    root.rebuild()
  }

  function selectAsin(asin) {
    if (root.confirmRemoveAsin !== "" && root.confirmRemoveAsin !== asin) { confirmTimer.stop(); root.confirmRemoveAsin = "" }
    root.selectedAsin = asin
    root.cursor = Lib.cursorOf(root.rows, asin)
  }

  function moveCursor(dx, dy) {
    if (root.rows.length === 0) return
    var next = Lib.stepCursor(root.rows, root.cursor, dx, dy)
    root.cursor = next
    root.selectedAsin = Lib.asinAt(root.rows, next)
    root.scrollToCursor()
  }

  function pageSize() {
    var h = root.isGrid ? root.cellHeight : root.listRowHeight
    return Math.max(1, Math.floor(resultView.height / h))
  }

  function scrollToCursor() {
    Qt.callLater(function() {
      if (!root.rows || root.cursor.row < 0 || root.cursor.row >= root.rows.length) return
      var target = root.cursor.row
      // Keep the section header visible when the cursor sits on the first row of a section.
      if (target > 0 && root.rows[target - 1].kind === "header") target -= 1
      resultView.positionViewAtIndex(target, ListView.Contain)
    })
  }

  // ------------------------------------------------------------ actions
  function selectedBook() {
    return root.selectedAsin ? (root.bookByAsin[root.selectedAsin] || null) : null
  }

  function playBook(book) {
    if (!book) return
    if (book.listenable === false) {
      root.statusText = "“" + book.title + "” isn’t available on this account (borrowed or lapsed subscription)."
      return
    }
    if (!root.service || typeof root.service.play !== "function") return
    root.service.play(book.asin)
    root.close()
  }

  function downloadBook(book) {
    if (!book) return
    if (book.listenable === false) {
      root.statusText = "Not available on this account, so it can't be downloaded."
      return
    }
    if (root.isLocal(book.asin)) {
      root.statusText = "Already downloaded."
      return
    }
    var dl = root.downloadFor(book.asin)
    if (dl && (dl.state === "queued" || dl.state === "downloading")) {
      root.statusText = "Already downloading."
      return
    }
    if (root.service && typeof root.service.download === "function") {
      root.service.download(book.asin)
      root.statusText = "Downloading “" + book.title + "”."
    }
  }

  function toggleView() {
    if (!root.service || typeof root.service.setViewMode !== "function") return
    root.service.setViewMode(root.isGrid ? "list" : "grid")
  }

  function refresh() {
    if (root.service && typeof root.service.refreshLibrary === "function") {
      root.service.refreshLibrary()
      root.statusText = "Refreshing your library…"
    }
  }

  // ------------------------------------------------------------ service wiring
  onColumnsChanged: root.rebuild()
  onBooksChanged: root.rebuild()
  onIsGridChanged: root.rebuild()
  onReadyChanged: if (root.ready && root.opened) Qt.callLater(function() { keyCatcher.forceActiveFocus() })

  Connections {
    target: root.service
    ignoreUnknownSignals: true

    function onLibraryOpenChanged() {
      if (root.service && root.service.libraryOpen) root.open("{}")
      else root.close()
    }

    function onLocalAsinsChanged() {
      root.rebuild()
    }
  }

  // ------------------------------------------------------------ window
  // A regular toplevel (xdg-toplevel), not a layer-shell surface: Hyprland tiles it like any
  // other app. Closing it from the window manager (SUPER+W) closes the library too.
  FloatingWindow {
    id: panel
    title: "Audible"
    visible: root.opened
    color: root.background
    implicitWidth: Style.space(1120)
    implicitHeight: Style.space(780)
    minimumSize: Qt.size(Style.space(520), Style.space(420))
    onVisibleChanged: if (!visible && root.opened) root.close()

    Item {
      id: card
      anchors.fill: parent
      readonly property int contentTopInset: root.contentMargin
      readonly property int contentRightInset: root.contentMargin
      readonly property int contentBottomInset: root.contentMargin
      readonly property int contentLeftInset: root.contentMargin

      Item {
        id: keyCatcher
        anchors.fill: parent
        focus: true

        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) {
          // While setup is needed, Onboarding owns the keyboard.
          if (!root.ready) return

          var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
          var alt = (event.modifiers & (Qt.AltModifier | Qt.MetaModifier)) !== 0
          var text = event.text || ""
          var code = text.length === 1 ? text.charCodeAt(0) : 0
          var printable = !ctrl && !alt && code >= 32 && code !== 127
          var idle = root.query === "" && !root.searching
          var lower = text.toLowerCase()

          if (event.key === Qt.Key_Escape) {
            // Esc clears the query first, then leaves search mode, then closes.
            if (root.query !== "") {
              root.setQuery("")
              root.searching = false
            } else if (root.searching) {
              root.searching = false
            } else {
              root.close()
            }
            event.accepted = true
          } else if (Util.editsFilter(event, root.query)) {
            root.setQuery(Util.editedFilter(event, root.query))
            event.accepted = true
          } else if (event.key === Qt.Key_Left) {
            root.moveCursor(-1, 0); event.accepted = true
          } else if (event.key === Qt.Key_Right) {
            root.moveCursor(1, 0); event.accepted = true
          } else if (event.key === Qt.Key_Up) {
            root.moveCursor(0, -1); event.accepted = true
          } else if (event.key === Qt.Key_Down) {
            root.moveCursor(0, 1); event.accepted = true
          } else if (event.key === Qt.Key_PageUp) {
            root.moveCursor(0, -root.pageSize()); event.accepted = true
          } else if (event.key === Qt.Key_PageDown) {
            root.moveCursor(0, root.pageSize()); event.accepted = true
          } else if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
            root.toggleView(); event.accepted = true
          } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            root.playBook(root.selectedBook()); event.accepted = true
          } else if (ctrl && event.key === Qt.Key_F) {
            root.cycleFilter(); event.accepted = true
          } else if (ctrl && event.key === Qt.Key_X) {
            root.removeBook(root.selectedBook()); event.accepted = true
          } else if (ctrl && event.key === Qt.Key_M) {
            root.markFinishedBook(root.selectedBook(), (event.modifiers & Qt.ShiftModifier) !== 0); event.accepted = true
          } else if (ctrl && event.key === Qt.Key_S) {
            if (root.service && typeof root.service.setSortMode === "function")
              root.service.setSortMode(root.sortMode === "recent" ? "added" : "recent")
            event.accepted = true
          } else if (ctrl && event.key === Qt.Key_D) {
            root.downloadBook(root.selectedBook()); event.accepted = true
          } else if (ctrl && event.key === Qt.Key_R) {
            root.refresh(); event.accepted = true
          } else if (ctrl && (event.key === Qt.Key_H || event.key === Qt.Key_J || event.key === Qt.Key_K || event.key === Qt.Key_L)) {
            if (event.key === Qt.Key_H) root.moveCursor(-1, 0)
            else if (event.key === Qt.Key_L) root.moveCursor(1, 0)
            else if (event.key === Qt.Key_K) root.moveCursor(0, -1)
            else root.moveCursor(0, 1)
            event.accepted = true
          } else if (printable && text === "/") {
            root.searching = true; event.accepted = true
          } else if (printable && idle && "hjkl".indexOf(lower) >= 0) {
            // With an empty idle query, bare hjkl move the cursor; every other letter starts a search.
            if (lower === "h") root.moveCursor(-1, 0)
            else if (lower === "l") root.moveCursor(1, 0)
            else if (lower === "k") root.moveCursor(0, -1)
            else root.moveCursor(0, 1)
            event.accepted = true
          } else if (printable && (root.query !== "" || root.searching || text !== " ")) {
            root.searching = true
            root.setQuery(root.query + text)
            event.accepted = true
          }
        }

        Column {
          anchors.fill: parent
          anchors.topMargin: card.contentTopInset
          anchors.rightMargin: card.contentRightInset
          anchors.bottomMargin: card.contentBottomInset
          anchors.leftMargin: card.contentLeftInset
          spacing: root.contentSpacing

          // ---------------------------------------------------- search line
          Row {
            id: searchLine
            width: parent.width
            height: root.lineHeight
            spacing: Style.space(10)
            visible: root.ready

            Text {
              id: searchIcon
              anchors.verticalCenter: parent.verticalCenter
              text: "󰍉"
              color: root.muted
              font.family: root.fontFamily
              font.pixelSize: Style.font.heading
            }

            Text {
              id: searchText
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - searchIcon.width - countText.width - parent.spacing * 2
              textFormat: Text.PlainText
              text: root.query !== "" ? root.query + (root.searching ? "│" : "")
                : (root.searching ? "│" : "Search your library…")
              color: root.query !== "" || root.searching ? root.foreground : root.muted
              elide: Text.ElideRight
              font.family: root.fontFamily
              font.pixelSize: Style.font.heading
            }

            Text {
              id: countText
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              color: root.muted
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              text: root.loading && root.books.length === 0 ? "Loading…"
                : (root.query !== "" ? root.countResults() + " results"
                  : (root.filterLabel !== "" ? root.filterLabel + " · " + root.countResults() + " books" : root.books.length + " books"))
            }
          }

          // ---------------------------------------------------- status line
          Text {
            id: statusLine
            width: parent.width
            height: Math.max(Style.space(18), Math.ceil(Style.font.body * 1.6))
            visible: root.ready
            textFormat: Text.PlainText
            elide: Text.ElideRight
            verticalAlignment: Text.AlignVCenter
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            color: root.libraryError && root.books.length === 0 ? root.urgent
              : (root.statusText !== "" ? root.foreground : root.muted)
            text: root.statusText !== "" ? root.statusText
              : (root.libraryError !== "" ? "Library error: " + root.libraryError + " (Ctrl+R to retry)"
              : (root.loading ? "Syncing your library…" : ""))
          }

          // ---------------------------------------------------- body
          Item {
            id: body
            width: parent.width
            height: Math.max(0, parent.height - searchLine.height - statusLine.height - footerLine.height - root.contentSpacing * 3)

            ListView {
              id: resultView
              anchors.fill: parent
              visible: root.ready && root.rows.length > 0
              clip: true
              model: root.rows
              boundsBehavior: Flickable.StopAtBounds
              cacheBuffer: Math.max(Style.space(200), root.cellHeight * 2)
              reuseItems: true

              delegate: Item {
                id: rowItem
                required property var modelData
                required property int index

                width: ListView.view ? ListView.view.width : 0
                height: modelData.kind === "header" ? root.sectionHeaderHeight
                  : (root.isGrid ? root.cellHeight : root.listRowHeight)

                // Section header
                Text {
                  visible: rowItem.modelData.kind === "header"
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.bottom: parent.bottom
                  anchors.bottomMargin: Style.space(4)
                  textFormat: Text.PlainText
                  elide: Text.ElideRight
                  text: rowItem.modelData.kind === "header" ? rowItem.modelData.title + "  ·  " + rowItem.modelData.count : ""
                  color: root.muted
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.title
                  font.bold: true
                }

                // Book row (one per grid row of cells, or one per list row)
                Row {
                  visible: rowItem.modelData.kind === "books"
                  anchors.left: parent.left
                  anchors.top: parent.top
                  spacing: 0

                  Repeater {
                    model: rowItem.modelData.kind === "books" ? rowItem.modelData.books : []

                    delegate: Item {
                      id: tile
                      required property var modelData

                      readonly property var book: modelData
                      readonly property var dl: root.downloadFor(book.asin)
                      readonly property bool local: root.isLocal(book.asin)
                      readonly property bool selected: book.asin === root.selectedAsin
                      readonly property bool playing: root.isPlaying(book.asin)
                      readonly property bool listenable: book.listenable !== false
                      readonly property real fraction: Lib.progressFraction({
                        percentComplete: book.percentComplete,
                        resumeSec: root.resumeFor(book.asin),
                        runtimeSec: book.runtimeSec
                      })
                      readonly property int plays: book.playCount || 0
                      readonly property string playsText: plays >= 2 ? "×" + plays : (plays === 1 ? "✓" : "")
                      readonly property bool busy: !!dl && (dl.state === "queued" || dl.state === "downloading")
                      // Pointing at a tile reveals what its badge does when clicked.
                      readonly property string badge: !listenable ? "Unavailable"
                        : (dl && dl.state === "failed") ? "Failed"
                        : (dl && dl.state === "queued") ? "Queued"
                        : (dl && dl.state === "downloading") ? Math.round((Number(dl.fraction) || 0) * 100) + "%"
                        : local ? (selected ? "Downloaded  ✕" : "Downloaded")
                        : (selected ? "⇣ Download" : "")
                      readonly property color badgeColor: (dl && dl.state === "failed") ? root.urgent
                        : (local || (dl && dl.state === "downloading")) ? root.accent : root.muted
                      readonly property string titleText: (playing ? "▶ " : "") + book.title + (playsText !== "" ? "  " + playsText : "")

                      width: root.isGrid ? root.cellWidth : resultView.width
                      height: root.isGrid ? root.cellHeight : root.listRowHeight
                      opacity: listenable ? 1 : 0.42

                      // Cursor highlight
                      Rectangle {
                        anchors.fill: parent
                        anchors.margins: root.isGrid ? Style.space(4) : Style.space(2)
                        radius: root.cornerRadius
                        color: tile.selected ? root.selectedBackground : "transparent"
                      }

                      // ---- grid layout
                      Item {
                        id: gridContent
                        visible: root.isGrid
                        anchors.fill: parent

                        Item {
                          id: coverBox
                          z: 5   // above the tile's click area, so the badges can take their own clicks
                          width: root.coverSize
                          height: root.coverSize
                          anchors.horizontalCenter: parent.horizontalCenter
                          y: Style.space(10)

                          Rectangle {
                            anchors.fill: parent
                            color: root.placeholderFill
                          }

                          Text {
                            anchors.centerIn: parent
                            visible: gridCover.status !== Image.Ready
                            text: tile.book.title.charAt(0).toUpperCase()
                            color: root.muted
                            opacity: 0.6
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.displayLarge
                          }

                          Image {
                            id: gridCover
                            anchors.fill: parent
                            source: root.isGrid && tile.book.coverUrl ? tile.book.coverUrl : ""
                            asynchronous: true
                            cache: true
                            smooth: true
                            fillMode: Image.PreserveAspectCrop
                            sourceSize: Qt.size(root.coverPx, root.coverPx)
                          }

                          Rectangle {
                            id: downloadBadge
                            visible: root.isGrid && tile.badge !== ""
                            anchors.right: parent.right
                            anchors.top: parent.top
                            anchors.margins: Style.space(4)
                            height: Style.space(18)
                            width: badgeLabel.implicitWidth + Style.space(10)
                            radius: root.cornerRadius
                            color: Util.alpha(root.background, 0.9)

                            Text {
                              id: badgeLabel
                              anchors.centerIn: parent
                              textFormat: Text.PlainText
                              text: tile.badge
                              color: tile.badgeColor
                              font.family: root.fontFamily
                              font.pixelSize: Style.font.caption
                            }

                            MouseArea {
                              anchors.fill: parent
                              enabled: tile.listenable && !tile.busy
                              cursorShape: Qt.PointingHandCursor
                              onClicked: root.badgeAction(tile.book)
                            }
                          }

                          // Full listens: a tick for one, ×N for more (top-left of the cover).
                          Rectangle {
                            visible: root.isGrid && tile.playsText !== ""
                            anchors.left: parent.left
                            anchors.top: parent.top
                            anchors.margins: Style.space(4)
                            height: Style.space(18)
                            width: playsLabel.implicitWidth + Style.space(10)
                            radius: root.cornerRadius
                            color: Util.alpha(root.background, 0.9)

                            Text {
                              id: playsLabel
                              anchors.centerIn: parent
                              textFormat: Text.PlainText
                              text: tile.playsText
                              color: root.accent
                              font.family: root.fontFamily
                              font.pixelSize: Style.font.caption
                              font.bold: true
                            }
                          }
                        }

                        Rectangle {
                          id: gridBar
                          anchors.left: coverBox.left
                          anchors.top: coverBox.bottom
                          anchors.topMargin: Style.space(3)
                          width: coverBox.width
                          height: Style.space(3)
                          color: root.placeholderFill

                          Rectangle {
                            width: parent.width * tile.fraction
                            height: parent.height
                            color: root.accent
                          }
                        }

                        Text {
                          id: gridTitle
                          anchors.left: coverBox.left
                          anchors.right: coverBox.right
                          anchors.top: gridBar.bottom
                          anchors.topMargin: Style.space(6)
                          height: root.titleHeight
                          textFormat: Text.PlainText
                          text: tile.titleText
                          wrapMode: Text.Wrap
                          maximumLineCount: 2
                          elide: Text.ElideRight
                          verticalAlignment: Text.AlignTop
                          color: tile.selected ? root.selectedText : root.foreground
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.body
                        }

                        Text {
                          anchors.left: coverBox.left
                          anchors.right: coverBox.right
                          anchors.top: gridTitle.bottom
                          textFormat: Text.PlainText
                          text: tile.book.author
                          elide: Text.ElideRight
                          color: root.muted
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                        }
                      }

                      // ---- list layout
                      Item {
                        id: listContent
                        z: 5
                        visible: !root.isGrid
                        anchors.fill: parent

                        Rectangle {
                          id: listThumbBg
                          anchors.left: parent.left
                          anchors.leftMargin: Style.space(12)
                          anchors.verticalCenter: parent.verticalCenter
                          width: root.thumbSize
                          height: root.thumbSize
                          color: root.placeholderFill

                          Image {
                            id: listCover
                            anchors.fill: parent
                            source: !root.isGrid && tile.book.coverUrl ? tile.book.coverUrl : ""
                            asynchronous: true
                            cache: true
                            smooth: true
                            fillMode: Image.PreserveAspectCrop
                            sourceSize: Qt.size(Style.space(80), Style.space(80))
                          }
                        }

                        Text {
                          id: listBadge
                          anchors.right: parent.right
                          anchors.rightMargin: Style.space(14)
                          anchors.verticalCenter: parent.verticalCenter
                          width: Style.space(96)
                          horizontalAlignment: Text.AlignRight
                          textFormat: Text.PlainText
                          elide: Text.ElideRight
                          text: tile.badge
                          color: tile.badgeColor
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption

                          MouseArea {
                            anchors.fill: parent
                            enabled: tile.listenable && !tile.busy
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.badgeAction(tile.book)
                          }
                        }

                        Column {
                          anchors.left: listThumbBg.right
                          anchors.leftMargin: Style.space(10)
                          anchors.right: listBadge.left
                          anchors.rightMargin: Style.space(10)
                          anchors.verticalCenter: parent.verticalCenter
                          spacing: Style.space(2)

                          Text {
                            width: parent.width
                            textFormat: Text.PlainText
                            text: tile.titleText
                            elide: Text.ElideRight
                            color: tile.selected ? root.selectedText : root.foreground
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.title
                          }

                          Text {
                            width: parent.width
                            textFormat: Text.PlainText
                            text: Lib.formatMeta({
                              author: tile.book.author,
                              runtimeSec: tile.book.runtimeSec,
                              percentComplete: tile.book.percentComplete,
                              finished: tile.book.finished
                            })
                            elide: Text.ElideRight
                            color: root.muted
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                          }
                        }

                        Rectangle {
                          anchors.left: listThumbBg.right
                          anchors.leftMargin: Style.space(10)
                          anchors.bottom: parent.bottom
                          anchors.bottomMargin: Style.space(2)
                          width: Math.max(0, parent.width - listThumbBg.width - Style.space(24) - Style.space(10))
                          height: Style.space(2)
                          color: root.placeholderFill

                          Rectangle {
                            width: parent.width * tile.fraction
                            height: parent.height
                            color: root.accent
                          }
                        }
                      }

                      MouseArea {
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onContainsMouseChanged: if (containsMouse) root.selectAsin(tile.book.asin)
                        onClicked: {
                          root.selectAsin(tile.book.asin)
                          root.playBook(tile.book)
                        }
                      }
                    }
                  }
                }
              }
            }

            // Empty and "no matches" states
            Column {
              anchors.centerIn: parent
              width: Math.min(parent.width, Style.space(520))
              spacing: Style.space(8)
              visible: root.ready && root.rows.length === 0 && !root.loading

              Text {
                width: parent.width
                horizontalAlignment: Text.AlignHCenter
                text: "󰍉"
                color: root.selectedText
                opacity: 0.8
                font.family: root.fontFamily
                font.pixelSize: Style.font.displayLarge
              }

              Text {
                width: parent.width
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.Wrap
                textFormat: Text.PlainText
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                text: root.libraryError !== "" && root.books.length === 0 ? "Couldn’t load your library."
                  : (root.books.length === 0 ? "Your library is empty."
                  : (root.query !== "" ? "No matches for “" + root.query + "”" : "Nothing to show."))
              }

              Text {
                width: parent.width
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.Wrap
                textFormat: Text.PlainText
                color: root.muted
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                text: root.libraryError !== "" && root.books.length === 0 ? root.libraryError + "\nCtrl+R to retry."
                  : (root.books.length === 0 ? "Sync your library from the Audible setup, then reopen."
                  : "Esc clears the search.")
              }
            }

            Column {
              anchors.centerIn: parent
              visible: root.ready && root.loading && root.books.length === 0
              spacing: Style.space(8)

              Text {
                textFormat: Text.PlainText
                text: "Loading your library…"
                color: root.muted
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }
            }

            Onboarding {
              anchors.fill: parent
              visible: !root.ready
              service: root.service
              onCloseRequested: root.close()
            }
          }

          // ---------------------------------------------------- key legend
          Text {
            id: footerLine
            width: parent.width
            height: Math.max(Style.space(18), Math.ceil(Style.font.bodySmall * 1.6))
            visible: root.ready
            textFormat: Text.PlainText
            elide: Text.ElideRight
            verticalAlignment: Text.AlignVCenter
            text: "Enter play · Ctrl+D download · Ctrl+X remove · Ctrl+M finished · Ctrl+F filter · Ctrl+S sort: " + (root.sortMode === "recent" ? "last played" : "added") + " · Tab view · Esc"
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }
      }
    }
  }

  // Number of rows with at least one book in the current results (for the counter).
  function countResults() {
    var n = 0
    for (var i = 0; i < root.rows.length; i++) {
      if (root.rows[i].kind === "books") n += root.rows[i].books.length
    }
    return n
  }
}
