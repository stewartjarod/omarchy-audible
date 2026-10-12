"use strict"
// The download settings script (SetupModel.downloadSettingsArgs) is run for real here against a
// stand-in `audible`, so what it reads and writes is checked, including the paths that matter for a
// brand-new install: nothing set yet, everything right already, one wrong value, a failed write.
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
const M = loadModel(path.join(__dirname, "..", "SetupModel.js"))

test("downloadArgs: one book, audio + chapters + cover, JSON output last", () => {
  assert.deepEqual(M.downloadArgs("B082MQ5TDB", "high", false),
    ["download", "--asin", "B082MQ5TDB", "--kind", "audio,chapter,cover", "--quality", "high", "-o", "json"])
})

test("downloadArgs: --force only when asked, and any quality other than normal means high", () => {
  const f = M.downloadArgs("1977300472", "normal", true)
  assert.ok(f.includes("--force"))
  assert.equal(f[f.indexOf("--quality") + 1], "normal")
  assert.equal(f[f.length - 1], "json")
  assert.ok(!M.downloadArgs("1977300472", "normal", false).includes("--force"))
  assert.equal(M.downloadArgs("1977300472", "weird")[6], "high")
})

test("downloadArgs: rejects anything that is not a 10-character ASIN", () => {
  for (const bad of ["", "short", "B082MQ5TDB; rm -rf ~", "B082MQ5TD", "B082MQ5TDBX", null, undefined, "B082MQ5TD-"]) {
    assert.throws(() => M.downloadArgs(bad, "high", false), /ASIN/)
  }
})

test("downloadSettingsArgs: absolute dir only, passed as an argument not in the script", () => {
  assert.throws(() => M.downloadSettingsArgs("books"))
  assert.throws(() => M.downloadSettingsArgs(""))
  const a = M.downloadSettingsArgs("/x/My Books; rm -rf ~")
  assert.deepEqual(a.slice(0, 2), ["sh", "-c"])
  assert.deepEqual(a.slice(3), ["sh", "/x/My Books; rm -rf ~", "custom", "%asin%/%asin%"])
  assert.ok(!a[2].includes("rm -rf"))
})

// Runs the settings script with a stand-in audible. `initial` is the CLI's current config; returns the
// calls made and the config afterwards.
function run(initial, { failSet } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"))
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin)
  const booksDir = path.join(dir, "My Books", "audible")
  const store = path.join(dir, "config.json")
  fs.writeFileSync(store, JSON.stringify(typeof initial === "function" ? initial(booksDir) : initial))
  const log = path.join(dir, "calls.log")
  const stub = `#!/usr/bin/env node
const fs = require("fs")
const store = ${JSON.stringify(store)}, log = ${JSON.stringify(log)}
const cfg = JSON.parse(fs.readFileSync(store, "utf8"))
const [cmd, sub, key, val] = process.argv.slice(2)
fs.appendFileSync(log, process.argv.slice(2).join("\\t") + "\\n")
if (cmd !== "config") process.exit(2)
if (sub === "get") { if (key in cfg) { console.log(cfg[key]); process.exit(0) } console.error("Error: " + key + " is not set"); process.exit(1) }
if (sub === "set") { if (${JSON.stringify(!!failSet)}) { console.error("boom"); process.exit(1) } cfg[key] = val; fs.writeFileSync(store, JSON.stringify(cfg)); console.log("set " + key + " = " + val); process.exit(0) }
process.exit(2)
`
  fs.writeFileSync(path.join(bin, "audible"), stub, { mode: 0o755 })
  const a = M.downloadSettingsArgs(booksDir)
  const r = spawnSync(a[0], a.slice(1), { env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir }, encoding: "utf8" })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => l.split("\t")) : []
  const after = JSON.parse(fs.readFileSync(store, "utf8"))
  fs.rmSync(dir, { recursive: true, force: true })
  return { r, calls, after, booksDir }
}

const sets = (calls) => calls.filter(c => c[1] === "set")

test("settings script: a fresh CLI (nothing set) gets all three settings", () => {
  const { r, calls, after, booksDir } = run({})
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(sets(calls).map(c => [c[2], c[3]]), [
    ["settings.default.download_dir", booksDir],
    ["settings.default.filename_mode", "custom"],
    ["settings.default.filename_template", "%asin%/%asin%"]
  ])
  assert.equal(after["settings.default.download_dir"], booksDir)   // a path with spaces survives intact
})

test("settings script: settings that are already right are not written again", () => {
  const { r, calls } = run(b => ({
    "settings.default.download_dir": b,
    "settings.default.filename_mode": "custom",
    "settings.default.filename_template": "%asin%/%asin%"
  }))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(sets(calls).length, 0)
  assert.equal(calls.length, 3)   // it only looked
})

test("settings script: only a wrong value is rewritten", () => {
  const { r, calls } = run({ "settings.default.filename_mode": "ascii", "settings.default.filename_template": "%asin%/%asin%" })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(sets(calls).map(c => c[2]), ["settings.default.download_dir", "settings.default.filename_mode"])
})

test("settings script: a failed write is reported through the exit status", () => {
  const { r } = run({}, { failSet: true })
  assert.equal(r.status, 1)
})
