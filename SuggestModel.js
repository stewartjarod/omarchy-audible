.pragma library
// "Suggested for you": a pure ranking over the owned library. No QML, no I/O, no Qt.
// Input: Book objects (LibraryModel.merge output). Candidates are owned, not finished, not started,
// and playable. Ranking, strongest first:
//   1. the next unread book in a series you are already partway through ("Book 3 of Sample Saga")
//   2. authors and narrators of books you finished (more weight if you finished them twice or the
//      public rating is high): "Because you finished X"
//   3. fit with your usual pace, when a pace is given (opts.pace.weeklySec): books you can finish in
//      about a week or two
//   4. shorter before longer, then newer purchases first
// Missing data never throws: a book without a series, rating, or pace just skips that signal.

var HIGH_RATING = 4.5

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

function keyOf(name) {
  return str(name).trim().toLowerCase()
}

// Started means: finished, or any progress, or any listen recorded.
function started(b) {
  return b.finished === true || num(b.percentComplete, 0) > 0 || num(b.resumeSec, 0) > 0 || num(b.lastListenedAt, 0) > 0
}

function owned(b) {
  return isObj(b) && typeof b.asin === "string" && b.asin !== "" && b.inLibrary !== false && !b.isSeries
}

function candidate(b, excluded) {
  return owned(b) && !excluded[b.asin] && b.finished !== true && b.listenable !== false && !started(b)
}

function seriesTitle(b) {
  return b.series && isObj(b.series) ? str(b.series.title).trim() : ""
}

function seriesNumber(b) {
  var s = b.series && isObj(b.series) ? parseFloat(str(b.series.sequence)) : NaN
  return isFinite(s) ? s : NaN
}

// Highest series number you have started or finished, per series key.
function seriesProgress(books) {
  var out = {}
  for (var i = 0; i < books.length; i++) {
    var b = books[i]
    var key = keyOf(seriesTitle(b))
    if (!key || !started(b)) continue
    var n = seriesNumber(b)
    var cur = out[key] || { any: false, max: -Infinity }
    cur.any = true
    if (isFinite(n) && n > cur.max) cur.max = n
    out[key] = cur
  }
  return out
}

// Next unread book per series you are partway through: the lowest number above your furthest book.
function nextInSeries(books, excluded) {
  var progress = seriesProgress(books)
  var best = {}
  for (var i = 0; i < books.length; i++) {
    var b = books[i]
    if (!candidate(b, excluded)) continue
    var key = keyOf(seriesTitle(b))
    var p = progress[key]
    var n = seriesNumber(b)
    if (!p || !p.any || !isFinite(n)) continue
    if (n <= p.max) continue
    if (!best[key] || n < seriesNumber(best[key])) best[key] = b
  }
  return best
}

// Weight of each author/narrator from the books you finished. Keeps the best finished title per name.
function affinityIndex(books) {
  var index = {}
  for (var i = 0; i < books.length; i++) {
    var b = books[i]
    if (!owned(b) || b.finished !== true) continue
    var rated = num(b.rating, 0) >= HIGH_RATING
    var repeat = num(b.playCount, 0) >= 2
    var weight = 1 + (rated ? 1 : 0) + (repeat ? 1 : 0)
    var names = [].concat(Array.isArray(b.authors) ? b.authors : [], Array.isArray(b.narrators) ? b.narrators : [])
    for (var k = 0; k < names.length; k++) {
      var name = keyOf(names[k])
      if (!name) continue
      var cur = index[name]
      if (!cur || weight > cur.weight) index[name] = { weight: weight, title: str(b.title).trim() }
    }
  }
  return index
}

// Best affinity for a candidate: { weight, title } or null.
function affinityOf(b, index) {
  var names = [].concat(Array.isArray(b.authors) ? b.authors : [], Array.isArray(b.narrators) ? b.narrators : [])
  var best = null
  for (var k = 0; k < names.length; k++) {
    var hit = index[keyOf(names[k])]
    if (hit && (!best || hit.weight > best.weight)) best = hit
  }
  return best
}

function weeksAt(runtimeSec, weeklySec) {
  return runtimeSec / weeklySec
}

function fitTier(runtimeSec, pace) {
  if (!pace || !(pace.weeklySec > 0) || !(runtimeSec > 0)) return 0
  var weeks = weeksAt(runtimeSec, pace.weeklySec)
  return weeks <= 1 ? 2 : (weeks <= 2 ? 1 : 0)
}

// Ranked suggestions: [{ asin, reason, book }], at most opts.limit (default 12).
// opts: { exclude: [asin] (e.g. Up next), pace: { weeklySec } | null, limit }
function suggest(books, opts) {
  var o = isObj(opts) ? opts : {}
  var limit = Math.max(0, Math.floor(num(o.limit, 12)))
  var list = Array.isArray(books) ? books.filter(isObj) : []
  var excluded = {}
  var ex = Array.isArray(o.exclude) ? o.exclude : []
  for (var e = 0; e < ex.length; e++) excluded[str(ex[e])] = true

  var finishedBooks = list.filter(function (b) { return owned(b) && b.finished === true })
  var affinity = affinityIndex(finishedBooks)
  var series = nextInSeries(list, excluded)
  var pace = isObj(o.pace) ? o.pace : null

  var scored = []
  for (var i = 0; i < list.length; i++) {
    var b = list[i]
    if (!candidate(b, excluded)) continue
    var key = keyOf(seriesTitle(b))
    var seriesHit = !!key && series[key] === b
    var aff = affinityOf(b, affinity)
    var fit = fitTier(num(b.runtimeSec, 0), pace)
    var reason = ""
    if (seriesHit) {
      var seq = str(b.series.sequence).trim()
      reason = seq ? "Book " + seq + " of " + seriesTitle(b) : "Next in " + seriesTitle(b)
    } else if (aff) {
      reason = "Because you finished " + aff.title
    } else if (fit > 0) {
      reason = "Fits your usual pace: about " + Math.max(1, Math.ceil(weeksAt(b.runtimeSec, pace.weeklySec))) + " week" + (Math.ceil(weeksAt(b.runtimeSec, pace.weeklySec)) === 1 ? "" : "s")
    } else {
      reason = "Not started yet"
    }
    scored.push({
      index: i,
      book: b,
      reason: reason,
      series: seriesHit ? 1 : 0,
      aff: aff ? aff.weight : 0,
      fit: fit,
      runtime: num(b.runtimeSec, 0),
      purchased: str(b.purchaseDate)
    })
  }

  scored.sort(function (x, y) {
    if (x.series !== y.series) return y.series - x.series
    if (x.aff !== y.aff) return y.aff - x.aff
    if (x.fit !== y.fit) return y.fit - x.fit
    if (x.runtime !== y.runtime) return x.runtime - y.runtime
    if (x.purchased !== y.purchased) return x.purchased < y.purchased ? 1 : -1
    return x.index - y.index
  })

  return scored.slice(0, limit).map(function (s) {
    return { asin: s.book.asin, reason: s.reason, book: s.book }
  })
}

if (typeof module !== "undefined") module.exports = { suggest, started, nextInSeries, affinityIndex, fitTier }
