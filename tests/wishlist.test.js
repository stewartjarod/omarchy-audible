// Run: node --test tests/wishlist.test.js   (from the plugin root)
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

const W = loadModel("WishlistModel.js")
const FIX = name => fs.readFileSync(path.join(__dirname, "..", "fixtures", "discover", name), "utf8")

test("parseLength reads Audible's hour and minute text", () => {
  assert.equal(W.parseLength("13h 31m"), 13 * 3600 + 31 * 60)
  assert.equal(W.parseLength("5h"), 5 * 3600)
  assert.equal(W.parseLength("45m"), 45 * 60)
  assert.equal(W.parseLength("-"), 0)
  assert.equal(W.parseLength(undefined), 0)
})

test("parseEnvelope handles the CLI envelope, errors, and junk", () => {
  assert.deepEqual(W.parseEnvelope('{"error":null,"result":[1]}'), { ok: true, result: [1], error: "" })
  assert.equal(W.parseEnvelope('{"error":{"message":"not signed in"},"result":null}').error, "not signed in")
  assert.equal(W.parseEnvelope("garbage").ok, false)
  assert.equal(W.parseEnvelope("null").ok, false)
})

test("parseWishlist reads the scrubbed fixture into entries with lengths in seconds", () => {
  const res = W.parseWishlist(FIX("wishlist-list.json"))
  assert.equal(res.ok, true)
  assert.equal(res.entries.length, 6)
  const first = res.entries[0]
  assert.equal(first.asin, "WISH0001")
  assert.equal(first.title, "Sample Wishlist Book 1")
  assert.equal(first.lengthSec, 13 * 3600 + 31 * 60)
  assert.equal(first.added, "2026-01-01")
})

test("parseWishlist drops bad rows and duplicates and reports envelope errors", () => {
  const text = JSON.stringify({ error: null, result: [
    { asin: "GOOD000001", title: "A", authors: "X", length: "1h", added: "2026-01-01", publication: "-" },
    { asin: "GOOD000001", title: "dup" },
    { asin: "bad asin", title: "bad" },
    null
  ] })
  const res = W.parseWishlist(text)
  assert.deepEqual(res.entries.map(e => e.asin), ["GOOD000001"])
  assert.equal(W.parseWishlist('{"error":{"message":"boom"},"result":null}').error, "boom")
})

test("wishlistBook is a not-owned tile with plain copy", () => {
  const e = W.parseWishlist(FIX("wishlist-list.json")).entries[0]
  const b = W.wishlistBook(e)
  assert.equal(b.inLibrary, false)
  assert.equal(b.wishlist, true)
  assert.equal(b.reason, "Not in your library")
  assert.equal(b.runtimeSec, e.lengthSec)
  assert.deepEqual(b.authors, ["Sample Author"])
  assert.equal(b.finished, false)
})

test("wishlistBooks skips anything you already own and sorts newest first", () => {
  const entries = W.parseWishlist(FIX("wishlist-list.json")).entries
  const owned = [{ asin: entries[1].asin }]
  const books = W.wishlistBooks(entries, owned)
  assert.equal(books.length, entries.length - 1)
  assert.ok(books.every(b => b.asin !== entries[1].asin))
  const added = books.map(b => b.addedAt)
  assert.deepEqual(added, [...added].sort().reverse())
})

test("inWishlist checks membership by ASIN", () => {
  const entries = W.parseWishlist(FIX("wishlist-list.json")).entries
  assert.equal(W.inWishlist(entries, "WISH0002"), true)
  assert.equal(W.inWishlist(entries, "NOTTHERE01"), false)
  assert.equal(W.inWishlist(null, "WISH0002"), false)
})

test("productOf and simsOf read the catalog fixtures", () => {
  const prod = W.productOf(JSON.parse(FIX("catalog-product.json")).result)
  assert.equal(prod.title, "Sample Audiobook One")
  assert.equal(prod.runtime_length_min, 811)
  assert.equal(W.productOf(null), null)
  assert.equal(W.productOf({ title: "bare product" }).title, "bare product")
  const sims = W.simsOf(JSON.parse(FIX("catalog-sims.json")).result)
  assert.equal(sims.length, 3)
  assert.equal(W.simsOf({}).length, 0)
  assert.equal(W.simsOf({ similar_products: [{ asin: "bad asin" }, null] }).length, 0)
})

test("read-only argv builders are exact and refuse invalid ASINs", () => {
  assert.deepEqual(W.listArgs(), ["audible", "collections", "wishlist", "list", "-o", "json"])
  const p = W.productArgs("SIMSAMPLE1")
  assert.deepEqual(p.slice(0, 5), ["audible", "api", "GET", "/1.0/catalog/products/SIMSAMPLE1", "--query"])
  assert.ok(W.simsArgs("SIMSAMPLE1")[3].endsWith("/sims"))
  assert.equal(W.productArgs("x; rm -rf ~"), null)
  assert.equal(W.simsArgs(""), null)
})

test("write argv builders exist, are exact, and refuse invalid ASINs (never run by the tests)", () => {
  assert.deepEqual(W.addArgs("WISH0001"), ["audible", "collections", "wishlist", "add", "--asin", "WISH0001", "-o", "json"])
  assert.deepEqual(W.removeArgs("WISH0001"), ["audible", "collections", "wishlist", "remove", "--asin", "WISH0001", "-o", "json"])
  assert.equal(W.addArgs("bad asin"), null)
  assert.equal(W.removeArgs(null), null)
})
