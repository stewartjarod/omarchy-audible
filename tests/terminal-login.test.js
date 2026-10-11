"use strict"
// The terminal sign-in script (SetupModel.terminalLoginArgs) is run for real here against stand-in
// `audible` and `secret-tool` programs, so the order of calls and what goes where is checked.
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

test("accountNameFor cleans the login name and has a fallback", () => {
  assert.equal(M.accountNameFor("jarod"), "jarod")
  assert.equal(M.accountNameFor("a b/c;d"), "abcd")
  assert.equal(M.accountNameFor(""), "audible")
  assert.equal(M.accountNameFor(null), "audible")
  assert.equal(M.accountNameFor("x".repeat(100)).length, 64)
})

test("terminalLoginArgs: positional name and marketplace, nothing interpolated into the script", () => {
  const a = M.terminalLoginArgs("jarod", "us")
  assert.deepEqual(a.slice(0, 2), ["sh", "-c"])
  assert.deepEqual(a.slice(3), ["sh", "jarod", "us"])
  assert.ok(!a[2].includes("jarod"))
  assert.throws(() => M.terminalLoginArgs("bad name; rm", "us"))
  assert.throws(() => M.terminalLoginArgs("jarod", "us; rm"))
})

function runScript({ haveSecretTool, loginFails, setFails }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-"))
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin)
  const log = path.join(dir, "calls.log")
  const store = path.join(dir, "stored.txt")
  const audible = `#!/bin/sh
echo "audible $*" >> "${log}"
if [ "$1 $2" = "account login" ]; then ${loginFails ? "exit 1" : "exit 0"}; fi
if [ "$1 $2 $3" = "account password set" ]; then
  echo "env-pw-len=\${#AUDIBLE_NEW_AUTH_PASSWORD}" >> "${log}"
  ${setFails ? "exit 1" : "exit 0"}
fi
exit 0
`
  fs.writeFileSync(path.join(bin, "audible"), audible, { mode: 0o755 })
  if (haveSecretTool) {
    fs.writeFileSync(path.join(bin, "secret-tool"), `#!/bin/sh
echo "secret-tool $*" >> "${log}"
if [ "$1" = "store" ]; then cat > "${store}"; fi
exit 0
`, { mode: 0o755 })
  }
  const args = M.terminalLoginArgs("tester", "us")
  // PATH holds only the stand-ins plus the basic tools the script itself uses; HOME is the temp dir
  // so the script's own PATH addition (~/.local/bin) finds nothing real.
  const tools = path.join(dir, "tools")
  fs.mkdirSync(tools)
  for (const t of ["sh", "head", "base64", "tr", "read", "printf", "echo", "cat"]) {
    const w = spawnSync("sh", ["-c", `command -v ${t}`]).stdout.toString().trim()
    if (w.startsWith("/")) fs.symlinkSync(w, path.join(tools, t))
  }
  const r = spawnSync(args[0], args.slice(1), {
    input: "\n",
    env: { PATH: `${bin}:${tools}`, HOME: dir },
    encoding: "utf8"
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []
  const stored = fs.existsSync(store) ? fs.readFileSync(store, "utf8") : null
  fs.rmSync(dir, { recursive: true, force: true })
  return { r, calls, stored }
}

test("terminal script: sign in plain, encrypt with an env password, keyring, point Audible at it", () => {
  const { r, calls, stored } = runScript({ haveSecretTool: true })
  assert.equal(r.status, 0, r.stderr)
  assert.match(calls[0], /^audible account login --external --plain -m us --name tester$/)
  assert.match(calls[1], /^audible account password set -a tester$/)
  assert.ok(Number(calls[2].split("=")[1]) >= 20, calls[2])   // a long generated password reached the CLI by environment
  assert.match(calls[3], /^secret-tool store --label=audible-rs tester service audible-rs account tester$/)
  assert.match(calls[4], /^audible account password source command -a tester --command secret-tool lookup service audible-rs account tester$/)
  assert.ok(stored && stored.length >= 20, "the generated password is what the keyring received on stdin")
  assert.ok(!calls.join("\n").includes(stored), "the password never appears in any command line")
  assert.match(r.stdout, /protected by your keyring/)
})

test("terminal script: no keyring tool leaves the login file as is and says so", () => {
  const { r, calls } = runScript({ haveSecretTool: false })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(calls.length, 1)
  assert.match(r.stdout, /no keyring tool/)
})

test("terminal script: a sign-in that does not finish stops with a clear line", () => {
  const { r, calls } = runScript({ haveSecretTool: true, loginFails: true })
  assert.equal(r.status, 1)
  assert.equal(calls.length, 1)
  assert.match(r.stdout, /did not finish/)
})

test("terminal script: if protecting the file fails the keyring is not touched and the popup is pointed at", () => {
  const { r, calls } = runScript({ haveSecretTool: true, setFails: true })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!calls.some((c) => c.startsWith("secret-tool")))
  assert.match(r.stdout, /could not protect/)
})
