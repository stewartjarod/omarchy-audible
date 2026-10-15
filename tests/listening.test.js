"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

// ListeningModel.js and LibraryModel.js start with `.pragma library` (a QML directive). Node cannot
// parse that line, so swap it for a comment and evaluate each file in this realm.
function loadModel(name) {
  const file = path.join(__dirname, "..", name)
  const src = fs.readFileSync(file, "utf8").replace(/^\.pragma library/, "//")
  const m = { exports: {} }
  new Function("module", "exports", src)(m, m.exports)
  return m.exports
}

const N = loadModel("ListeningModel.js")
const L = loadModel("LibraryModel.js")

// ---- rewind on resume -------------------------------------------------------

test("rewindSeconds scales with how long playback was paused", () => {
  assert.equal(N.rewindSeconds(0, true), 0)
  assert.equal(N.rewindSeconds(29.9, true), 0)
  assert.equal(N.rewindSeconds(30, true), 3)
  assert.equal(N.rewindSeconds(299, true), 3)
  assert.equal(N.rewindSeconds(300, true), 8)
  assert.equal(N.rewindSeconds(1799, true), 8)
  assert.equal(N.rewindSeconds(1800, true), 15)
  assert.equal(N.rewindSeconds(7199, true), 15)
  assert.equal(N.rewindSeconds(7200, true), 30)
  assert.equal(N.rewindSeconds(86400, true), 30)
})

test("rewindSeconds is zero when the setting is off or the pause length is unusable", () => {
  assert.equal(N.rewindSeconds(600, false), 0)
  assert.equal(N.rewindSeconds(NaN, true), 0)
  assert.equal(N.rewindSeconds(-5, true), 0)
  assert.equal(N.rewindSeconds(undefined, undefined), 0)
})

// ---- sleep timer: start, add, chapter ---------------------------------------

test("sleepAddMinutes starts a fresh timer from nothing", () => {
  const t = N.sleepAddMinutes(null, 15)
  assert.deepEqual(t, { kind: "time", remaining: 900, preset: 15 })
})

test("sleepAddMinutes adds time when the running preset is tapped again", () => {
  let t = N.sleepAddMinutes(null, 15)
  t = N.sleepAddMinutes(t, 15)
  assert.equal(t.remaining, 1800)
  assert.equal(t.preset, 15)
  t = N.sleepAddMinutes(t, 15)
  assert.equal(t.remaining, 2700)
})

test("sleepAddMinutes switches to a different preset instead of stacking", () => {
  let t = N.sleepAddMinutes(null, 15)
  t = N.sleepAddMinutes(t, 60)
  assert.deepEqual(t, { kind: "time", remaining: 3600, preset: 60 })
})

test("sleepRunningPreset reports the minutes of a running time timer", () => {
  assert.equal(N.sleepRunningPreset(null), 0)
  assert.equal(N.sleepRunningPreset(N.sleepChapterTimer(50)), 0)
  assert.equal(N.sleepRunningPreset(N.sleepAddMinutes(null, 45)), 45)
})

test("sleepChapterOvershot ignores normal polling lag and flags a real jump past the target", () => {
  const ch = N.sleepChapterTimer(1000)
  assert.equal(N.sleepChapterOvershot(ch, 1000, 1), false)
  assert.equal(N.sleepChapterOvershot(ch, 1003, 1), false)     // 3 s past at 1x: polling lag
  assert.equal(N.sleepChapterOvershot(ch, 1006, 2), true)      // 6 s past at 2x: allowance is 2*2+1 = 5 s
  assert.equal(N.sleepChapterOvershot(ch, 1020, 1), true)      // user jumped on
  assert.equal(N.sleepChapterOvershot(N.sleepAddMinutes(null, 15), 5000, 1), false)
  assert.equal(N.sleepChapterOvershot(null, 5000, 1), false)
})

test("sleepAddMinutes replaces an end-of-chapter timer and ignores zero minutes", () => {
  const ch = N.sleepChapterTimer(600)
  assert.deepEqual(N.sleepAddMinutes(ch, 30), { kind: "time", remaining: 1800, preset: 30 })
  const t = N.sleepAddMinutes(null, 30)
  assert.equal(N.sleepAddMinutes(t, 0), t)
  assert.equal(N.sleepAddMinutes(null, 0), null)
  assert.equal(N.sleepAddMinutes(null, -10), null)
})

test("sleepChapterTimer needs a real end position", () => {
  assert.deepEqual(N.sleepChapterTimer(1234), { kind: "chapter", endPos: 1234 })
  assert.equal(N.sleepChapterTimer(0), null)
  assert.equal(N.sleepChapterTimer(NaN), null)
})

// ---- sleep countdown --------------------------------------------------------

test("sleepTick counts down only while audio plays", () => {
  let t = N.sleepAddMinutes(null, 15)
  t = N.sleepTick(t, true, 1)
  assert.equal(t.remaining, 899)
  t = N.sleepTick(t, false, 1)
  assert.equal(t.remaining, 899, "a pause does not eat sleep time")
  t = N.sleepTick(t, true, 5)
  assert.equal(t.remaining, 894)
})

test("sleepTick floors at zero and leaves chapter and empty timers alone", () => {
  assert.equal(N.sleepTick({ kind: "time", remaining: 0.5, preset: 15 }, true, 1).remaining, 0)
  const ch = N.sleepChapterTimer(900)
  assert.equal(N.sleepTick(ch, true, 1), ch)
  assert.equal(N.sleepTick(null, true, 1), null)
})

test("sleepRemainingSec reads time timers directly and chapter timers from the position", () => {
  assert.equal(N.sleepRemainingSec({ kind: "time", remaining: 90, preset: 15 }, 0, 1), 90)
  assert.equal(N.sleepRemainingSec(null, 100, 1), 0)
  // 300 s of book left in the chapter at 2x is 150 s of listening.
  assert.equal(N.sleepRemainingSec(N.sleepChapterTimer(1000), 700, 2), 150)
  // A zero or missing speed is treated as 1x.
  assert.equal(N.sleepRemainingSec(N.sleepChapterTimer(1000), 700, 0), 300)
  assert.equal(N.sleepRemainingSec(N.sleepChapterTimer(1000), 1200, 1), 0)
})

test("isSleepDue fires at zero for time timers and one second early for chapters", () => {
  const t = { kind: "time", remaining: 0, preset: 15 }
  assert.equal(N.isSleepDue(t, 0), true)
  assert.equal(N.isSleepDue(t, 0.5), false)
  const ch = N.sleepChapterTimer(100)
  assert.equal(N.isSleepDue(ch, 1), true)
  assert.equal(N.isSleepDue(ch, 1.5), false)
  assert.equal(N.isSleepDue(null, 0), false)
})

// ---- fade curve -------------------------------------------------------------

test("fadeFactor is full above 30 s, linear over the last 30 s, and silent at zero", () => {
  assert.equal(N.fadeFactor(120, 30), 1)
  assert.equal(N.fadeFactor(30, 30), 1)
  assert.equal(N.fadeFactor(15, 30), 0.5)
  assert.equal(N.fadeFactor(7.5, 30), 0.25)
  assert.equal(N.fadeFactor(0, 30), 0)
  assert.equal(N.fadeFactor(-3, 30), 0)
  assert.equal(N.fadeFactor(10, 0), 1, "zero-length fade means no fade")
  assert.equal(N.FADE_SEC, 30)
})

test("fadeVolume scales the user's saved level and never exceeds it", () => {
  assert.equal(N.fadeVolume(100, 31), 100)
  assert.equal(N.fadeVolume(100, 15), 50)
  assert.equal(N.fadeVolume(100, 0), 0)
  assert.equal(N.fadeVolume(130, 7.5), 33)   // 32.5 rounds to 33
  assert.equal(N.fadeVolume(-20, 10), 0)
  assert.equal(N.fadeVolume(NaN, 10), 33)   // unknown base falls back to 100, so 100 * 10/30
})

test("the fade curve only goes down as the sleep time runs out", () => {
  let prev = Infinity
  for (let r = 30; r >= 0; r -= 0.5) {
    const v = N.fadeVolume(100, r)
    assert.ok(v <= prev, `volume rose at ${r} s`)
    prev = v
  }
  assert.equal(prev, 0)
})

// ---- z cycle and labels -----------------------------------------------------

test("z cycles 15, 30, 45, 60, end of chapter, then off", () => {
  let t = null
  const seen = []
  for (let i = 0; i < 7; i++) {
    const choice = N.nextSleepChoice(t)
    seen.push(choice)
    // Apply the choice the way the component does.
    t = choice === 0 ? null : choice === "chapter" ? N.sleepChapterTimer(500) : N.sleepAddMinutes(null, choice)
  }
  assert.deepEqual(seen, [15, 30, 45, 60, "chapter", 0, 15])
})

test("sleepChoiceOf reports the timer's current choice", () => {
  assert.equal(N.sleepChoiceOf(null), 0)
  assert.equal(N.sleepChoiceOf(N.sleepAddMinutes(null, 45)), 45)
  assert.equal(N.sleepChoiceOf(N.sleepChapterTimer(10)), "chapter")
})

test("sleepLabel is plain English and empty when off", () => {
  assert.equal(N.sleepLabel(null, 0), "")
  assert.equal(N.sleepLabel({ kind: "time", remaining: 720, preset: 15 }, 720), "Sleep in 12 min")
  assert.equal(N.sleepLabel({ kind: "time", remaining: 61, preset: 15 }, 61), "Sleep in 2 min")
  assert.equal(N.sleepLabel({ kind: "time", remaining: 30, preset: 15 }, 30), "Sleep in under a minute")
  assert.equal(N.sleepLabel(N.sleepChapterTimer(99), 42), "Sleep at end of chapter")
})

// ---- auto-advance: next in series -------------------------------------------

function book(asin, extra) {
  return Object.assign({ asin, title: asin, authors: ["A"], series: null, finished: false, listenable: true, local: false }, extra || {})
}
function inSeries(asin, title, seq, extra) {
  return book(asin, Object.assign({ title: asin, series: { title, sequence: seq } }, extra || {}))
}

const SAGA = "Saga"

test("finishing a book in a series with a downloaded next book picks that next book", () => {
  const books = [
    inSeries("A", SAGA, "1", { finished: true, local: true }),
    inSeries("B", SAGA, "2", { local: true }),
    inSeries("C", SAGA, "3", { local: true }),
  ]
  assert.deepEqual(N.nextInSeries(L, books, "A", { autoAdvance: "downloaded" }), { asin: "B", reason: "series" })
})

test("the next book is not started when it is not downloaded (no surprise 500 MB download)", () => {
  const books = [
    inSeries("A", SAGA, "1", { finished: true, local: true }),
    inSeries("B", SAGA, "2", { local: false }),
  ]
  assert.equal(N.nextInSeries(L, books, "A", { autoAdvance: "downloaded" }), null)
})

test("the last book in a series starts nothing", () => {
  const books = [
    inSeries("A", SAGA, "1", { finished: true, local: true }),
    inSeries("B", SAGA, "2", { finished: true, local: true }),
  ]
  assert.equal(N.nextInSeries(L, books, "B", { autoAdvance: "downloaded" }), null)
})

test("a book with no series starts nothing", () => {
  const books = [book("X", { local: true, finished: true }), book("Y", { local: true })]
  assert.equal(N.nextInSeries(L, books, "X", { autoAdvance: "downloaded" }), null)
})

test("a series with only one owned book starts nothing", () => {
  const books = [inSeries("A", "Solo", "1", { finished: true, local: true })]
  assert.equal(N.nextInSeries(L, books, "A", { autoAdvance: "downloaded" }), null)
})

test("autoAdvance off starts nothing even when a next book is ready", () => {
  const books = [
    inSeries("A", SAGA, "1", { finished: true, local: true }),
    inSeries("B", SAGA, "2", { local: true }),
  ]
  assert.equal(N.nextInSeries(L, books, "A", { autoAdvance: "off" }), null)
})

test("unnumbered series books go in title order after numbered ones", () => {
  const books = [
    inSeries("Z", "Shorts", "", { title: "Zulu", finished: true, local: true }),
    inSeries("M", "Shorts", "", { title: "Mike", local: true }),
    inSeries("N", "Shorts", "", { title: "November", local: true }),
  ]
  // Reading order by title: Mike, November, Zulu. Zulu finished, so nothing follows it.
  assert.equal(N.nextInSeries(L, books, "Z", { autoAdvance: "downloaded" }), null)
  const first = [
    inSeries("M", "Shorts", "", { title: "Mike", finished: true, local: true }),
    inSeries("N", "Shorts", "", { title: "November", local: true }),
  ]
  assert.deepEqual(N.nextInSeries(L, first, "M", { autoAdvance: "downloaded" }), { asin: "N", reason: "series" })
})

test("already-finished books later in the series are skipped", () => {
  const books = [
    inSeries("A", SAGA, "1", { finished: true, local: true }),
    inSeries("B", SAGA, "2", { finished: true, local: true }),
    inSeries("C", SAGA, "3", { local: true }),
  ]
  assert.deepEqual(N.nextInSeries(L, books, "A", { autoAdvance: "downloaded" }), { asin: "C", reason: "series" })
})

test("a finished book that is missing from the list starts nothing", () => {
  const books = [inSeries("B", SAGA, "2", { local: true }), inSeries("C", SAGA, "3", { local: true })]
  assert.equal(N.nextInSeries(L, books, "A", { autoAdvance: "downloaded" }), null)
})

test("a queue provider's pick wins over the series rule when it is downloaded", () => {
  const books = [
    inSeries("A", SAGA, "1", { finished: true, local: true }),
    inSeries("B", SAGA, "2", { local: true }),
    book("Q", { local: true }),
  ]
  assert.deepEqual(N.nextInSeries(L, books, "A", { autoAdvance: "downloaded", provider: "Q" }), { asin: "Q", reason: "queue" })
})

test("a queue provider's pick that is not downloaded starts nothing, and never falls back to series", () => {
  const books = [
    inSeries("A", SAGA, "1", { finished: true, local: true }),
    inSeries("B", SAGA, "2", { local: true }),
    book("Q", { local: false }),
  ]
  assert.equal(N.nextInSeries(L, books, "A", { autoAdvance: "downloaded", provider: "Q" }), null)
  assert.equal(N.nextInSeries(L, books, "A", { autoAdvance: "downloaded", provider: "NOPE" }), null)
})

test("autoAdvance off beats a queue provider too", () => {
  const books = [book("Q", { local: true })]
  assert.equal(N.nextInSeries(L, books, "A", { autoAdvance: "off", provider: "Q" }), null)
})

test("an injected isLocal decides downloads, overriding the book's local flag", () => {
  const books = [
    inSeries("A", SAGA, "1", { finished: true, local: false }),
    inSeries("B", SAGA, "2", { local: false }),
  ]
  const isLocal = (a) => a === "B"
  assert.deepEqual(N.nextInSeries(L, books, "A", { autoAdvance: "downloaded", isLocal }), { asin: "B", reason: "series" })
})

test("nextInSeries tolerates empty input", () => {
  assert.equal(N.nextInSeries(L, [], "A", { autoAdvance: "downloaded" }), null)
  assert.equal(N.nextInSeries(L, null, "A", {}), null)
})

// ---- audio filter chains ----------------------------------------------------

test("filterChain: off is empty, normalize is dynaudnorm, voice is an EQ and compressor", () => {
  assert.equal(N.filterChain("off"), "")
  assert.equal(N.filterChain("bogus"), "")
  assert.equal(N.filterChain("normalize"), "dynaudnorm")
  const v = N.filterChain("voice")
  assert.match(v, /^highpass=f=80,/)
  assert.match(v, /equalizer=f=3000/)
  assert.match(v, /acompressor=/)
  assert.doesNotMatch(v, /dynaudnorm/)
  assert.equal(v.split(",").length, 3)
})

test("affCommands always removes the labelled filter first, then adds the new chain inside lavfi", () => {
  assert.deepEqual(N.affCommands("off"), [["af", "remove", "@listen"]])
  assert.deepEqual(N.affCommands("normalize"), [
    ["af", "remove", "@listen"],
    ["af", "add", "@listen:lavfi=[dynaudnorm]"],
  ])
  const voice = N.affCommands("voice")
  assert.equal(voice[0][1], "remove")
  assert.equal(voice[1][0], "af")
  assert.equal(voice[1][1], "add")
  assert.ok(voice[1][2].startsWith("@listen:lavfi=["))
  assert.ok(voice[1][2].endsWith("]"))
  assert.equal(voice[1][2].split("[").length, 2, "one bracket pair only")
})

// ---- notifications ----------------------------------------------------------

test("notifyArgs builds notify-send argv with a -- guard before the title", () => {
  assert.deepEqual(N.notifyArgs("Finished", "Saga 1"), ["notify-send", "-a", "Audible", "--", "Finished", "Saga 1"])
  assert.deepEqual(N.notifyArgs("Up next", "B starts", 5000), ["notify-send", "-a", "Audible", "-t", "5000", "--", "Up next", "B starts"])
  assert.deepEqual(N.notifyArgs("-rf title"), ["notify-send", "-a", "Audible", "--", "-rf title"])
})

test("notification texts never carry a book title", () => {
  for (const t of [N.DOWNLOAD_DONE_BODY, N.FINISHED_BODY, N.UP_NEXT_BODY]) assert.equal(typeof t, "string")
  assert.equal(N.UP_NEXT_BODY, "Your next book starts in 5 seconds.")
})
