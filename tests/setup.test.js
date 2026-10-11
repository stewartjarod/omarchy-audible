// Tests for SetupModel.js. Run: node --test tests/setup.test.js
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")

// SetupModel.js starts with `.pragma library` (QML only), which is a syntax
// error for node, so strip that line and evaluate with a CommonJS module object.
function loadModel(file) {
  const src = fs.readFileSync(file, "utf8").replace(/^\.pragma library\s*$/m, "")
  const mod = { exports: {} }
  new Function("module", "exports", src)(mod, mod.exports)
  return mod.exports
}

const ROOT = path.join(__dirname, "..")
const M = loadModel(path.join(ROOT, "SetupModel.js"))
const fx = (name) => fs.readFileSync(path.join(ROOT, "fixtures", name), "utf8")

const STATE_ORDER = ["no-audible", "no-player", "no-account", "locked", "unsynced", "ready"]

// Real-fixture-based probes. Each test tweaks one thing.
function accountsOk() { return M.parseAccountList(fx("account-list.json"), "") }
function accountsEmpty() { return M.parseAccountList(fx("account-list-empty.json"), fx("account-list-empty.err")) }
function libOk() { return M.parseLibraryProbe(fx("library-list.json"), "", 0) }
function libLocked() { return M.parseLibraryProbe(fx("locked-out.json"), fx("locked-err.txt"), 1) }
function libUnsynced() { return M.parseLibraryProbe(fx("unsynced-out.json"), "", 0) }

function probe(over = {}) {
  return Object.assign({
    audible: { found: true, version: fx("version.txt").trim() },
    mpv: { found: true },
    secretTool: { found: true },
    accounts: accountsOk(),
    library: libOk(),
    busy: "",
    login: { url: "", waiting: false }
  }, over)
}

const statuses = (r) => r.steps.map((s) => s.status)
const allText = (r) => [r.title, r.message, r.primary && r.primary.label, ...r.secondary.map((s) => s.label)].join(" | ")

// ---------------------------------------------------------------- detect()

test("fixtures give the expected baseline inputs", () => {
  const lib = JSON.parse(fx("library-list.json")).result.length
  assert.equal(libOk().count, lib)
  assert.equal(libUnsynced().count, 0)
  assert.equal(libLocked().locked, true)
  assert.equal(accountsEmpty().accounts.length, 0)
})

test("state no-audible: CLI missing -> install primary, first step current", () => {
  const r = M.detect(probe({ audible: { found: false, version: "" } }))
  assert.equal(r.state, "no-audible")
  assert.equal(r.ready, false)
  assert.equal(r.primary.id, "install-audible")
  assert.equal(r.primary.busy, undefined)
  assert.deepEqual(r.secondary, [])
  assert.deepEqual(statuses(r), ["current", "todo", "todo", "todo", "todo"])
  assert.match(r.message, /GitHub|checksum/)
})

test("state no-audible: installing shows busy primary with label", () => {
  const r = M.detect(probe({ audible: { found: false }, busy: "install-audible" }))
  assert.equal(r.primary.id, "install-audible")
  assert.equal(r.primary.busy, true)
  assert.equal(r.primary.label, "Installing...")
})

test("state no-player: mpv missing -> no primary, names omarchy pkg add mpv", () => {
  const r = M.detect(probe({ mpv: { found: false } }))
  assert.equal(r.state, "no-player")
  assert.equal(r.primary, null)
  assert.deepEqual(statuses(r), ["done", "current", "todo", "todo", "todo"])
  assert.match(r.message, /omarchy pkg add mpv/)
})

test("state no-account: empty account list -> primary login", () => {
  const r = M.detect(probe({ accounts: accountsEmpty(), library: { ok: false, count: 0, error: "", locked: false } }))
  assert.equal(r.state, "no-account")
  assert.equal(r.primary.id, "login")
  assert.equal(r.primary.label, "Sign in to Audible")
  assert.deepEqual(r.secondary, [])
  assert.deepEqual(statuses(r), ["done", "done", "current", "todo", "todo"])
})

test("state no-account while login waiting: no primary, cancel secondary, reassuring copy", () => {
  const r = M.detect(probe({ accounts: accountsEmpty(), login: { url: "http://127.0.0.1:39457/x/", waiting: true }, busy: "login" }))
  assert.equal(r.state, "no-account")
  assert.equal(r.primary, null)
  assert.deepEqual(r.secondary, [{ id: "cancel", label: "Cancel sign-in" }])
  assert.match(r.message, /browser/)
  assert.match(r.message, /checking your account/)
})

test("state no-account while login busy but not waiting: primary busy", () => {
  const r = M.detect(probe({ accounts: accountsEmpty(), busy: "login" }))
  assert.equal(r.primary.id, "login")
  assert.equal(r.primary.busy, true)
  assert.equal(r.primary.label, "Starting sign-in...")
})

test("state locked with secret-tool: store-password with password input, remove secondary", () => {
  const r = M.detect(probe({ library: libLocked() }))
  assert.equal(r.state, "locked")
  assert.equal(r.primary.id, "store-password")
  assert.equal(r.primary.input, "password")
  assert.deepEqual(r.secondary, [{ id: "remove-password", label: "Remove saved password" }])
  assert.deepEqual(statuses(r), ["done", "done", "done", "current", "todo"])
  assert.match(r.message, /keyring/)
  assert.doesNotMatch(r.message, /fail/i)
})

test("state locked: busy store-password shows Saving...", () => {
  const r = M.detect(probe({ library: libLocked(), busy: "store-password" }))
  assert.equal(r.primary.busy, true)
  assert.equal(r.primary.label, "Saving...")
  assert.equal(r.primary.input, "password")
})

test("state locked without secret-tool: remove-password primary only, libsecret named", () => {
  const r = M.detect(probe({ library: libLocked(), secretTool: { found: false } }))
  assert.equal(r.state, "locked")
  assert.equal(r.primary.id, "remove-password")
  assert.equal(r.primary.input, undefined)
  assert.deepEqual(r.secondary, [])
  assert.match(r.message, /libsecret/)
})

test("state locked via account list locked flag (not library)", () => {
  const acc = M.parseAccountList(fx("locked-out.json"), "")
  assert.equal(acc.locked, true)
  const r = M.detect(probe({ accounts: acc, library: { ok: false, count: 0, error: "x", locked: false } }))
  assert.equal(r.state, "locked")
})

test("state locked wins over an unsynced library result", () => {
  const r = M.detect(probe({ library: { ok: false, count: 0, error: "locked", locked: true } }))
  assert.equal(r.state, "locked")
})

test("state unsynced: empty library -> sync primary", () => {
  const r = M.detect(probe({ library: libUnsynced() }))
  assert.equal(r.state, "unsynced")
  assert.equal(r.primary.id, "sync")
  assert.equal(r.primary.label, "Sync library")
  assert.deepEqual(statuses(r), ["done", "done", "done", "done", "current"])
})

test("state unsynced: busy sync shows Syncing... and no error suffix", () => {
  const r = M.detect(probe({ library: { ok: false, count: 0, error: "timeout", locked: false }, busy: "sync" }))
  assert.equal(r.primary.busy, true)
  assert.equal(r.primary.label, "Syncing...")
  assert.doesNotMatch(r.message, /timeout/)
})

test("state unsynced: library error (not locked) is shown plainly", () => {
  const lib = M.parseLibraryProbe("", "network unreachable\n", 1)
  assert.equal(lib.ok, false)
  assert.equal(lib.locked, false)
  const r = M.detect(probe({ library: lib }))
  assert.equal(r.state, "unsynced")
  assert.match(r.message, /network unreachable/)
})

test("state ready: no primary, all steps done", () => {
  const r = M.detect(probe())
  assert.equal(r.state, "ready")
  assert.equal(r.ready, true)
  assert.equal(r.primary, null)
  assert.deepEqual(r.secondary, [])
  assert.deepEqual(statuses(r), ["done", "done", "done", "done", "done"])
})

test("priority: missing CLI beats everything else", () => {
  const r = M.detect(probe({ audible: { found: false }, mpv: { found: false }, library: libLocked(), accounts: accountsEmpty() }))
  assert.equal(r.state, "no-audible")
})

test("priority: missing mpv beats locked and no account", () => {
  const r = M.detect(probe({ mpv: { found: false }, library: libLocked() }))
  assert.equal(r.state, "no-player")
})

test("priority: no account beats unsynced", () => {
  const r = M.detect(probe({ accounts: accountsEmpty(), library: libUnsynced() }))
  assert.equal(r.state, "no-account")
})

test("priority: locked beats no account", () => {
  const r = M.detect(probe({ accounts: accountsEmpty(), library: libLocked() }))
  assert.equal(r.state, "locked")
})

test("robust to empty or missing probe fields without throwing", () => {
  assert.equal(M.detect().state, "no-audible")
  assert.equal(M.detect(null).state, "no-audible")
  assert.equal(M.detect({}).state, "no-audible")
  const r = M.detect({ audible: { found: true }, mpv: { found: true } })
  assert.equal(r.state, "no-account")
  assert.equal(M.detect({ audible: { found: true }, mpv: { found: true }, accounts: { ok: true, accounts: [{ name: "x" }] } }).state, "unsynced")
})

test("every state returns the full result shape with a fixed step order", () => {
  const probes = [
    probe({ audible: { found: false } }),
    probe({ mpv: { found: false } }),
    probe({ accounts: accountsEmpty() }),
    probe({ library: libLocked() }),
    probe({ library: libUnsynced() }),
    probe(),
  ]
  const expectedStates = STATE_ORDER
  probes.forEach((p, i) => {
    const r = M.detect(p)
    assert.equal(r.state, expectedStates[i])
    assert.deepEqual(Object.keys(r).sort(), ["message", "notice", "primary", "ready", "secondary", "state", "steps", "title"])
    assert.deepEqual(r.steps.map((s) => s.id), ["audible", "player", "account", "password", "library"])
    assert.deepEqual(r.steps.map((s) => s.label), ["Audible CLI", "Audio player (mpv)", "Sign in to Audible", "Unlock the saved login", "Sync your library"])
    const cur = r.steps.filter((s) => s.status === "current").length
    assert.equal(cur, r.ready ? 0 : 1, `exactly one current step for ${r.state}`)
    // done steps come before the current one, todo after
    const order = r.steps.map((s) => s.status)
    const rank = { done: 0, current: 1, todo: 2 }
    for (let k = 1; k < order.length; k++) assert.ok(rank[order[k]] >= rank[order[k - 1]], `monotonic statuses for ${r.state}`)
    assert.ok(r.title.length > 0 && r.message.length > 0)
    assert.ok(r.message.length < 400, "message stays short")
  })
})

test("copy never suggests audible setup, mentions the resident agent, or calls the login failed", () => {
  const probes = [
    probe({ audible: { found: false } }), probe({ mpv: { found: false } }),
    probe({ accounts: accountsEmpty() }), probe({ accounts: accountsEmpty(), login: { url: "", waiting: true } }),
    probe({ library: libLocked() }), probe({ library: libLocked(), secretTool: { found: false } }),
    probe({ library: libUnsynced() }), probe(),
  ]
  for (const p of probes) {
    const text = allText(M.detect(p))
    assert.doesNotMatch(text, /audible setup/)
    assert.doesNotMatch(text, /agent/i)
    assert.doesNotMatch(text, /failed/i)
  }
})

test("primary action ids are always from the contract set", () => {
  const ids = new Set()
  const probes = [
    probe({ audible: { found: false } }), probe({ accounts: accountsEmpty() }), probe({ accounts: accountsEmpty(), login: { url: "", waiting: true } }),
    probe({ library: libLocked() }), probe({ library: libLocked(), secretTool: { found: false } }), probe({ library: libUnsynced() }), probe(),
  ]
  for (const p of probes) {
    const r = M.detect(p)
    if (r.primary) ids.add(r.primary.id)
    r.secondary.forEach((s) => ids.add(s.id))
  }
  assert.deepEqual([...ids].sort(), ["cancel", "install-audible", "login", "remove-password", "store-password", "sync"])
})

// ------------------------------------------------------- parseAccountList

test("parseAccountList: real account list fixture", () => {
  const r = M.parseAccountList(fx("account-list.json"), "")
  assert.equal(r.ok, true)
  assert.equal(r.locked, false)
  assert.equal(r.error, "")
  assert.deepEqual(r.accounts, [{
    name: "example", authFile: "encrypted", passwordSource: "command",
    marketplaces: "us", defaultMp: "us", isDefault: true
  }])
})

test("parseAccountList: empty result is ok with no accounts, both via json and the stderr hint", () => {
  const a = M.parseAccountList(fx("account-list-empty.json"), "")
  assert.equal(a.ok, true)
  assert.deepEqual(a.accounts, [])
  const b = M.parseAccountList("", fx("account-list-empty.err"))
  assert.equal(b.ok, true)
  assert.deepEqual(b.accounts, [])
})

test("parseAccountList: locked error envelope is detected", () => {
  const r = M.parseAccountList(fx("locked-out.json"), "")
  assert.equal(r.ok, false)
  assert.equal(r.locked, true)
  assert.match(r.error, /is locked/)
  assert.deepEqual(r.accounts, [])
})

test("parseAccountList: locked text on stderr with no stdout is detected", () => {
  const r = M.parseAccountList("", fx("locked-err.txt"))
  assert.equal(r.locked, true)
  assert.equal(r.ok, false)
})

test("parseAccountList: non-locked error envelope is not locked", () => {
  const r = M.parseAccountList('{"error":{"message":"config broken"},"result":null}', "")
  assert.equal(r.ok, false)
  assert.equal(r.locked, false)
  assert.equal(r.error, "config broken")
})

test("parseAccountList: malformed and empty input never throw", () => {
  const inputs = [["", ""], ["not json", ""], ["{", "boom"], [undefined, undefined], [null, null], ["null", ""], ["[]", ""], ["123", ""]]
  for (const [o, e] of inputs) {
    const r = M.parseAccountList(o, e)
    assert.equal(typeof r.ok, "boolean")
    assert.ok(Array.isArray(r.accounts))
    assert.equal(r.ok, false, `ok false for ${JSON.stringify([o, e])}`)
  }
})

test("parseAccountList: result that is not an array is an error; bad items are skipped", () => {
  assert.equal(M.parseAccountList('{"error":null,"result":{"x":1}}', "").ok, false)
  const r = M.parseAccountList('{"error":null,"result":[null,"x",{"name":""},{"name":"b","default":"*"}]}', "")
  assert.equal(r.ok, true)
  assert.deepEqual(r.accounts.map((a) => a.name), ["b"])
  assert.equal(r.accounts[0].isDefault, true)
})

// ------------------------------------------------------- parseLibraryProbe

test("parseLibraryProbe: library list fixture counts books", () => {
  const n = JSON.parse(fx("library-list.json")).result.length
  assert.deepEqual(M.parseLibraryProbe(fx("library-list.json"), "", 0), { ok: true, count: n, error: "", locked: false })
})

test("parseLibraryProbe: synced-never fixture is ok with zero books", () => {
  assert.deepEqual(M.parseLibraryProbe(fx("unsynced-out.json"), "", 0), { ok: true, count: 0, error: "", locked: false })
})

test("parseLibraryProbe: locked fixture (exit 1) is locked", () => {
  const r = M.parseLibraryProbe(fx("locked-out.json"), fx("locked-err.txt"), 1)
  assert.equal(r.ok, false)
  assert.equal(r.locked, true)
  assert.equal(r.count, 0)
})

test("parseLibraryProbe: locked text only on stderr is locked", () => {
  assert.equal(M.parseLibraryProbe("", fx("locked-err.txt"), 1).locked, true)
})

test("parseLibraryProbe: nonzero exit with valid JSON is not ok", () => {
  const r = M.parseLibraryProbe(fx("library-list.json"), "something went wrong", 2)
  assert.equal(r.ok, false)
  assert.equal(r.locked, false)
  assert.equal(r.error, "something went wrong")
})

test("parseLibraryProbe: garbage, empty and missing input never throw", () => {
  const cases = [["", "", 1], ["oops", "", 1], [undefined, undefined, undefined], [null, null, null], ["", "net down", 1], ["[]", "", 0], ["{}", "", 0]]
  for (const [o, e, c] of cases) {
    const r = M.parseLibraryProbe(o, e, c)
    assert.equal(typeof r.ok, "boolean")
    assert.equal(typeof r.count, "number")
    assert.equal(r.ok, false, `not ok for ${JSON.stringify([o, e, c])}`)
  }
  assert.equal(M.parseLibraryProbe("", "net down", 1).error, "net down")
})

// --------------------------------------------------------- parseLoginUrl

test("parseLoginUrl: extracts the URL from the real sign-in server output", () => {
  const out = fx("login-server-output.txt")
  const line = out.split("\n").find((l) => l.includes("http://"))
  assert.equal(M.parseLoginUrl(line), "http://127.0.0.1:39457/0123456789abcdef0123456789abcdef/")
  assert.equal(M.parseLoginUrl(out), "http://127.0.0.1:39457/0123456789abcdef0123456789abcdef/")
})

test("parseLoginUrl: adds a trailing slash when missing and rejects other lines", () => {
  assert.equal(M.parseLoginUrl("  http://127.0.0.1:1234/tok"), "http://127.0.0.1:1234/tok/")
  assert.equal(M.parseLoginUrl("ssh -L 39457:localhost:39457 <user>@<this-host>"), null)
  assert.equal(M.parseLoginUrl("Waiting up to 900s for the sign-in to complete"), null)
  assert.equal(M.parseLoginUrl("https://example.com/abc/"), null)
  assert.equal(M.parseLoginUrl("http://127.0.0.1:99999/abc/"), null)
  assert.equal(M.parseLoginUrl(null), null)
  assert.equal(M.parseLoginUrl(undefined), null)
  assert.equal(M.parseLoginUrl(""), null)
})

// ---------------------------------------------------------- password args

test("passwordSourceArgs: points audible at secret-tool for the account, no secret in args", () => {
  const args = M.passwordSourceArgs("example")
  assert.deepEqual(args, [
    "account", "password", "source", "command",
    "-a", "example",
    "--command", "secret-tool lookup service audible-rs account example"
  ])
})

test("keyringStoreArgs: secret-tool store for the account, password never in args", () => {
  const args = M.keyringStoreArgs("example")
  assert.deepEqual(args, ["store", "--label=audible-rs example", "service", "audible-rs", "account", "example"])
  assert.ok(args.every((a) => typeof a === "string"))
})

test("account names are validated: bad names throw instead of building a shell command", () => {
  for (const bad of ["", "a b", "x;rm -rf", "$(id)", undefined, null, 42, "a".repeat(65)]) {
    assert.throws(() => M.passwordSourceArgs(bad), /invalid account name/)
    assert.throws(() => M.keyringStoreArgs(bad), /invalid account name/)
  }
  assert.doesNotThrow(() => M.keyringStoreArgs("me@example.com"))
})

// ------------------------------------------------------------- installPlan

test("installPlan: pinned release for x86_64", () => {
  const p = M.installPlan("v0.1.0-alpha.8", "x86_64")
  const asset = "audible-0.1.0-alpha.8-x86_64-unknown-linux-musl.tar.gz"
  assert.deepEqual(p, {
    asset,
    url: "https://github.com/mkb79/audible-rs/releases/download/v0.1.0-alpha.8/" + asset,
    sumsUrl: "https://github.com/mkb79/audible-rs/releases/download/v0.1.0-alpha.8/SHA256SUMS",
    binDir: "~/.local/bin"
  })
  assert.equal(M.PINNED_TAG, "v0.1.0-alpha.8")
})

test("installPlan: tag defaults to the pinned release; other arch or tag return an error", () => {
  assert.equal(M.installPlan(undefined, "x86_64").asset, M.installPlan("v0.1.0-alpha.8", "x86_64").asset)
  assert.match(M.installPlan("v0.1.0-alpha.8", "aarch64").error, /x86_64/)
  assert.match(M.installPlan("v0.1.0-alpha.8", undefined).error, /x86_64/)
  assert.match(M.installPlan("v9.9.9", "x86_64").error, /pinned/)
})

// -------------------------------------------------------------- verifySums

test("verifySums: accepts the real sha256 of the asset and rejects anything else", () => {
  const asset = M.installPlan("v0.1.0-alpha.8", "x86_64").asset
  const tarball = Buffer.from("pretend this is a tarball")
  const hex = crypto.createHash("sha256").update(tarball).digest("hex")
  const other = crypto.createHash("sha256").update("other").digest("hex")
  const sums = [
    `${other}  audible-0.1.0-alpha.8-aarch64-unknown-linux-musl.tar.gz`,
    `${hex}  ${asset}`,
    ""
  ].join("\n")

  assert.equal(M.verifySums(sums, asset, hex), true)
  assert.equal(M.verifySums(sums, asset, hex.toUpperCase()), true)
  assert.equal(M.verifySums(sums, asset, other), false)
  assert.equal(M.verifySums(sums, "missing.tar.gz", hex), false)
  assert.equal(M.verifySums(sums, asset, "not-a-hash"), false)
  assert.equal(M.verifySums("", asset, hex), false)
  assert.equal(M.verifySums(undefined, asset, hex), false)
})

test("verifySums: binary-mode '*' prefix and ./ paths are accepted; conflicting duplicates fail", () => {
  const asset = "a.tar.gz"
  const hex = crypto.createHash("sha256").update("x").digest("hex")
  const other = crypto.createHash("sha256").update("y").digest("hex")
  assert.equal(M.verifySums(`${hex} *${asset}\n`, asset, hex), true)
  assert.equal(M.verifySums(`${hex}  ./${asset}\r\n`, asset, hex), true)
  assert.equal(M.verifySums(`${hex}  ${asset}\n${other}  ${asset}\n`, asset, hex), false)
})

test("module exports the contract functions", () => {
  for (const name of ["detect", "parseAccountList", "parseLibraryProbe", "parseLoginUrl", "passwordSourceArgs", "keyringStoreArgs", "installPlan", "verifySums"]) {
    assert.equal(typeof M[name], "function", name)
  }
})

// ------------------------------------------- no account (captured on a clean HOME, audible-rs alpha.8)

const noAccountCodes = JSON.parse(fx("no-account-exit-codes.json"))
const noAccountAccounts = () => M.parseAccountList(fx("no-account-list.json"), fx("no-account-list.err"))
const noAccountLibrary = () => M.parseLibraryProbe(fx("no-account-library.json"), fx("no-account-library.err"), noAccountCodes.libraryList)

test("no account: account list is ok with zero accounts (not locked, not an error)", () => {
  assert.equal(noAccountCodes.accountList, 0)
  const r = noAccountAccounts()
  assert.equal(r.ok, true)
  assert.deepEqual(r.accounts, [])
  assert.equal(r.locked, false)
  assert.equal(r.error, "")
})

test("no account: library list exits 1 with an error envelope that is NOT the locked signal", () => {
  assert.equal(noAccountCodes.libraryList, 1)
  const r = noAccountLibrary()
  assert.equal(r.ok, false)
  assert.equal(r.count, 0)
  assert.equal(r.locked, false)
  assert.match(r.error, /^no account configured: register one with `audible account login`/)
})

test("no account: library sync stderr (no JSON on stdout) is a plain error, not locked", () => {
  assert.equal(noAccountCodes.librarySync, 1)
  assert.equal(fx("no-account-sync.out"), "")
  const r = M.parseLibraryProbe(fx("no-account-sync.out"), fx("no-account-sync.err"), noAccountCodes.librarySync)
  assert.equal(r.ok, false)
  assert.equal(r.locked, false)
  assert.equal(r.error, "Error: no account configured: register one with `audible account login` (or import with `audible account import`)")
})

test("no account: detect() sends a clean install to the sign-in step, not to locked or unsynced", () => {
  const r = M.detect(probe({ accounts: noAccountAccounts(), library: noAccountLibrary() }))
  assert.equal(r.state, "no-account")
  assert.equal(r.primary.id, "login")
  assert.equal(r.primary.label, "Sign in to Audible")
  assert.deepEqual(statuses(r), ["done", "done", "current", "todo", "todo"])
  assert.doesNotMatch(allText(r), /locked|failed|error/i)
})

// -------------------------------------------------------- versionNotice()

test("versionNotice: null when the installed CLI is the pinned release", () => {
  assert.equal(M.versionNotice("audible 0.1.0-alpha.8", "v0.1.0-alpha.8"), null)
  assert.equal(M.versionNotice(fx("version.txt"), M.PINNED_TAG), null)
})

test("versionNotice: a plain sentence naming both versions when they differ", () => {
  assert.equal(
    M.versionNotice("audible 0.1.0-alpha.7", "v0.1.0-alpha.8"),
    "Built and tested with audible-rs 0.1.0-alpha.8; you have 0.1.0-alpha.7, which may behave differently."
  )
  assert.equal(
    M.versionNotice("audible 0.2.0", "v0.1.0-alpha.8"),
    "Built and tested with audible-rs 0.1.0-alpha.8; you have 0.2.0, which may behave differently."
  )
})

test("versionNotice: null when there is no installed version or no pin (nothing to compare)", () => {
  assert.equal(M.versionNotice("", "v0.1.0-alpha.8"), null)
  assert.equal(M.versionNotice(undefined, "v0.1.0-alpha.8"), null)
  assert.equal(M.versionNotice("audible 0.1.0-alpha.7", ""), null)
  assert.equal(M.versionNotice("audible 0.1.0-alpha.7", undefined), null)
})

test("versionNotice: unreadable version text still warns, without echoing arbitrary output", () => {
  const s = M.versionNotice("something odd\nsecond line", "v0.1.0-alpha.8")
  assert.equal(s, "Built and tested with audible-rs 0.1.0-alpha.8; you have a version we could not read, which may behave differently.")
  assert.doesNotMatch(s, /odd|second/)
})

test("versionNotice: the pin may be given with or without the leading v", () => {
  assert.equal(M.versionNotice("audible 0.1.0-alpha.8", "0.1.0-alpha.8"), null)
  assert.match(M.versionNotice("audible 0.1.0-alpha.7", "0.1.0-alpha.8"), /^Built and tested with audible-rs 0\.1\.0-alpha\.8;/)
})

test("detect: passes the version notice through when the probe carries the pin", () => {
  const off = M.detect(probe({ audible: { found: true, version: "audible 0.1.0-alpha.7" }, pinned: "v0.1.0-alpha.8" }))
  assert.equal(off.notice, "Built and tested with audible-rs 0.1.0-alpha.8; you have 0.1.0-alpha.7, which may behave differently.")
  const on = M.detect(probe({ pinned: "v0.1.0-alpha.8" }))
  assert.equal(on.notice, null)
  const noPin = M.detect(probe({ audible: { found: true, version: "audible 0.1.0-alpha.7" } }))
  assert.equal(noPin.notice, null)
  assert.equal(M.detect(probe({ audible: { found: false, version: "" }, pinned: "v0.1.0-alpha.8" })).notice, null)
})

test("signOutArgs removes the account and its auth file, never deregisters the device", () => {
  assert.deepEqual(M.signOutArgs("jarod"), ["account", "remove", "jarod", "--yes", "--delete-auth-file"])
  assert.throws(() => M.signOutArgs("x; rm -rf ~"))
  assert.ok(!M.signOutArgs("jarod").includes("logout"))
})
