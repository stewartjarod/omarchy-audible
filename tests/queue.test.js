// Run: node --test tests/queue.test.js   (from the plugin root)
"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

// QueueModel.js starts with `.pragma library` (a QML directive). Swap it for a comment so node can load it.
function loadModel() {
  const file = path.join(__dirname, "..", "QueueModel.js")
  const src = fs.readFileSync(file, "utf8").replace(/^\.pragma library/, "//")
  const m = { exports: {} }
  new Function("module", "exports", src)(m, m.exports)
  return m.exports
}

const Q = loadModel()
const A = "AAAAAAAA01", B = "BBBBBBBB02", C = "CCCCCCCC03", D = "DDDDDDDD04"

function book(asin, extra) {
  return Object.assign({ asin, title: asin, finished: false, listenable: true, inLibrary: true }, extra || {})
}

test("parseQueue reads the file format, a bare array, and rejects junk", () => {
  assert.deepEqual(Q.parseQueue(JSON.stringify({ version: 1, asins: [A, B] })), [A, B])
  assert.deepEqual(Q.parseQueue(JSON.stringify([B, A])), [B, A])
  assert.deepEqual(Q.parseQueue("not json"), [])
  assert.deepEqual(Q.parseQueue(""), [])
  assert.deepEqual(Q.parseQueue("null"), [])
  assert.deepEqual(Q.parseQueue(JSON.stringify({ asins: "nope" })), [])
})

test("parseQueue drops invalid and duplicate ASINs but keeps order", () => {
  const text = JSON.stringify({ asins: [A, "", "bad asin!", B, A, 42, null, C] })
  assert.deepEqual(Q.parseQueue(text), [A, B, C])
})

test("serialize round-trips through parseQueue", () => {
  const list = [C, A, B]
  const text = Q.serialize(list)
  assert.equal(JSON.parse(text).version, 1)
  assert.deepEqual(Q.parseQueue(text), list)
})

test("addToEnd appends and never duplicates", () => {
  assert.deepEqual(Q.addToEnd([A], B), [A, B])
  assert.deepEqual(Q.addToEnd([A, B], A), [A, B])
  assert.deepEqual(Q.addToEnd([], "not-valid!"), [])
})

test("playNext puts the book first, moving it if already queued", () => {
  assert.deepEqual(Q.playNext([A, B], C), [C, A, B])
  assert.deepEqual(Q.playNext([A, B, C], C), [C, A, B])
  assert.deepEqual(Q.playNext([], A), [A])
})

test("remove, clear", () => {
  assert.deepEqual(Q.remove([A, B, C], B), [A, C])
  assert.deepEqual(Q.remove([A, B], D), [A, B])
  assert.deepEqual(Q.clear(), [])
})

test("moveUp and moveDown swap with the neighbour and stop at the ends", () => {
  assert.deepEqual(Q.moveUp([A, B, C], B), [B, A, C])
  assert.deepEqual(Q.moveDown([A, B, C], B), [A, C, B])
  assert.deepEqual(Q.moveUp([A, B, C], A), [A, B, C])
  assert.deepEqual(Q.moveDown([A, B, C], C), [A, B, C])
  assert.deepEqual(Q.moveUp([A, B], D), [A, B])
})

test("prune drops unknown books but keeps finished ones (listen again), and keeps everything when the library is unknown", () => {
  const books = [book(A), book(B, { finished: true }), book(C)]
  assert.deepEqual(Q.prune([A, B, C, D], books), [A, B, C])
  assert.deepEqual(Q.prune([A, B], null), [A, B])
})

test("pending lists the live books in queue order", () => {
  const books = [book(A), book(B, { finished: true }), book(C)]
  assert.deepEqual(Q.pending([C, B, A, D], books).map(b => b.asin), [C, B, A])
  assert.deepEqual(Q.pending([A], null), [])
})

test("next follows the queue, skipping unplayable books", () => {
  const books = [
    book(A), book(B, { finished: true }), book(C, { listenable: false }), book(D)
  ]
  assert.equal(Q.next([A, B, C, D], A, books), B)   // finished is fine: queued on purpose
  assert.equal(Q.next([A, C, D], A, books), D)
  assert.equal(Q.next([A, B, C, D], D, books), "")
})

test("next starts at the top when the current book is not queued", () => {
  const books = [book(A), book(B), book(C)]
  assert.equal(Q.next([B, C], A, books), B)
  assert.equal(Q.next([], A, books), "")
})

test("next does not mutate the list and tolerates a missing library", () => {
  const list = [A, B]
  assert.equal(Q.next(list, A, null), B)
  assert.deepEqual(list, [A, B])
  assert.equal(Q.next(list, B, null), "")
})

test("has and positionOf are 1-based and tolerate junk", () => {
  assert.equal(Q.has([A, B], B), true)
  assert.equal(Q.has([A, B], C), false)
  assert.equal(Q.has([A, B], undefined), false)
  assert.equal(Q.positionOf([A, B], B), 2)
  assert.equal(Q.positionOf([A, B], C), 0)
})
