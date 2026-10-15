"use strict"
// ProcessModel.wrap run for real: fixed PATH, exit status, stdin, output ceilings, the deadline, and
// a signal to the wrapper stopping the whole command.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const path = require("path")
const { spawnSync, spawn } = require("child_process")

const src = fs.readFileSync(path.join(__dirname, "..", "ProcessModel.js"), "utf8").replace(/^\.pragma library\s*$/m, "")
const mod = { exports: {} }
new Function("module", "exports", src)(mod, mod.exports)
const P = mod.exports

function run(argv, deadline, input) {
  const a = P.wrap(argv, deadline)
  const r = spawnSync(a[0], a.slice(1), { input, encoding: "utf8", maxBuffer: 1 << 30, env: { HOME: "/nonexistent", PATH: "/evil" } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test("exit status, stdout, stderr and stdin pass through; PATH is fixed, not inherited", () => {
  assert.deepEqual(run(["sh", "-c", "echo out; echo err >&2; exit 3"]), { code: 3, out: "out\n", err: "err\n" })
  assert.equal(run(["cat"], 5, "hello").out, "hello")
  assert.equal(run(["sh", "-c", "printf %s \"$PATH\""]).out, "/usr/local/bin:/usr/bin:/bin:/nonexistent/.local/bin")
  assert.equal(run(["sh", "-c", "printf '%s|' \"$@\"", "sh", "a b", "$(x)", "--"]).out, "a b|$(x)|--|")
})

test("output over the ceiling stops the command and fails instead of growing without bound", () => {
  const r = run(["sh", "-c", `head -c ${P.STDOUT_MAX + 1000} /dev/zero`])
  assert.equal(r.out.length, P.STDOUT_MAX)
  assert.notEqual(r.code, 0)
  assert.equal(run(["sh", "-c", `head -c ${P.STDOUT_MAX + 1} /dev/zero`]).code, 141)   // one byte over
  const exact = run(["sh", "-c", `head -c ${P.STDOUT_MAX} /dev/zero`])
  assert.equal(exact.code, 0)
  assert.equal(exact.out.length, P.STDOUT_MAX)
  const e = run(["sh", "-c", `head -c ${P.STDERR_MAX * 3} /dev/zero >&2`])
  assert.equal(e.err.length, P.STDERR_MAX)
})

test("the deadline stops a stuck command with exit 124", () => {
  const t = Date.now()
  assert.equal(run(["sleep", "30"], 1).code, 124)
  assert.ok(Date.now() - t < 10000)
  assert.equal(P.deadlineOf(undefined), P.DEFAULT_DEADLINE_SEC)
  assert.equal(P.deadlineOf(0), P.DEFAULT_DEADLINE_SEC)
  assert.equal(P.deadlineOf(960), 960)
})

test("a signal to the wrapper (cancelling the sign-in) stops the whole command", async () => {
  const marker = "process-test-" + process.pid
  const a = P.wrap(["sh", "-c", "sleep 37 & wait", marker], 100)
  const child = spawn(a[0], a.slice(1), { stdio: "ignore" })
  await new Promise((r) => setTimeout(r, 400))
  child.kill("SIGTERM")
  await new Promise((r) => child.on("exit", r))
  await new Promise((r) => setTimeout(r, 300))
  const left = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.trim()
  assert.equal(left, "")
})

test("detached commands get the same fixed PATH", () => {
  const a = P.detached(["sh", "-c", "printf %s \"$PATH\""])
  const r = spawnSync(a[0], a.slice(1), { encoding: "utf8", env: { HOME: "/h", PATH: "/evil" } })
  assert.equal(r.stdout, "/usr/local/bin:/usr/bin:/bin:/h/.local/bin")
})
