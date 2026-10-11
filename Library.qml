import Quickshell
import QtQuick
import qs.Commons
import qs.Ui
import "LibraryModel.js" as Lib
import "SuggestModel.js" as Sug   // HOOK(discover)
import "DiscoverModel.js" as Disc   // HOOK(discover)

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
  readonly property bool groupSeries: root.service ? root.service.groupSeries !== false : true
  onGroupSeriesChanged: root.rebuild()
  readonly property bool continueExpanded: root.service ? root.service.continueExpanded === true : false
  onContinueExpandedChanged: root.rebuild()

  // The details page for one book (opened by a click or Enter; Play is on that page).
  property string detailAsin: ""
  // HOOK(discover): a book you do not own (wishlist, "More like this") shows its catalog copy.
  readonly property var detailBook: root.detailAsin !== ""
    ? (root.service && root.service.catalog ? root.service.catalog.detailFor(root.detailAsin, root.bookByAsin[root.detailAsin] || null) : (root.bookByAsin[root.detailAsin] || null))
    : null
  property string detailReturnAsin: ""   // HOOK(discover): the book a "More like this" pick came from

  function openDetail(book) {
    if (!book) return
    if (book.isSeries) { root.openSeriesView(book); return }
    root.statusText = ""
    root.detailAsin = book.asin
  }

  function closeDetail() {
    var back = root.detailReturnAsin   // HOOK(discover)
    root.detailReturnAsin = ""
    root.detailAsin = back
    root.statusText = ""
    if (back === "") keyCatcher.forceActiveFocus()
  }

  // HOOK(discover): "More like this" opens another book's details; Back goes to this one.
  function openCatalogBook(asin) {
    if (!asin) return
    root.detailReturnAsin = root.detailAsin
    root.statusText = ""
    root.detailAsin = asin
  }

  function detailAction(id) {
    if (id.indexOf("open:") === 0) { root.openCatalogBook(id.substr(5)); return }   // HOOK(discover)
    var book = root.detailBook
    if (!book) return
    root.statusText = ""
    if (id === "play") root.playBook(book)
    else if (id === "toggle") { if (root.service) root.service.togglePause() }
    else if (id === "download") root.downloadBook(book)
    else if (id === "remove") root.askRemove(book)
    else if (id === "finish") root.markFinishedBook(book, false)
    else if (id === "unfinish") root.markFinishedBook(book, true)
    else if (id === "series") {
      var title = book.series ? book.series.title : ""
      root.closeDetail()
      if (title) root.openSeriesView({ asin: "series:" + Lib.seriesKeyOf(book), title: title })
    }
  }

  // A series view replaces the grid with just that series' books (Esc / Backspace goes back).
  property string openSeries: ""
  property string seriesReturnAsin: ""

  function openSeriesView(tile) {
    if (!tile) return
    root.seriesReturnAsin = tile.asin
    root.openSeries = tile.title
    root.query = ""
    root.searching = false
    root.statusText = ""
    var secs = Lib.seriesSections(root.books, tile.title, { status: root.statusFilter })
    var next = secs.length ? Lib.nextUp(secs[0].books) : null   // land on the next book you have not finished
    root.selectedAsin = next ? next.asin : ""
    root.rebuild()
  }

  function closeSeriesView() {
    if (root.openSeries === "") return
    root.openSeries = ""
    root.selectedAsin = root.seriesReturnAsin
    root.seriesReturnAsin = ""
    root.query = ""
    root.statusText = ""
    root.rebuild()
  }

  // HOOK(discover): the "Show more" link of a header row. Suggested has its own state.
  property bool suggestExpanded: false
  function toggleSection(id) {
    if (id === "suggested") root.suggestExpanded = !root.suggestExpanded
    else root.toggleContinue()
  }

  function toggleContinue() {
    if (root.service && typeof root.service.setContinueExpanded === "function") root.service.setContinueExpanded(!root.continueExpanded)
  }

  function toggleGroup() {
    if (!root.service || typeof root.service.setGroupSeries !== "function") return
    root.service.setGroupSeries(!root.groupSeries)
    root.statusText = root.groupSeries ? "Showing every book separately." : "Grouping books by series."
  }

  readonly property real trackpadGain: (root.service && root.service.trackpadGain > 0) ? root.service.trackpadGain : 2.5
  readonly property real wheelRows: (root.service && root.service.scrollRows > 0) ? root.service.scrollRows : 0.5
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

  // Removing a download asks first, in a modal dialog (Delete is pre-selected; Esc or Cancel backs out).
  property var removeTarget: null
  readonly property string removeMessage: removeTarget
    ? "Delete “" + removeTarget.title + "” from this computer?\n\nThis frees about "
      + Math.max(1, Math.round((Number(removeTarget.runtimeSec) || 0) * 16000 / 1048576))
      + " MB. Your place and listen count are kept, and you can download it again any time."
    : ""

  // HOOK(discover): wishlist books are not in the library: no playing, downloading, deleting or marking.
  function notOwnedBook(book) {
    if (!book || book.inLibrary !== false) return false
    root.statusText = "Not in your library. Open it to see more, or add it to your wishlist."
    return true
  }

  function askRemove(book) {
    if (root.notOwnedBook(book)) return
    if (!book || !root.service) return
    if (book.isSeries) { root.statusText = "Open the series (Enter) to delete a book from it."; return }
    if (!root.isLocal(book.asin)) { root.statusText = "That book is not downloaded."; return }
    root.removeTarget = book
  }

  function cancelRemove() {
    root.removeTarget = null
    keyCatcher.forceActiveFocus()
  }

  function confirmRemove() {
    var book = root.removeTarget
    root.removeTarget = null
    keyCatcher.forceActiveFocus()
    if (!book || !root.service) return
    var err = root.service.removeDownload(book.asin)
    root.statusText = err !== "" ? err : "Deleted “" + book.title + "” from this computer. You can download it again any time."
  }

  function markFinishedBook(book, undo) {
    if (!book || !root.service) return
    if (root.notOwnedBook(book)) return
    if (book.isSeries) { root.statusText = "Open the series (Enter) to mark a book finished."; return }
    root.statusText = (undo ? root.service.unmarkFinished(book.asin) : root.service.markFinished(book.asin))
  }

  // The badge on a tile: download a book that is not here yet, or remove one that is.
  function badgeAction(book) {
    if (!book) return
    if (book.isSeries) { root.selectAsin(book.asin); root.openSeriesView(book); return }
    root.selectAsin(book.asin)
    if (root.isLocal(book.asin)) root.askRemove(book)
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
    root.openSeries = ""
    root.seriesReturnAsin = ""
    root.detailAsin = ""
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
  // HOOK(discover): Up next from the library. Ctrl+U toggles, Ctrl+Up / Ctrl+Down reorder.
  function isQueued(asin) {
    return !!asin && !!root.service && !!root.service.queue && root.service.queue.has(asin)
  }
  function toggleUpNext(book) {
    if (!book || book.isSeries || !root.service || !root.service.queue) return
    if (root.notOwnedBook(book)) return
    root.statusText = root.isQueued(book.asin) ? root.service.queue.remove(book.asin) : root.service.queue.add(book.asin)
  }
  function moveUpNext(asin, dir) {
    if (!root.service || !root.service.queue) return
    if (dir < 0) root.service.queue.moveUp(asin)
    else root.service.queue.moveDown(asin)
  }

  // HOOK(discover): the Wishlist view (Ctrl+W): books on your Audible wishlist that are not in your library.
  property bool wishlistView: false
  onWishlistViewChanged: {
    if (root.wishlistView && root.service && root.service.catalog) root.service.catalog.ensureWishlist()
    root.statusText = root.wishlistView ? "Your Audible wishlist. These books are not in your library." : ""
    root.rebuild()
  }
  function toggleWishlist() { root.wishlistView = !root.wishlistView }

  // Suggested (one row, up to 24 ranked books) and Up next, on the main view only.
  function discoverContext() {
    var q = root.service && root.service.queue ? root.service.queue : null
    var queued = q && Array.isArray(q.asins) ? q.asins : []
    return {
      suggested: Sug.suggest(root.books, { exclude: queued, limit: 24, pace: null }),
      upNext: q && Array.isArray(q.pendingBooks) ? q.pendingBooks : []
    }
  }

  function rebuild() {
    var map = {}
    for (var i = 0; i < root.books.length; i++) map[root.books[i].asin] = root.books[i]
    var secs = root.openSeries !== ""
      ? Lib.seriesSections(root.books, root.openSeries, { query: root.query, status: root.statusFilter })
      : Lib.sections(root.books, { query: root.query, sort: root.sortMode, status: root.statusFilter, group: root.groupSeries })
    // HOOK(discover): the wishlist view replaces the sections; the main view gets Suggested and Up next.
    if (root.wishlistView) secs = root.service && root.service.catalog && root.service.catalog.wishlistBooks.length
      ? [{ id: "wishlist", title: "Wishlist (not in your library)", books: root.service.catalog.wishlistBooks }] : []
    else if (root.openSeries === "" && root.query === "") secs = Disc.compose(secs, root.discoverContext())
    // Series tiles, wishlist books and Suggested copies are not in root.books: register every book on screen
    // so selection and activation can find them (HOOK(discover): was series tiles only).
    for (var s = 0; s < secs.length; s++)
      for (var t = 0; t < secs[s].books.length; t++) map[secs[s].books[t].asin] = secs[s].books[t]
    root.bookByAsin = map
    // "Continue listening" is one row until expanded (the main view only, and not while searching).
    var limits = {}
    if (root.openSeries === "" && root.query === "") limits["continue"] = root.isGrid ? root.columns : 5
    limits["suggested"] = root.isGrid ? root.columns : 5   // HOOK(discover): Suggested is one row until expanded
    var built = Lib.buildRows(secs, root.columns, { limits: limits, expanded: { "continue": root.continueExpanded, "suggested": root.suggestExpanded } })
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
    if (root.notOwnedBook(book)) return
    if (book.isSeries) { root.openSeriesView(book); return }
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
    if (root.notOwnedBook(book)) return
    if (book.isSeries) { root.statusText = "Open the series (Enter) to download a book from it."; return }
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

  // HOOK(discover): Up next and the wishlist change while the library is open.
  Connections {
    target: root.service && root.service.queue ? root.service.queue : null
    ignoreUnknownSignals: true
    function onAsinsChanged() { root.rebuild() }
  }
  Connections {
    target: root.service && root.service.catalog ? root.service.catalog : null
    ignoreUnknownSignals: true
    function onWishEntriesChanged() { if (root.wishlistView) root.rebuild() }
    function onWishLoadingChanged() {
      if (root.wishlistView && root.service.catalog.wishLoading) root.statusText = "Loading your wishlist..."
    }
    function onWishErrorChanged() {
      if (root.wishlistView && root.service.catalog.wishError !== "") root.statusText = "Could not load your wishlist: " + root.service.catalog.wishError
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

      BookDetail {
        id: detailView
        anchors.fill: parent
        z: 50
        visible: root.detailBook !== null
        book: root.detailBook
        service: root.service
        note: root.statusText
        onBackRequested: root.closeDetail()
        onActivated: function(id) { root.detailAction(id) }
      }

      ConfirmDialog {
        id: removeDialog
        anchors.fill: parent
        z: 100
        opened: root.removeTarget !== null
        message: root.removeMessage
        confirmText: "Delete"
        cancelText: "Cancel"
        background: root.background
        foreground: root.foreground
        scrim: root.scrim
        selectedBackground: root.selectedBackground
        selectedText: root.selectedText
        fontFamily: root.fontFamily
        cornerRadius: root.cornerRadius
        onOpenedChanged: if (opened) selectedIndex = 1   // Delete is the pre-selected button
        onCanceled: root.cancelRemove()
        onConfirmed: root.confirmRemove()
      }
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
          // The delete dialog is modal: it gets every key until it closes.
          if (removeDialog.opened) { removeDialog.handleKey(event); event.accepted = true; return }
          // So is the details page.
          if (root.detailBook !== null) { detailView.handleKey(event); event.accepted = true; return }

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
            } else if (root.wishlistView) {
              root.wishlistView = false   // HOOK(discover)
            } else if (root.openSeries !== "") {
              root.closeSeriesView()
            } else {
              root.close()
            }
            event.accepted = true
          } else if (event.key === Qt.Key_Backspace && root.query === "" && !root.searching && root.openSeries !== "") {
            root.closeSeriesView(); event.accepted = true
          } else if (Util.editsFilter(event, root.query)) {
            root.setQuery(Util.editedFilter(event, root.query))
            event.accepted = true
          } else if (ctrl && (event.key === Qt.Key_Up || event.key === Qt.Key_Down) && root.isQueued(root.selectedAsin)) {
            root.moveUpNext(root.selectedAsin, event.key === Qt.Key_Up ? -1 : 1); event.accepted = true   // HOOK(discover)
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
            if (event.modifiers & Qt.ShiftModifier) root.playBook(root.selectedBook())
            else root.openDetail(root.selectedBook())
            event.accepted = true
          } else if (ctrl && event.key === Qt.Key_U) {
            root.toggleUpNext(root.selectedBook()); event.accepted = true   // HOOK(discover)
          } else if (ctrl && event.key === Qt.Key_W) {
            root.toggleWishlist(); event.accepted = true   // HOOK(discover)
          } else if (ctrl && event.key === Qt.Key_F) {
            root.cycleFilter(); event.accepted = true
          } else if (ctrl && event.key === Qt.Key_G) {
            root.toggleGroup(); event.accepted = true
          } else if (ctrl && event.key === Qt.Key_E) {
            root.toggleContinue(); event.accepted = true
          } else if (ctrl && event.key === Qt.Key_X) {
            root.askRemove(root.selectedBook()); event.accepted = true
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
                : (root.openSeries !== "" ? "‹ Back to library (Esc)"
                : (root.query !== "" ? root.countResults() + " results"
                  : (root.filterLabel !== "" ? root.filterLabel + " · " + root.countResults() + " books" : root.books.length + " books")))

              MouseArea {
                anchors.fill: parent
                enabled: root.openSeries !== ""
                cursorShape: Qt.PointingHandCursor
                onClicked: root.closeSeriesView()
              }
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

              // Qt's default wheel step is ~55 px a notch, a fifth of a grid row here. Scroll by a
              // fraction of a row per notch (grid) or a few rows (list), animated, and let notches
              // queue up instead of stalling.
              NumberAnimation { id: wheelAnim; target: resultView; property: "contentY"; duration: 130; easing.type: Easing.OutCubic }
              WheelHandler {
                target: null
                acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
                onWheel: function(event) {
                  var r = Lib.wheelStep({
                    pixelY: event.pixelDelta.y, angleY: event.angleDelta.y,
                    rowHeight: root.isGrid ? root.cellHeight : root.listRowHeight,
                    rows: root.wheelRows, grid: root.isGrid, trackpadGain: root.trackpadGain
                  })
                  var minY = resultView.originY
                  var maxY = resultView.originY + Math.max(0, resultView.contentHeight - resultView.height)
                  resultView.cancelFlick()
                  if (r.animate) {
                    // mouse wheel: glide, and let quick notches queue up
                    var base = wheelAnim.running ? wheelAnim.to : resultView.contentY
                    wheelAnim.stop()
                    wheelAnim.to = Math.max(minY, Math.min(maxY, base - r.dy))
                    wheelAnim.restart()
                  } else {
                    // trackpad: move with the fingers, no animation to lag behind them
                    wheelAnim.stop()
                    resultView.contentY = Math.max(minY, Math.min(maxY, resultView.contentY - r.dy))
                  }
                  event.accepted = true
                }
              }

              delegate: Item {
                id: rowItem
                required property var modelData
                required property int index

                width: ListView.view ? ListView.view.width : 0
                height: modelData.kind === "header" ? root.sectionHeaderHeight
                  : (root.isGrid ? root.cellHeight : root.listRowHeight)

                // Section header
                Text {
                  id: expandHint
                  visible: rowItem.modelData.kind === "header" && rowItem.modelData.collapsible === true
                  anchors.right: parent.right
                  anchors.bottom: parent.bottom
                  anchors.bottomMargin: Style.space(4)
                  textFormat: Text.PlainText
                  text: rowItem.modelData.kind !== "header" ? ""
                    : (rowItem.modelData.expanded ? "Show less ▴" : "Show " + rowItem.modelData.hidden + " more ▾")
                  color: root.accent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body

                  MouseArea {
                    anchors.fill: parent
                    anchors.margins: -Style.space(6)
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.toggleSection(rowItem.modelData.id)   // HOOK(discover)
                  }
                }

                Text {
                  visible: rowItem.modelData.kind === "header"
                  anchors.left: parent.left
                  anchors.right: expandHint.visible ? expandHint.left : parent.right
                  anchors.rightMargin: expandHint.visible ? Style.space(12) : 0
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
                      readonly property string badge: book.isSeries === true ? book.seriesCount + " books"
                        : !listenable ? "Unavailable"
                        : (dl && dl.state === "failed") ? "Failed"
                        : (dl && dl.state === "queued") ? "Queued"
                        : (dl && dl.state === "downloading") ? Math.round((Number(dl.fraction) || 0) * 100) + "%"
                        : local ? (selected ? "Downloaded  ✕" : "Downloaded")
                        : (selected ? "⇣ Download" : "")
                      readonly property color badgeColor: book.isSeries === true ? root.accent
                        : (dl && dl.state === "failed") ? root.urgent
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
                        z: 5   // above the tile's whole-tile click area (declared later), so the badges get their own clicks
                        visible: root.isGrid
                        anchors.fill: parent

                        // A series: two more covers peeking out behind the first.
                        Repeater {
                          model: tile.book.isSeries === true && root.isGrid ? 2 : 0
                          Rectangle {
                            required property int index
                            x: coverBox.x + Style.space(4) * (index + 1)
                            y: coverBox.y - Style.space(4) * (index + 1)
                            width: coverBox.width
                            height: coverBox.height
                            color: Util.alpha(root.foreground, index === 0 ? 0.16 : 0.09)
                            border.width: 1
                            border.color: Util.alpha(root.foreground, 0.28)
                          }
                        }

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
                          text: tile.book.reason ? tile.book.reason : tile.book.author   // HOOK(discover)
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
                          root.openDetail(tile.book)
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
            text: root.wishlistView
              ? "Enter details · Ctrl+W back to library · Esc back to library"
              : "Enter details · Shift+Enter play · Ctrl+U up next · Ctrl+↑↓ reorder · Ctrl+W wishlist · Ctrl+D download · Ctrl+X delete · Ctrl+M finished · Ctrl+F filter · Ctrl+G series · Ctrl+E more · Ctrl+S sort: " + (root.sortMode === "recent" ? "last played" : "added") + " · Tab view · Esc"
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
