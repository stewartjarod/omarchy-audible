.pragma library

// Pure listening helpers for jarod.audible: sleep timer, rewind on resume, auto-advance choice,
// audio filter chains and notification argv. No QML imports, no I/O, no Qt.*.
// Times are seconds (real) unless a name says Ms. Volumes are mpv's scale (100 = unchanged).

var FADE_SEC = 30
var SLEEP_PRESETS = [15, 30, 45, 60]
// What "z" cycles through, in order. 0 means off.
var SLEEP_CYCLE = [15, 30, 45, 60, "chapter", 0]

function num(x, fallback) {
  return typeof x === "number" && isFinite(x) ? x : fallback
}

// ---- rewind on resume -------------------------------------------------------
// How far to jump back when playback resumes after being paused for pausedSec seconds.
// Short pauses are a re-listen to nothing; longer ones earn a reminder of where you were.
function rewindSeconds(pausedSec, enabled) {
  if (enabled === false) return 0
  var s = num(pausedSec, 0)
  if (s < 30) return 0
  if (s < 5 * 60) return 3
  if (s < 30 * 60) return 8
  if (s < 2 * 60 * 60) return 15
  return 30
}

// ---- sleep timer ------------------------------------------------------------
// A timer is null (off), {kind: "time", remaining: sec, preset: minutes} or {kind: "chapter", endPos: sec}.
// "time" counts down only while audio plays, so a pause does not eat the sleep time.

// Tapping the preset that is already running adds its time again. Tapping a different preset,
// or any preset when nothing (or an end-of-chapter timer) is running, starts fresh.
function sleepAddMinutes(timer, minutes) {
  var m = num(minutes, 0)
  if (m <= 0) return timer || null
  if (timer && timer.kind === "time" && timer.preset === m) {
    return { kind: "time", remaining: timer.remaining + m * 60, preset: m }
  }
  return { kind: "time", remaining: m * 60, preset: m }
}

// The minutes of a running time timer, or 0. Used by the "add again" key.
function sleepRunningPreset(timer) {
  return timer && timer.kind === "time" ? num(timer.preset, 0) : 0
}

// True when the book has moved well past a chapter-end timer's target (a user jump, not normal
// 1 Hz polling overshoot), so the timer should retarget instead of pausing.
function sleepChapterOvershot(timer, position, speed) {
  if (!timer || timer.kind !== "chapter") return false
  var sp = num(speed, 1) > 0 ? num(speed, 1) : 1
  return num(position, 0) > num(timer.endPos, 0) + 2 * sp + 1
}

// "End of this chapter" replaces whatever was running. endPos is the chapter's end in book seconds.
function sleepChapterTimer(chapterEndPos) {
  var e = num(chapterEndPos, -1)
  return e > 0 ? { kind: "chapter", endPos: e } : null
}

// One second of playback passed. Only time timers count down here.
function sleepTick(timer, playing, dtSec) {
  if (!timer || timer.kind !== "time" || !playing) return timer || null
  var dt = num(dtSec, 1)
  return { kind: "time", remaining: Math.max(0, timer.remaining - dt), preset: timer.preset }
}

// Seconds of listening left before the sleep pause. Chapter timers read the book position.
function sleepRemainingSec(timer, position, speed) {
  if (!timer) return 0
  if (timer.kind === "chapter") {
    var sp = num(speed, 1) > 0 ? num(speed, 1) : 1
    return Math.max(0, (num(timer.endPos, 0) - num(position, 0)) / sp)
  }
  return Math.max(0, num(timer.remaining, 0))
}

// Time to pause. Chapter timers look one second ahead, because position is polled once a second.
function isSleepDue(timer, remainingSec) {
  if (!timer) return false
  return timer.kind === "chapter" ? remainingSec <= 1 : remainingSec <= 0
}

// Volume ramps down linearly over the last FADE_SEC seconds: full above it, silent at zero.
function fadeFactor(remainingSec, fadeSec) {
  var f = num(fadeSec, FADE_SEC)
  var r = num(remainingSec, 0)
  if (f <= 0) return r > 0 ? 1 : 0
  if (r >= f) return 1
  if (r <= 0) return 0
  return r / f
}

// The mpv volume to apply while fading, from the user's own (saved) level.
function fadeVolume(baseVolume, remainingSec, fadeSec) {
  var base = Math.max(0, num(baseVolume, 100))
  return Math.round(base * fadeFactor(remainingSec, fadeSec))
}

// The choice "z" shows for the current timer: 0 off, a number of minutes, or "chapter".
function sleepChoiceOf(timer) {
  if (!timer) return 0
  if (timer.kind === "chapter") return "chapter"
  return num(timer.preset, 0)
}

// The next value in SLEEP_CYCLE after the current timer's choice.
function nextSleepChoice(timer) {
  var cur = sleepChoiceOf(timer)
  var i = SLEEP_CYCLE.indexOf(cur)
  return SLEEP_CYCLE[(i + 1) % SLEEP_CYCLE.length]
}

// Short plain text for the popup and the bar tooltip. "" when no timer.
function sleepLabel(timer, remainingSec) {
  if (!timer) return ""
  if (timer.kind === "chapter") return "Sleep at end of chapter"
  var r = num(remainingSec, 0)
  if (r < 60) return "Sleep in under a minute"
  return "Sleep in " + Math.ceil(r / 60) + " min"
}

// ---- auto-advance -----------------------------------------------------------
// Pick the book to start after `finishedAsin`. Returns {asin, reason} or null.
//   lib:   the LibraryModel module (seriesIndex, seriesKeyOf, sortSeriesMembers, nextUp)
//   books: merged Book list (finished already reflects this listen, see merge)
//   opts:  {autoAdvance: "off"|"downloaded", isLocal: fn(asin) -> bool,
//           provider: asin string from another agent's queue, or ""}
// Rules: never a download. A queue provider's pick wins over the series rule.
function nextInSeries(lib, books, finishedAsin, opts) {
  var o = opts || {}
  if (o.autoAdvance === "off") return null
  var list = Array.isArray(books) ? books : []
  var isLocal = typeof o.isLocal === "function" ? o.isLocal : function (a) {
    for (var i = 0; i < list.length; i++) if (list[i].asin === a) return !!list[i].local
    return false
  }
  function find(a) {
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].asin === a) return list[i]
    return null
  }
  if (o.provider) {
    var pick = find(o.provider)
    return pick && isLocal(pick.asin) ? { asin: pick.asin, reason: "queue" } : null
  }
  var cur = find(finishedAsin)
  if (!cur || !lib) return null
  var key = lib.seriesKeyOf(cur)
  if (!key) return null
  var members = lib.seriesIndex(list, 2)[key]
  if (!members) return null
  var at = -1
  for (var m = 0; m < members.length; m++) if (members[m].asin === finishedAsin) { at = m; break }
  if (at < 0) return null
  var rest = members.slice(at + 1).filter(function (b) { return !b.finished })
  var next = lib.nextUp(rest)
  if (!next || next.finished || next.listenable === false) return null
  return isLocal(next.asin) ? { asin: next.asin, reason: "series" } : null
}

// ---- audio filters ----------------------------------------------------------
// The filter graph for a mode, or "" when off. Wrapped in lavfi=[...] by affCommands.
var VOICE_CHAIN = "highpass=f=80,equalizer=f=3000:width_type=q:width=1:g=2,acompressor=threshold=-20dB:ratio=2.5:attack=15:release=200:makeup=2"
function filterChain(mode) {
  if (mode === "normalize") return "dynaudnorm"
  if (mode === "voice") return VOICE_CHAIN
  return ""
}

// IPC commands that replace our labelled filter (so other af filters, if any, are kept).
// The remove comes first and may fail harmlessly when nothing is labelled yet.
function affCommands(mode) {
  var chain = filterChain(mode)
  var cmds = [["af", "remove", "@listen"]]
  if (chain !== "") cmds.push(["af", "add", "@listen:lavfi=[" + chain + "]"])
  return cmds
}

// ---- notifications ----------------------------------------------------------
// notify-send argv. "--" stops a title that starts with "-" being read as an option.
function notifyArgs(title, body, expireMs) {
  var argv = ["notify-send", "-a", "Audible"]
  var t = num(expireMs, 0)
  if (t > 0) argv.push("-t", String(Math.round(t)))
  argv.push("--", String(title || ""))
  if (body) argv.push(String(body))
  return argv
}

function upNextBody(title) {
  return String(title || "Your next book") + " starts in 5 seconds."
}

if (typeof module !== "undefined") module.exports = {
  FADE_SEC: FADE_SEC,
  SLEEP_PRESETS: SLEEP_PRESETS,
  SLEEP_CYCLE: SLEEP_CYCLE,
  rewindSeconds: rewindSeconds,
  sleepAddMinutes: sleepAddMinutes,
  sleepRunningPreset: sleepRunningPreset,
  sleepChapterOvershot: sleepChapterOvershot,
  sleepChapterTimer: sleepChapterTimer,
  sleepTick: sleepTick,
  sleepRemainingSec: sleepRemainingSec,
  isSleepDue: isSleepDue,
  fadeFactor: fadeFactor,
  fadeVolume: fadeVolume,
  sleepChoiceOf: sleepChoiceOf,
  nextSleepChoice: nextSleepChoice,
  sleepLabel: sleepLabel,
  nextInSeries: nextInSeries,
  filterChain: filterChain,
  affCommands: affCommands,
  notifyArgs: notifyArgs,
  upNextBody: upNextBody
}
