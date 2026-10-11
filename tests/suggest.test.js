// Run: node --test tests/suggest.test.js   (from the plugin root)
"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

function loadModel() {
  const file = path.join(__dirname, "..", "SuggestModel.js")
  const src = fs.readFileSync(file, "utf8").replace(/^\.pragma library/, "//")
  const m = { exports: {} }
  new Function("module", "exports", src)(m, m.exports)
  return m.exports
}

const S = loadModel()

// A merged Book (LibraryModel.merge shape, the fields suggest() reads).
function book(asin, extra) {
  return Object.assign({
    asin, title: "Title " + asin, authors: ["Author " + asin], narrators: [], runtimeSec: 3600,
    series: null, percentComplete: 0, resumeSec: 0, remainingSec: 0, finished: false, listenable: true,
    lastListenedAt: 0, purchaseDate: "2024-01-01", rating: 0, playCount: 0, local: false
  }, extra || {})
}

const asins = list => list.map(s => s.asin)

test("empty and malformed input give no suggestions and never throw", () => {
  assert.deepEqual(S.suggest(null, null), [])
  assert.deepEqual(S.suggest([null, 3, "x"], {}), [])
  assert.deepEqual(S.suggest([], { limit: 5 }), [])
})

test("only owned, unfinished, unstarted, playable books are candidates", () => {
  const lib = [
    book("NEW1"),
    book("DONE", { finished: true, percentComplete: 100 }),
    book("PART", { percentComplete: 40, resumeSec: 900 }),
    book("LAPSED", { listenable: false }),
    book("CLOUD", { inLibrary: false }),
    book("SER", { isSeries: true, asin: "series:x" })
  ]
  assert.deepEqual(asins(S.suggest(lib, {})), ["NEW1"])
})

test("excluded ASINs (for example Up next) are not suggested", () => {
  const lib = [book("A1"), book("B1")]
  assert.deepEqual(asins(S.suggest(lib, { exclude: ["A1"] })), ["B1"])
})

test("the next unread book in a series you are partway through comes first, with a plain reason", () => {
  const lib = [
    book("S1", { finished: true, percentComplete: 100, series: { title: "Bobiverse", sequence: "1" } }),
    book("S2", { percentComplete: 30, resumeSec: 500, series: { title: "Bobiverse", sequence: "2" } }),
    book("S3", { series: { title: "Bobiverse", sequence: "3" } }),
    book("S4", { series: { title: "Bobiverse", sequence: "4" } }),
    book("LONE", { runtimeSec: 60 * 60 * 2, finished: false, authors: ["Someone"] })
  ]
  const out = S.suggest(lib, {})
  assert.equal(out[0].asin, "S3")
  assert.equal(out[0].reason, "Book 3 of Bobiverse")
  assert.deepEqual(asins(out), ["S3", "S4", "LONE"])   // one series slot; the rest by length
})

test("a series you have not started is not treated as mid-way", () => {
  const lib = [
    book("T1", { series: { title: "Fresh", sequence: "1" } }),
    book("T2", { series: { title: "Fresh", sequence: "2" } })
  ]
  const out = S.suggest(lib, {})
  assert.ok(out.every(s => !s.reason.startsWith("Book")))
})

test("series books below your furthest one are not suggested", () => {
  const lib = [
    book("U5", { finished: true, percentComplete: 100, series: { title: "Run", sequence: "5" } }),
    book("U2", { series: { title: "Run", sequence: "2" } }),
    book("U6", { series: { title: "Run", sequence: "6" } })
  ]
  const out = S.suggest(lib, {})
  assert.equal(out[0].asin, "U6")
  assert.equal(out.some(s => s.asin === "U2"), true)
  assert.equal(out.find(s => s.asin === "U2").reason !== "Book 2 of Run", true)
})

test("a book by an author you finished gets 'Because you finished X'", () => {
  const lib = [
    book("F1", { title: "Finished One", finished: true, percentComplete: 100, authors: ["Jane Doe"], rating: 4.8, playCount: 2 }),
    book("C1", { authors: ["Jane Doe"] }),
    book("C2", { authors: ["Other Person"] })
  ]
  const out = S.suggest(lib, {})
  assert.equal(out[0].asin, "C1")
  assert.equal(out[0].reason, "Because you finished Finished One")
  assert.equal(out[1].reason, "Not started yet")
})

test("a narrator match counts as affinity too", () => {
  const lib = [
    book("F2", { title: "Read By Her", finished: true, percentComplete: 100, narrators: ["Ann Narr"] }),
    book("C3", { narrators: ["ann narr"], authors: ["Nobody"] })
  ]
  assert.equal(S.suggest(lib, {})[0].reason, "Because you finished Read By Her")
})

test("with no pace, shorter comes before longer on equal footing", () => {
  const lib = [
    book("LONG", { runtimeSec: 40000, purchaseDate: "2024-05-01" }),
    book("SHORT", { runtimeSec: 9000, purchaseDate: "2020-01-01" })
  ]
  assert.deepEqual(asins(S.suggest(lib, {})), ["SHORT", "LONG"])
})

test("with a pace, books you can finish in about a week or two rank first and get a plain reason", () => {
  const weekly = 5 * 3600   // five hours a week
  const lib = [
    book("BIG", { runtimeSec: 30 * 3600 }),
    book("SMALL", { runtimeSec: 4 * 3600 })
  ]
  const out = S.suggest(lib, { pace: { weeklySec: weekly } })
  assert.equal(out[0].asin, "SMALL")
  assert.equal(out[0].reason, "Fits your usual pace: about 1 week")
  assert.equal(out[1].asin, "BIG")
})

test("a pace missing or zero is ignored", () => {
  const lib = [book("X1", { runtimeSec: 100 }), book("X2", { runtimeSec: 200 })]
  assert.deepEqual(asins(S.suggest(lib, { pace: { weeklySec: 0 } })), ["X1", "X2"])
  assert.deepEqual(asins(S.suggest(lib, { pace: null })), ["X1", "X2"])
})

test("the limit caps the result", () => {
  const lib = []
  for (let i = 0; i < 30; i++) lib.push(book("L" + String(i).padStart(3, "0"), { runtimeSec: 1000 + i }))
  assert.equal(S.suggest(lib, { limit: 4 }).length, 4)
  assert.equal(S.suggest(lib, {}).length, 12)
})

test("suggest is deterministic and does not mutate its input", () => {
  const lib = [book("M1", { runtimeSec: 5 }), book("M2", { runtimeSec: 5 })]
  const before = JSON.stringify(lib)
  assert.deepEqual(asins(S.suggest(lib, {})), asins(S.suggest(lib, {})))
  assert.equal(JSON.stringify(lib), before)
})
