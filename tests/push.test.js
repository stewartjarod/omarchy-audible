"use strict"
// The write to Audible (SyncModel.pushPosition) run for real against a stand-in `audible`: the content
// id, the fresh read, the refusal rules and the PUT, including what must NOT be written.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")

function loadModel(file) {
  const src = fs.readFileSync(file, "utf8").replace(/^\.pragma library\s*$/m, "")
  const mod = { exports: {} }
  new Function("module", "exports", src)(mod, mod.exports)
  return mod.exports
}
const M = loadModel(path.join(__dirname, "..", "SyncModel.js"))

const ASIN = "B0SMPL0072"
const ACR = "CR!SAMPLE0000000000000000000000"
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0)          // "when this computer last played the book"
const stamp = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "")   // "2026-10-12 12:00:00.000"

// A stand-in account. `remote` is Audible's position for ASIN (null = none). Calls are logged.
function world({ remote = null, putFails = false, putEnvelopeError = false, acrMissing = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-"))
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin)
  const log = path.join(dir, "calls.log"), store = path.join(dir, "account.json")
  fs.writeFileSync(store, JSON.stringify({ remote }))
  const stub = `#!/usr/bin/env node
const fs = require("fs")
const [api, method, url, ...rest] = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, [method, url, ...rest].join("\\t") + "\\n")
const acct = JSON.parse(fs.readFileSync(${JSON.stringify(store)}, "utf8"))
const out = (o) => console.log(JSON.stringify({ error: null, result: o, warnings: [] }))
if (method === "GET" && url.startsWith("/1.0/content/")) {
  if (${JSON.stringify(acrMissing)}) { out({ content_metadata: {} }); process.exit(0) }
  out({ content_metadata: { content_reference: { acr: ${JSON.stringify(ACR)}, asin: ${JSON.stringify(ASIN)} } } }); process.exit(0)
}
if (method === "GET" && url === "/1.0/annotations/lastpositions") {
  const r = acct.remote
  out({ asin_last_position_heard_annots: [{ asin: ${JSON.stringify(ASIN)}, last_position_heard: r
    ? { status: "Exists", position_ms: r.ms, last_updated: r.at } : { status: "DoesNotExist" } }] }); process.exit(0)
}
if (method === "PUT" && url === "/1.0/lastpositions/${ASIN}") {
  if (${JSON.stringify(putEnvelopeError)}) { console.log(JSON.stringify({ error: { message: "nope" }, result: {} })); process.exit(0) }
  if (${JSON.stringify(putFails)}) { console.error("Error: request failed with HTTP status 500"); process.exit(1) }
  const body = JSON.parse(rest[rest.indexOf("--body") + 1])
  acct.remote = { ms: body.position_ms, at: "2099-01-01 00:00:00.000" }   // Audible's own (far ahead) clock
  fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(acct)); out("ok"); process.exit(0)
}
console.error("unexpected call"); process.exit(2)
`
  fs.writeFileSync(path.join(bin, "audible"), stub, { mode: 0o755 })
  const run = (argv, cb) => {
    const r = spawnSync(argv[0], argv.slice(1), { env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` }, encoding: "utf8" })
    cb(r.status, r.stdout, r.stderr)
  }
  return {
    run,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")) : []),
    account: () => JSON.parse(fs.readFileSync(store, "utf8")).remote,
    done: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}

function push(w, ctx) {
  let res = null
  M.pushPosition(w.run, { asin: ASIN, positionSec: 600, listenedAtMs: T0, acr: "", pushedMs: undefined, ...ctx }, (r) => { res = r })
  return res
}
const puts = (w) => w.calls().filter((c) => c[0] === "PUT")
const gets = (w, part) => w.calls().filter((c) => c[0] === "GET" && c[1].includes(part))

test("a book with no position on Audible: reads the content id, then writes acr, asin and whole ms", () => {
  const w = world({ remote: null })
  const r = push(w, { positionSec: 600.0004 })
  assert.equal(r.outcome, "sent")
  assert.equal(r.acr, ACR)
  assert.equal(r.positionMs, 600000)
  assert.equal(puts(w).length, 1)
  const body = JSON.parse(puts(w)[0][puts(w)[0].indexOf("--body") + 1])
  assert.deepEqual(body, { acr: ACR, asin: ASIN, position_ms: 600000 })
  assert.equal(w.account().ms, 600000)
  w.done()
})

test("the content id is read once: a cached one is reused, with no second metadata call", () => {
  const w = world({ remote: null })
  const first = push(w, {})
  const second = push(w, { acr: first.acr, pushedMs: first.positionMs, positionSec: 700 })
  assert.equal(second.outcome, "sent")
  assert.equal(gets(w, "/metadata").length, 1)
  assert.equal(puts(w).length, 2)
  w.done()
})

test("another device wrote after we last listened: no write at all (the phone is not moved back)", () => {
  const w = world({ remote: { ms: 5000000, at: stamp(T0 + 30 * 60 * 1000) } })   // 30 minutes after us
  const r = push(w, { acr: ACR })
  assert.equal(r.outcome, "refused")
  assert.equal(r.why, "stale")
  assert.equal(r.remote.positionMs, 5000000)   // handed back so the popup can offer "Resume from phone"
  assert.equal(puts(w).length, 0)
  assert.equal(w.account().ms, 5000000)
  w.done()
})

test("an older phone position is overwritten: the newest listening wins", () => {
  const w = world({ remote: { ms: 5000000, at: stamp(T0 - 3 * 3600 * 1000) } })
  assert.equal(push(w, { acr: ACR }).outcome, "sent")
  assert.equal(w.account().ms, 600000)
  w.done()
})

test("our own earlier write, stamped by Audible's far-ahead clock, is not 'newer' and never locks us out", () => {
  const w = world({ remote: { ms: 600000, at: "2099-01-01 00:00:00.000" } })
  const r = push(w, { acr: ACR, pushedMs: 600000, positionSec: 650 })
  assert.equal(r.outcome, "sent")
  assert.equal(w.account().ms, 650000)
  w.done()
})

test("the same far-ahead stamp with a DIFFERENT position is another device and is refused", () => {
  const w = world({ remote: { ms: 601000, at: "2099-01-01 00:00:00.000" } })
  assert.equal(push(w, { acr: ACR, pushedMs: 600000 }).outcome, "refused")
  assert.equal(puts(w).length, 0)
  w.done()
})

test("clock slack: a stamp a few seconds after our last listening is not another device", () => {
  const w = world({ remote: { ms: 590000, at: stamp(T0 + 20 * 1000) } })
  assert.equal(push(w, { acr: ACR }).outcome, "sent")
  w.done()
})

test("never played here (no listening time): refuses rather than guess", () => {
  const w = world({ remote: { ms: 1000, at: stamp(T0 - 1000) } })
  const r = push(w, { acr: ACR, listenedAtMs: 0 })
  assert.equal(r.outcome, "refused")
  assert.equal(r.why, "unknown")
  assert.equal(puts(w).length, 0)
  w.done()
})

test("no content id available: fails without writing", () => {
  const w = world({ acrMissing: true })
  const r = push(w, {})
  assert.equal(r.outcome, "failed")
  assert.equal(r.acr, "")
  assert.equal(puts(w).length, 0)
  w.done()
})

test("a failed write (HTTP error, exit 1) is a failure and the cached content id is dropped", () => {
  const w = world({ putFails: true })
  const r = push(w, { acr: ACR })
  assert.equal(r.outcome, "failed")
  assert.equal(r.acr, "")
  assert.ok(!/HTTP|500|Error/.test(r.error), "the message is plain English, not raw output")
  w.done()
})

test("an error envelope with exit 0 still counts as a failure, never as sent", () => {
  const w = world({ putEnvelopeError: true })
  assert.equal(push(w, { acr: ACR }).outcome, "failed")
  w.done()
})

test("callSucceeded: exit 0 and no envelope error; non-JSON output trusts the exit code", () => {
  assert.equal(M.callSucceeded(0, '{"error":null,"result":{}}'), true)
  assert.equal(M.callSucceeded(0, '{"error":{"message":"x"}}'), false)
  assert.equal(M.callSucceeded(1, '{"error":null}'), false)
  assert.equal(M.callSucceeded(0, "ok"), true)
})

test("buildAcrArgv is a GET for one valid ASIN; parseAcr takes only that book's content id", () => {
  assert.deepEqual(M.buildAcrArgv(ASIN), ["audible", "api", "GET", "/1.0/content/" + ASIN + "/metadata",
    "--query", "response_groups=content_reference", "-o", "json"])
  assert.throws(() => M.buildAcrArgv("x; rm -rf ~"), /ASIN/)
  const ok = JSON.stringify({ error: null, result: { content_metadata: { content_reference: { acr: ACR, asin: ASIN } } } })
  assert.equal(M.parseAcr(ok, ASIN), ACR)
  assert.equal(M.parseAcr(ok, "B0SMPL0099"), "")                 // a reply about another book
  assert.equal(M.parseAcr('{"error":{"message":"404"},"result":{}}', ASIN), "")
  assert.equal(M.parseAcr("not json", ASIN), "")
})
