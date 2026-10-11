.pragma library
// Pure helpers for "Up next": an ordered list of ASINs the user wants to hear after the current book.
// No QML, no I/O, no Qt. Every function tolerates malformed input and never throws.
// The list is plain ASIN strings; the Book objects come from the library (LibraryModel.merge output).

var VERSION = 1
var ASIN_RE = /^[A-Za-z0-9]{4,24}$/

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function cleanAsin(v) {
  var s = typeof v === "string" ? v.trim() : ""
  return ASIN_RE.test(s) ? s : ""
}

// Valid, unique ASINs in their original order (the first occurrence wins).
function dedupe(list) {
  var out = []
  var seen = {}
  var src = Array.isArray(list) ? list : []
  for (var i = 0; i < src.length; i++) {
    var a = cleanAsin(src[i])
    if (a && !seen[a]) {
      seen[a] = true
      out.push(a)
    }
  }
  return out
}

// Text of queue.json -> ASIN list. Accepts {version, asins: [...]} or a bare array. Bad text -> [].
function parseQueue(text) {
  var data
  try {
    data = JSON.parse(String(text === undefined || text === null ? "" : text))
  } catch (e) {
    return []
  }
  if (Array.isArray(data)) return dedupe(data)
  if (isObj(data) && Array.isArray(data.asins)) return dedupe(data.asins)
  return []
}

function serialize(list) {
  return JSON.stringify({ version: VERSION, asins: dedupe(list) }, null, 1)
}

function has(list, asin) {
  var a = cleanAsin(asin)
  return a !== "" && dedupe(list).indexOf(a) >= 0
}

// 1-based position in the queue, or 0 when the book is not queued.
function positionOf(list, asin) {
  var a = cleanAsin(asin)
  var i = a ? dedupe(list).indexOf(a) : -1
  return i + 1
}

// Append to the end. Already queued -> unchanged (no duplicates).
function addToEnd(list, asin) {
  var base = dedupe(list)
  var a = cleanAsin(asin)
  if (!a || base.indexOf(a) >= 0) return base
  base.push(a)
  return base
}

// Put a book first: it plays right after the current one. Moves it if already queued.
function playNext(list, asin) {
  var a = cleanAsin(asin)
  if (!a) return dedupe(list)
  return [a].concat(remove(list, a))
}

function remove(list, asin) {
  var a = cleanAsin(asin)
  return dedupe(list).filter(function (x) { return x !== a })
}

function clear() {
  return []
}

function moveBy(list, asin, delta) {
  var base = dedupe(list)
  var a = cleanAsin(asin)
  var i = base.indexOf(a)
  if (i < 0) return base
  var j = i + delta
  if (j < 0 || j >= base.length) return base
  var out = base.slice()
  out[i] = base[j]
  out[j] = base[i]
  return out
}

function moveUp(list, asin) {
  return moveBy(list, asin, -1)
}

function moveDown(list, asin) {
  return moveBy(list, asin, 1)
}

// Map asin -> Book for the known library books; null when no list was given.
function bookIndex(books) {
  if (!Array.isArray(books)) return null
  var map = {}
  for (var i = 0; i < books.length; i++) {
    var b = books[i]
    if (isObj(b) && typeof b.asin === "string") map[b.asin] = b
  }
  return map
}

// A queued book that is still ahead of you: it is in the library and not finished.
function isLive(book) {
  return isObj(book) && book.finished !== true
}

// Drop queue entries that are unknown to the library or already finished. With no library list
// (null) nothing is dropped, so an unloaded library cannot empty the queue.
function prune(list, books) {
  var map = bookIndex(books)
  var base = dedupe(list)
  if (!map) return base
  return base.filter(function (a) { return isLive(map[a]) })
}

// The Book objects still to hear, in queue order (unknown and finished entries are skipped).
function pending(list, books) {
  var map = bookIndex(books)
  if (!map) return []
  return dedupe(list).map(function (a) { return map[a] }).filter(isLive)
}

// The ASIN that should follow currentAsin: the next queued book after it that can be played
// (in the library, not finished, listenable). When currentAsin is not queued, the first playable
// book in the queue. Returns "" when nothing qualifies. Never mutates the list.
function next(list, currentAsin, books) {
  var base = dedupe(list)
  var map = bookIndex(books)
  var playable = function (a) {
    if (!map) return true
    var b = map[a]
    return isLive(b) && b.listenable !== false && b.inLibrary !== false
  }
  var cur = cleanAsin(currentAsin)
  var start = cur ? base.indexOf(cur) : -1
  for (var i = start + 1; i < base.length; i++) {
    if (playable(base[i])) return base[i]
  }
  return ""
}

if (typeof module !== "undefined") module.exports = { cleanAsin, dedupe, parseQueue, serialize, has, positionOf, addToEnd, playNext, remove, clear, moveUp, moveDown, prune, pending, next, isLive }
