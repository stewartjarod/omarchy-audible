// Run: node --test tests/stats.test.js   (from the plugin root)
"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

// StatsModel.js starts with `.pragma library` (a QML directive). Swap it for a comment so node can
// evaluate the file, the same trick library.test.js uses.
function loadModel() {
  const file = path.join(__dirname, "..", "StatsModel.js")
  const src = fs.readFileSync(file, "utf8").replace(/^\.pragma library/, "//")
  const m = { exports: {} }
  new Function("module", "exports", src)(m, m.exports)
  return m.exports
}

const S = loadModel()
const fixture = name => fs.readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8")

// Local-time helpers: the model buckets by local calendar day, so the tests build local dates.
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()
const TODAY = "2026-10-10"

// A log with one day of listening, for brevity.
function day(wallSec, bookSec, perBook) {
  return { wallSec, bookSec, perBook: perBook || {} }
}

// ---------------------------------------------------------------- accumulation

test("addInterval counts wall seconds and book seconds (wall * speed)", () => {
  const log = {}
  S.addInterval(log, at(2026, 10, 10, 9), at(2026, 10, 10, 9) + 1000, "B1", 1)
  S.addInterval(log, at(2026, 10, 10, 9, 0, 1), at(2026, 10, 10, 9, 0, 2), "B1", 2)
  const d = log[TODAY]
  assert.equal(d.wallSec, 2)
  assert.equal(d.bookSec, 3)            // 1 s at 1x + 1 s at 2x
  assert.equal(d.perBook.B1, 3)
})

test("addInterval keeps per-book totals separate", () => {
  const log = {}
  const t = at(2026, 10, 10, 9)
  S.addInterval(log, t, t + 1000, "A", 1)
  S.addInterval(log, t + 1000, t + 2000, "B", 1.5)
  assert.equal(log[TODAY].perBook.A, 1)
  assert.equal(log[TODAY].perBook.B, 1.5)
  assert.equal(log[TODAY].wallSec, 2)
  assert.equal(log[TODAY].bookSec, 2.5)
})

test("a tick with no book loaded still counts wall time", () => {
  const log = {}
  const t = at(2026, 10, 10, 9)
  S.addInterval(log, t, t + 1000, "", 1)
  assert.equal(log[TODAY].wallSec, 1)
  assert.deepEqual(log[TODAY].perBook, {})
})

test("a suspend gap is capped at MAX_TICK_MS (5 s)", () => {
  const log = {}
  const t = at(2026, 10, 10, 9)
  S.addInterval(log, t, t + 60 * 60 * 1000, "B1", 1)   // an hour since the last tick
  assert.equal(S.MAX_TICK_MS, 5000)
  assert.equal(log[TODAY].wallSec, 5)
  assert.equal(log[TODAY].bookSec, 5)
})

test("a backwards clock or an empty interval counts nothing", () => {
  const log = {}
  const t = at(2026, 10, 10, 9)
  S.addInterval(log, t, t - 1000, "B1", 1)
  S.addInterval(log, t, t, "B1", 1)
  S.addInterval(log, NaN, t, "B1", 1)
  assert.deepEqual(log, {})
})

test("a bad speed falls back to 1x and absurd speeds are clamped", () => {
  const log = {}
  const t = at(2026, 10, 10, 9)
  S.addInterval(log, t, t + 1000, "B1", 0)
  S.addInterval(log, t + 1000, t + 2000, "B1", NaN)
  assert.equal(log[TODAY].bookSec, 2)
  S.addInterval(log, t + 2000, t + 3000, "B1", 500)
  assert.equal(log[TODAY].bookSec, 2 + 10)   // clamped to 10x
})

// ---------------------------------------------------------------- midnight

test("an interval across midnight is split between the two days", () => {
  const start = at(2026, 10, 10, 23, 59, 58)
  const end = at(2026, 10, 11, 0, 0, 3)
  const parts = S.splitByDay(start, end)
  assert.deepEqual(parts.map(p => p.day), ["2026-10-10", "2026-10-11"])
  assert.equal(parts[0].ms, 2000)
  assert.equal(parts[1].ms, 3000)
})

test("a tick that crosses midnight lands on both days, and totals add up", () => {
  const log = {}
  const start = at(2026, 10, 10, 23, 59, 58)
  S.addInterval(log, start, start + 5000, "B1", 2)
  assert.equal(log["2026-10-10"].wallSec, 2)
  assert.equal(log["2026-10-11"].wallSec, 3)
  assert.equal(log["2026-10-10"].bookSec, 4)
  assert.equal(log["2026-10-11"].bookSec, 6)
  assert.equal(log["2026-10-11"].perBook.B1, 6)
})

test("splitByDay on one day returns one part", () => {
  const t = at(2026, 10, 10, 12)
  assert.deepEqual(S.splitByDay(t, t + 1000).map(p => p.day), [TODAY])
})

// ---------------------------------------------------------------- restarts and the file

test("parseLog reads a saved log and drops junk keys", () => {
  const text = JSON.stringify({
    "2026-10-09": { wallSec: 600, bookSec: 900, perBook: { A: 900 } },
    "not-a-day": { wallSec: 1 },
    "2026-10-08": "nope",
    "2026-10-07": { wallSec: -5, bookSec: "x", perBook: { A: 0, B: 3 } }
  })
  const r = S.parseLog(text)
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(r.log).sort(), ["2026-10-07", "2026-10-09"])
  assert.equal(r.log["2026-10-09"].wallSec, 600)
  assert.equal(r.log["2026-10-07"].wallSec, 0)
  assert.equal(r.log["2026-10-07"].bookSec, 0)
  assert.deepEqual(r.log["2026-10-07"].perBook, { B: 3 })
})

test("parseLog: empty text is a fresh install; corrupt text is reported", () => {
  assert.deepEqual(S.parseLog(""), { ok: true, log: {} })
  assert.deepEqual(S.parseLog("   "), { ok: true, log: {} })
  assert.deepEqual(S.parseLog("{not json"), { ok: false, log: {} })
  assert.deepEqual(S.parseLog("[1,2]"), { ok: false, log: {} })
  assert.deepEqual(S.parseLog("null"), { ok: false, log: {} })
})

test("a restart: ticks made before the file loaded are merged, not lost", () => {
  const saved = { "2026-10-09": day(100, 200, { A: 200 }) }
  const beforeLoad = { [TODAY]: day(7, 7, { A: 7 }) }
  const merged = S.mergeLogs(saved, beforeLoad)
  assert.deepEqual(merged["2026-10-09"], day(100, 200, { A: 200 }))
  assert.equal(merged[TODAY].wallSec, 7)
  assert.equal(merged[TODAY].perBook.A, 7)
  // inputs are not mutated
  assert.equal(saved[TODAY], undefined)
})

test("mergeLogs adds the same day from both sides", () => {
  const a = { [TODAY]: day(10, 20, { A: 20 }) }
  const b = { [TODAY]: day(5, 5, { A: 5, B: 5 }) }
  const m = S.mergeLogs(a, b)
  assert.equal(m[TODAY].wallSec, 15)
  assert.equal(m[TODAY].bookSec, 25)
  assert.deepEqual(m[TODAY].perBook, { A: 25, B: 5 })
})

test("serialize round-trips through parseLog", () => {
  const log = { [TODAY]: day(12.34, 24.68, { A: 24.68 }) }
  const back = S.parseLog(S.serialize(log)).log
  assert.equal(back[TODAY].wallSec, 12.3)
  assert.equal(back[TODAY].bookSec, 24.7)
  assert.equal(back[TODAY].perBook.A, 24.7)
})

test("prune keeps roughly two years and drops older days", () => {
  const log = {
    "2026-10-10": day(1, 1),
    [S.addDays(TODAY, -729)]: day(1, 1),   // kept: 730 days including today
    [S.addDays(TODAY, -730)]: day(1, 1)    // dropped
  }
  S.prune(log, TODAY)
  assert.ok(log["2026-10-10"])
  assert.ok(log[S.addDays(TODAY, -729)])
  assert.equal(log[S.addDays(TODAY, -730)], undefined)
  assert.equal(S.KEEP_DAYS, 730)
})

// ---------------------------------------------------------------- dates

test("addDays and dayDiff work across month and year ends and DST", () => {
  assert.equal(S.addDays("2026-10-31", 1), "2026-11-01")
  assert.equal(S.addDays("2026-01-01", -1), "2025-12-31")
  assert.equal(S.addDays("2026-03-07", 1), "2026-03-08")   // US DST starts 2026-03-08
  assert.equal(S.dayDiff("2026-10-01", "2026-10-10"), 9)
  assert.equal(S.dayDiff("2026-10-10", "2026-10-01"), -9)
  assert.equal(S.addDays("garbage", 1), "")
})

test("weekday and short date labels", () => {
  assert.equal(S.weekdayShort("2026-10-16"), "Fri")
  assert.equal(S.weekdayLong("2026-10-16"), "Friday")
  assert.equal(S.shortDate("2026-10-16"), "Fri 16 Oct")
})

test("dayLabel: today, tomorrow, weekday within a week, date after", () => {
  assert.equal(S.dayLabel(TODAY, TODAY), "today")
  assert.equal(S.dayLabel("2026-10-11", TODAY), "tomorrow")
  assert.equal(S.dayLabel("2026-10-16", TODAY), "Friday")
  assert.equal(S.dayLabel("2026-10-30", TODAY), "Fri 30 Oct")
})

// ---------------------------------------------------------------- streak and averages

function logWith(days) {
  const log = {}
  for (const [offset, wallSec] of days) log[S.addDays(TODAY, offset)] = day(wallSec, wallSec)
  return log
}

test("streak counts consecutive days of at least five minutes", () => {
  const log = logWith([[0, 600], [-1, 300], [-2, 900], [-3, 299], [-4, 900]])
  assert.equal(S.streak(log, TODAY), 3)
})

test("streak still counts from yesterday before today reaches five minutes", () => {
  const log = logWith([[0, 60], [-1, 600], [-2, 600]])
  assert.equal(S.streak(log, TODAY), 2)
})

test("streak is zero with no listening, and a gap breaks it", () => {
  assert.equal(S.streak({}, TODAY), 0)
  assert.equal(S.streak(logWith([[-2, 600], [-3, 600]]), TODAY), 0)
  assert.equal(S.streak(logWith([[0, 600], [-2, 600]]), TODAY), 1)
})

test("streak threshold can be overridden", () => {
  assert.equal(S.streak(logWith([[0, 60]]), TODAY, 60), 1)
})

test("longest day is the most listened day; ties go to the later date", () => {
  const log = logWith([[-5, 1000], [-2, 3000], [-1, 3000], [0, 10]])
  const l = S.longestDay(log)
  assert.equal(l.day, S.addDays(TODAY, -1))
  assert.equal(l.wallSec, 3000)
  assert.equal(S.longestDay({}), null)
})

test("average divides by the covered days, not by 30 for a new install", () => {
  // first logged day is 4 days ago: covered = 5 days (today included)
  const log = logWith([[-4, 500], [0, 500]])
  const a = S.average(log, TODAY, 30)
  assert.equal(a.days, 5)
  assert.equal(a.wallSec, 200)
  assert.equal(a.listenDays, 2)
})

test("average over a long history uses the full window", () => {
  const log = logWith([[-100, 3000], [0, 3000]])
  const a = S.average(log, TODAY, 30)
  assert.equal(a.days, 30)
  assert.equal(a.wallSec, 100)
})

test("average with no data is zero, not NaN", () => {
  const a = S.average({}, TODAY, 30)
  assert.deepEqual(a, { wallSec: 0, bookSec: 0, days: 0, listenDays: 0 })
})

test("windowSums covers the last N days, today included", () => {
  const log = logWith([[0, 60], [-6, 60], [-7, 600]])
  assert.equal(S.windowSums(log, S.addDays(TODAY, -6), TODAY).wallSec, 120)
})

test("time saved is book seconds minus wall seconds", () => {
  const log = { [TODAY]: day(600, 900), [S.addDays(TODAY, -1)]: day(300, 300) }
  assert.equal(S.timeSaved(S.windowSums(log, "", "9999-12-31")), 300)
  assert.equal(S.timeSaved({ wallSec: 100, bookSec: 50 }), -50)
})

test("summarize gives today, week, streak, and a 14-day strip", () => {
  const log = logWith([[0, 600], [-1, 600], [-8, 6000]])
  const s = S.summarize(log, TODAY)
  assert.equal(s.today.wallSec, 600)
  assert.equal(s.week.wallSec, 1200)     // -8 is outside the 7 days
  assert.equal(s.streak, 2)
  assert.equal(s.days.length, 14)
  assert.equal(s.days[13].day, TODAY)
  assert.equal(s.days[13].wallSec, 600)
  assert.equal(s.days[0].day, S.addDays(TODAY, -13))
  assert.equal(s.allWallSec, 7200)
})

test("perBookTotals sorts books by listened seconds", () => {
  const log = { [TODAY]: day(0, 0, { A: 10, B: 50 }), [S.addDays(TODAY, -1)]: day(0, 0, { A: 100 }) }
  assert.deepEqual(S.perBookTotals(log), [{ asin: "A", sec: 110 }, { asin: "B", sec: 50 }])
})

// ---------------------------------------------------------------- pace and forecast

test("forecast: nothing left is finished", () => {
  const f = S.forecast(0, 1000, TODAY)
  assert.equal(f.finished, true)
  assert.equal(S.forecastSentence(f, TODAY), "Finished")
  assert.equal(S.forecast(-30, 1000, TODAY).finished, true)
  assert.equal(S.forecast(NaN, 1000, TODAY).finished, true)
})

test("forecast: zero, negative, or missing pace gives no date", () => {
  for (const p of [0, -5, NaN, undefined, null]) {
    const f = S.forecast(3600, p, TODAY)
    assert.equal(f.finished, false)
    assert.equal(f.date, null)
    assert.equal(f.days, null)
    assert.equal(f.text, "No pace yet")
  }
})

test("forecast: no data at all falls back to the default pace", () => {
  const bf = S.bookForecast({}, "B1", TODAY, 3600 * 4)
  assert.equal(bf.pace.source, "default")
  assert.equal(bf.pace.secPerDay, S.DEFAULT_PACE_SEC)
  assert.equal(bf.forecast.days, 8)     // 4 h at 30 min a day
})

test("forecast: counts days and names the finish day", () => {
  // 3 h left at 1 h a day: 3 days including today, so finish on the third day
  const f = S.forecast(3 * 3600, 3600, TODAY)
  assert.equal(f.days, 3)
  assert.equal(f.date, "2026-10-12")
  assert.equal(S.forecastSentence(f, TODAY), "At your pace you will finish Monday, in 2 days")
  assert.equal(S.finishBy(f, TODAY), "finish by Monday")
})

test("forecast: finishing today and tomorrow read naturally", () => {
  const today = S.forecast(600, 3600, TODAY)
  assert.equal(today.days, 1)
  assert.equal(S.forecastSentence(today, TODAY), "At your pace you will finish today")
  const tomorrow = S.forecast(3600 + 1, 3600, TODAY)
  assert.equal(tomorrow.days, 2)
  assert.equal(S.forecastSentence(tomorrow, TODAY), "At your pace you will finish tomorrow, in 1 day")
})

test("forecast: a huge pace finishes in a day, not NaN", () => {
  const f = S.forecast(3600 * 10, 1e12, TODAY)
  assert.equal(f.days, 1)
  assert.equal(f.date, TODAY)
  assert.equal(f.finished, false)
})

test("forecast: a tiny pace is reported as years away, with no date", () => {
  const f = S.forecast(3600 * 10, 1e-6, TODAY)
  assert.equal(f.date, null)
  assert.equal(f.days, null)
  assert.match(f.text, /Years away/)
})

test("forecast: a long but real horizon still gets a date", () => {
  const f = S.forecast(3600 * 10, 60, TODAY)   // 600 days
  assert.equal(f.days, 600)
  assert.match(f.date, /^20(27|28)-/)
})

test("pace: the book's recent listening over the 14-day window", () => {
  // 14 days of data, 1400 book-seconds on this book in the window
  const log = {}
  for (let i = 0; i < 14; i++) {
    const k = S.addDays(TODAY, -i)
    log[k] = day(i < 7 ? 100 : 0, i < 7 ? 100 : 0, i < 7 ? { B1: 100 } : {})
  }
  const p = S.pace(log, "B1", TODAY)
  assert.equal(p.source, "recent")
  assert.equal(p.secPerDay, 700 / 14)          // 700 book-seconds over 14 calendar days
  assert.equal(p.perListeningDay, 100)         // 100 on each day it was played
})

test("pace: a neglected book falls back to its all-time pace, then general listening", () => {
  const log = { [S.addDays(TODAY, -40)]: day(600, 600, { B1: 600 }), [S.addDays(TODAY, -30)]: day(0, 0) }
  log[S.addDays(TODAY, -3)] = day(300, 300, { B2: 300 })   // recent, but another book
  const p = S.pace(log, "B1", TODAY)
  assert.equal(p.source, "alltime")
  assert.ok(p.secPerDay > 0)
  // a book that was never played, but with recent general listening
  const q = S.pace(log, "ZZZ", TODAY)
  assert.equal(q.source, "general")
  assert.equal(S.pace(log, "", TODAY).source, "general")
})

test("pace: huge listening is capped so the forecast stays sane", () => {
  const log = { [TODAY]: day(3600, 1e9, { B1: 1e9 }) }
  const p = S.pace(log, "B1", TODAY)
  assert.equal(p.secPerDay, S.MAX_PACE_SEC)
  assert.equal(S.forecast(3600 * 5, p.secPerDay, TODAY).days, 1)
})

test("bookForecast ties pace and forecast together for a loaded book", () => {
  const log = { [TODAY]: day(3600, 7200, { B1: 7200 }) }   // 2 h of book in one day
  const bf = S.bookForecast(log, "B1", TODAY, 3600 * 6)
  // the window is one day, so the pace is 7200 per day: 6 h takes 3 calendar days
  assert.equal(bf.pace.secPerDay, 7200)
  assert.equal(bf.forecast.days, 3)
})

// ---------------------------------------------------------------- burn-down

test("burnDown: actual line ends at today's remaining and moves back in time", () => {
  const log = {
    [TODAY]: day(600, 600, { B1: 600 }),
    [S.addDays(TODAY, -1)]: day(600, 900, { B1: 900 })
  }
  const bd = S.burnDown(log, "B1", TODAY, 3000)
  const last = bd.actual[bd.actual.length - 1]
  assert.equal(last.day, TODAY)
  assert.equal(last.remainingSec, 3000)
  // remaining at the end of yesterday = today's remaining + today's book-seconds
  assert.equal(bd.actual[bd.actual.length - 2].remainingSec, 3600)
  // the line is never increasing going forward when listening only reduces it
  for (let i = 1; i < bd.actual.length; i++) assert.ok(bd.actual[i].remainingSec <= bd.actual[i - 1].remainingSec + 1e-9)
  assert.equal(bd.actual.length, 15)     // 14 days plus the point before the window
})

test("burnDown: projection starts at today and ends at zero on the forecast day", () => {
  const log = { [TODAY]: day(1800, 1800, { B1: 1800 }) }   // pace: 1800 a day over 14 days
  const bd = S.burnDown(log, "B1", TODAY, 3600 * 2)
  assert.equal(bd.projection[0].day, TODAY)
  assert.equal(bd.projection[0].remainingSec, 7200)
  const end = bd.projection[bd.projection.length - 1]
  assert.equal(end.remainingSec, 0)
  assert.equal(end.day, bd.forecast.date)
  for (let i = 1; i < bd.projection.length; i++) assert.ok(bd.projection[i].remainingSec <= bd.projection[i - 1].remainingSec)
})

test("burnDown: a finished book has no projection", () => {
  const bd = S.burnDown({}, "B1", TODAY, 0)
  assert.equal(bd.projection.length, 0)
  assert.equal(bd.forecast.finished, true)
  assert.equal(bd.actual[bd.actual.length - 1].remainingSec, 0)
})

test("burnDown: no data still projects, using the default pace", () => {
  const bd = S.burnDown({}, "B1", TODAY, 3600)
  assert.ok(bd.actual.length > 0)
  assert.ok(bd.projection.length > 0)
  assert.equal(bd.pace.source, "default")
})

test("burnDown: a very slow pace draws at most 60 days ahead but keeps the date", () => {
  // 1 s of book a day: about 3600 days for an hour, so the date is far away but a real date
  const log = { [TODAY]: day(1, 1, { B1: 1 }) }
  const bd = S.burnDown(log, "B1", TODAY, 3600)
  assert.equal(bd.truncated, true)
  assert.equal(bd.projection.length, S.PROJECTION_DRAW_DAYS + 1)
  assert.ok(bd.projection[bd.projection.length - 1].remainingSec > 0)
  assert.ok(bd.forecast.date > S.addDays(TODAY, 60))
})

test("burnDown: a huge pace projects to the next day only", () => {
  const log = { [TODAY]: day(1, 1e12, { B1: 1e12 }) }
  const bd = S.burnDown(log, "B1", TODAY, 3600)
  assert.equal(bd.forecast.days, 1)
  assert.equal(bd.projection.length, 2)
  assert.equal(bd.projection[1].remainingSec, 0)
})

// ---------------------------------------------------------------- Audible's own numbers

test("parseAudibleStats reads the monthly JSON fixture", () => {
  const p = S.parseAudibleStats(fixture("stats-year.json"))
  assert.equal(p.ok, true)
  assert.equal(p.error, "")
  assert.equal(p.rows.length, 6)
  assert.deepEqual(p.rows[0], { marketplace: "us", interval: "2026-03", minutes: 56 })
  assert.equal(p.allTimeMinutes, 33912)
})

test("yearMinutes sums the year across marketplaces", () => {
  const p = S.parseAudibleStats(fixture("stats-year.json"))
  assert.equal(S.yearMinutes(p, 2026), 1428)   // matches the envelope's window_minutes
  assert.equal(S.yearMinutes(p, 2025), 0)
})

test("parseAudibleStats reads the yearly JSON fixture (--since)", () => {
  const p = S.parseAudibleStats(fixture("stats-since.json"))
  assert.equal(p.ok, true)
  assert.equal(S.yearMinutes(p, 2024), 3254)
  assert.equal(S.yearMinutes(p, 2025), 1698)
  assert.equal(S.yearMinutes(p, 2026), 1431)
})

test("parseAudibleStats reads the plain fixture and agrees with the JSON total", () => {
  const p = S.parseAudibleStats(fixture("stats-plain.txt"))
  assert.equal(p.ok, true)
  assert.equal(p.rows.length, 6)
  assert.equal(S.yearMinutes(p, 2026), 1428)
})

test("parseAudibleStats reports errors and empty output", () => {
  assert.equal(S.parseAudibleStats("").ok, false)
  assert.equal(S.parseAudibleStats("{\"error\":{\"message\":\"token expired\"},\"result\":null}").error, "token expired")
  assert.equal(S.parseAudibleStats("something else entirely").ok, false)
})

test("audibleSays phrases hours, minutes, and other years", () => {
  assert.equal(S.audibleSays(1428, 2026, 2026), "Audible says: 24 h this year")
  assert.equal(S.audibleSays(3254, 2024, 2026), "Audible says: 54 h in 2024")
  assert.equal(S.audibleSays(42, 2026, 2026), "Audible says: 42 min this year")
  assert.equal(S.audibleSays(0, 2026, 2026), "Audible says: no listening this year")
})

test("module exports the contract functions", () => {
  for (const name of ["addInterval", "parseLog", "serialize", "mergeLogs", "prune", "summarize", "burnDown", "bookForecast", "forecastSentence", "finishBy", "parseAudibleStats", "yearMinutes", "audibleSays", "dayKey"]) {
    assert.equal(typeof S[name], "function", name)
  }
})

// ---------------------------------------------------------------- the tick stream as ListeningLog drives it

test("a tick stream: a midnight crossing, a suspend gap, and a pause", () => {
  // Mirrors ListeningLog.tick(): each tick credits (last, now], the first tick after a start uses 1 s,
  // and a pause resets `last` to 0.
  const log = {}
  let last = 0
  function tick(now, asin, speed) {
    const start = last > 0 ? last : now - S.NOMINAL_TICK_MS
    last = now
    S.addInterval(log, start, now, asin, speed)
  }
  let t = at(2026, 10, 10, 23, 59, 57) + 500          // 23:59:57.5, first tick: nominal 1 s
  tick(t, "B1", 1.5)
  t += 1000; tick(t, "B1", 1.5)                        // 23:59:58.5
  t += 1000; tick(t, "B1", 1.5)                        // 23:59:59.5
  t += 1000; tick(t, "B1", 1.5)                        // 00:00:00.5, crosses midnight: 0.5 s each side
  for (let i = 0; i < 3; i++) { t += 1000; tick(t, "B1", 1.5) }   // 01.5, 02.5, 03.5 on the 11th
  t += 60 * 60 * 1000; tick(t, "B1", 1.5)              // laptop suspended for an hour: capped at 5 s
  for (let i = 0; i < 4; i++) { t += 1000; tick(t, "B1", 1.5) }
  last = 0                                             // paused, then played again
  t += 1000; tick(t, "B1", 1.5)                        // nominal 1 s
  const oct10 = log["2026-10-10"], oct11 = log["2026-10-11"]
  assert.ok(Math.abs(oct10.wallSec - 3.5) < 1e-9)      // 1 + 1 + 1 + 0.5
  assert.ok(Math.abs(oct11.wallSec - 13.5) < 1e-9)     // 0.5 + 3 + 5 (capped) + 4 + 1
  assert.ok(Math.abs(oct11.bookSec - oct11.wallSec * 1.5) < 1e-6)
  assert.ok(Math.abs(oct11.perBook.B1 - oct11.bookSec) < 1e-9)
  assert.ok(Math.abs(oct10.bookSec - 3.5 * 1.5) < 1e-9)
})
