"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

// PlayerModel.js starts with the QML directive `.pragma library`, which is not
// valid JS, so node cannot require() it as-is. Load it through a vm context
// with that line blanked out. The file itself stays QML-loadable unchanged.
// Same realm as the tests (new Function), so deepEqual on returned arrays works.
const P = (() => {
  const src = fs.readFileSync(path.join(__dirname, "..", "PlayerModel.js"), "utf8")
    .replace(/^\.pragma library\s*$/m, "")
  const mod = { exports: {} }
  new Function("module", src)(mod)
  return mod.exports
})()

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "fixtures", "mpv-chapter-list.json"), "utf8")
)
// The fixture has no duration. This test-only duration sits a few minutes past
// the last chapter start so the last chapter gets a real end.
const BOOK_DURATION = 3100

function near(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ~${expected}, got ${actual}`)
}

// ---- formatDuration --------------------------------------------------------

test("formatDuration hm style", () => {
  assert.equal(P.formatDuration(7 * 3600 + 42 * 60 + 30, "hm"), "7h 42m")
  assert.equal(P.formatDuration(42 * 60, "hm"), "42m")
  assert.equal(P.formatDuration(2 * 3600, "hm"), "2h")
  assert.equal(P.formatDuration(59, "hm"), "<1m")
  assert.equal(P.formatDuration(0, "hm"), "<1m")
  assert.equal(P.formatDuration(60, "hm"), "1m")
  assert.equal(P.formatDuration(3599.9, "hm"), "59m")
})

test("formatDuration default style is hm", () => {
  assert.equal(P.formatDuration(90 * 60), "1h 30m")
  assert.equal(P.formatDuration(90 * 60, "nonsense"), "1h 30m")
})

test("formatDuration left style", () => {
  assert.equal(P.formatDuration(42 * 60, "left"), "42m left")
  assert.equal(P.formatDuration(7 * 3600 + 42 * 60, "left"), "7h 42m left")
  assert.equal(P.formatDuration(5, "left"), "<1m left")
})

test("formatDuration clock style", () => {
  assert.equal(P.formatDuration(3723, "clock"), "1:02:03")
  assert.equal(P.formatDuration(42 * 60 + 7, "clock"), "42:07")
  assert.equal(P.formatDuration(5, "clock"), "0:05")
  assert.equal(P.formatDuration(0, "clock"), "0:00")
  assert.equal(P.formatDuration(10 * 3600, "clock"), "10:00:00")
})

test("formatDuration clamps negative, NaN and Infinity", () => {
  assert.equal(P.formatDuration(-100, "hm"), "<1m")
  assert.equal(P.formatDuration(NaN, "clock"), "0:00")
  assert.equal(P.formatDuration(Infinity, "hm"), "<1m")
  assert.equal(P.formatDuration(undefined, "left"), "<1m left")
})

// ---- timeLeft --------------------------------------------------------------

test("timeLeft at normal speed", () => {
  assert.equal(P.timeLeft(1000, 250, 1), 750)
  assert.equal(P.timeLeft(1000, 250), 750)
})

test("timeLeft scales by speed", () => {
  near(P.timeLeft(1000, 0, 2), 500)
  near(P.timeLeft(3000, 1000, 1.5), 1333.3333333, 1e-3)
})

test("timeLeft clamps position past the end and negative position", () => {
  assert.equal(P.timeLeft(1000, 1200, 1), 0)
  assert.equal(P.timeLeft(1000, -50, 1), 1000)
})

test("timeLeft treats speed <= 0 as 1", () => {
  assert.equal(P.timeLeft(1000, 0, 0), 1000)
  assert.equal(P.timeLeft(1000, 0, -2), 1000)
  assert.equal(P.timeLeft(1000, 0, NaN), 1000)
})

test("timeLeft with missing or bad duration is 0", () => {
  assert.equal(P.timeLeft(0, 0, 1), 0)
  assert.equal(P.timeLeft(undefined, 10, 1), 0)
  assert.equal(P.timeLeft(NaN, 10, 1), 0)
})

// ---- normalizeChapters -----------------------------------------------------

test("normalizeChapters on the real 12-chapter fixture", () => {
  const ch = P.normalizeChapters(fixture, BOOK_DURATION)
  assert.equal(ch.length, 12)
  assert.deepEqual(ch.map((c) => c.index), [...Array(12).keys()])
  assert.equal(ch[0].title, "Chapter 1")
  assert.equal(ch[0].start, 0)
  assert.equal(ch[0].end, 130.309977)
  near(ch[0].length, 130.309977)
  assert.equal(ch[1].start, 130.309977)
  assert.equal(ch[1].end, 532.014966)
  // Contiguous: every end is the next start.
  for (let i = 0; i < ch.length - 1; i++) assert.equal(ch[i].end, ch[i + 1].start)
  // Last chapter runs to the book duration.
  assert.equal(ch[11].start, 2672.755964)
  assert.equal(ch[11].end, BOOK_DURATION)
  near(ch[11].length, BOOK_DURATION - 2672.755964)
  // Lengths add up to the whole book.
  const total = ch.reduce((s, c) => s + c.length, 0)
  near(total, BOOK_DURATION, 1e-6)
})

test("normalizeChapters accepts a bare array too", () => {
  const ch = P.normalizeChapters(fixture.data, BOOK_DURATION)
  assert.equal(ch.length, 12)
})

test("normalizeChapters empty or missing list gives one synthetic chapter", () => {
  for (const input of [undefined, null, {}, { data: [] }, [], "nope", 42]) {
    const ch = P.normalizeChapters(input, 1234)
    assert.equal(ch.length, 1)
    assert.equal(ch[0].index, 0)
    assert.equal(ch[0].start, 0)
    assert.equal(ch[0].end, 1234)
    assert.equal(ch[0].length, 1234)
    assert.equal(typeof ch[0].title, "string")
  }
})

test("normalizeChapters drops entries without a finite time", () => {
  const ch = P.normalizeChapters(
    { data: [{ title: "A", time: 0 }, { title: "bad", time: "x" }, null, { title: "B" }, { title: "C", time: 50 }] },
    100
  )
  assert.deepEqual(ch.map((c) => c.title), ["A", "C"])
  assert.equal(ch[0].end, 50)
  assert.equal(ch[1].end, 100)
})

test("normalizeChapters sorts by start and keeps input order on ties", () => {
  const ch = P.normalizeChapters(
    { data: [{ title: "late", time: 80 }, { title: "first", time: 0 }, { title: "tieA", time: 40 }, { title: "tieB", time: 40 }] },
    100
  )
  assert.deepEqual(ch.map((c) => c.title), ["first", "tieA", "tieB", "late"])
  // tieA is zero-length: its end is the next start.
  assert.equal(ch[1].length, 0)
  assert.equal(ch[2].length, 40)
})

test("normalizeChapters fills blank titles", () => {
  const ch = P.normalizeChapters({ data: [{ title: "  ", time: 0 }, { time: 10 }] }, 20)
  assert.deepEqual(ch.map((c) => c.title), ["Chapter 1", "Chapter 2"])
})

test("normalizeChapters clamps starts into [0, duration]", () => {
  const ch = P.normalizeChapters({ data: [{ title: "neg", time: -5 }, { title: "past", time: 500 }] }, 100)
  assert.equal(ch[0].start, 0)
  assert.equal(ch[1].start, 100)
  assert.equal(ch[1].length, 0)
  assert.equal(ch[1].end, 100)
})

test("normalizeChapters with unknown duration ends last chapter at its start", () => {
  const ch = P.normalizeChapters(fixture, 0)
  assert.equal(ch.length, 12)
  assert.equal(ch[11].end, ch[11].start)
  assert.equal(ch[11].length, 0)
  assert.equal(ch[0].end, 130.309977)
})

test("normalizeChapters does not mutate its input", () => {
  const copy = JSON.parse(JSON.stringify(fixture))
  P.normalizeChapters(copy, BOOK_DURATION)
  assert.deepEqual(copy, fixture)
})

// ---- chapterIndexAt --------------------------------------------------------

test("chapterIndexAt on the real fixture", () => {
  const ch = P.normalizeChapters(fixture, BOOK_DURATION)
  assert.equal(P.chapterIndexAt(ch, 0), 0)
  assert.equal(P.chapterIndexAt(ch, 130.309976), 0)
  assert.equal(P.chapterIndexAt(ch, 130.309977), 1) // exact boundary belongs to the next chapter
  assert.equal(P.chapterIndexAt(ch, 300), 1)
  assert.equal(P.chapterIndexAt(ch, 2672.755964), 11)
  assert.equal(P.chapterIndexAt(ch, 3000), 11)
  assert.equal(P.chapterIndexAt(ch, BOOK_DURATION), 11)
})

test("chapterIndexAt every chapter start maps to itself", () => {
  const ch = P.normalizeChapters(fixture, BOOK_DURATION)
  ch.forEach((c, i) => assert.equal(P.chapterIndexAt(ch, c.start), i))
})

test("chapterIndexAt edge inputs", () => {
  assert.equal(P.chapterIndexAt([], 10), 0)
  assert.equal(P.chapterIndexAt(undefined, 10), 0)
  assert.equal(P.chapterIndexAt(null, 10), 0)
  const ch = P.normalizeChapters(null, 100)
  assert.equal(P.chapterIndexAt(ch, 50), 0)
  assert.equal(P.chapterIndexAt(ch, NaN), 0)
  assert.equal(P.chapterIndexAt(ch, -10), 0)
})

test("chapterIndexAt before a first chapter that starts late returns 0", () => {
  const ch = P.normalizeChapters({ data: [{ title: "A", time: 10 }, { title: "B", time: 20 }] }, 30)
  assert.equal(P.chapterIndexAt(ch, 5), 0)
  assert.equal(P.chapterIndexAt(ch, 15), 0)
  assert.equal(P.chapterIndexAt(ch, 25), 1)
})

test("chapterIndexAt with zero-length chapters picks the last one at that start", () => {
  const ch = P.normalizeChapters({ data: [{ title: "A", time: 0 }, { title: "B", time: 40 }, { title: "C", time: 40 }] }, 100)
  assert.equal(P.chapterIndexAt(ch, 40), 2)
  assert.equal(P.chapterIndexAt(ch, 39.9), 0)
})

test("chapterIndexAt linear-agrees with a brute-force scan", () => {
  const ch = P.normalizeChapters(fixture, BOOK_DURATION)
  for (let p = 0; p <= BOOK_DURATION; p += 7.3) {
    let want = 0
    for (let i = 0; i < ch.length; i++) if (ch[i].start <= p) want = i
    assert.equal(P.chapterIndexAt(ch, p), want, `position ${p}`)
  }
})

// ---- chapterProgress -------------------------------------------------------

test("chapterProgress across a chapter", () => {
  const c = { start: 100, length: 200 }
  assert.equal(P.chapterProgress(c, 100), 0)
  assert.equal(P.chapterProgress(c, 200), 0.5)
  assert.equal(P.chapterProgress(c, 300), 1)
})

test("chapterProgress clamps outside the chapter", () => {
  const c = { start: 100, length: 200 }
  assert.equal(P.chapterProgress(c, 50), 0)
  assert.equal(P.chapterProgress(c, 1000), 1)
})

test("chapterProgress with real fixture chapter", () => {
  const ch = P.normalizeChapters(fixture, BOOK_DURATION)
  near(P.chapterProgress(ch[1], 331.162471), 0.5, 1e-6) // midpoint of chapter 2
})

test("chapterProgress zero-length, missing and NaN inputs", () => {
  assert.equal(P.chapterProgress({ start: 5, length: 0 }, 5), 0)
  assert.equal(P.chapterProgress({ start: 5 }, 10), 0)
  assert.equal(P.chapterProgress(null, 10), 0)
  assert.equal(P.chapterProgress({ start: 0, length: 10 }, NaN), 0)
})

// ---- clampSpeed ------------------------------------------------------------

test("clampSpeed clamps and passes through", () => {
  assert.equal(P.clampSpeed(1.5, 0.5, 3), 1.5)
  assert.equal(P.clampSpeed(0.1, 0.5, 3), 0.5)
  assert.equal(P.clampSpeed(9, 0.5, 3), 3)
  assert.equal(P.clampSpeed(3.5, 0.5, 4), 3.5) // above 3x is allowed when max says so
})

test("clampSpeed defaults and bad input", () => {
  assert.equal(P.clampSpeed(NaN, 0.5, 3), 1)
  assert.equal(P.clampSpeed(undefined, 0.5, 3), 1)
  assert.equal(P.clampSpeed(0.2), 0.5)
  assert.equal(P.clampSpeed(5), 3)
  assert.equal(P.clampSpeed(1, 2, 1.5), 1.5) // swapped bounds
})

// ---- stepSpeed -------------------------------------------------------------

const OPTS = { step: 0.05, min: 0.5, max: 3 }

// Steps through a sequence and collects every value, asserting each one is
// on the grid and free of float noise.
function walk(start, dir, n, opts) {
  const out = []
  let s = start
  for (let i = 0; i < n; i++) {
    s = P.stepSpeed(s, dir, opts)
    out.push(s)
  }
  return out
}

test("stepSpeed 0.05 grid up from 0.5 to 3.5+ with no float noise", () => {
  const seq = walk(0.5, +1, 70, { step: 0.05, min: 0.5, max: 4 })
  assert.equal(seq[0], 0.55)
  assert.equal(seq[1], 0.6)
  assert.equal(seq[9], 1.0)
  assert.equal(seq[10], 1.05)
  assert.equal(seq[49], 3.0)
  assert.equal(seq[59], 3.5)
  assert.equal(seq[69], 4.0)
  assert.equal(P.stepSpeed(seq[69], +1, { step: 0.05, min: 0.5, max: 4 }), 4) // stays at max
  for (const v of seq) assert.equal(v, Number(v.toFixed(2)), `noise in ${v}`)
  // Strictly increasing by 0.05 each time.
  for (let i = 1; i < seq.length; i++) near(seq[i] - seq[i - 1], 0.05, 1e-9)
})

test("stepSpeed 0.1 grid from 0.5", () => {
  assert.deepEqual(walk(0.5, +1, 5, { step: 0.1, min: 0.5, max: 3 }), [0.6, 0.7, 0.8, 0.9, 1])
  assert.deepEqual(walk(1.0, -1, 3, { step: 0.1, min: 0.5, max: 3 }), [0.9, 0.8, 0.7])
})

test("stepSpeed 0.25 grid from 0.5 to 3.5", () => {
  const opts = { step: 0.25, min: 0.5, max: 3.5 }
  assert.deepEqual(walk(0.5, +1, 4, opts), [0.75, 1, 1.25, 1.5])
  assert.deepEqual(walk(3.5, -1, 3, opts), [3.25, 3, 2.75])
  assert.equal(P.stepSpeed(3.5, +1, opts), 3.5)
  assert.equal(P.stepSpeed(0.5, -1, opts), 0.5)
})

test("stepSpeed up then down returns to the start (grid speeds)", () => {
  let s = 1.5
  for (let i = 0; i < 20; i++) s = P.stepSpeed(s, +1, OPTS)
  for (let i = 0; i < 20; i++) s = P.stepSpeed(s, -1, OPTS)
  assert.equal(s, 1.5)
})

test("stepSpeed off-grid speeds move to the next grid point in that direction", () => {
  assert.equal(P.stepSpeed(1.02, +1, OPTS), 1.05)
  assert.equal(P.stepSpeed(1.02, -1, OPTS), 1)
  assert.equal(P.stepSpeed(1.27, -1, { step: 0.1, min: 0.5, max: 3 }), 1.2)
  assert.equal(P.stepSpeed(1.27, +1, { step: 0.1, min: 0.5, max: 3 }), 1.3)
})

test("stepSpeed never produces 1.2000000000000002 style noise", () => {
  // 0.1 grid, values that famously accumulate float error.
  let s = 1
  const seen = []
  for (let i = 0; i < 40; i++) {
    s = P.stepSpeed(s, +1, { step: 0.1, min: 0.1, max: 10 })
    seen.push(s)
  }
  for (const v of seen) assert.equal(v, Number(v.toFixed(1)), `noise in ${v}`)
  assert.equal(seen[1], 1.2)
  assert.equal(seen[9], 2)
  assert.equal(seen[39], 5)
})

test("stepSpeed clamps at min and max without moving past them", () => {
  assert.equal(P.stepSpeed(0.5, -1, OPTS), 0.5)
  assert.equal(P.stepSpeed(0.5, -1, OPTS), 0.5)
  assert.equal(P.stepSpeed(3, +1, OPTS), 3)
  assert.equal(P.stepSpeed(3, +1, OPTS), 3)
  // Down from above max lands on max, not max - step.
  assert.equal(P.stepSpeed(4, -1, OPTS), 3)
  // Up from below min lands on min.
  assert.equal(P.stepSpeed(0.1, +1, OPTS), 0.5)
  assert.equal(P.stepSpeed(0.1, -1, OPTS), 0.5)
})

test("stepSpeed with max off the grid clamps to max", () => {
  const opts = { step: 0.5, min: 1, max: 3.2 }
  assert.equal(P.stepSpeed(3, +1, opts), 3.2)
  assert.equal(P.stepSpeed(3.2, +1, opts), 3.2)
  assert.equal(P.stepSpeed(3.2, -1, opts), 3)
})

test("stepSpeed with dir 0 snaps to the nearest grid point", () => {
  assert.equal(P.stepSpeed(1.02, 0, OPTS), 1)
  assert.equal(P.stepSpeed(1.03, 0, OPTS), 1.05)
  assert.equal(P.stepSpeed(1.5, 0, OPTS), 1.5)
})

test("stepSpeed with zero or invalid step just clamps", () => {
  assert.equal(P.stepSpeed(1.234, 1, { step: 0, min: 0.5, max: 3 }), 1.23)
  assert.equal(P.stepSpeed(9, 1, { step: -1, min: 0.5, max: 3 }), 3)
  assert.equal(P.stepSpeed(1.5, 1, { step: NaN, min: 0.5, max: 3 }), 1.55) // NaN step falls back to 0.05
})

test("stepSpeed bad speed inputs", () => {
  assert.equal(P.stepSpeed(NaN, 1, OPTS), 1.05) // NaN is read as 1
  assert.equal(P.stepSpeed(undefined, -1, OPTS), 0.95)
  assert.equal(P.stepSpeed(0, 1, OPTS), 0.5)
  assert.equal(P.stepSpeed(-3, -1, OPTS), 0.5)
})

test("stepSpeed with missing options uses defaults 0.05 / 0.5 / 3", () => {
  assert.equal(P.stepSpeed(1, +1), 1.05)
  assert.equal(P.stepSpeed(1, -1, {}), 0.95)
  assert.equal(P.stepSpeed(3, +1, null), 3)
})

test("stepSpeed with swapped min and max", () => {
  assert.equal(P.stepSpeed(1, +1, { step: 0.5, min: 3, max: 0.5 }), 1.5)
})

test("stepSpeed decimals follow the step", () => {
  assert.equal(P.stepSpeed(1, +1, { step: 0.025, min: 0.5, max: 3 }), 1.025)
  assert.equal(P.stepSpeed(1.025, +1, { step: 0.025, min: 0.5, max: 3 }), 1.05)
})

// ---- formatSpeed -----------------------------------------------------------

test("formatSpeed trims trailing zeros", () => {
  assert.equal(P.formatSpeed(1.5), "1.5x")
  assert.equal(P.formatSpeed(2), "2x")
  assert.equal(P.formatSpeed(2.25), "2.25x")
  assert.equal(P.formatSpeed(1), "1x")
  assert.equal(P.formatSpeed(0.5), "0.5x")
  assert.equal(P.formatSpeed(3.5), "3.5x")
  assert.equal(P.formatSpeed(3.75), "3.75x")
})

test("formatSpeed rounds float noise and to two decimals", () => {
  assert.equal(P.formatSpeed(1.2000000000000002), "1.2x")
  assert.equal(P.formatSpeed(0.1 + 0.2), "0.3x")
  assert.match(P.formatSpeed(1.005), /^1(\.0[01])?x$/) // binary float rounding, still a clean number
  assert.equal(P.formatSpeed(2.256), "2.26x")
})

test("formatSpeed bad input falls back to 1x", () => {
  assert.equal(P.formatSpeed(NaN), "1x")
  assert.equal(P.formatSpeed(undefined), "1x")
})

// ---- chapterTicks ----------------------------------------------------------

test("chapterTicks on the real fixture are the 11 inner boundaries", () => {
  const ch = P.normalizeChapters(fixture, BOOK_DURATION)
  const ticks = P.chapterTicks(ch, BOOK_DURATION)
  assert.equal(ticks.length, 11)
  ticks.forEach((t, i) => near(t, fixture.data[i + 1].time / BOOK_DURATION, 1e-12))
  assert.ok(ticks.every((t) => t > 0 && t < 1))
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b))
})

test("chapterTicks excludes 0 and 1 and duplicates", () => {
  const ch = P.normalizeChapters({ data: [{ time: 0 }, { time: 50 }, { time: 50 }, { time: 100 }] }, 100)
  assert.deepEqual(P.chapterTicks(ch, 100), [0.5])
})

test("chapterTicks with a single chapter or synthetic list is empty", () => {
  assert.deepEqual(P.chapterTicks(P.normalizeChapters(null, 100), 100), [])
  assert.deepEqual(P.chapterTicks([], 100), [])
  assert.deepEqual(P.chapterTicks(undefined, 100), [])
})

test("chapterTicks with unknown duration is empty", () => {
  const ch = P.normalizeChapters(fixture, 0)
  assert.deepEqual(P.chapterTicks(ch, 0), [])
  assert.deepEqual(P.chapterTicks(ch, NaN), [])
})

// ---- seekTarget ------------------------------------------------------------

test("seekTarget moves and clamps to [0, duration]", () => {
  assert.equal(P.seekTarget(100, 30, 1000), 130)
  assert.equal(P.seekTarget(100, -30, 1000), 70)
  assert.equal(P.seekTarget(100, -500, 1000), 0)
  assert.equal(P.seekTarget(990, 30, 1000), 1000)
  assert.equal(P.seekTarget(0, 0, 1000), 0)
})

test("seekTarget with position beyond duration clamps to duration", () => {
  assert.equal(P.seekTarget(1200, 0, 1000), 1000)
  assert.equal(P.seekTarget(1200, -10, 1000), 1000)
})

test("seekTarget with unknown duration only clamps the lower bound", () => {
  assert.equal(P.seekTarget(10, 30, 0), 40)
  assert.equal(P.seekTarget(10, -30, 0), 0)
  assert.equal(P.seekTarget(10, 30, undefined), 40)
})

test("seekTarget with bad inputs treats them as 0", () => {
  assert.equal(P.seekTarget(NaN, 10, 100), 10)
  assert.equal(P.seekTarget(10, NaN, 100), 10)
  assert.equal(P.seekTarget(undefined, undefined, 100), 0)
})

test("seekTarget works with the skip size used by the panel", () => {
  // 30s back from 10s stops at 0, not -20.
  assert.equal(P.seekTarget(10, -30, 2000), 0)
  assert.equal(P.seekTarget(10, 30, 2000), 40)
})

// ---- barLabel --------------------------------------------------------------

const PLAYING = {
  title: "Managing Oneself",
  position: 0,
  duration: BOOK_DURATION,
  speed: 2,
  playing: true,
  hasBook: true,
  setupReady: true,
}

test("barLabel playing at 2x", () => {
  const r = P.barLabel(PLAYING)
  // (3100 - 0) / 2 = 1550 s = 25m 50s -> "25m left"
  assert.equal(r.text, "Managing Oneself · 25m left · 2x")
  assert.match(r.tooltip, /Playing/)
  assert.match(r.tooltip, /Managing Oneself/)
  assert.match(r.tooltip, /2x/)
})

test("barLabel paused keeps the same text but says Paused in the tooltip", () => {
  const r = P.barLabel(Object.assign({}, PLAYING, { playing: false, speed: 1 }))
  assert.equal(r.text, "Managing Oneself · 51m left · 1x")
  assert.match(r.tooltip, /Paused/)
  assert.doesNotMatch(r.tooltip, /Playing/)
})

test("barLabel uses position and speed for time left", () => {
  const r = P.barLabel(Object.assign({}, PLAYING, { position: 1550, speed: 1.5 }))
  // (3100 - 1550) / 1.5 = 1033.3s -> 17m
  assert.equal(r.text, "Managing Oneself · 17m left · 1.5x")
})

test("barLabel nearly finished book", () => {
  const r = P.barLabel(Object.assign({}, PLAYING, { position: BOOK_DURATION, speed: 1 }))
  assert.equal(r.text, "Managing Oneself · <1m left · 1x")
})

test("barLabel truncates long titles with an ellipsis", () => {
  const long = "A Very Long Audiobook Title That Keeps Going And Going"
  const r = P.barLabel(Object.assign({}, PLAYING, { title: long }), { maxTitle: 20 })
  const shown = r.text.split(" · ")[0]
  assert.equal(shown.length, 20)
  assert.equal(shown, "A Very Long Audiobo…")
  assert.equal(r.text, "A Very Long Audiobo… · 25m left · 2x")
  // The tooltip keeps the full title.
  assert.ok(r.tooltip.indexOf(long) >= 0)
})

test("barLabel does not cut a title at exactly maxTitle", () => {
  const r = P.barLabel(Object.assign({}, PLAYING, { title: "12345678901234567890" }), { maxTitle: 20 })
  assert.equal(r.text.split(" · ")[0], "12345678901234567890")
})

test("barLabel trims whitespace before truncating and does not leave a trailing space", () => {
  const r = P.barLabel(Object.assign({}, PLAYING, { title: "Hello world    and more text here" }), { maxTitle: 12 })
  // 11 chars "Hello world" then ellipsis
  assert.equal(r.text.split(" · ")[0], "Hello world…")
})

test("barLabel default maxTitle is 40", () => {
  const title = "x".repeat(60)
  const shown = P.barLabel(Object.assign({}, PLAYING, { title: title })).text.split(" · ")[0]
  assert.equal(shown.length, 40)
  assert.ok(shown.endsWith("…"))
})

test("barLabel maxTitle 1 gives a lone ellipsis", () => {
  const r = P.barLabel(Object.assign({}, PLAYING, { title: "Hello" }), { maxTitle: 1 })
  assert.equal(r.text.split(" · ")[0], "…")
})

test("barLabel not ready: icon-only text and a setup tooltip", () => {
  const r = P.barLabel(Object.assign({}, PLAYING, { setupReady: false }))
  assert.equal(r.text, "")
  assert.match(r.tooltip, /setup/i)
})

test("barLabel setupReady missing is treated as not ready", () => {
  const st = Object.assign({}, PLAYING)
  delete st.setupReady
  assert.equal(P.barLabel(st).text, "")
})

test("barLabel ready but nothing loaded: icon-only text", () => {
  const r = P.barLabel(Object.assign({}, PLAYING, { hasBook: false }))
  assert.equal(r.text, "")
  assert.match(r.tooltip, /nothing/i)
})

test("barLabel with null state is icon-only", () => {
  assert.equal(P.barLabel(null).text, "")
  assert.equal(P.barLabel(undefined).text, "")
})

test("barLabel book loaded with unknown duration omits the time segment", () => {
  const r = P.barLabel(Object.assign({}, PLAYING, { duration: 0 }))
  assert.equal(r.text, "Managing Oneself · 2x")
  assert.doesNotMatch(r.tooltip, /left/)
})

test("barLabel book loaded with no title shows time and speed only", () => {
  const r = P.barLabel(Object.assign({}, PLAYING, { title: "" }))
  assert.equal(r.text, "25m left · 2x")
})

test("barLabel missing speed defaults to 1x", () => {
  const st = Object.assign({}, PLAYING)
  delete st.speed
  assert.equal(P.barLabel(st).text, "Managing Oneself · 51m left · 1x")
})

test("barLabel speed 0 or negative is treated as 1x", () => {
  assert.equal(P.barLabel(Object.assign({}, PLAYING, { speed: 0 })).text, "Managing Oneself · 51m left · 1x")
  assert.equal(P.barLabel(Object.assign({}, PLAYING, { speed: -2 })).text, "Managing Oneself · 51m left · 1x")
})

test("barLabel position past the end shows the finished state", () => {
  const r = P.barLabel(Object.assign({}, PLAYING, { position: 99999 }))
  assert.equal(r.text, "Managing Oneself · <1m left · 2x")
})

test("barLabel works with the real fixture chapter model", () => {
  // barLabel uses book-level time, so the chapter list is not an input; this
  // checks the fixture title style renders cleanly end to end.
  const ch = P.normalizeChapters(fixture, BOOK_DURATION)
  const i = P.chapterIndexAt(ch, 1000)
  assert.equal(i, 4) // 1000s is in chapter 5 (starts 782, next starts 1105)
  const r = P.barLabel(Object.assign({}, PLAYING, { position: 1000, speed: 1 }))
  assert.equal(r.text, "Managing Oneself · 35m left · 1x")
})

// ---- formatting consistency -------------------------------------------------

test("formatDuration and formatSpeed never return NaN text", () => {
  for (const v of [NaN, Infinity, -Infinity, undefined, null, "x", -1, 0]) {
    assert.doesNotMatch(P.formatDuration(v, "hm"), /NaN|undefined|Infinity/)
    assert.doesNotMatch(P.formatSpeed(v), /NaN|undefined|Infinity/)
  }
})

// ---- volume -------------------------------------------------------------------

test("stepVolume moves on a 5-point grid and snaps odd values", () => {
  assert.equal(P.stepVolume(80, 1), 85)
  assert.equal(P.stepVolume(80, -1), 75)
  assert.equal(P.stepVolume(82, 1), 85)    // snaps up to the next notch
  assert.equal(P.stepVolume(82, -1), 80)   // and down to the previous one
  assert.equal(P.stepVolume(100, 0), 100)
})

test("stepVolume clamps to 0..130 by default and honours custom limits", () => {
  assert.equal(P.stepVolume(0, -1), 0)
  assert.equal(P.stepVolume(130, 1), 130)
  assert.equal(P.stepVolume(128, 1), 130)
  assert.equal(P.stepVolume(50, 1, { step: 10, max: 60 }), 60)
  assert.equal(P.stepVolume(55, 1, { step: 10, max: 60 }), 60)
  assert.equal(P.stepVolume(50, -1, { step: 10, min: 40 }), 40)
})

test("stepVolume survives junk input", () => {
  assert.equal(P.stepVolume(undefined, 1), 105)
  assert.equal(P.stepVolume("abc", -1), 95)
  assert.equal(P.stepVolume(50, 1, { step: -3 }), 55)
})

test("clampVolume rounds to whole numbers and clamps", () => {
  assert.equal(P.clampVolume(49.6), 50)
  assert.equal(P.clampVolume(-5), 0)
  assert.equal(P.clampVolume(999), 130)
  assert.equal(P.clampVolume(null), 100)
})

test("formatVolume shows a percent, or muted", () => {
  assert.equal(P.formatVolume(75, false), "75%")
  assert.equal(P.formatVolume(75, true), "muted")
  assert.equal(P.formatVolume(100.4, false), "100%")
})

// ---- loadCommands / mpvLaunchArgs ------------------------------------------
test("loadCommands: loadfile with key/iv options, then unpause, volume, speed", () => {
  const c = P.loadCommands("/b/A/A.aaxc", { key: "ab12", iv: "cd34" }, { start: 125, speed: 1.4, volume: 80 })
  assert.deepEqual(c[0], ["loadfile", "/b/A/A.aaxc", "replace", -1, { "demuxer-lavf-o": "audible_key=ab12,audible_iv=cd34", start: "125" }])
  assert.deepEqual(c[1], ["set_property", "pause", false])
  assert.deepEqual(c[2], ["set_property", "volume", 80])
  assert.deepEqual(c[3], ["set_property", "speed", 1.4])
})

test("loadCommands: no start option when starting from 0; volume/speed optional", () => {
  const c = P.loadCommands("/f", { key: "ab", iv: "cd" }, {})
  assert.equal(c.length, 2)
  assert.equal(c[0][4].start, undefined)
})

test("loadCommands: unusable voucher or non-hex key gives no commands", () => {
  assert.deepEqual(P.loadCommands("/f", null, {}), [])
  assert.deepEqual(P.loadCommands("/f", { key: "zz", iv: "cd" }, {}), [])
  assert.deepEqual(P.loadCommands("/f", { key: "ab" }, {}), [])
  assert.deepEqual(P.loadCommands("", { key: "ab", iv: "cd" }, {}), [])
})

test("mpvLaunchArgs: detached, idle, socket path, optional uwsm and volume", () => {
  const a = P.mpvLaunchArgs("/run/s.sock", { uwsm: true, volume: 70 })
  assert.deepEqual(a.slice(0, 5), ["setsid", "-f", "uwsm-app", "--", "mpv"])
  assert.ok(a.includes("--idle=yes") && a.includes("--volume=70") && a.includes("--input-ipc-server=/run/s.sock"))
  const b = P.mpvLaunchArgs("/s", {})
  assert.deepEqual(b.slice(0, 3), ["setsid", "-f", "mpv"])
  assert.ok(!b.some((x) => x.startsWith("--volume")))
})
