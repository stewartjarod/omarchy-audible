"use strict"
// The terminal unlock script (SetupModel.terminalUnlockArgs) is run for real here against stand-in
// `audible`, `secret-tool` and `stty` programs, so the order of calls and where the password goes are
// checked: it reaches the keyring on stdin and is never on a command line.
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

test("terminalUnlockArgs: positional account name, nothing interpolated into the script", () => {
  const a = M.terminalUnlockArgs("jarod")
  assert.deepEqual(a.slice(0, 2), ["sh", "-c"])
  assert.deepEqual(a.slice(3), ["sh", "jarod"])
  assert.ok(!a[2].includes("jarod"))
  assert.throws(() => M.terminalUnlockArgs("bad name; rm"))
  assert.throws(() => M.terminalUnlockArgs(""))
})

function runScript({ typed, storeFails }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tu-"))
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin)
  const log = path.join(dir, "calls.log")
  const store = path.join(dir, "stored.txt")
  fs.writeFileSync(path.join(bin, "audible"), `#!/bin/sh
echo "audible $*" >> "${log}"
exit 0
`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, "secret-tool"), `#!/bin/sh
echo "secret-tool $*" >> "${log}"
if [ "$1" = "store" ]; then cat > "${store}"; fi
${storeFails ? "exit 1" : "exit 0"}
`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, "stty"), `#!/bin/sh
echo "stty $*" >> "${log}"
exit 0
`, { mode: 0o755 })
  const tools = path.join(dir, "tools")
  fs.mkdirSync(tools)
  for (const t of ["sh", "cat"]) {
    const w = spawnSync("sh", ["-c", `command -v ${t}`]).stdout.toString().trim()
    if (w.startsWith("/")) fs.symlinkSync(w, path.join(tools, t))
  }
  const args = M.terminalUnlockArgs("tester")
  // The script pins PATH to the system directories (then ~/.local/bin). Here only the stand-ins may
  // run, so that one line is swapped for the test's PATH; the rest of the script runs unchanged.
  const SAFE = 'PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"; export PATH'
  assert.equal(args[2].split("\n")[0], SAFE)
  args[2] = args[2].replace(SAFE, `PATH="${bin}:${path.join(dir, "tools")}"; export PATH`)
  const r = spawnSync(args[0], args.slice(1), {
    input: typed + "\n\n",   // the password line, then Enter to close
    env: { PATH: `${bin}:${tools}`, HOME: dir },
    encoding: "utf8"
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []
  const stored = fs.existsSync(store) ? fs.readFileSync(store, "utf8") : null
  fs.rmSync(dir, { recursive: true, force: true })
  return { r, calls, stored }
}

test("unlock script: echo off while typing, keyring on stdin, then Audible pointed at it", () => {
  const pw = "correct horse $battery `staple`"
  const { r, calls, stored } = runScript({ typed: pw })
  assert.equal(r.status, 0, r.stderr)
  const nonStty = calls.filter((c) => !c.startsWith("stty"))
  assert.equal(calls[0], "stty -echo")
  assert.ok(calls.indexOf("stty echo") > 0 && calls.indexOf("stty echo") < calls.indexOf(nonStty[0]), "echo is back on before anything runs")
  assert.match(nonStty[0], /^secret-tool store --label=audible-rs tester service audible-rs account tester$/)
  assert.match(nonStty[1], /^audible account password source command -a tester --command secret-tool lookup service audible-rs account tester$/)
  assert.equal(stored, pw, "the typed password, unchanged, is what the keyring received on stdin")
  assert.ok(!calls.join("\n").includes("horse"), "the password never appears in any command line")
  assert.ok(!r.stdout.includes("horse"), "the password is not printed")
  assert.match(r.stdout, /Saved/)
})

test("unlock script: nothing typed saves nothing", () => {
  const { r, calls } = runScript({ typed: "" })
  assert.equal(r.status, 1)
  assert.ok(!calls.some((c) => c.startsWith("secret-tool") || c.startsWith("audible")))
  assert.match(r.stdout, /nothing was saved/)
})

test("unlock script: a keyring that refuses leaves Audible untouched and says so", () => {
  const { r, calls } = runScript({ typed: "pw", storeFails: true })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!calls.some((c) => c.startsWith("audible")))
  assert.match(r.stdout, /Could not save/)
})
