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

test("read-only builders are exact request specs and refuse invalid ASINs", () => {
  assert.deepEqual(W.listArgs(), ["audible", "collections", "wishlist", "list", "-o", "json"])
  assert.deepEqual(W.productArgs("SIMSAMPLE1"),
    { api: true, method: "GET", path: "/1.0/catalog/products/SIMSAMPLE1", query: { response_groups: W.GROUPS } })
  assert.equal(W.simsArgs("SIMSAMPLE1").path, "/1.0/catalog/products/SIMSAMPLE1/sims")
  assert.equal(W.productArgs("x; rm -rf ~"), null)
  assert.equal(W.simsArgs(""), null)
})

test("wishlist writes are the CLI's own collection requests, need a state token, and refuse invalid ASINs (never run)", () => {
  assert.deepEqual(W.wishlistMetaRequest(), { api: true, method: "GET", path: "/1.0/collections/__WISHLIST" })
  assert.equal(W.parseStateToken(JSON.stringify({ error: null, result: { state_token: "ST1" } })), "ST1")
  assert.equal(W.parseStateToken(JSON.stringify({ error: { message: "x" }, result: { state_token: "ST1" } })), "")
  assert.equal(W.parseStateToken("not json"), "")
  assert.deepEqual(W.addRequest("WISH0001", "ST1"), { api: true, method: "POST", path: "/1.0/collections/__WISHLIST/items",
    body: { collection_id: "__WISHLIST", asins: ["WISH0001"], state_token: "ST1" } })
  assert.deepEqual(W.removeRequest("WISH0001", "ST1"), { api: true, method: "DELETE", path: "/1.0/collections/__WISHLIST/items",
    query: { state_token: "ST1", asins: "WISH0001" } })
  assert.equal(W.addRequest("bad asin", "ST1"), null)
  assert.equal(W.addRequest("WISH0001", ""), null)
  assert.equal(W.removeRequest(null, "ST1"), null)
})

test("cover batches, args and parsing", () => {
  const ids = Array.from({ length: 120 }, (_, i) => "B" + String(i).padStart(9, "0"))
  const b = W.coverBatches(ids.concat(["bad id!", ids[0]]), { [ids[1]]: "x" })
  assert.deepEqual(b.map((x) => x.length), [50, 50, 19])
  assert.ok(!b[0].includes(ids[1]))
  const req = W.coverArgs(b[0])
  assert.equal(req.query.asins, b[0].join(","))
  assert.equal(req.query.response_groups, "media")
  assert.equal(W.coverArgs([]), null)
  const m = W.parseCovers({ products: [
    { asin: "AAAA1", product_images: { 500: "https://m.media-amazon.com/a.jpg" } },
    { asin: "AAAA2", product_images: { 500: "javascript:x" } },
    { asin: "AAAA3" }
  ] })
  assert.deepEqual(m, { AAAA1: "https://m.media-amazon.com/a.jpg" })
  assert.deepEqual(W.parseCovers(null), {})
  const books = W.wishlistBooks([{ asin: "AAAA1", title: "T", added: "2026-01-01" }], [], m)
  assert.equal(books[0].coverUrl, "https://m.media-amazon.com/a.jpg")
})
