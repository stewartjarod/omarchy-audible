"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

// SyncModel.js starts with `.pragma library` (not valid JS for node); blank it like player.test.js does.
const M = (() => {
  const src = fs.readFileSync(path.join(__dirname, "..", "SyncModel.js"), "utf8")
    .replace(/^\.pragma library\s*$/m, "")
  const mod = { exports: {} }
  new Function("module", src)(mod)
  return mod.exports
})()

const fx = (name) => fs.readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8")
const lastPositions = fx("sync-lastpositions.json")
const progress = JSON.parse(fx("sync-library-progress.json")).result.items
const showJson = JSON.parse(fx("sync-annotations-show.json"))

const BOOK = "B0C7WJXBRL"                 // 361 min, 24% on the library, phone at 5255484 ms
const FINISHED = "B08F6D4ZPV"            // finished on the library, phone position 0
const UNKNOWN = "B000000000"             // DoesNotExist

const libBook = (asin) => {
  const it = progress.find((i) => i.asin === asin)
  const ls = it.listening_status
  return {
    asin, finished: ls.is_finished === true || ls.percent_complete >= 99,
    percentComplete: ls.percent_complete, runtimeSec: it.runtime_length_min * 60, listenable: true
  }
}

test("parseTimestamp reads Audible's timezone-less stamp as UTC", () => {
  assert.equal(M.parseTimestamp("2025-08-28 19:24:46.771"), Date.UTC(2025, 7, 28, 19, 24, 46, 771))
  assert.equal(M.parseTimestamp("2023-04-30 14:07:53.386"), Date.UTC(2023, 3, 30, 14, 7, 53, 386))
  assert.equal(M.parseTimestamp("2025-08-28 19:24:46"), Date.UTC(2025, 7, 28, 19, 24, 46, 0))
  assert.equal(M.parseTimestamp(""), 0)
  assert.equal(M.parseTimestamp("garbage"), 0)
})

test("parseLastPositions reads the real reply: ms to seconds, DoesNotExist kept as no-position", () => {
  const r = M.parseLastPositions(lastPositions)
  assert.equal(r.ok, true)
  assert.equal(r.positions[BOOK].positionSec, 5255.484)
  assert.equal(r.positions[BOOK].exists, true)
  assert.equal(r.positions[FINISHED].positionSec, 0)
  assert.equal(r.positions[FINISHED].exists, true)
  assert.equal(r.positions[UNKNOWN].exists, false)
  assert.equal(r.positions[UNKNOWN].positionSec, 0)
})

test("parseLastPositions turns an API error envelope into a plain sentence, not raw text", () => {
  const r = M.parseLastPositions(JSON.stringify({ error: { message: "request failed with HTTP status 400 Bad Request" }, result: null }))
  assert.equal(r.ok, false)
  assert.match(r.error, /Could not reach Audible|did not take|sign-in/)
  assert.doesNotMatch(r.error, /HTTP|400/)
  assert.equal(M.parseLastPositions("not json").ok, false)
})

test("friendlyError maps sign-in trouble to the setup hint", () => {
  assert.match(M.friendlyError("account is locked"), /sign-in needs attention/)
})

test("buildPullArgv is always a GET with a comma list of ASINs", () => {
  const argv = M.buildPullArgv(["A1", "A2"])
  assert.equal(argv[2], "GET")
  assert.equal(argv[3], "/1.0/annotations/lastpositions")
  assert.ok(argv.includes("asins=A1,A2"))
  assert.ok(!argv.includes("PUT") && !argv.includes("POST") && !argv.includes("DELETE"))
})

test("chunk splits into batches", () => {
  assert.deepEqual(M.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(M.chunk([], 25), [])
})

test("pullCandidates skips finished and unlistenable books, keeps started, downloaded and last", () => {
  const books = [
    { asin: "S", percentComplete: 10, finished: false, listenable: true },
    { asin: "F", percentComplete: 100, finished: true, listenable: true },
    { asin: "N", percentComplete: 0, finished: false, listenable: true },
    { asin: "X", percentComplete: 50, finished: false, listenable: false },
    { asin: "D", percentComplete: 0, finished: false, listenable: true }
  ]
  const got = M.pullCandidates(books, { D: true }, "L")
  assert.deepEqual(got, ["L", "S", "D"])
})

test("localBaseline mirrors resumePosition: own resume first, else percent of runtime, finished has none", () => {
  assert.deepEqual(M.localBaseline({ position: 900, updatedAt: 5 }, libBook(BOOK)), { position: 900, updatedAt: 5 })
  const b = M.localBaseline(null, libBook(BOOK))
  assert.equal(Math.round(b.position), 5198)       // 24% of 21660 s
  assert.equal(M.localBaseline(null, libBook(FINISHED)).position, 0)
})

test("REAL NUMBERS: phone 5255 s vs library 24% (5198 s) is a 57 s gap, so no offer", () => {
  const phone = M.parseLastPositions(lastPositions).positions[BOOK]
  const d = M.decide(phone, M.localBaseline(null, libBook(BOOK)), { durationSec: 21660 })
  assert.equal(d.state, "none")
  assert.ok(Math.abs(d.gapSec - 57) < 1)
})

test("finished book with phone position 0 never produces an offer or push", () => {
  const phone = M.parseLastPositions(lastPositions).positions[FINISHED]
  assert.equal(M.decide(phone, M.localBaseline(null, libBook(FINISHED)), { durationSec: 27480 }).state, "none")
  assert.equal(M.decide(phone, { position: 0, updatedAt: 0 }, { durationSec: 27480 }).state, "none")
})

test("DoesNotExist on the phone with local progress means local-ahead (push candidate), not phone-ahead", () => {
  const phone = M.parseLastPositions(lastPositions).positions[UNKNOWN]
  assert.equal(M.decide(phone, { position: 600, updatedAt: 0 }, { durationSec: 3000 }).state, "local-ahead")
})

test("phone clearly ahead (more than 2 minutes, further than local) gives phone-ahead", () => {
  const phone = { positionSec: 3000, updatedAt: 0, exists: true }
  assert.equal(M.decide(phone, { position: 2000, updatedAt: 0 }, { durationSec: 9000 }).state, "phone-ahead")
})

test("a 2 minute difference is inside the tolerance", () => {
  const phone = { positionSec: 2100, updatedAt: 0, exists: true }
  assert.equal(M.decide(phone, { position: 2000, updatedAt: 0 }, { durationSec: 9000 }).state, "none")
})

test("timestamps decide newer-wins when both sides have one: an old phone spot does not beat newer local", () => {
  const phone = { positionSec: 3000, updatedAt: Date.UTC(2025, 0, 1), exists: true }
  const local = { position: 1000, updatedAt: Date.UTC(2026, 5, 1) }
  assert.equal(M.decide(phone, local, { durationSec: 9000 }).state, "local-ahead")
})

test("phone near the end (inside the last 60 s) is treated as finished, not an offer", () => {
  const phone = { positionSec: 8960, updatedAt: 0, exists: true }
  assert.equal(M.decide(phone, { position: 1000, updatedAt: 0 }, { durationSec: 9000 }).state, "none")
})

test("formatHm and formatPosition: '2h 13m', '42m', '<1m', and the chapter prefix", () => {
  assert.equal(M.formatHm(2 * 3600 + 13 * 60 + 9), "2h 13m")
  assert.equal(M.formatHm(42 * 60), "42m")
  assert.equal(M.formatHm(20), "<1m")
  const chapters = [{ index: 0, start: 0 }, { index: 1, start: 600 }, { index: 11, start: 7000 }]
  assert.equal(M.formatPosition(7980, chapters), "Chapter 12 · 2h 13m")
  assert.equal(M.formatPosition(7980, []), "2h 13m")
})

test("the real show record decodes to the same position as the lastpositions reply", () => {
  const sec = Number(showJson.result[0].position) / 1000
  assert.equal(sec, M.parseLastPositions(lastPositions).positions[BOOK].positionSec)
})

test("backoff doubles and caps at 30 minutes", () => {
  assert.equal(M.backoffMs(1), 60000)
  assert.equal(M.backoffMs(2), 120000)
  assert.equal(M.backoffMs(3), 240000)
  assert.equal(M.backoffMs(50), 30 * 60 * 1000)
})

test("push is opt-in and dry run is on unless explicitly off", () => {
  assert.deepEqual(M.pushMode({}), { push: false, dryRun: true })
  assert.deepEqual(M.pushMode({ syncPositionToAudible: true }), { push: true, dryRun: true })
  assert.deepEqual(M.pushMode({ syncPositionToAudible: true, syncDryRun: false }), { push: true, dryRun: false })
  assert.equal(M.pushMode({ syncPositionToAudible: "true" }).push, false)  // strict boolean only
})

test("live send needs push on, dry run off AND a content id; all else is refused", () => {
  assert.equal(M.canSendLive({ push: true, dryRun: false }, ""), false)
  assert.equal(M.canSendLive({ push: true, dryRun: true }, "ACR"), false)
  assert.equal(M.canSendLive({ push: false, dryRun: false }, "ACR"), false)
  assert.equal(M.canSendLive({ push: true, dryRun: false }, "ACR"), true)
})

test("buildPushRequest marks itself unverified and builds a PUT with the position in ms", () => {
  const req = M.buildPushRequest(BOOK, 5255.4, "ACR")
  assert.equal(req.unverified, true)
  assert.equal(req.argv[2], "PUT")
  assert.equal(req.body.position_ms, 5255400)
  assert.equal(req.body.acr, "ACR")
  assert.equal(M.buildPushRequest("", 1, "x"), null)
})

test("shouldPush: off, backoff, unchanged, rate limits and due", () => {
  const base = { pushOn: true, hasBook: true, playing: true, paused: false, positionSec: 600, nowMs: 1e12, lastPushMs: 0, nextAllowedMs: 0 }
  assert.equal(M.shouldPush({ ...base, pushOn: false }).reason, "off")
  assert.equal(M.shouldPush({ ...base, nextAllowedMs: 1e12 + 1 }).reason, "backoff")
  assert.equal(M.shouldPush({ ...base, sentSec: 602 }).reason, "unchanged")
  assert.equal(M.shouldPush({ ...base, lastPushMs: 1e12 - 60000 }).reason, "rate-limit")
  assert.equal(M.shouldPush(base).send, true)
  // paused: a short gap is allowed, but never a burst
  assert.equal(M.shouldPush({ ...base, playing: false, paused: true, lastPushMs: 1e12 - 30000 }).send, true)
  assert.equal(M.shouldPush({ ...base, playing: false, paused: true, lastPushMs: 1e12 - 2000 }).send, false)
})

test("describeWouldSend reads like a plain log line and says nothing was sent", () => {
  const s = M.describeWouldSend(BOOK, 7980, [{ index: 0, start: 0 }, { index: 11, start: 7000 }])
  assert.equal(s, "Would send to Audible: book B0C7WJXBRL, at Chapter 12 · 2h 13m. Not sent (dry run is on).")
})

test("needsPull respects the 10 minute freshness window", () => {
  assert.equal(M.needsPull(0, 1000), true)
  assert.equal(M.needsPull(1000, 1000 + 5 * 60000), false)
  assert.equal(M.needsPull(1000, 1000 + 11 * 60000), true)
})
