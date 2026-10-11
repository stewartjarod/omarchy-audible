.pragma library
// Wishlist and catalog helpers. Pure: no QML, no I/O, no Qt. Every function tolerates bad input.
// Builds the argv for the read-only calls and the two wishlist WRITE calls. The write argv is
// only ever run from Catalog.qml after a second, deliberate user press. Nothing here runs anything.

var GROUPS = "contributors,product_desc,product_attrs,media,rating,series"
var ASIN_RE = /^[A-Za-z0-9]{4,24}$/

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function str(v) {
  if (v === null || v === undefined) return ""
  return typeof v === "string" ? v : String(v)
}

function cleanAsin(v) {
  var s = typeof v === "string" ? v.trim() : ""
  return ASIN_RE.test(s) ? s : ""
}

// "13h 31m" -> 48660, "5h" -> 18000, "45m" -> 2700, "-" or junk -> 0.
function parseLength(text) {
  var s = str(text)
  var h = /(\d+)\s*h/.exec(s)
  var m = /(\d+)\s*m/.exec(s)
  if (!h && !m) return 0
  return (h ? parseInt(h[1], 10) : 0) * 3600 + (m ? parseInt(m[1], 10) : 0) * 60
}

// CLI JSON envelope {error, result} (or a bare array). -> {ok, result, error}.
function parseEnvelope(text) {
  var data
  try {
    data = JSON.parse(str(text))
  } catch (e) {
    return { ok: false, result: null, error: "Unexpected reply from audible" }
  }
  if (Array.isArray(data)) return { ok: true, result: data, error: "" }
  if (isObj(data)) {
    if (data.error) {
      var msg = isObj(data.error) ? str(data.error.message) : str(data.error)
      return { ok: false, result: null, error: msg.trim() || "audible reported an error" }
    }
    return { ok: true, result: data.result === undefined ? null : data.result, error: "" }
  }
  return { ok: false, result: null, error: "Unexpected reply from audible" }
}

// `audible collections wishlist list -o json` -> {ok, entries, error}.
// Entry: {asin, title, authors, length, lengthSec, added, publication}.
function parseWishlist(text) {
  var env = parseEnvelope(text)
  if (!env.ok) return { ok: false, entries: [], error: env.error }
  var list = Array.isArray(env.result) ? env.result : []
  var entries = []
  var seen = {}
  for (var i = 0; i < list.length; i++) {
    var e = list[i]
    if (!isObj(e)) continue
    var asin = cleanAsin(e.asin)
    if (!asin || seen[asin]) continue
    seen[asin] = true
    entries.push({
      asin: asin,
      title: str(e.title).trim() || "Untitled",
      authors: str(e.authors).trim(),
      length: str(e.length).trim(),
      lengthSec: parseLength(e.length),
      added: str(e.added).trim(),
      publication: str(e.publication).trim()
    })
  }
  return { ok: true, entries: entries, error: "" }
}

// Wishlist entry -> a Book (LibraryModel shape) for a grid tile. Not owned: inLibrary false.
function wishlistBook(entry) {
  var authors = str(entry.authors).split(",").map(function (s) { return s.trim() }).filter(function (s) { return s })
  return {
    asin: entry.asin,
    title: entry.title,
    subtitle: "",
    authors: authors,
    author: authors.join(", "),
    narrators: [],
    coverUrl: "",
    runtimeSec: entry.lengthSec || 0,
    series: null,
    percentComplete: 0,
    remainingSec: 0,
    finished: false,
    listenable: true,
    releaseDate: "",
    description: "",
    publisher: "",
    rating: 0,
    ratingCount: 0,
    format: "",
    purchaseDate: "",
    local: false,
    download: null,
    resumeSec: 0,
    lastListenedAt: 0,
    finishedAt: 0,
    inLibrary: false,
    wishlist: true,
    addedAt: entry.added,
    reason: "Not in your library"
  }
}

// The wishlist as library tiles, newest added first, without anything you already own.
function wishlistBooks(entries, ownedBooks, covers) {
  var owned = {}
  var list = Array.isArray(ownedBooks) ? ownedBooks : []
  for (var i = 0; i < list.length; i++) if (isObj(list[i]) && list[i].asin) owned[list[i].asin] = true
  var src = Array.isArray(entries) ? entries : []
  return src
    .map(function (e, idx) { return { e: e, idx: idx } })
    .filter(function (x) { return isObj(x.e) && cleanAsin(x.e.asin) && !owned[x.e.asin] })
    .sort(function (a, b) {
      var da = str(a.e.added), db = str(b.e.added)
      if (da !== db) return da < db ? 1 : -1
      return a.idx - b.idx
    })
    .map(function (x) {
      var b = wishlistBook(x.e)
      var url = isObj(covers) ? str(covers[b.asin]) : ""
      if (url) b.coverUrl = url
      return b
    })
}

function inWishlist(entries, asin) {
  var a = cleanAsin(asin)
  var list = Array.isArray(entries) ? entries : []
  for (var i = 0; i < list.length; i++) if (isObj(list[i]) && list[i].asin === a) return true
  return false
}

// Catalog product reply -> the raw product object (or null).
function productOf(result) {
  if (!isObj(result)) return null
  if (isObj(result.product)) return result.product
  return typeof result.title === "string" ? result : null
}

// Sims reply -> raw catalog items (an array, possibly empty).
function simsOf(result) {
  if (!isObj(result) || !Array.isArray(result.similar_products)) return []
  return result.similar_products.filter(function (x) { return isObj(x) && cleanAsin(x.asin) })
}

// ---- argv builders (run through Service.run, which does not use a shell) ----------------------

function listArgs() {
  return ["audible", "collections", "wishlist", "list", "-o", "json"]
}

function productArgs(asin) {
  var a = cleanAsin(asin)
  if (!a) return null
  return ["audible", "api", "GET", "/1.0/catalog/products/" + a, "--query", "response_groups=" + GROUPS, "-o", "json"]
}

// One catalog call for up to 50 books' covers (the wishlist list has no images).
var COVER_BATCH = 50

function coverArgs(asins) {
  var list = (Array.isArray(asins) ? asins : []).map(cleanAsin).filter(function (a) { return a }).slice(0, COVER_BATCH)
  if (!list.length) return null
  return ["audible", "api", "GET", "/1.0/catalog/products", "--query", "asins=" + list.join(","), "--query", "response_groups=media", "--query", "num_results=" + COVER_BATCH, "-o", "json"]
}

// Split asins into batches of COVER_BATCH, leaving out any that already have a cover.
function coverBatches(asins, have) {
  var out = []
  var cur = []
  var seen = {}
  var list = Array.isArray(asins) ? asins : []
  for (var i = 0; i < list.length; i++) {
    var a = cleanAsin(list[i])
    if (!a || seen[a] || (isObj(have) && have[a])) continue
    seen[a] = true
    cur.push(a)
    if (cur.length === COVER_BATCH) { out.push(cur); cur = [] }
  }
  if (cur.length) out.push(cur)
  return out
}

// Catalog products reply -> { asin: coverUrl } for the books that have one.
function parseCovers(result) {
  var map = {}
  var list = isObj(result) && Array.isArray(result.products) ? result.products : []
  for (var i = 0; i < list.length; i++) {
    var p = list[i]
    if (!isObj(p) || !cleanAsin(p.asin) || !isObj(p.product_images)) continue
    var keys = Object.keys(p.product_images).sort(function (a, b) { return parseInt(b, 10) - parseInt(a, 10) })
    for (var k = 0; k < keys.length; k++) {
      var u = str(p.product_images[keys[k]])
      if (/^https:\/\//.test(u)) { map[p.asin] = u; break }
    }
  }
  return map
}

function simsArgs(asin) {
  var a = cleanAsin(asin)
  if (!a) return null
  return ["audible", "api", "GET", "/1.0/catalog/products/" + a + "/sims", "--query", "num_results=10", "--query", "response_groups=" + GROUPS, "-o", "json"]
}

// WRITE. Only Catalog.qml, only after a confirmed second press.
function addArgs(asin) {
  var a = cleanAsin(asin)
  if (!a) return null
  return ["audible", "collections", "wishlist", "add", "--asin", a, "-o", "json"]
}

// WRITE. Only Catalog.qml, only after a confirmed second press.
function removeArgs(asin) {
  var a = cleanAsin(asin)
  if (!a) return null
  return ["audible", "collections", "wishlist", "remove", "--asin", a, "-o", "json"]
}

if (typeof module !== "undefined") module.exports = { GROUPS, parseLength, parseEnvelope, parseWishlist, wishlistBook, wishlistBooks, inWishlist, productOf, simsOf, listArgs, productArgs, coverArgs, coverBatches, parseCovers, simsArgs, addArgs, removeArgs }
