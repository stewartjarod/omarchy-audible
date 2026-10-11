// Run: node --test tests/discover.test.js   (from the plugin root)
"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

function loadModel(name) {
  const file = path.join(__dirname, "..", name)
  const src = fs.readFileSync(file, "utf8").replace(/^\.pragma library/, "//")
  const m = { exports: {} }
  new Function("module", "exports", src)(m, m.exports)
  return m.exports
}

const D = loadModel("DiscoverModel.js")
const b = (asin, extra) => Object.assign({ asin, title: asin }, extra || {})

test("with nothing new, the sections come back unchanged", () => {
  const secs = [{ id: "continue", title: "Continue listening", books: [b("A")] }]
  assert.deepEqual(D.compose(secs, {}), secs)
  assert.deepEqual(D.compose(null, null), [])
})

test("suggested then up next come first, each with its reason", () => {
  const secs = [{ id: "all", title: "All books", books: [b("X"), b("Y")] }]
  const out = D.compose(secs, {
    suggested: [{ asin: "X", reason: "Book 2 of Run", book: b("X") }],
    upNext: [b("Q1"), b("Q2")]
  })
  assert.deepEqual(out.map(s => s.id), ["suggested", "upnext", "all"])
  assert.equal(out[0].books[0].reason, "Book 2 of Run")
  assert.equal(out[1].books[0].reason, "Up next, number 1")
  assert.equal(out[1].books[1].reason, "Up next, number 2")
})

test("a book shown in a new section is removed from the regular sections, so it appears once", () => {
  const secs = [
    { id: "continue", title: "Continue listening", books: [b("C")] },
    { id: "all", title: "All books", books: [b("X"), b("Y")] }
  ]
  const out = D.compose(secs, { suggested: [{ asin: "X", reason: "r", book: b("X") }], upNext: [b("C")] })
  const all = out.flatMap(s => s.books.map(x => x.asin))
  assert.deepEqual(all.sort(), ["C", "X", "Y"])
  assert.equal(out.find(s => s.id === "all").books.length, 1)
})

test("a regular section that empties out is dropped", () => {
  const secs = [{ id: "all", title: "All books", books: [b("X")] }]
  const out = D.compose(secs, { suggested: [{ asin: "X", reason: "r", book: b("X") }] })
  assert.deepEqual(out.map(s => s.id), ["suggested"])
})

test("library objects are not mutated (copies carry the reason)", () => {
  const book = b("Z")
  D.compose([], { suggested: [{ asin: "Z", reason: "why", book }] })
  assert.equal("reason" in book, false)
})
