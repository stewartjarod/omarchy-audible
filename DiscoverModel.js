.pragma library
// Adds the "Suggested for you" and "Up next" sections on top of the sections LibraryModel.sections()
// built. Pure: no QML, no I/O. A book shown in one of the new sections is taken out of the regular
// sections, so every book still appears exactly once.

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

// A shallow copy of a Book with extra fields (never mutates the library's objects).
function withFields(book, extra) {
  var out = {}
  for (var k in book) out[k] = book[k]
  for (var j in extra) out[j] = extra[j]
  return out
}

// secs: sections from LibraryModel.sections(). ctx: {
//   suggested: [{asin, reason, book}]   from SuggestModel.suggest(), already ranked
//   upNext:    [Book]                   from QueueModel.pending(), queue order
// }
// Returns [continue?, upnext?, suggested?, ...rest]. Empty sections are left out.
function compose(secs, ctx) {
  var base = Array.isArray(secs) ? secs : []
  var o = isObj(ctx) ? ctx : {}
  var suggested = Array.isArray(o.suggested) ? o.suggested.filter(function (s) { return isObj(s) && isObj(s.book) }) : []
  var upNext = Array.isArray(o.upNext) ? o.upNext.filter(isObj) : []

  var shown = {}
  var sugSec = null, upSec = null
  if (suggested.length) {
    var sugBooks = suggested.map(function (s) { return withFields(s.book, { reason: s.reason }) })
    sugBooks.forEach(function (b) { shown[b.asin] = true })
    sugSec = { id: "suggested", title: "Suggested for you", books: sugBooks }
  }
  if (upNext.length) {
    var upBooks = upNext.map(function (b, i) { return withFields(b, { reason: "Up next, number " + (i + 1) }) })
    upBooks.forEach(function (b) { shown[b.asin] = true })
    upSec = { id: "upnext", title: "Up next", books: upBooks }
  }

  // Order: Continue listening first (picking up where you were matters most), then your own
  // Up next queue, then suggestions, then everything else.
  var out = []
  var rest = []
  for (var s = 0; s < base.length; s++) {
    var sec = base[s]
    var books = (Array.isArray(sec.books) ? sec.books : []).filter(function (b) { return !(b && shown[b.asin]) })
    if (!books.length) continue
    var ns = { id: sec.id, title: sec.title, books: books }
    if (sec.id === "continue") out.push(ns)
    else rest.push(ns)
  }
  if (upSec) out.push(upSec)
  if (sugSec) out.push(sugSec)
  out = out.concat(rest)
  return out
}

if (typeof module !== "undefined") module.exports = { compose }
