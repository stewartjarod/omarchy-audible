.pragma library
// Sync with Audible: pure helpers for reading the phone's last position and deciding what to do.
// No QML, no I/O. The Sync.qml item does the process runs and state.
//
// Verified on the author's account (2026-10-10, audible-rs 0.1.0-alpha.8):
//   GET /1.0/annotations/lastpositions?asins=A,B  -> result.asin_last_position_heard_annots[]
//     { asin, last_position_heard: { last_updated: "2025-08-28 19:24:46.771", position_ms: 5255484,
//       status: "Exists" | "DoesNotExist" } }
//   position_ms is milliseconds into the book (5255484 ms = 24.3% of a 361 min book, library says 24.0).
//   last_updated has no timezone. It is parsed here as UTC (assumption, see report).
// Writing a position (verified on the author's account, 2026-10-12, with a read-back and a restore):
//   PUT /1.0/lastpositions/<asin>  body { acr, asin, position_ms }
//   The content id (acr) comes from GET /1.0/content/<asin>/metadata?response_groups=content_reference
//   -> result.content_metadata.content_reference.acr. No license request is needed. The Audible app
//   follows a pushed position by itself and shows a "moved ahead/back" notice with an undo.
//   Audible stamps a write with its own server clock, so it can run ahead of this computer's clock.
//   audible-rs exits 1 on an HTTP error and prints an envelope whose `error` is set.

var TOLERANCE_SEC = 120        // phone must be this far ahead (or behind) before we offer or push
var END_GUARD_SEC = 60         // positions this close to the end count as "finished", like resumePosition
var PULL_BATCH = 25            // ASINs per lastpositions call
var PULL_MAX_AGE_MS = 10 * 60 * 1000
var PUSH_PLAY_INTERVAL_MS = 3 * 60 * 1000   // while playing: at most one write per 3 min
var PUSH_PAUSE_INTERVAL_MS = 10 * 1000      // paused or stopped: quick, but never a burst
var PUSH_MIN_CHANGE_SEC = 5                 // do not write for a move smaller than this
var SKEW_MS = 60 * 1000                     // slack between Audible's clock and this computer's
var BACKOFF_BASE_MS = 60 * 1000
var BACKOFF_MAX_MS = 30 * 60 * 1000

// "2025-08-28 19:24:46.771" -> epoch ms (UTC). Regex on purpose: Date.parse of this form is
// implementation-defined (QML's engine may return NaN).
function parseTimestamp(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(String(s || ""))
  if (!m) return 0
  var ms = m[7] ? Number((m[7] + "00").slice(0, 3)) : 0
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms)
}

// Plain-English reason for a failed call. Never includes tokens or raw output.
function friendlyError(text) {
  var t = String(text || "").toLowerCase()
  if (/401|403|unauthori|expired|locked|password|sign ?in|login/.test(t))
    return "Your Audible sign-in needs attention. Open the Audible setup to check it."
  if (/timed out|timeout|network|resolve|connect|unreachable|dns/.test(t))
    return "Could not reach Audible right now. Your position is still saved on this computer."
  return "Audible did not take the position update. Your position is still saved on this computer."
}

// Parse the stdout of `audible api GET /1.0/annotations/lastpositions -o json`.
// Returns { ok, positions: { asin: { positionSec, updatedAt, exists } }, error }.
// A DoesNotExist entry means "no position on the phone", reported as exists:false, positionSec 0.
function parseLastPositions(text) {
  var env = null
  try { env = JSON.parse(String(text || "")) } catch (e) { return { ok: false, positions: {}, error: friendlyError("parse") } }
  if (!env || env.error) return { ok: false, positions: {}, error: friendlyError(env && env.error ? JSON.stringify(env.error) : "") }
  var list = env.result && env.result.asin_last_position_heard_annots
  if (!Array.isArray(list)) return { ok: false, positions: {}, error: friendlyError("shape") }
  var positions = {}
  for (var i = 0; i < list.length; i++) {
    var row = list[i] || {}
    var lp = row.last_position_heard || {}
    if (!row.asin) continue
    if (lp.status !== "Exists" || typeof lp.position_ms !== "number" || !isFinite(lp.position_ms) || lp.position_ms < 0) {
      positions[row.asin] = { positionSec: 0, positionMs: 0, updatedAt: 0, exists: false }
      continue
    }
    positions[row.asin] = {
      positionSec: lp.position_ms / 1000,
      positionMs: Math.round(lp.position_ms),
      updatedAt: parseTimestamp(lp.last_updated),
      exists: true
    }
  }
  return { ok: true, positions: positions, error: "" }
}

// The argv for one batched read. Always GET: the pull path must never be able to write.
function buildPullArgv(asins) {
  var argv = ["audible", "api", "GET", "/1.0/annotations/lastpositions",
              "--query", "asins=" + asins.join(","), "-o", "json"]
  return argv
}

function chunk(list, n) {
  var out = []
  for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}

// Which books are worth asking the phone about: not finished, started or downloaded,
// plus the book we would continue. Keeps the call count small on a big library.
function pullCandidates(books, localAsins, lastAsin) {
  var seen = {}
  var out = []
  function add(a) { if (a && !seen[a]) { seen[a] = true; out.push(a) } }
  add(lastAsin)
  var list = Array.isArray(books) ? books : []
  for (var i = 0; i < list.length; i++) {
    var b = list[i]
    if (!b || !b.asin || b.finished || b.listenable === false) continue
    var started = (Number(b.percentComplete) || 0) > 0 || (Number(b.resumeSec) || 0) > 0
    var local = !!(localAsins && localAsins[b.asin])
    if (started || local) add(b.asin)
  }
  return out
}

// The local side of the comparison, using the same baseline resumePosition uses:
// our own saved position, else Audible's percent of the runtime. Finished books have none.
function localBaseline(resumeEntry, book) {
  if (resumeEntry && typeof resumeEntry.position === "number") {
    return { position: resumeEntry.position, updatedAt: Number(resumeEntry.updatedAt) || 0 }
  }
  if (book && !book.finished && (Number(book.percentComplete) || 0) > 0 && (Number(book.runtimeSec) || 0) > 0) {
    return { position: book.runtimeSec * book.percentComplete / 100, updatedAt: 0 }
  }
  return { position: 0, updatedAt: 0 }
}

// Decide what the phone position means for us.
//   phone: { positionSec, updatedAt, exists } | null     local: { position, updatedAt } | null
//   opts:  { durationSec }
// Returns { state: "none" | "phone-ahead" | "local-ahead", phoneSec, localSec, gapSec }.
// "Newer" uses timestamps when both sides have one, otherwise the position itself.
function decide(phone, local, opts) {
  var o = opts || {}
  var phoneSec = phone && phone.exists !== false ? (Number(phone.positionSec) || 0) : 0
  var localSec = local ? (Number(local.position) || 0) : 0
  var result = { state: "none", phoneSec: phoneSec, localSec: localSec, gapSec: phoneSec - localSec }
  var duration = Number(o.durationSec) || 0
  if (phoneSec >= duration - END_GUARD_SEC && duration > 0 && phoneSec > 0) return result
  var phoneNewer
  if (phone && local && phone.updatedAt && local.updatedAt) phoneNewer = phone.updatedAt > local.updatedAt
  else phoneNewer = phoneSec > localSec
  if (phoneNewer) {
    if (phoneSec > 0 && phoneSec - localSec > TOLERANCE_SEC) result.state = "phone-ahead"
  } else if (Math.abs(localSec - phoneSec) > TOLERANCE_SEC) {
    // local is the newer side (or the phone is not ahead): its spot is what should be on Audible
    result.state = "local-ahead"
  }
  return result
}

// "2h 13m", "42m", "<1m"
function formatHm(sec) {
  var s = Math.max(0, Math.floor(Number(sec) || 0))
  var h = Math.floor(s / 3600)
  var m = Math.floor((s % 3600) / 60)
  if (h > 0) return h + "h " + m + "m"
  if (m > 0) return m + "m"
  return "<1m"
}

// chapters: normalizeChapters output ([{index, start}]) when known, else empty.
function chapterNumberAt(chapters, sec) {
  var list = Array.isArray(chapters) ? chapters : []
  var found = null
  for (var i = 0; i < list.length; i++) if (Number(list[i].start) <= sec) found = list[i]
  if (!found) return 0
  var n = typeof found.index === "number" ? found.index : 0
  return n + 1
}

// "Chapter 12 · 2h 13m", or just "2h 13m" when the chapters are not known yet.
function formatPosition(sec, chapters) {
  var n = chapterNumberAt(chapters, Number(sec) || 0)
  return n > 0 ? "Chapter " + n + " · " + formatHm(sec) : formatHm(sec)
}

// Exponential back-off after failures: 1 min, 2, 4, ... capped at 30 min.
function backoffMs(failures) {
  var f = Math.max(1, Number(failures) || 1)
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, f - 1))
}

// Setting: writing your position to Audible is strictly opt-in (=== true) and off by default.
function pushMode(settings) {
  var s = settings || {}
  return { push: s.savePositionToAudible === true }
}

function isAsin(a) { return /^[A-Za-z0-9]{10}$/.test(String(a || "")) }

// True when a finished `audible api` call really worked: exit 0 and no error in the envelope.
// (audible-rs exits 1 on an HTTP error today; the envelope check is a second line of defence.)
function callSucceeded(code, out) {
  if (code !== 0) return false
  var env = null
  try { env = JSON.parse(String(out || "")) } catch (e) { return true }   // not JSON: trust the exit code
  return !(env && typeof env === "object" && env.error)
}

// The read that returns the book's content id. Always a GET.
function buildAcrArgv(asin) {
  if (!isAsin(asin)) throw new Error("not a valid ASIN")
  return ["audible", "api", "GET", "/1.0/content/" + asin + "/metadata",
          "--query", "response_groups=content_reference", "-o", "json"]
}

// The content id from that reply, or "" when it is missing, for another book, or the call failed.
function parseAcr(text, asin) {
  var env = null
  try { env = JSON.parse(String(text || "")) } catch (e) { return "" }
  if (!env || env.error) return ""
  var ref = env.result && env.result.content_metadata && env.result.content_metadata.content_reference
  if (!ref || typeof ref.acr !== "string" || ref.acr === "" || ref.acr.length > 200) return ""
  if (ref.asin && ref.asin !== asin) return ""
  return ref.acr
}

// The one write this plugin ever makes to the Audible account. `positionMs` is the integer sent, so
// the caller can remember exactly what it wrote (see pushRefusal).
function buildPushRequest(asin, positionSec, acr) {
  if (!isAsin(asin) || typeof acr !== "string" || acr === "") return null
  var sec = Number(positionSec)
  if (!isFinite(sec) || sec < 0) return null
  var body = { acr: acr, asin: asin, position_ms: Math.round(sec * 1000) }
  return {
    argv: ["audible", "api", "PUT", "/1.0/lastpositions/" + asin, "--body", JSON.stringify(body), "-o", "json"],
    body: body,
    positionMs: body.position_ms
  }
}

// Why a write must not happen now, or "" when it may. `remote` is Audible's position for the book,
// read just before the write: { exists, positionMs, updatedAt }. `listenedAtMs` is when this computer
// last played the book (the resume entry's time). `pushedMs` is the integer this computer last wrote.
//   - Audible has no position, or the position is exactly what we wrote last: fine (our own echo,
//     stamped with Audible's clock, must never lock us out).
//   - Audible's position was written after we last listened here (beyond the clock slack): another
//     device listened since, so we do not overwrite it.
function pushRefusal(remote, listenedAtMs, pushedMs) {
  if (!remote || remote.exists === false) return ""
  if (pushedMs !== undefined && pushedMs !== null && remote.positionMs === pushedMs) return ""
  var listened = Number(listenedAtMs) || 0
  if (listened <= 0) return "unknown"
  if ((Number(remote.updatedAt) || 0) > listened + SKEW_MS) return "stale"
  return ""
}

// One guarded write, as a sequence of `audible api` calls through run(argv, cb(code, out, err)):
//   1. the content id (skipped when ctx.acr is cached)   2. a fresh read of Audible's position
//   3. pushRefusal(...)                                  4. the write, only if nothing refused it.
// ctx: { asin, positionSec, listenedAtMs, acr, pushedMs }.
// done(result): { outcome: "sent" | "refused" | "failed", why, acr, remote, positionMs, error }.
//   "refused": another device wrote after we last listened (why "stale"); `remote` is what Audible has.
//   "failed":  `acr` is "" when the content id should be read again next time; `error` is plain English.
// Nothing here touches the clock or the disk, so it can be tested with a stand-in `audible`.
function pushPosition(run, ctx, done) {
  var asin = ctx.asin
  function fail(err, acr, remote) { done({ outcome: "failed", error: err || friendlyError(""), acr: acr || "", remote: remote || null }) }
  function afterAcr(acr) {
    if (!acr) { fail("", ""); return }
    run(buildPullArgv([asin]), function (code, out, err) {
      if (!callSucceeded(code, out)) { fail(friendlyError(err || out), acr); return }
      var r = parseLastPositions(out)
      if (!r.ok) { fail(r.error, acr); return }
      var remote = r.positions[asin] || { exists: false, positionMs: 0, positionSec: 0, updatedAt: 0 }
      var why = pushRefusal(remote, ctx.listenedAtMs, ctx.pushedMs)
      if (why !== "") { done({ outcome: "refused", why: why, acr: acr, remote: remote }); return }
      var req = buildPushRequest(asin, ctx.positionSec, acr)
      if (!req) { fail("", acr, remote); return }
      run(req.argv, function (code2, out2, err2) {
        if (callSucceeded(code2, out2)) done({ outcome: "sent", acr: acr, remote: remote, positionMs: req.positionMs })
        else fail(friendlyError(err2 || out2), "", remote)   // drop the content id: it may be the problem
      })
    })
  }
  if (ctx.acr) { afterAcr(ctx.acr); return }
  run(buildAcrArgv(asin), function (code, out) {
    afterAcr(callSucceeded(code, out) ? parseAcr(out, asin) : "")
  })
}

// Whether a push should happen now. state: { pushOn, hasBook, playing, paused, positionSec,
// sentSec, nowMs, lastPushMs, nextAllowedMs }
function shouldPush(state) {
  var s = state || {}
  if (!s.pushOn || !s.hasBook) return { send: false, reason: "off" }
  if ((Number(s.positionSec) || 0) <= 0) return { send: false, reason: "no-position" }
  if ((Number(s.nextAllowedMs) || 0) > (Number(s.nowMs) || 0)) return { send: false, reason: "backoff" }
  if (s.sentSec !== undefined && s.sentSec !== null && Math.abs(s.positionSec - s.sentSec) < PUSH_MIN_CHANGE_SEC)
    return { send: false, reason: "unchanged" }
  var gap = (Number(s.nowMs) || 0) - (Number(s.lastPushMs) || 0)
  var need = s.playing && !s.paused ? PUSH_PLAY_INTERVAL_MS : PUSH_PAUSE_INTERVAL_MS
  if (gap < need) return { send: false, reason: "rate-limit" }
  return { send: true, reason: "due" }
}

function needsPull(fetchedAtMs, nowMs) {
  return !fetchedAtMs || (Number(nowMs) - Number(fetchedAtMs)) > PULL_MAX_AGE_MS
}

if (typeof module !== "undefined") module.exports = {
  TOLERANCE_SEC: TOLERANCE_SEC, END_GUARD_SEC: END_GUARD_SEC, PULL_BATCH: PULL_BATCH,
  parseTimestamp: parseTimestamp, friendlyError: friendlyError, parseLastPositions: parseLastPositions,
  buildPullArgv: buildPullArgv, chunk: chunk, pullCandidates: pullCandidates, localBaseline: localBaseline,
  decide: decide, formatHm: formatHm, chapterNumberAt: chapterNumberAt, formatPosition: formatPosition,
  SKEW_MS: SKEW_MS, backoffMs: backoffMs, pushMode: pushMode, isAsin: isAsin, callSucceeded: callSucceeded,
  buildAcrArgv: buildAcrArgv, parseAcr: parseAcr, buildPushRequest: buildPushRequest, pushRefusal: pushRefusal, pushPosition: pushPosition,
  shouldPush: shouldPush, needsPull: needsPull
}
