"use strict"
// What other local users can see. /proc/<pid>/cmdline is world-readable, so no process this plugin
// starts may carry a book id, a listening position, a content id or the sign-in server's secret in
// its argv; files and sockets that hold them live in owner-only directories.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")

function loadModel(file) {
  const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/^\.pragma library\s*$/m, "")
  const mod = { exports: {} }
  new Function("module", "exports", src)(mod, mod.exports)
  return mod.exports
}
const Api = loadModel("ApiRequest.js")
const Sync = loadModel("SyncModel.js")
const W = loadModel("WishlistModel.js")
const P = loadModel("PlayerModel.js")
const S = loadModel("SetupModel.js")

const ASIN = "B0SMPL0072"
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "privacy-"))
const mode = (p) => fs.statSync(p).mode & 0o777

// ---------------------------------------------------------------- API requests go on stdin

test("toProcess: the argv is fixed and the whole request is on stdin", () => {
  const spec = Sync.buildPushRequest(ASIN, 600, "CR!SAMPLE").request
  const p = Api.toProcess(spec)
  assert.deepEqual(p.argv, ["audible", "api", "--request-file", "/dev/stdin", "-o", "json"])
  assert.match(p.input, /^method = "PUT"\npath = "\/1\.0\/lastpositions\/B0SMPL0072"\nbody = /)
})

test("every request builder that names a book keeps it out of argv", () => {
  const specs = [
    Sync.buildPullRequest([ASIN, "B0SMPL0099"]), Sync.buildAcrRequest(ASIN), Sync.buildPushRequest(ASIN, 600, "CR!SAMPLE").request,
    W.productArgs(ASIN), W.simsArgs(ASIN), W.coverArgs([ASIN]), W.addRequest(ASIN, "ST1"), W.removeRequest(ASIN, "ST1")
  ]
  for (const spec of specs) {
    assert.ok(Api.isRequest(spec), JSON.stringify(spec))
    const p = Api.toProcess(spec)
    const line = p.argv.join(" ")
    for (const secret of [ASIN, "CR!SAMPLE", "600000", "ST1"]) assert.ok(!line.includes(secret), line)
    assert.ok(p.input.includes(ASIN))
  }
})

test("toToml: values round-trip through TOML/JSON string escapes; bad requests are refused", () => {
  const body = { acr: 'a"b\\c\nd\u0001', asin: ASIN, position_ms: 1 }
  const toml = Api.toToml(Api.request("PUT", "/1.0/lastpositions/" + ASIN, { k: 'x"y' }, body))
  const field = (k) => JSON.parse(toml.match(new RegExp("^" + k + " = (\".*\")$", "m"))[1])
  assert.deepEqual(JSON.parse(field("body")), body)
  assert.equal(field("k"), 'x"y')
  assert.equal(toml.split("\n").filter((l) => l.startsWith("body")).length, 1)   // escapes keep it on one line
  assert.throws(() => Api.toToml(Api.request("PATCH", "/1.0/x")), /request/)
  assert.throws(() => Api.toToml(Api.request("GET", "/1.0/x\npath = \"/evil\"")), /path/)
  assert.throws(() => Api.toToml(Api.request("GET", "https://evil/1.0/x")), /path/)
  assert.throws(() => Api.toToml(Api.request("GET", "/1.0/x", { "a b": "1" })), /query/)
  assert.throws(() => Api.toProcess(["audible", "api"]), /request/)
})

// ---------------------------------------------------------------- local commands

test("deleting a book: the ASIN is read from stdin, never in argv, and only that book goes", () => {
  const dir = tmp()
  const books = path.join(dir, "books")
  for (const a of [ASIN, "B0SMPL0099"]) {
    fs.mkdirSync(path.join(books, a), { recursive: true })
    fs.writeFileSync(path.join(books, a, a + ".AAX_22_64.aaxc"), "x")
  }
  const argv = P.removeBookArgs(books)
  assert.ok(!argv.join(" ").includes(ASIN))
  spawnSync(argv[0], argv.slice(1), { input: ASIN + "\n" })
  assert.equal(fs.existsSync(path.join(books, ASIN)), false)
  assert.equal(fs.existsSync(path.join(books, "B0SMPL0099", "B0SMPL0099.AAX_22_64.aaxc")), true)
  for (const bad of ["../books", "", "B0SMPL0099/..", "B0SMPL00999"]) {
    const r = spawnSync(argv[0], argv.slice(1), { input: bad + "\n" })
    assert.notEqual(r.status, 0, bad)
  }
  assert.equal(fs.existsSync(path.join(books, "B0SMPL0099", "B0SMPL0099.AAX_22_64.aaxc")), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("reading a voucher: the path comes from stdin; only a regular .voucher file is read", () => {
  const dir = tmp()
  const v = path.join(dir, ASIN + ".AAX_22_64.voucher")
  fs.writeFileSync(v, '{"key":"00","iv":"11"}')
  const argv = P.readVoucherArgs()
  assert.ok(!argv.join(" ").includes(ASIN))
  const read = (p) => spawnSync(argv[0], argv.slice(1), { input: p + "\n", encoding: "utf8" })
  assert.equal(read(v).stdout, '{"key":"00","iv":"11"}')
  fs.symlinkSync(v, path.join(dir, "link.voucher"))
  for (const bad of [path.join(dir, "link.voucher"), path.join(dir, "missing.voucher"), "/etc/passwd", "relative.voucher"]) {
    assert.notEqual(read(bad).status, 0, bad)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

test("the CLI's data and books directories become owner-only, and so do world-readable files in them", () => {
  const dir = tmp()
  const data = path.join(dir, "audible"), books = path.join(data, "books"), db = path.join(data, "db")
  fs.mkdirSync(path.join(books, ASIN), { recursive: true, mode: 0o755 })
  fs.mkdirSync(db, { mode: 0o755 })
  fs.chmodSync(data, 0o755); fs.chmodSync(books, 0o755); fs.chmodSync(path.join(books, ASIN), 0o755)
  fs.writeFileSync(path.join(db, "account.sqlite"), "x", { mode: 0o644 })
  fs.writeFileSync(path.join(books, ASIN, ASIN + ".aaxc"), "x", { mode: 0o644 })
  const argv = P.privateDataDirArgs(data, books)
  assert.equal(spawnSync(argv[0], argv.slice(1)).status, 0)
  for (const d of [data, books, db, path.join(books, ASIN)]) assert.equal(mode(d), 0o700, d)
  assert.equal(mode(path.join(db, "account.sqlite")), 0o600)
  assert.equal(mode(path.join(books, ASIN, ASIN + ".aaxc")), 0o600)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("the private-directory helpers refuse a symlink in place of a directory", () => {
  const dir = tmp()
  const target = path.join(dir, "elsewhere"), link = path.join(dir, "state")
  fs.mkdirSync(target, { mode: 0o755 }); fs.chmodSync(target, 0o755)
  fs.symlinkSync(target, link)
  for (const argv of [P.privateDirArgs(link), P.privateDataDirArgs(link, path.join(link, "books"))]) {
    assert.notEqual(spawnSync(argv[0], argv.slice(1)).status, 0)
  }
  assert.equal(mode(target), 0o755)
  const books = path.join(dir, "books"), victim = path.join(dir, "victim")
  fs.mkdirSync(books); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, "keep"), "x")
  fs.symlinkSync(victim, path.join(books, ASIN))
  const rm = P.removeBookArgs(books)
  spawnSync(rm[0], rm.slice(1), { input: ASIN + "\n" })
  assert.equal(fs.existsSync(path.join(victim, "keep")), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("mpv's IPC socket is never in /tmp", () => {
  assert.equal(P.socketPath("/run/user/1000", "/s"), "/run/user/1000/omarchy-audible-mpv.sock")
  assert.equal(P.socketPath("/run/user/1000/", "/s"), "/run/user/1000/omarchy-audible-mpv.sock")
  for (const r of ["", undefined, "/tmp", "/tmp/x", "relative"]) assert.equal(P.socketPath(r, "/s"), "/s/mpv.sock", String(r))
})

// ---------------------------------------------------------------- sign-in address

const LOGIN = "http://127.0.0.1:39457/0123456789abcdef/"

test("sign-in page: only the sign-in address, and opening it puts no secret in argv", () => {
  assert.match(S.signInPageHtml(LOGIN), /http-equiv="refresh" content="0;url=http:\/\/127\.0\.0\.1:39457\/0123456789abcdef\/"/)
  for (const bad of ["https://evil.example/", LOGIN + '"><script>', "javascript:alert(1)", ""]) assert.equal(S.signInPageHtml(bad), "", bad)

  const dir = tmp()
  const run = path.join(dir, "run")
  fs.mkdirSync(run, { mode: 0o700 })
  const argv = S.signInWriteArgs(path.join(dir, "state"))
  assert.ok(!argv.join(" ").includes("0123456789abcdef"))
  const r = spawnSync(argv[0], argv.slice(1), { input: S.signInPageHtml(LOGIN), env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: run }, encoding: "utf8" })
  assert.equal(r.status, 0, String(r.stderr))
  const page = path.join(run, "audible-sign-in.html")
  assert.equal(r.stdout.trim(), page)                               // what xdg-open is given: the file, not the address
  assert.equal(mode(page), 0o600)
  assert.ok(fs.readFileSync(page, "utf8").includes(LOGIN))

  const clean = S.signInCleanupArgs(path.join(dir, "state"))
  spawnSync(clean[0], clean.slice(1), { env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: run } })
  assert.equal(fs.existsSync(page), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("without a private $XDG_RUNTIME_DIR (here /tmp) the sign-in page goes to the private state directory", () => {
  const dir = tmp()
  const state = path.join(dir, "state")
  const argv = S.signInWriteArgs(state)
  const r = spawnSync(argv[0], argv.slice(1), { input: S.signInPageHtml(LOGIN), env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: "/tmp" } })
  assert.equal(r.status, 0, String(r.stderr))
  assert.equal(mode(state), 0o700)
  assert.equal(mode(path.join(state, "audible-sign-in.html")), 0o600)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- installer

test("the CLI download is checked against a sha256 pinned in the code, not a file from the same release", () => {
  const plan = S.installPlan("v0.1.0-alpha.8", "x86_64")
  assert.match(plan.sha256, /^[0-9a-f]{64}$/)
  assert.equal(plan.sumsUrl, undefined)
  const ctl = fs.readFileSync(path.join(__dirname, "..", "SetupController.qml"), "utf8")
  assert.ok(ctl.includes("plan.sha256"))
  assert.ok(!/SHA256SUMS/.test(ctl))
})
