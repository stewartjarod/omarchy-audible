"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const C = (() => {
  const src = fs.readFileSync(path.join(__dirname, "..", "CoverModel.js"), "utf8")
    .replace(/^\.pragma library\s*$/m, "")
  const mod = { exports: {} }
  new Function("module", src)(mod)
  return mod.exports
})()

const URL = "https://m.media-amazon.com/images/I/51abcDEF+x._SL500_.jpg"

test("only plain https URLs are fetched", () => {
  assert.equal(C.isRemote(URL), true)
  assert.equal(C.isRemote("http://m.media-amazon.com/a.jpg"), false)
  assert.equal(C.isRemote("file:///etc/passwd"), false)
  assert.equal(C.isRemote("https://x/a\".jpg"), false, "a quote would break out of the curl config string")
  assert.equal(C.isRemote("https://x/a\\b.jpg"), false)
  assert.equal(C.isRemote("https://x/a b.jpg"), false)
  assert.equal(C.isRemote("https://x/a\nurl = \"https://evil\""), false)
  assert.equal(C.isRemote("https://x/" + "a".repeat(3000)), false)
  assert.equal(C.isRemote(undefined), false)
})

test("cache names are 16 hex digits and stable", () => {
  const n = C.cacheName(URL)
  assert.match(n, /^[0-9a-f]{16}$/)
  assert.equal(C.cacheName(URL), n)
  assert.notEqual(C.cacheName(URL + "x"), n)
  assert.equal(C.cachePath("/c", URL), "/c/" + n + ".img")
})

test("the URL and the cache name travel on stdin, never in argv", () => {
  const argv = C.fetchArgs("/cache/jarod-audible/covers")
  assert.ok(!argv.join(" ").includes("media-amazon"))
  assert.ok(!argv.join(" ").includes(C.cacheName(URL)))
  assert.equal(C.fetchInput(URL), C.cacheName(URL) + "\nurl = \"" + URL + "\"\n")
  assert.equal(C.fetchInput("http://insecure/a.jpg"), "")
})

test("parseList keeps only cache names", () => {
  const names = C.parseList("0123456789abcdef.img\n../evil.img\nZZZZ.img\n\nfedcba9876543210.img\n")
  assert.deepEqual(Object.keys(names).sort(), ["0123456789abcdef", "fedcba9876543210"])
})

// ---- the fetch script itself, against a stand-in curl --------------------------------------
// The stub reads the -K config from stdin like curl, checks it got the URL there, and prints
// $STUB_BODY's file (or fails with $STUB_RC).
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cover-test-"))
  const bin = path.join(root, "bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "curl"),
    "#!/bin/sh\ncfg=$(cat)\ncase $cfg in *'url = \"https://'*) ;; *) exit 9;; esac\n" +
    "[ -n \"$STUB_RC\" ] && exit \"$STUB_RC\"\ncat \"$STUB_BODY\"\n", { mode: 0o755 })
  return { root, bin, dir: path.join(root, "covers") }
}

function fetch(sb, body, extraEnv) {
  const bodyFile = path.join(sb.root, "body")
  fs.writeFileSync(bodyFile, body)
  const argv = C.fetchArgs(sb.dir)
  return spawnSync(argv[0], argv.slice(1), {
    input: C.fetchInput(URL),
    env: Object.assign({ PATH: sb.bin + ":/usr/bin:/bin", STUB_BODY: bodyFile }, extraEnv || {})
  })
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, 1)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(1000, 1)])

function leftovers(sb) {
  return fs.readdirSync(sb.dir).filter((f) => f.startsWith(".part."))
}

test("a JPEG lands in a private cache under its hash name", () => {
  const sb = sandbox()
  const r = fetch(sb, JPEG)
  assert.equal(r.status, 0, String(r.stderr))
  const dest = C.cachePath(sb.dir, URL)
  assert.deepEqual(fs.readFileSync(dest), JPEG)
  assert.equal(fs.statSync(sb.dir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600)
  assert.deepEqual(leftovers(sb), [])
})

test("a PNG is accepted too", () => {
  const sb = sandbox()
  assert.equal(fetch(sb, PNG).status, 0)
})

test("a reply over the ceiling is dropped", () => {
  const sb = sandbox()
  const big = Buffer.concat([JPEG, Buffer.alloc(C.MAX_BYTES, 1)])
  assert.notEqual(fetch(sb, big).status, 0)
  assert.equal(fs.existsSync(C.cachePath(sb.dir, URL)), false)
  assert.deepEqual(leftovers(sb), [])
})

test("something that is not an image is dropped", () => {
  const sb = sandbox()
  assert.notEqual(fetch(sb, Buffer.from("<html>not a cover</html>")).status, 0)
  assert.equal(fs.existsSync(C.cachePath(sb.dir, URL)), false)
  assert.deepEqual(leftovers(sb), [])
})

test("a failed download leaves nothing behind", () => {
  const sb = sandbox()
  assert.notEqual(fetch(sb, JPEG, { STUB_RC: "22" }).status, 0)
  assert.equal(fs.existsSync(C.cachePath(sb.dir, URL)), false)
  assert.deepEqual(leftovers(sb), [])
})

test("a cached cover is not fetched again", () => {
  const sb = sandbox()
  assert.equal(fetch(sb, JPEG).status, 0)
  assert.equal(fetch(sb, JPEG, { STUB_RC: "22" }).status, 0, "cache hit must not run curl")
})

test("a symlinked cache directory is refused", () => {
  const sb = sandbox()
  const elsewhere = path.join(sb.root, "elsewhere")
  fs.mkdirSync(elsewhere)
  fs.symlinkSync(elsewhere, sb.dir)
  assert.notEqual(fetch(sb, JPEG).status, 0)
  assert.deepEqual(fs.readdirSync(elsewhere), [])
})

test("a bad cache name on stdin is refused", () => {
  const sb = sandbox()
  const argv = C.fetchArgs(sb.dir)
  const r = spawnSync(argv[0], argv.slice(1), { input: "../../x\nurl = \"" + URL + "\"\n", env: { PATH: sb.bin + ":/usr/bin:/bin" } })
  assert.notEqual(r.status, 0)
})
