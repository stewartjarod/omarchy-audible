import QtQuick
import "LibraryModel.js" as Lib
import "WishlistModel.js" as W

// Catalog and wishlist access for the library. Everything here is READ-ONLY except the two wishlist
// changes (add / remove), which run only after an explicit second press on the same book
// (requestWrite). Results stay in memory for this session. HOOK(discover): Service.qml creates it
// as `catalogCtl` and exposes it as `catalog`.
Item {
  id: root

  property var svc: null

  property var detailCache: ({})     // asin -> Book from the catalog (books you do not own)
  property var simsCache: ({})       // asin -> [asin] for "More like this"; null while loading
  property var wishEntries: []       // raw wishlist entries from `audible collections wishlist list`
  property bool wishLoaded: false
  property bool wishLoading: false
  property string wishError: ""

  property string writeAsin: ""      // a wishlist change waiting for its second press
  property string writeKind: ""      // "add" | "remove"
  property string writeNote: ""      // one plain line of feedback for the details page

  // The wishlist as tiles, not counting anything you own.
  readonly property var wishlistBooks: W.wishlistBooks(root.wishEntries, root.svc ? root.svc.books : [])

  function withKey(obj, key, value) {
    var n = {}
    for (var k in obj) n[k] = obj[k]
    n[key] = value
    return n
  }

  function ownedBook(asin) {
    var list = root.svc && Array.isArray(root.svc.books) ? root.svc.books : []
    for (var i = 0; i < list.length; i++) if (list[i].asin === asin) return list[i]
    return null
  }

  function isOwned(asin) { return ownedBook(asin) !== null }

  function titleOf(asin) {
    var b = detailFor(asin, null)
    return b && b.title ? b.title : "this book"
  }

  // The book to show on the details page: an owned book as it is, or the catalog copy for a book
  // you do not own (falls back to the grid's copy until the catalog answers).
  function detailFor(asin, fallback) {
    if (!asin) return fallback || null
    if (fallback && fallback.inLibrary !== false) return fallback
    if (fallback && fallback.inLibrary === false) return root.detailCache[asin] || fallback
    var owned = ownedBook(asin)
    if (owned) return owned
    return root.detailCache[asin] || null
  }

  // Full catalog details for one book you do not own (cover, summary, rating, narrator, length).
  function ensureDetail(asin) {
    if (!root.svc || !asin || isOwned(asin)) return
    root.ensureWishlist()   // so "Add to wishlist" / "Remove from wishlist" is right
    if (root.detailCache[asin] && root.detailCache[asin].detailed === true) return
    var argv = W.productArgs(asin)
    if (!argv) return
    root.svc.run(argv, function (code, out) {
      var env = W.parseEnvelope(out)
      var raw = code === 0 && env.ok ? W.productOf(env.result) : null
      if (!raw) return
      var b = Lib.normalize(raw)
      if (!b) return
      b.inLibrary = false
      b.detailed = true
      root.detailCache = root.withKey(root.detailCache, b.asin, b)
    })
  }

  // "More like this" for any book: catalog suggestions, as Book objects (owned ones stay owned).
  function ensureSims(asin) {
    if (!root.svc || !asin || root.simsCache.hasOwnProperty(asin)) return
    root.ensureWishlist()
    var argv = W.simsArgs(asin)
    if (!argv) return
    root.simsCache = root.withKey(root.simsCache, asin, null)
    root.svc.run(argv, function (code, out) {
      var env = W.parseEnvelope(out)
      var items = code === 0 && env.ok ? W.simsOf(env.result) : []
      var ids = []
      var found = {}
      for (var i = 0; i < items.length; i++) {
        var b = Lib.normalize(items[i])
        if (!b) continue
        if (!b.description) b.description = Lib.clipText(Lib.stripHtml(String(items[i].short_description || "")), 1500)
        if (!isOwned(b.asin)) b.inLibrary = false
        ids.push(b.asin)
        found[b.asin] = b
      }
      // Keep any richer copy already fetched for the same book.
      var merged = {}
      for (var k in found) merged[k] = (root.detailCache[k] && root.detailCache[k].detailed === true) ? root.detailCache[k] : found[k]
      var cache = {}
      for (var c in root.detailCache) cache[c] = root.detailCache[c]
      for (var m in merged) cache[m] = merged[m]
      root.detailCache = cache
      root.simsCache = root.withKey(root.simsCache, asin, ids)
    })
  }

  // The "More like this" books for asin, as Book objects (empty while loading or when none).
  function similarFor(asin) {
    var ids = root.simsCache[asin]
    if (!Array.isArray(ids)) return []
    var out = []
    for (var i = 0; i < ids.length; i++) {
      var b = detailFor(ids[i], null)
      if (b) out.push(b)
    }
    return out
  }

  function similarPending(asin) { return root.simsCache.hasOwnProperty(asin) && root.simsCache[asin] === null }

  function inWishlist(asin) { return W.inWishlist(root.wishEntries, asin) }

  // READ-ONLY: the wishlist. Loaded when the library's Wishlist view opens.
  function ensureWishlist() { if (!root.wishLoaded && !root.wishLoading) root.refreshWishlist() }

  function refreshWishlist() {
    if (!root.svc || root.wishLoading) return
    root.wishLoading = true
    root.wishError = ""
    root.svc.run(W.listArgs(), function (code, out, err) {
      root.wishLoading = false
      var res = W.parseWishlist(out)
      if (code !== 0 || !res.ok) {
        root.wishError = res.error || String(err || "").split("\n")[0] || "Could not load your wishlist."
        return
      }
      root.wishError = ""
      root.wishEntries = res.entries
      root.wishLoaded = true
    })
  }

  // ---- wishlist changes (guarded) -------------------------------------------------------------
  // The first press only explains; the second press on the same book, same kind, does it.
  // Esc, moving to another book, or any other write cancels the pending one.
  function requestWrite(kind, asin, shownTitle) {
    var argv = kind === "add" ? W.addArgs(asin) : (kind === "remove" ? W.removeArgs(asin) : null)
    if (!argv || !root.svc) return
    var title = shownTitle ? String(shownTitle) : root.titleOf(asin)
    if (root.writeAsin === asin && root.writeKind === kind) {
      root.writeAsin = ""
      root.writeKind = ""
      root.writeNote = "Working on it..."
      root.runWrite(kind, argv)
      return
    }
    root.writeAsin = asin
    root.writeKind = kind
    root.writeNote = kind === "add"
      ? "Press Enter again to add “" + title + "” to your Audible wishlist. Esc cancels."
      : "Press Enter again to remove “" + title + "” from your Audible wishlist. Esc cancels."
  }

  function cancelWrite() {
    root.writeAsin = ""
    root.writeKind = ""
    root.writeNote = ""
  }

  function runWrite(kind, argv) {
    root.svc.run(argv, function (code, out, err) {
      if (code === 0) {
        root.writeNote = kind === "add" ? "Added to your wishlist." : "Removed from your wishlist."
        root.refreshWishlist()
      } else {
        root.writeNote = "Could not change your wishlist: " + (String(err || out || "unknown error").split("\n")[0])
      }
    })
  }
}
