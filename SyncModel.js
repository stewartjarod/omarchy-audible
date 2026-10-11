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
// NOT verified: how a position is written. buildPushRequest() uses a guessed endpoint and body and
// is marked unverified. Live sending stays off until the integrator confirms it.

var TOLERANCE_SEC = 120        // phone must be this far ahead (or behind) before we offer or push
var END_GUARD_SEC = 60         // positions this close to the end count as "finished", like resumePosition
var PULL_BATCH = 25            // ASINs per lastpositions call
var PULL_MAX_AGE_MS = 10 * 60 * 1000
var PUSH_PLAY_INTERVAL_MS = 3 * 60 * 1000   // while playing: at most one write per 3 min
var PUSH_PAUSE_INTERVAL_MS = 10 * 1000      // paused or stopped: quick, but never a burst
var PUSH_MIN_CHANGE_SEC = 5                 // do not write for a move smaller than this
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
      positions[row.asin] = { positionSec: 0, updatedAt: 0, exists: false }
      continue
    }
    positions[row.asin] = {
      positionSec: lp.position_ms / 1000,
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

// Settings: push is strictly opt-in (=== true); dry run is ON unless explicitly false.
function pushMode(settings) {
  var s = settings || {}
  return { push: s.syncPositionToAudible === true, dryRun: s.syncDryRun !== false }
}

// Live sending needs push on, dry run off, and a content id. Anything else is a log line only.
function canSendLive(mode, acr) {
  return !!(mode && mode.push && !mode.dryRun && acr)
}

// UNVERIFIED write shape. Endpoint and body are guesses until confirmed against a real write
// (the integrator must check this with `audible api PUT ... --dry-run` before enabling live sends).
function buildPushRequest(asin, positionSec, acr) {
  if (!asin) return null
  var body = { asin: asin, position_ms: Math.round((Number(positionSec) || 0) * 1000) }
  if (acr) body.acr = acr
  return {
    unverified: true,
    argv: ["audible", "api", "PUT", "/1.0/lastpositions/" + asin, "--body", JSON.stringify(body), "-o", "json"],
    body: body
  }
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

function describeWouldSend(asin, positionSec, chapters) {
  return "Would send to Audible: book " + asin + ", at " + formatPosition(positionSec, chapters) +
         ". Not sent (dry run is on)."
}

function needsPull(fetchedAtMs, nowMs) {
  return !fetchedAtMs || (Number(nowMs) - Number(fetchedAtMs)) > PULL_MAX_AGE_MS
}

if (typeof module !== "undefined") module.exports = {
  TOLERANCE_SEC: TOLERANCE_SEC, END_GUARD_SEC: END_GUARD_SEC, PULL_BATCH: PULL_BATCH,
  parseTimestamp: parseTimestamp, friendlyError: friendlyError, parseLastPositions: parseLastPositions,
  buildPullArgv: buildPullArgv, chunk: chunk, pullCandidates: pullCandidates, localBaseline: localBaseline,
  decide: decide, formatHm: formatHm, chapterNumberAt: chapterNumberAt, formatPosition: formatPosition,
  backoffMs: backoffMs, pushMode: pushMode, canSendLive: canSendLive, buildPushRequest: buildPushRequest,
  shouldPush: shouldPush, describeWouldSend: describeWouldSend, needsPull: needsPull
}
