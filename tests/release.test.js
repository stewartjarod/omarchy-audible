"use strict"
// Version hygiene: one valid SemVer in manifest.json that matches the changelog, and the
// Conventional Commits hook (.githooks/commit-msg) accepts and rejects the right first lines.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawnSync } = require("child_process")

const ROOT = path.join(__dirname, "..")
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

test("manifest.json has a valid SemVer version", () => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"))
  assert.match(man.version, SEMVER)
})

test("the newest released section of CHANGELOG.md is the manifest version", () => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"))
  const log = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")
  const heads = [...log.matchAll(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?$/gm)]
  assert.ok(heads.length >= 2, "an Unreleased section and at least one release")
  assert.equal(heads[0][1], "Unreleased", "Unreleased comes first")
  const released = heads.filter((h) => h[1] !== "Unreleased")
  assert.equal(released[0][1], man.version)
  for (const h of released) {
    assert.match(h[1], SEMVER)
    assert.ok(h[2], "release " + h[1] + " has a date")
  }
  // newest first, strictly descending
  const key = (v) => v.split(/[-+]/)[0].split(".").map(Number)
  for (let i = 1; i < released.length; i++) {
    const a = key(released[i - 1][1]), b = key(released[i][1])
    assert.ok(a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2]))), "versions descend")
  }
  // every release has a link reference at the bottom
  for (const h of released) assert.ok(log.includes("[" + h[1] + "]: https://"), "link for " + h[1])
})

function hook(line) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cm-")), "MSG")
  fs.writeFileSync(f, line + "\n\nbody\n")
  const r = spawnSync("sh", [path.join(ROOT, ".githooks", "commit-msg"), f], { encoding: "utf8" })
  fs.rmSync(path.dirname(f), { recursive: true, force: true })
  return r
}

test("commit-msg hook accepts Conventional Commits", () => {
  for (const ok of [
    "feat: save your position to Audible",
    "fix(setup): find the book after the first download",
    "feat(sync)!: rename the position setting",
    "chore(release): 0.2.0",
    "docs: add a changelog",
    "Merge branch 'x'",
    'Revert "feat: x"'
  ]) assert.equal(hook(ok).status, 0, ok)
})

test("commit-msg hook rejects anything else, with a hint", () => {
  for (const bad of [
    "Add a changelog",
    "feat:no space",
    "feat: ",
    "Feature: x",
    "fix(Setup): uppercase scope",
    "fix (setup): space before the scope",
    "wip",
    ""
  ]) {
    const r = hook(bad)
    assert.equal(r.status, 1, JSON.stringify(bad))
    assert.match(r.stderr, /Conventional Commits/)
  }
})
