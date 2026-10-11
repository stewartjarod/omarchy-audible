.pragma library

// Listening statistics: pure functions only (no QML, no I/O, no clock reads except where a
// `now`/`todayKey` is passed in). The on-disk log is a plain object keyed by local day:
//
//   { "2026-10-10": { wallSec: 1234.5, bookSec: 2469, perBook: { "B0XXXX": 2469 } } }
//
// wallSec = real time spent playing; bookSec = audiobook content covered (wall * speed).
// ListeningLog.qml owns the file and the timer; everything here works on the object.

var DAY_MS = 86400000
var MAX_TICK_MS = 5000          // one tick never counts more than this (suspend / resume gaps)
var NOMINAL_TICK_MS = 1000      // the first tick after a (re)start has no previous tick to measure from
var KEEP_DAYS = 730             // roughly two years of history
var STREAK_MIN_SEC = 300        // a listening day for the streak: at least five minutes
var PACE_DAYS = 14              // window used for "your pace"
var AVG_DAYS = 30               // window for the daily average
var DEFAULT_PACE_SEC = 1800     // nothing logged at all: assume 30 book-minutes a day
var MAX_PACE_SEC = 86400 * 4    // sanity cap on book-seconds per calendar day (a fast, long listen)
var MAX_FORECAST_DAYS = 3650    // beyond ten years the forecast is not shown as a date
var MIN_SPEED = 0.1
var MAX_SPEED = 10

var DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
var DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function pad2(n) { return (n < 10 ? "0" : "") + n }

// Local calendar day of an epoch-ms time, "YYYY-MM-DD".
function dayKey(ms) {
  var d = new Date(ms)
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
}

// Day keys are calendar dates, so arithmetic on them is done in UTC to avoid DST shifts.
function keyToUtc(key) {
  var m = DAY_RE.exec(String(key))
  if (!m) return NaN
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function utcToKey(t) {
  var d = new Date(t)
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate())
}

function addDays(key, n) {
  var t = keyToUtc(key)
  return isNaN(t) ? "" : utcToKey(t + Math.round(n) * DAY_MS)
}

// Whole calendar days from a to b (b - a). Positive when b is later.
function dayDiff(a, b) {
  var ta = keyToUtc(a), tb = keyToUtc(b)
  if (isNaN(ta) || isNaN(tb)) return 0
  return Math.round((tb - ta) / DAY_MS)
}

function weekdayShort(key) {
  var t = keyToUtc(key)
  return isNaN(t) ? "" : DOW[new Date(t).getUTCDay()]
}

function weekdayLong(key) {
  var t = keyToUtc(key)
  return isNaN(t) ? "" : DOW_LONG[new Date(t).getUTCDay()]
}

function shortDate(key) {
  var t = keyToUtc(key)
  if (isNaN(t)) return ""
  var d = new Date(t)
  return DOW[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]
}

// Split a wall-clock interval at local midnights: [{day, ms}], in order, ms summing to the span.
function splitByDay(startMs, endMs) {
  var out = []
  var t = startMs
  while (t < endMs) {
    var d = new Date(t)
    var nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
    var until = Math.min(endMs, nextMidnight)
    if (until <= t) until = endMs   // defensive: never loop without progress
    out.push({ day: dayKey(t), ms: until - t })
    t = until
  }
  return out
}

function emptyDay() { return { wallSec: 0, bookSec: 0, perBook: {} } }

// Credit the interval [startMs, endMs] to the log. It is capped at MAX_TICK_MS, measured back
// from endMs, so a suspend that lasted an hour counts as five seconds. A zero or negative
// interval (the clock went backwards) counts nothing. Mutates and returns `log`.
function addInterval(log, startMs, endMs, asin, speed) {
  var start = Number(startMs), end = Number(endMs)
  if (!isFinite(start) || !isFinite(end) || end <= start) return log
  if (end - start > MAX_TICK_MS) start = end - MAX_TICK_MS
  var sp = Number(speed)
  if (!isFinite(sp) || sp <= 0) sp = 1
  sp = Math.min(MAX_SPEED, Math.max(MIN_SPEED, sp))
  var parts = splitByDay(start, end)
  for (var i = 0; i < parts.length; i++) {
    var wall = parts[i].ms / 1000
    var book = wall * sp
    var e = log[parts[i].day]
    if (!e) { e = emptyDay(); log[parts[i].day] = e }
    e.wallSec += wall
    e.bookSec += book
    if (asin) e.perBook[asin] = (e.perBook[asin] || 0) + book
  }
  return log
}

// Read the file text. Anything that is not a usable log gives {ok: false} and an empty log;
// an empty string is a fresh install and counts as ok.
function parseLog(text) {
  var out = {}
  var s = String(text || "")
  if (s.trim() === "") return { ok: true, log: out }
  var raw
  try { raw = JSON.parse(s) } catch (e) { return { ok: false, log: out } }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, log: out }
  for (var k in raw) {
    if (!DAY_RE.test(k)) continue
    var v = raw[k]
    if (!v || typeof v !== "object") continue
    var wall = Number(v.wallSec), book = Number(v.bookSec)
    if (!isFinite(wall) || wall < 0) wall = 0
    if (!isFinite(book) || book < 0) book = 0
    var perBook = {}
    if (v.perBook && typeof v.perBook === "object") {
      for (var a in v.perBook) {
        var n = Number(v.perBook[a])
        if (a !== "" && isFinite(n) && n > 0) perBook[a] = n
      }
    }
    out[k] = { wallSec: wall, bookSec: book, perBook: perBook }
  }
  return { ok: true, log: out }
}

// Text to write: numbers rounded to a tenth of a second so the file stays small and readable.
function serialize(log) {
  var out = {}
  for (var k in log) {
    var e = log[k]
    var pb = {}
    for (var a in e.perBook) pb[a] = Math.round(e.perBook[a] * 10) / 10
    out[k] = { wallSec: Math.round(e.wallSec * 10) / 10, bookSec: Math.round(e.bookSec * 10) / 10, perBook: pb }
  }
  return JSON.stringify(out)
}

// Add the day totals of `b` into a copy of `a`. Used when the file loads after ticks already
// happened, so no listening is lost either way round.
function mergeLogs(a, b) {
  var out = {}
  var src = [a || {}, b || {}]
  for (var s = 0; s < src.length; s++) {
    for (var k in src[s]) {
      var e = src[s][k]
      var t = out[k]
      if (!t) { t = emptyDay(); out[k] = t }
      t.wallSec += e.wallSec || 0
      t.bookSec += e.bookSec || 0
      for (var asin in (e.perBook || {})) t.perBook[asin] = (t.perBook[asin] || 0) + e.perBook[asin]
    }
  }
  return out
}

// Drop days older than keepDays (counting today). Mutates and returns `log`.
function prune(log, todayKey, keepDays) {
  var keep = keepDays || KEEP_DAYS
  var cutoff = addDays(todayKey, 1 - keep)
  for (var k in log) if (k < cutoff) delete log[k]
  return log
}

function earliestKey(log) {
  var first = ""
  for (var k in log) if (first === "" || k < first) first = k
  return first
}

// Totals for the days from..to inclusive (string compare works on YYYY-MM-DD).
function windowSums(log, fromKey, toKey) {
  var s = { wallSec: 0, bookSec: 0, listenDays: 0 }
  for (var k in log) {
    if (k < fromKey || k > toKey) continue
    var e = log[k]
    s.wallSec += e.wallSec
    s.bookSec += e.bookSec
    if (e.wallSec > 0) s.listenDays++
  }
  return s
}

// Book-seconds for one book over a window, and how many days it was played on.
function perBookSums(log, asin, fromKey, toKey) {
  var s = { sec: 0, days: 0 }
  if (!asin) return s
  for (var k in log) {
    if (k < fromKey || k > toKey) continue
    var v = log[k].perBook[asin]
    if (v > 0) { s.sec += v; s.days++ }
  }
  return s
}

// Consecutive days with at least minSec of listening, ending today. If today has not reached
// the threshold yet, the streak still counts from yesterday (it does not break mid-day).
function streak(log, todayKey, minSec) {
  var min = minSec === undefined ? STREAK_MIN_SEC : minSec
  function on(k) { return !!log[k] && log[k].wallSec >= min }
  var k = on(todayKey) ? todayKey : addDays(todayKey, -1)
  var n = 0
  while (on(k)) { n++; k = addDays(k, -1) }
  return n
}

// The day with the most listening. Ties go to the later day. null when nothing is logged.
function longestDay(log) {
  var best = null
  for (var k in log) {
    var e = log[k]
    if (e.wallSec <= 0) continue
    if (!best || e.wallSec > best.wallSec || (e.wallSec === best.wallSec && k > best.day))
      best = { day: k, wallSec: e.wallSec, bookSec: e.bookSec }
  }
  return best
}

// Average per day over the last `days` days. The divisor is the smaller of `days` and the
// number of days since the first logged day, so a new install is not averaged over empty weeks.
function average(log, todayKey, days) {
  var first = earliestKey(log)
  var n = days || AVG_DAYS
  var covered = first && first <= todayKey ? Math.min(n, dayDiff(first, todayKey) + 1) : 0
  var s = windowSums(log, addDays(todayKey, 1 - n), todayKey)
  if (covered <= 0) return { wallSec: 0, bookSec: 0, days: 0, listenDays: 0 }
  return { wallSec: s.wallSec / covered, bookSec: s.bookSec / covered, days: covered, listenDays: s.listenDays }
}

// Time saved by listening faster than 1x: book content minus the wall time it took.
function timeSaved(sums) {
  return sums.bookSec - sums.wallSec
}

// One entry per day for the last `days` days, oldest first, for the bar chart.
function recentDays(log, todayKey, days) {
  var out = []
  var n = days || 14
  for (var i = n - 1; i >= 0; i--) {
    var k = addDays(todayKey, -i)
    var e = log[k]
    out.push({ day: k, wallSec: e ? e.wallSec : 0, bookSec: e ? e.bookSec : 0, dow: weekdayShort(k) })
  }
  return out
}

// Pace: how many book-seconds of this book you get through per calendar day, over the last
// PACE_DAYS days (or since the first logged day, if that is more recent). Days you do not
// listen at all are part of the average, so the forecast already allows for days off.
// Falls back in order: this book recently, this book ever, your listening in general, a default.
// Returns {secPerDay, perListeningDay, source}. secPerDay is always > 0.
function pace(log, asin, todayKey) {
  var first = earliestKey(log)
  var recentFrom = addDays(todayKey, 1 - PACE_DAYS)
  var span = first && first <= todayKey ? Math.max(1, Math.min(PACE_DAYS, dayDiff(first, todayKey) + 1)) : PACE_DAYS
  var spanAll = first && first <= todayKey ? Math.max(1, dayDiff(first, todayKey) + 1) : 1

  var bookWin = perBookSums(log, asin, recentFrom, todayKey)
  if (bookWin.sec > 0)
    return clampPace({ secPerDay: bookWin.sec / span, perListeningDay: bookWin.sec / bookWin.days, source: "recent" })

  var bookAll = perBookSums(log, asin, "", "9999-12-31")
  if (bookAll.sec > 0)
    return clampPace({ secPerDay: bookAll.sec / spanAll, perListeningDay: bookAll.sec / bookAll.days, source: "alltime" })

  var win = windowSums(log, recentFrom, todayKey)
  if (win.bookSec > 0)
    return clampPace({ secPerDay: win.bookSec / span, perListeningDay: win.bookSec / win.listenDays, source: "general" })

  return { secPerDay: DEFAULT_PACE_SEC, perListeningDay: DEFAULT_PACE_SEC, source: "default" }
}

function clampPace(p) {
  p.secPerDay = Math.min(MAX_PACE_SEC, Math.max(1, p.secPerDay))
  p.perListeningDay = Math.min(MAX_PACE_SEC, Math.max(1, p.perListeningDay))
  return p
}

// Project the finish. remainingSec is content seconds left. Returns:
//   {finished: true, days: 0, date: null}                  nothing left
//   {finished: false, days: null, date: null, text}         no usable pace, or years away
//   {finished: false, days, date}                           days = calendar days from today to
//                                                           the finish, counting today; date is
//                                                           the day it finishes (today + days - 1).
function forecast(remainingSec, secPerDay, todayKey) {
  var rem = Number(remainingSec)
  var p = Number(secPerDay)
  if (!isFinite(rem) || rem <= 0) return { finished: true, days: 0, date: null, text: "Finished" }
  if (!isFinite(p) || p <= 0) return { finished: false, days: null, date: null, text: "No pace yet" }
  var days = Math.max(1, Math.ceil(rem / p))
  if (days > MAX_FORECAST_DAYS) return { finished: false, days: null, date: null, text: "Years away at this pace" }
  return { finished: false, days: days, date: addDays(todayKey, days - 1), text: "" }
}

// "today", "tomorrow", a weekday for the next week, otherwise "Fri 16 Oct".
function dayLabel(key, todayKey) {
  var n = dayDiff(todayKey, key)
  if (n <= 0) return "today"
  if (n === 1) return "tomorrow"
  if (n < 7) return weekdayLong(key)
  return shortDate(key)
}

// Full sentence for the popup or the window: "At your pace you will finish Friday, in 6 days".
function forecastSentence(f, todayKey) {
  if (!f) return ""
  if (f.finished) return "Finished"
  if (!f.date) return f.text
  var n = f.days - 1
  var when = dayLabel(f.date, todayKey)
  var tail = n > 0 ? ", in " + n + (n === 1 ? " day" : " days") : ""
  return "At your pace you will finish " + when + tail
}

// Short form for the player: "finish by Fri", "finish by Fri 16 Oct". Empty when unknown.
function finishBy(f, todayKey) {
  if (!f) return ""
  if (f.finished) return "finished"
  if (!f.date) return ""
  return "finish by " + dayLabel(f.date, todayKey)
}

// Everything the forecast needs for one book.
function bookForecast(log, asin, todayKey, remainingSec) {
  var p = pace(log, asin, todayKey)
  return { pace: p, forecast: forecast(remainingSec, p.secPerDay, todayKey) }
}

// Burn-down for one book. `actual` is remaining content at the end of each of the last
// PACE_DAYS days (oldest first, the last point is today at remainingNowSec). `projection`
// starts at today's value and steps down by the pace until the book is done.
function burnDown(log, asin, todayKey, remainingNowSec) {
  var rem = Math.max(0, Number(remainingNowSec) || 0)
  var n = PACE_DAYS
  var actual = []
  var cur = rem
  for (var i = 0; i < n; i++) {
    var k = addDays(todayKey, -i)
    actual.unshift({ day: k, remainingSec: cur })
    var e = log[k]
    cur += e && e.perBook[asin] ? e.perBook[asin] : 0
  }
  // The point before the window: where the book stood at the start of the window.
  actual.unshift({ day: addDays(todayKey, -n), remainingSec: cur })

  var bf = bookForecast(log, asin, todayKey, rem)
  var projection = []
  if (rem > 0 && bf.forecast.days !== null) {
    var p = bf.pace.secPerDay
    projection.push({ day: todayKey, remainingSec: rem })
    for (var j = 0; j < bf.forecast.days; j++) {
      projection.push({ day: addDays(todayKey, j), remainingSec: Math.max(0, rem - (j + 1) * p) })
    }
  }
  return { asin: asin, actual: actual, projection: projection, forecast: bf.forecast, pace: bf.pace }
}

// Headline numbers for the window: today, this week, the 30-day average, streak, longest day, time saved.
function summarize(log, todayKey) {
  var week = windowSums(log, addDays(todayKey, -6), todayKey)
  var month = windowSums(log, addDays(todayKey, 1 - AVG_DAYS), todayKey)
  var all = windowSums(log, "", "9999-12-31")
  var t = log[todayKey]
  return {
    today: { wallSec: t ? t.wallSec : 0, bookSec: t ? t.bookSec : 0 },
    week: week,
    month: month,
    average: average(log, todayKey, AVG_DAYS),
    streak: streak(log, todayKey),
    longest: longestDay(log),
    savedWeekSec: timeSaved(week),
    savedMonthSec: timeSaved(month),
    savedAllSec: timeSaved(all),
    allWallSec: all.wallSec,
    days: recentDays(log, todayKey, 14)
  }
}

// Book-seconds per book across the whole log, largest first: [{asin, sec}].
function perBookTotals(log) {
  var sums = {}
  for (var k in log) {
    var pb = log[k].perBook
    for (var a in pb) sums[a] = (sums[a] || 0) + pb[a]
  }
  var out = []
  for (var b in sums) out.push({ asin: b, sec: sums[b] })
  out.sort(function (x, y) { return y.sec - x.sec })
  return out
}

// ---------------------------------------------------------------------------
// Audible's own numbers: `audible stats -o json` (see fixtures/stats-year.json).
// Account-wide, minutes per month (or per year with --since), per marketplace.
// ---------------------------------------------------------------------------

function parseAudibleStats(text) {
  var s = String(text || "").trim()
  if (s === "") return { ok: false, error: "audible printed nothing", rows: [] }
  var rows = []
  try {
    var env = JSON.parse(s)
    if (env && env.error) return { ok: false, error: String(env.error.message || env.error), rows: [] }
    var res = (env && env.result) || {}
    var mps = res.marketplaces || []
    for (var i = 0; i < mps.length; i++) {
      var ivs = mps[i].intervals || []
      for (var j = 0; j < ivs.length; j++) {
        var m = Number(ivs[j].minutes)
        rows.push({ marketplace: String(mps[i].marketplace || ""), interval: String(ivs[j].interval), minutes: isFinite(m) ? m : 0 })
      }
    }
    return { ok: true, error: "", rows: rows, allTimeMinutes: Number(res.all_time_minutes) || 0 }
  } catch (e) { /* not JSON: try the plain format below */ }

  // plain: "us<TAB>2026-03<TAB>56", one row per marketplace and interval
  var lines = s.split(/\r?\n/)
  for (var l = 0; l < lines.length; l++) {
    var cols = lines[l].trim().split(/\s+/)
    if (cols.length !== 3) continue
    var mins = Number(cols[2])
    if (!isFinite(mins)) continue
    rows.push({ marketplace: cols[0], interval: cols[1], minutes: mins })
  }
  if (rows.length === 0) return { ok: false, error: "could not read audible stats output", rows: [] }
  return { ok: true, error: "", rows: rows, allTimeMinutes: 0 }
}

// Minutes Audible counts for one calendar year (all marketplaces).
function yearMinutes(parsed, year) {
  var y = String(year)
  var sum = 0
  var rows = (parsed && parsed.rows) || []
  for (var i = 0; i < rows.length; i++) if (rows[i].interval.slice(0, 4) === y) sum += rows[i].minutes
  return sum
}

// "Audible says: 24 h this year" (or "in 2024", or minutes when under an hour).
function audibleSays(minutes, year, currentYear) {
  var label = String(year) === String(currentYear) ? "this year" : "in " + year
  if (!(minutes > 0)) return "Audible says: no listening " + label
  if (minutes < 60) return "Audible says: " + Math.round(minutes) + " min " + label
  return "Audible says: " + Math.round(minutes / 60) + " h " + label
}

if (typeof module !== "undefined") module.exports = {
  DAY_MS, MAX_TICK_MS, NOMINAL_TICK_MS, KEEP_DAYS, STREAK_MIN_SEC, PACE_DAYS, AVG_DAYS,
  DEFAULT_PACE_SEC, MAX_PACE_SEC, MAX_FORECAST_DAYS,
  dayKey, addDays, dayDiff, weekdayShort, weekdayLong, shortDate, splitByDay,
  addInterval, parseLog, serialize, mergeLogs, prune, earliestKey, windowSums, perBookSums,
  streak, longestDay, average, timeSaved, recentDays, pace, forecast, dayLabel,
  forecastSentence, finishBy, bookForecast, burnDown, summarize, perBookTotals,
  parseAudibleStats, yearMinutes, audibleSays
}
