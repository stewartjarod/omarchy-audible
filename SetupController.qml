import QtQuick
import Quickshell
import Quickshell.Io
import "SetupModel.js" as Setup

// First-run setup: probes the machine (audible CLI, mpv, account, library), turns that into the
// onboarding state (SetupModel.detect), and runs the setup actions (install, sign in, save the
// password, sync). Split out of Service.qml; Service re-exports the properties surfaces read.
Item {
  id: ctl

  property var svc: null   // the Service: run(), setupLog, pinnedTag, refreshLibrary(), scanLocal()

  property var setup: ({ ready: false, state: "checking", title: "Checking your setup...", message: "", primary: null, secondary: [], steps: [] })
  readonly property bool ready: setup && setup.ready === true
  property string setupBusyId: ""
  property string loginUrl: ""
  property bool loginWaiting: false
  property var lastProbe: null
  property var loginProc: null
  property string loginPassword: ""   // the generated login-file password; in memory only until the keyring has it
  property bool loginSeen: false      // the account showed up; waiting for the sign-in command to finish
  property bool previewing: false

  function emptyProbe() {
    return {
      audible: { found: false, version: "" }, mpv: { found: false }, secretTool: { found: false },
      accounts: Setup.parseAccountList("", ""), library: Setup.parseLibraryProbe("", "", 127),
      pinned: svc.pinnedTag, // HOOK(ship): lets SetupModel.detect flag a non-pinned audible CLI (notice)
      busy: "", login: { url: "", waiting: false }
    }
  }

  function rerenderSetup() {
    if (!lastProbe) return
    var p = {}
    for (var k in lastProbe) p[k] = lastProbe[k]
    p.busy = setupBusyId
    p.login = { url: loginUrl, waiting: loginWaiting }
    var wasReady = ready
    setup = Setup.detect(p)
    if (ready && !wasReady) { svc.refreshLibrary(); svc.scanLocal() }
  }

  function recheck(then) {
    var probe = emptyProbe()
    svc.run(["sh", "-c", "for c in audible mpv secret-tool uwsm-app; do command -v \"$c\" >/dev/null 2>&1 && echo \"$c\"; done; true"], function(code, out) {
      var have = {}
      String(out).split("\n").forEach(function(l) { if (l) have[l.trim()] = true })
      probe.audible.found = have["audible"] === true
      probe.mpv.found = have["mpv"] === true
      svc.hasUwsm = have["uwsm-app"] === true
      probe.secretTool.found = have["secret-tool"] === true
      if (!probe.audible.found) { lastProbe = probe; rerenderSetup(); if (then) then(); return }
      var pending = 3
      var finish = function() { if (--pending === 0) { lastProbe = probe; rerenderSetup(); if (then) then() } }
      svc.run(["audible", "--version"], function(c, o) { probe.audible.version = String(o).trim(); finish() })
      svc.run(["audible", "account", "list", "-o", "json"], function(c, o, e) { probe.accounts = Setup.parseAccountList(o, e); finish() })
      svc.run(["audible", "library", "list", "-o", "json", "--limit", "1"], function(c, o, e) { probe.library = Setup.parseLibraryProbe(o, e, c); finish() })
    })
  }

  function busyWith(id, logLine) {
    setupBusyId = id
    svc.setupLog = logLine || ""
    rerenderSetup()
  }
  function doneBusy(logLine) {
    setupBusyId = ""
    svc.setupLog = logLine || ""
    recheck()
  }

  function argvFor(args, bin) {
    var a = (args || []).slice()
    return a.length > 0 && a[0] === bin ? a : [bin].concat(a)
  }

  function marketplaceGuess() {
    var lang = String(Quickshell.env("LANG") || "")
    var m = /_([A-Z]{2})/.exec(lang)
    var map = { US: "us", GB: "uk", CA: "ca", AU: "au", DE: "de", FR: "fr", ES: "es", IT: "it", JP: "jp", IN: "in", BR: "br" }
    return m && map[m[1]] ? map[m[1]] : "us"
  }

  // Show an onboarding state without touching anything (for screenshots/demos). Any action
  // while previewing just restores the real state, so a stray Enter cannot install or log in.
  function previewSetup(name) {
    if (!lastProbe) return
    var p = {}
    for (var k in lastProbe) p[k] = lastProbe[k]
    var none = '{"error":null,"result":[],"warnings":[]}'
    var locked = '{"error":{"message":"account \\"example\\" is locked (password_source = prompt) \u2014 unlock it with `audible account unlock -a example`"},"result":null,"warnings":[]}'
    p.busy = ""
    p.login = { url: "", waiting: false }
    var log = ""
    if (name === "no-audible") { p.audible = { found: false, version: "" }; p.accounts = Setup.parseAccountList("", ""); p.library = Setup.parseLibraryProbe("", "", 127) }
    else if (name === "no-player") p.mpv = { found: false }
    else if (name === "no-account" || name === "login") {
      p.accounts = Setup.parseAccountList(none, ""); p.library = Setup.parseLibraryProbe("", "", 1)
      if (name === "login") { p.login = { url: "http://127.0.0.1:39457/0123456789abcdef/", waiting: true }; log = "Sign in to Amazon in the browser window that just opened." }
    }
    else if (name === "locked") p.library = Setup.parseLibraryProbe(locked, "", 1)
    else if (name === "unsynced" || name === "syncing") {
      p.library = Setup.parseLibraryProbe(none, "", 0)
      if (name === "syncing") { p.busy = "sync"; log = "Syncing your library... 120 of 237" }
    }
    else { previewing = false; recheck(); return }
    previewing = true
    svc.setupLog = log
    setup = Setup.detect(p)
  }

  function runSetupAction(id, payload) {
    if (previewing) { previewing = false; svc.setupLog = ""; recheck(); return }
    switch (id) {
    case "recheck": svc.setupLog = ""; recheck(); break
    case "install-audible": installAudible(); break
    case "login": startLogin(); break
    case "cancel": cancelLogin(); break
    case "store-password": storePassword(payload ? String(payload.password || "") : ""); break
    case "remove-password":
      Quickshell.execDetached(["xdg-terminal-exec", "sh", "-c",
        "export PATH=\"$HOME/.local/bin:$PATH\"; audible account password remove; echo; read -r -p 'Press Enter to close' _"])
      svc.setupLog = "Finish in the terminal that just opened, then press r to re-check."
      break
    case "sync": syncLibrary(); break
    case "sign-out": signOut(); break
    }
  }

  function installAudible() {
    var plan = Setup.installPlan(svc.pinnedTag, "x86_64")
    if (!plan || plan.error) { svc.setupLog = String((plan && plan.error) || "No download available for this machine"); return }
    busyWith("install-audible", "Downloading the Audible CLI and checking its checksum...")
    var script = "set -e; d=$(mktemp -d); trap 'rm -rf \"$d\"' EXIT; cd \"$d\"; " +
      "curl -fsSL -o \"$1\" \"$2\"; curl -fsSL -o SHA256SUMS \"$3\"; " +
      "sha256sum -c SHA256SUMS --ignore-missing >/dev/null; tar -xzf \"$1\"; " +
      "install -Dm755 ./*/audible \"$HOME/.local/bin/audible\""
    svc.run(["sh", "-c", script, "sh", plan.asset, plan.url, plan.sumsUrl], function(code, out, err) {
      doneBusy(code === 0 ? "Installed. Checking everything again..." : "The download did not verify: " + String(err).split("\n")[0])
    })
  }

  // The sign-in command asks for a password for the new login file and cannot be answered from
  // here. So make a random one, hand it over in the environment (never argv), and once the account
  // exists put it in the keyring and point Audible at it. Without a keyring tool the file is saved
  // unencrypted (--plain) and the setup log says so.
  function startLogin() {
    if (loginWaiting) return
    loginWaiting = true
    loginSeen = false
    loginUrl = ""
    busyWith("", "Starting the sign-in page...")
    var haveKeyring = !!(lastProbe && lastProbe.secretTool && lastProbe.secretTool.found)
    if (!haveKeyring) { launchLogin("", false); return }
    svc.run(["sh", "-c", "head -c 24 /dev/urandom | base64 | tr -d '=+/\\n'"], function(code, out) {
      if (!loginWaiting) return   // cancelled meanwhile
      var pw = String(out).trim()
      if (code !== 0 || pw.length < 16) {
        loginWaiting = false
        svc.setupLog = "Could not prepare a password for your login."
        rerenderSetup()
        return
      }
      launchLogin(pw, true)
    })
  }

  function launchLogin(pw, encrypted) {
    var opened = false
    loginPassword = pw
    var argv = ["audible", "account", "login", "server", "-m", marketplaceGuess(), "--timeout", "900"]
    if (!encrypted) argv.push("--plain")
    loginProc = svc.run(argv,
      function(code, out, err) {
        // the exit code is not a reliable success signal; the account list decides
        loginWaiting = false
        loginProc = null
        loginUrl = ""
        finishLogin()
      },
      { env: encrypted ? { AUDIBLE_NEW_AUTH_PASSWORD: pw } : null,
        line: function(l) {
          var u = Setup.parseLoginUrl(l)
          if (u && !opened) {
            opened = true
            loginUrl = u
            Quickshell.execDetached(["xdg-open", u])
            svc.setupLog = "Sign in to Amazon in the browser window that just opened."
            rerenderSetup()
          }
        } })
    rerenderSetup()
    loginPoll.restart()
  }

  // The sign-in command is over (or was stopped): check for the account, and store the generated
  // password if there is one.
  function finishLogin() {
    var pw = loginPassword
    loginPassword = ""
    loginSeen = false
    svc.setupLog = ""
    recheck(function() {
      if (pw !== "" && accountName() !== "") storePassword(pw)
      else if (pw !== "") svc.setupLog = "Sign-in did not finish. Try again."
    })
  }

  function cancelLogin() {
    loginPassword = ""
    if (loginProc) loginProc.signal(15)
    loginWaiting = false
    loginSeen = false
    loginUrl = ""
    svc.setupLog = ""
    recheck()
  }

  // While the sign-in page is open, notice the account appearing. The command is left to finish
  // writing the login file on its own (it exits when done); only if it lingers is it stopped.
  Timer {
    id: loginPoll
    interval: 3000
    repeat: true
    running: ctl.loginWaiting
    property int seenTicks: 0
    onTriggered: ctl.svc.run(["audible", "account", "list", "-o", "json"], function(c, o, e) {
      var acc = Setup.parseAccountList(o, e)
      if (!(acc.ok && acc.accounts.length > 0 && ctl.loginWaiting)) { loginPoll.seenTicks = 0; return }
      if (!ctl.loginSeen) { ctl.loginSeen = true; ctl.svc.setupLog = "Signed in. Saving your login..." }
      if (++loginPoll.seenTicks >= 5 && ctl.loginProc) ctl.loginProc.signal(15)   // lingering: ~15 s
    })
  }

  function accountName() {
    var a = lastProbe && lastProbe.accounts && lastProbe.accounts.accounts
    if (!a || a.length === 0) return ""
    for (var i = 0; i < a.length; i++) if (a[i].isDefault) return a[i].name
    return a[0].name
  }

  function storePassword(password) {
    var name = accountName()
    if (name === "" || password === "") { svc.setupLog = "Type your Audible file password first."; return }
    busyWith("store-password", "Saving it to your keyring...")
    // password goes to secret-tool on stdin only, never in argv or logs
    svc.run(argvFor(Setup.keyringStoreArgs(name), "secret-tool"), function(code, out, err) {
      if (code !== 0) { doneBusy("The keyring would not take it: " + String(err).split("\n")[0]); return }
      svc.run(argvFor(Setup.passwordSourceArgs(name), "audible"), function(c2, o2, e2) {
        doneBusy(c2 === 0 ? "Saved. Your login unlocks automatically now." : "Saved to the keyring, but could not point Audible at it: " + String(e2).split("\n")[0])
      })
    }, { input: password })
  }

  // Sign out: stop playback, drop the account from the CLI's config and forget its library.
  // Downloaded books and the saved auth file stay on disk. The setup screen takes over, so the next
  // sign-in is the normal first-run flow.
  function signOut() {
    var name = accountName()
    if (name === "") { svc.setupLog = "You are not signed in."; return }
    var argv
    try { argv = argvFor(Setup.signOutArgs(name), "audible") } catch (e) { svc.setupLog = "That account name cannot be signed out from here."; return }
    if (svc.hasBook) svc.stop()
    busyWith("sign-out", "Signing out...")
    svc.run(argv, function(code, out, err) {
      if (code !== 0) { doneBusy("Could not sign out: " + String(err || out).split("\n")[0]); return }
      svc.clearAccountData()
      doneBusy("Signed out of " + name + ".")
    })
  }

  function syncLibrary() {
    busyWith("sync", "Syncing your library...")
    svc.run(["audible", "library", "sync"], function(code, out, err) {
      doneBusy(code === 0 ? "Library synced." : "Sync failed: " + String(err || out).split("\n")[0])
    }, { line: function(l) { if (l.trim() !== "") svc.setupLog = l.trim().slice(0, 90) } })
  }
}
