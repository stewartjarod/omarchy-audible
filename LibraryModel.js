.pragma library

// Pure helpers for the jarod.audible library screen. No QML, no I/O, no Qt.
// Every function tolerates malformed input: it never throws.

var FOLD_MAP = { "ø": "o", "ß": "ss", "æ": "ae", "œ": "oe", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i" }
var WORD_SPLIT = /[\s\-_:;,.!?'"()\[\]\/&·|–—’‘“”…]+/

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function str(v) {
  if (v === null || v === undefined) return ""
  return typeof v === "string" ? v : String(v)
}

function num(v, fallback) {
  if (typeof v === "number") return isFinite(v) ? v : fallback
  if (typeof v === "string" && v.trim() !== "") {
    var n = Number(v)
    return isFinite(n) ? n : fallback
  }
  return fallback
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v)
}

function trunc(v) {
  return v < 0 ? Math.ceil(v) : Math.floor(v)
}

// Lower-case and strip diacritics so "Café" matches "cafe" and "Ø" matches "o".
function fold(text) {
  var s = str(text).toLowerCase()
  if (typeof s.normalize === "function") {
    try { s = s.normalize("NFD") } catch (e) { /* keep raw */ }
  }
  s = s.replace(/[̀-ͯ]/g, "")
  return s.replace(/[øßæœłđðþı]/g, function (c) { return FOLD_MAP[c] })
}

function words(folded) {
  return folded.split(WORD_SPLIT).filter(function (w) { return w.length > 0 })
}

function tokens(query) {
  return words(fold(query))
}

function isUrl(v) {
  return /^(https:\/\/|file:\/\/)/.test(v)
}

function namesOf(list) {
  var out = []
  if (!Array.isArray(list)) return out
  for (var i = 0; i < list.length; i++) {
    var entry = list[i]
    var name = isObj(entry) ? str(entry.name).trim() : str(entry).trim()
    if (name) out.push(name)
  }
  return out
}

function seriesOf(raw) {
  var list = Array.isArray(raw) ? raw : (isObj(raw) ? [raw] : [])
  for (var i = 0; i < list.length; i++) {
    var s = list[i]
    if (!isObj(s)) continue
    var title = str(s.title).trim()
    if (!title) continue
    return { title: title, sequence: str(s.sequence).trim() }
  }
  return null
}

// product_images is { "<size>": url }; prefer the largest size that is a usable URL.
function coverOf(images) {
  if (!isObj(images)) return ""
  var best = ""
  var bestSize = -Infinity
  var keys = Object.keys(images)
  for (var i = 0; i < keys.length; i++) {
    var url = images[keys[i]]
    if (typeof url !== "string" || !isUrl(url)) continue
    var size = num(Number(keys[i]), 0)
    if (size > bestSize) {
      best = url
      bestSize = size
    }
  }
  return best
}

function toMs(v) {
  if (typeof v === "number") return isFinite(v) ? v : 0
  if (typeof v === "string" && v) {
    var t = Date.parse(v)
    return isFinite(t) ? t : 0
  }
  return 0
}

function errorText(e) {
  if (isObj(e)) return str(e.message).trim() || "Unknown library error."
  return str(e).trim() || "Unknown library error."
}

// Raw `audible api GET /1.0/library` item -> Book.
// Returns null when the item has no asin (cannot be addressed).
function normalize(item) {
  if (!isObj(item)) return null
  var asin = str(item.asin).trim()
  if (!asin) return null

  var ls = isObj(item.listening_status) ? item.listening_status : null
  var lib = isObj(item.library_status) ? item.library_status : null

  var authors = namesOf(item.authors)
  var narrators = namesOf(item.narrators)

  var runtimeMin = num(item.runtime_length_min, 0)
  var runtimeSec = runtimeMin > 0 ? Math.round(runtimeMin * 60) : 0

  var pct = ls ? num(ls.percent_complete, null) : null
  if (pct === null) pct = num(item.percent_complete, 0)
  pct = clamp(pct, 0, 100)

  // finished_at_timestamp is NOT a finish signal: it stays set from an earlier listen even
  // when the book was restarted (seen at 16% and 48% in real data). Trust is_finished or >= 99%.
  var finished = (ls && ls.is_finished === true) ||
    item.is_finished === true ||
    pct >= 99

  var remaining = ls ? num(ls.time_remaining_seconds, 0) : 0

  return {
    asin: asin,
    title: str(item.title).trim() || "Untitled",
    subtitle: str(item.subtitle).trim(),
    authors: authors,
    author: authors.join(", "),
    narrators: narrators,
    coverUrl: coverOf(item.product_images),
    runtimeSec: runtimeSec,
    series: seriesOf(item.series),
    percentComplete: pct,
    remainingSec: Math.max(0, remaining),
    finished: !!finished,
    listenable: item.is_listenable !== false,
    releaseDate: str(item.release_date),
    purchaseDate: str(item.purchase_date) || str(lib && lib.date_added),
    // Local state, filled by merge().
    local: false,
    download: null,
    resumeSec: 0,
    lastListenedAt: 0
  }
}

// Response text of `audible api GET /1.0/library` -> {books, error}.
// Accepts the CLI envelope {error, result: {items}}, a bare {items}, or a bare array.
function parseApiPage(jsonText) {
  var data
  if (typeof jsonText === "string") {
    try { data = JSON.parse(jsonText) } catch (e) {
      return { books: [], error: "The library response was not valid JSON." }
    }
  } else {
    data = jsonText
  }
  if (!isObj(data) && !Array.isArray(data)) {
    return { books: [], error: "The library response was empty." }
  }
  if (isObj(data) && data.error) {
    return { books: [], error: errorText(data.error) }
  }
  var result = (isObj(data) && data.result !== undefined && data.result !== null) ? data.result : data
  var items = null
  if (Array.isArray(result)) items = result
  else if (isObj(result) && Array.isArray(result.items)) items = result.items
  if (!items) {
    return { books: [], error: "The library response had no items." }
  }

  var books = []
  var seen = {}
  for (var i = 0; i < items.length; i++) {
    var book = normalize(items[i])
    if (!book || seen[book.asin]) continue
    seen[book.asin] = true
    books.push(book)
  }
  return { books: books, error: null }
}

// Overlay local state (Service.localAsins / downloads / resume) on Books.
// Returns new objects; the inputs are not mutated.
function merge(books, local) {
  var L = isObj(local) ? local : {}
  var localAsins = isObj(L.localAsins) ? L.localAsins : {}
  var downloads = isObj(L.downloads) ? L.downloads : {}
  var resume = isObj(L.resume) ? L.resume : {}
  var list = Array.isArray(books) ? books : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var src = list[i]
    if (!isObj(src) || !src.asin) continue
    var asin = src.asin
    var d = downloads[asin]
    var download = (isObj(d) && d.state)
      ? { state: str(d.state), fraction: clamp(num(d.fraction, 0), 0, 1) }
      : null
    var r = resume[asin]
    var copy = {}
    var keys = Object.keys(src)
    for (var k = 0; k < keys.length; k++) copy[keys[k]] = src[keys[k]]
    copy.local = !!localAsins[asin] || (download !== null && download.state === "done")
    copy.download = download
    copy.resumeSec = isObj(r) ? Math.max(0, num(r.position, 0)) : 0
    copy.lastListenedAt = isObj(r) ? toMs(r.updatedAt) : 0
    out.push(copy)
  }
  return out
}

// Ranking tiers for one token (lower is better); -1 means no match.
// 0 title prefix, 1 title word prefix, 2 title contains, 3 author, 4 other fields.
function tokenTier(book, tok) {
  var title = fold(book.title)
  if (title.indexOf(tok) === 0) return 0
  var titleWords = words(title)
  for (var i = 0; i < titleWords.length; i++) {
    if (titleWords[i].indexOf(tok) === 0) return 1
  }
  if (title.indexOf(tok) >= 0) return 2
  if (fold(book.author).indexOf(tok) >= 0) return 3
  var others = [fold(book.subtitle), fold(book.series && book.series.title)]
  var narr = Array.isArray(book.narrators) ? book.narrators : []
  for (var n = 0; n < narr.length; n++) others.push(fold(narr[n]))
  var auth = Array.isArray(book.authors) ? book.authors : []
  for (var a = 0; a < auth.length; a++) others.push(fold(auth[a]))
  for (var o = 0; o < others.length; o++) {
    if (others[o].indexOf(tok) >= 0) return 4
  }
  return -1
}

// Multi-token AND search. A book ranks by its best token tier. Ties keep input order.
function filter(books, query) {
  var list = Array.isArray(books) ? books : []
  var toks = tokens(query)
  if (toks.length === 0) return list.slice()
  var scored = []
  for (var i = 0; i < list.length; i++) {
    var book = list[i]
    if (!isObj(book)) continue
    var rank = Infinity
    var ok = true
    for (var t = 0; t < toks.length; t++) {
      var tier = tokenTier(book, toks[t])
      if (tier < 0) { ok = false; break }
      if (tier < rank) rank = tier
    }
    if (ok) scored.push({ book: book, rank: rank, index: i })
  }
  scored.sort(function (a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank
    return a.index - b.index
  })
  return scored.map(function (s) { return s.book })
}

function isContinue(b) {
  return b.listenable !== false && !b.finished && (b.percentComplete > 0 || b.resumeSec > 0)
}

function byIndex(list) {
  return list.map(function (entry, i) { return { b: entry, i: i } })
}

// Sections for the screen. Without a query each book lands in exactly one of
// continue / downloaded / all. Empty sections are omitted.
function sections(books, opts) {
  var list = Array.isArray(books) ? books.filter(isObj) : []
  var query = opts && opts.query
  if (tokens(query).length > 0) {
    var hits = filter(list, query)
    return hits.length ? [{ id: "results", title: "Results", books: hits }] : []
  }

  var cont = []
  var downloaded = []
  var all = []
  for (var i = 0; i < list.length; i++) {
    var b = list[i]
    if (isContinue(b)) cont.push(b)
    else if (b.local) downloaded.push(b)
    else all.push(b)
  }

  cont = byIndex(cont).sort(function (x, y) {
    var ax = toMs(x.b.lastListenedAt), ay = toMs(y.b.lastListenedAt)
    if (ax !== ay) return ay - ax
    if (x.b.percentComplete !== y.b.percentComplete) return y.b.percentComplete - x.b.percentComplete
    return x.i - y.i
  }).map(function (e) { return e.b })

  var byPurchase = function (x, y) {
    var px = str(x.b.purchaseDate), py = str(y.b.purchaseDate)
    if (px !== py) return px < py ? 1 : -1
    return x.i - y.i
  }
  downloaded = byIndex(downloaded).sort(byPurchase).map(function (e) { return e.b })
  all = byIndex(all).sort(byPurchase).map(function (e) { return e.b })

  var out = []
  if (cont.length) out.push({ id: "continue", title: "Continue listening", books: cont })
  if (downloaded.length) out.push({ id: "downloaded", title: "Downloaded", books: downloaded })
  if (all.length) out.push({ id: "all", title: "All books", books: all })
  return out
}

// Flat index navigation. Vertical moves step by `columns`; horizontal moves step by 1.
// With columns == 1 (list) dx is ignored. Clamped at both ends, no wrap.
function moveSelection(o) {
  var opts = isObj(o) ? o : {}
  var count = Math.max(0, Math.floor(num(opts.count, 0)))
  if (count === 0) return 0
  var cols = Math.max(1, Math.floor(num(opts.columns, 1)))
  var index = clamp(Math.floor(num(opts.index, 0)), 0, count - 1)
  var dx = trunc(num(opts.dx, 0))
  var dy = trunc(num(opts.dy, 0))
  if (cols === 1) dx = 0
  var next = index + dx + dy * cols
  return clamp(next, 0, count - 1)
}

// Rows for a ListView: one header row per section, then rows of up to `columns` books.
function buildRows(sectionList, columns) {
  var cols = Math.max(1, Math.floor(num(columns, 1)))
  var rows = []
  var list = Array.isArray(sectionList) ? sectionList : []
  for (var s = 0; s < list.length; s++) {
    var sec = list[s]
    var books = Array.isArray(sec.books) ? sec.books : []
    rows.push({ kind: "header", id: sec.id, title: sec.title, count: books.length })
    for (var i = 0; i < books.length; i += cols) {
      rows.push({ kind: "books", sectionId: sec.id, books: books.slice(i, i + cols) })
    }
  }
  return rows
}

// Cursor over buildRows() output: {row, col}. row is -1 when there is nothing to select.
function firstCursor(rows) {
  var list = Array.isArray(rows) ? rows : []
  for (var i = 0; i < list.length; i++) {
    if (list[i].kind === "books") return { row: i, col: 0 }
  }
  return { row: -1, col: 0 }
}

function cursorOf(rows, asin) {
  var list = Array.isArray(rows) ? rows : []
  if (asin) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind !== "books") continue
      for (var j = 0; j < list[i].books.length; j++) {
        if (list[i].books[j].asin === asin) return { row: i, col: j }
      }
    }
  }
  return firstCursor(list)
}

function asinAt(rows, cursor) {
  var row = cursor && Array.isArray(rows) ? rows[cursor.row] : null
  if (!row || row.kind !== "books" || !row.books[cursor.col]) return ""
  return row.books[cursor.col].asin
}

// Visual navigation over buildRows() output. Vertical moves skip header rows and keep the
// column, clamped to the target row's length. Horizontal moves stay inside the row.
function stepCursor(rows, cursor, dx, dy) {
  var list = Array.isArray(rows) ? rows : []
  var valid = cursor && list[cursor.row] && list[cursor.row].kind === "books"
  if (!valid) return firstCursor(list)
  var row = cursor.row
  var col = cursor.col
  var vert = trunc(num(dy, 0))
  var horiz = trunc(num(dx, 0))
  if (vert !== 0) {
    var step = vert > 0 ? 1 : -1
    for (var n = 0; n < Math.abs(vert); n++) {
      var t = row + step
      while (t >= 0 && t < list.length && list[t].kind !== "books") t += step
      if (t < 0 || t >= list.length) break
      row = t
    }
    col = Math.min(col, list[row].books.length - 1)
  }
  if (horiz !== 0) {
    col = clamp(col + horiz, 0, list[row].books.length - 1)
  }
  return { row: row, col: col }
}

// Fraction 0..1 of the book already heard. Uses percentComplete, else resumeSec / runtimeSec.
function progressFraction(book) {
  if (!isObj(book)) return 0
  var pct = num(book.percentComplete, 0)
  if (pct > 0) return clamp(pct / 100, 0, 1)
  var resume = num(book.resumeSec, 0)
  var runtime = num(book.runtimeSec, 0)
  if (resume > 0 && runtime > 0) return clamp(resume / runtime, 0, 1)
  return 0
}

// Seconds -> "7h 42m", "42m", "7h", "<1m". Empty string for no usable duration.
function formatRuntime(sec) {
  var s = num(sec, 0)
  if (s <= 0) return ""
  if (s < 60) return "<1m"
  var minutes = Math.floor(s / 60)
  var hours = Math.floor(minutes / 60)
  var rem = minutes % 60
  if (hours > 0) return rem > 0 ? hours + "h " + rem + "m" : hours + "h"
  return minutes + "m"
}

// "Author · 7h 42m · 24%". Finished books show "Finished" in place of the percentage.
function formatMeta(book) {
  if (!isObj(book)) return ""
  var parts = []
  if (str(book.author)) parts.push(str(book.author))
  var rt = formatRuntime(book.runtimeSec)
  if (rt) parts.push(rt)
  if (book.finished) {
    parts.push("Finished")
  } else {
    var pct = Math.round(clamp(num(book.percentComplete, 0), 0, 100))
    if (pct > 0) parts.push(pct + "%")
  }
  return parts.join(" · ")
}

if (typeof module !== "undefined") module.exports = {
  parseApiPage: parseApiPage,
  normalize: normalize,
  merge: merge,
  filter: filter,
  sections: sections,
  moveSelection: moveSelection,
  formatMeta: formatMeta,
  formatRuntime: formatRuntime,
  buildRows: buildRows,
  firstCursor: firstCursor,
  cursorOf: cursorOf,
  asinAt: asinAt,
  stepCursor: stepCursor,
  progressFraction: progressFraction,
  fold: fold
}
