.pragma library

// Pure player helpers for stewartjarod.audible. No QML imports, no I/O, no Qt.*.
// Times are seconds (real). Speeds are real multipliers (1 = normal).

// Finite number or fallback. Guards every numeric input so NaN/Infinity/strings
// from mpv or settings never leak into the UI.
function num(x, fallback) {
  return typeof x === "number" && isFinite(x) ? x : fallback
}

function pad2(n) {
  return n < 10 ? "0" + n : "" + n
}

// Count decimal places of a number as written (0.05 -> 2, 0.5 -> 1, 3 -> 0).
function decimalPlaces(x) {
  var s = String(x)
  if (s.indexOf("e") >= 0) return 6
  var i = s.indexOf(".")
  return i < 0 ? 0 : s.length - i - 1
}

// Seconds -> text.
//   "hm"    "7h 42m", "42m", "7h", "<1m"
//   "clock" "1:02:03", "42:07", "0:05"
//   "left"  "7h 42m left", "42m left", "<1m left"
function formatDuration(sec, style) {
  var s = Math.floor(Math.max(0, num(sec, 0)))
  var h = Math.floor(s / 3600)
  var m = Math.floor(s / 60)
  var mm = m % 60
  var ss = s % 60

  if (style === "clock") {
    if (h > 0) return h + ":" + pad2(mm) + ":" + pad2(ss)
    return Math.floor(s / 60) + ":" + pad2(ss)
  }

  var hm
  if (s < 60) hm = "<1m"
  else if (h > 0) hm = mm > 0 ? h + "h " + mm + "m" : h + "h"
  else hm = m + "m"

  if (style === "left") return hm + " left"
  return hm
}

// Book seconds remaining at the given speed. Position past the end clamps to 0;
// speed <= 0 (or not a number) is treated as 1.
function timeLeft(duration, position, speed) {
  var d = num(duration, 0)
  var p = Math.max(0, num(position, 0))
  var s = num(speed, 1)
  if (s <= 0) s = 1
  var rest = Math.max(0, d - p)
  return rest / s
}

// mpv chapter-list reply ({data: [{title, time}], error, request_id}) or a bare
// array of the same entries, plus the book duration in seconds.
// Returns [{index, title, start, end, length}] sorted by start. Entries with
// no finite time are dropped. The last chapter ends at the book duration. With
// no usable chapters, one synthetic chapter spans the whole book.
function normalizeChapters(mpvChapterList, duration) {
  var d = Math.max(0, num(duration, 0))
  var raw = Array.isArray(mpvChapterList)
    ? mpvChapterList
    : (mpvChapterList && Array.isArray(mpvChapterList.data) ? mpvChapterList.data : [])

  var items = []
  for (var i = 0; i < raw.length; i++) {
    var c = raw[i]
    if (!c || typeof c !== "object") continue
    var t = num(c.time, NaN)
    if (!isFinite(t)) continue
    var start = Math.max(0, t)
    if (d > 0) start = Math.min(d, start)
    var title = typeof c.title === "string" ? c.title.trim() : ""
    items.push({ title: title, start: start, order: i })
  }

  if (items.length === 0) {
    return [{ index: 0, title: "Full book", start: 0, end: d, length: d }]
  }

  items.sort(function(a, b) { return a.start - b.start || a.order - b.order })

  var out = []
  for (var j = 0; j < items.length; j++) {
    var it = items[j]
    var end = j + 1 < items.length ? items[j + 1].start : (d > it.start ? d : it.start)
    out.push({
      index: j,
      title: it.title !== "" ? it.title : "Chapter " + (j + 1),
      start: it.start,
      end: end,
      length: Math.max(0, end - it.start)
    })
  }
  return out
}

// Index of the chapter playing at `position`: the last chapter whose start is
// at or before it. Before the first chapter, or with no chapters, returns 0.
function chapterIndexAt(chapters, position) {
  if (!Array.isArray(chapters) || chapters.length === 0) return 0
  var p = num(position, 0)
  if (p < chapters[0].start) return 0
  var lo = 0
  var hi = chapters.length - 1
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1
    if (chapters[mid].start <= p) lo = mid
    else hi = mid - 1
  }
  return lo
}

// 0..1 progress through one chapter. Zero-length or missing chapters give 0.
function chapterProgress(chapter, position) {
  if (!chapter) return 0
  var len = num(chapter.length, 0)
  if (!(len > 0)) return 0
  var v = (num(position, 0) - num(chapter.start, 0)) / len
  return Math.min(1, Math.max(0, v))
}

// Clamp a speed into [min, max]. Non-numbers become 1 before clamping.
// ---- volume (mpv's own scale: 100 = unchanged, up to 130 by default) ----------

function clampVolume(v, min, max) {
  var lo = num(min, 0), hi = num(max, 130)
  if (hi < lo) { var t = lo; lo = hi; hi = t }
  return Math.min(hi, Math.max(lo, Math.round(num(v, 100))))
}

// Next volume on the step grid (default 5), dir > 0 up, dir < 0 down. Always whole numbers.
function stepVolume(vol, dir, opts) {
  var o = opts || {}
  var step = num(o.step, 5)
  if (!(step > 0)) step = 5
  var min = num(o.min, 0), max = num(o.max, 130)
  var cur = clampVolume(vol, min, max)
  var k = cur / step
  var next = dir > 0 ? (Math.floor(k + 1e-9) + 1) * step : dir < 0 ? (Math.ceil(k - 1e-9) - 1) * step : cur
  return clampVolume(next, min, max)
}

function formatVolume(v, muted) {
  return muted ? "muted" : clampVolume(v, 0, 1000) + "%"
}

function clampSpeed(x, min, max) {
  var lo = num(min, 0.5)
  var hi = num(max, 3)
  if (hi < lo) { var tmp = lo; lo = hi; hi = tmp }
  var v = num(x, 1)
  return Math.min(hi, Math.max(lo, v))
}

// Next/previous speed on the grid min + k * step (k integer), dir > 0 up,
// dir < 0 down, dir 0 snaps to the nearest grid point. Off-grid speeds move to
// the next grid point in that direction. Results clamp to [min, max] and are
// rounded to enough decimals to kill float noise (2 minimum, e.g. 1.2 not
// 1.2000000000000002). Non-positive or invalid step: just clamp.
function stepSpeed(speed, dir, opts) {
  var o = opts || {}
  var min = num(o.min, 0.5)
  var max = num(o.max, 3)
  var step = num(o.step, 0.05)
  if (max < min) { var tmp = min; min = max; max = tmp }

  var dp = Math.min(6, Math.max(2, decimalPlaces(step), decimalPlaces(min)))
  var v = num(speed, 1)

  if (!(step > 0)) {
    return Number(clampSpeed(v, min, max).toFixed(dp))
  }

  var eps = 1e-9
  var k = (v - min) / step
  var target
  if (dir > 0) target = Math.floor(k + eps) + 1
  else if (dir < 0) target = Math.ceil(k - eps) - 1
  else target = Math.round(k)

  var next = min + target * step
  return Number(clampSpeed(next, min, max).toFixed(dp))
}

// "1.5x", "2x", "2.25x". Rounds to 2 decimals, no trailing zeros.
function formatSpeed(x) {
  var v = num(x, 1)
  return Number(v.toFixed(2)) + "x"
}

// Fractions (0..1) where one chapter ends and the next begins, for the progress
// bar tick marks. Excludes 0 and 1 and duplicates. Empty if duration <= 0.
function chapterTicks(chapters, duration) {
  var d = num(duration, 0)
  var out = []
  if (!(d > 0) || !Array.isArray(chapters)) return out
  for (var i = 1; i < chapters.length; i++) {
    var f = num(chapters[i].start, 0) / d
    if (!(f > 0 && f < 1)) continue
    if (out.length > 0 && out[out.length - 1] === f) continue
    out.push(f)
  }
  return out
}

// position + delta, clamped to [0, duration]. Duration <= 0 (unknown) leaves the
// upper end open. Only the lower bound applies then.
function seekTarget(position, delta, duration) {
  var t = num(position, 0) + num(delta, 0)
  var d = num(duration, 0)
  t = Math.max(0, t)
  if (d > 0) t = Math.min(d, t)
  return t
}

// Bar label for the widget. state: {title, position, duration, speed, playing,
// hasBook, setupReady}. opts: {maxTitle} (default 40, title is cut with an
// ellipsis). Not ready or nothing loaded: empty text (icon only) and a tooltip
// that says why.
function barLabel(state, opts) {
  var st = state || {}
  var o = opts || {}
  var maxTitle = Math.max(1, Math.floor(num(o.maxTitle, 40)))

  if (!st.setupReady) return { text: "", tooltip: "Audible: setup needed" }
  if (!st.hasBook) return { text: "", tooltip: "Audible: nothing playing" }

  var fullTitle = typeof st.title === "string" ? st.title.trim() : ""
  var shortTitle = fullTitle
  if (fullTitle.length > maxTitle) {
    shortTitle = maxTitle <= 1
      ? "…"
      : fullTitle.slice(0, maxTitle - 1).replace(/\s+$/, "") + "…"
  }

  var duration = num(st.duration, 0)
  var speed = num(st.speed, 1)
  if (speed <= 0) speed = 1
  var left = timeLeft(duration, st.position, speed)
  var hasTime = duration > 0

  var parts = []
  if (shortTitle !== "") parts.push(shortTitle)
  if (hasTime) parts.push(formatDuration(left, "left"))
  parts.push(formatSpeed(speed))

  var tip = []
  if (fullTitle !== "") tip.push(fullTitle)
  tip.push(st.playing ? "Playing" : "Paused")
  if (hasTime) tip.push(formatDuration(left, "left"))
  tip.push(formatSpeed(speed))

  return { text: parts.join(" · "), tooltip: tip.join(" · ") }
}

// The mpv IPC commands that start a downloaded AAXC book. Mirrors what the old audible-play helper
// sent: loadfile (key/iv go in as demuxer options so they never reach a command line), then
// unpause (mpv sits paused after a previous book ends), then volume and speed.
// voucher is the parsed <asin>.voucher JSON ({key, iv}); returns [] if it is unusable.
function loadCommands(file, voucher, opts) {
  var o = opts || {}
  var key = voucher && typeof voucher.key === "string" ? voucher.key : ""
  var iv = voucher && typeof voucher.iv === "string" ? voucher.iv : ""
  if (!file || !/^[0-9a-fA-F]+$/.test(key) || !/^[0-9a-fA-F]+$/.test(iv)) return []
  var fileOpts = { "demuxer-lavf-o": "audible_key=" + key + ",audible_iv=" + iv }
  var start = num(o.start, 0)
  if (start > 0) fileOpts.start = String(start)
  var cmds = [
    ["loadfile", String(file), "replace", -1, fileOpts],
    ["set_property", "pause", false]
  ]
  if (num(o.volume, -1) >= 0) cmds.push(["set_property", "volume", o.volume])
  if (num(o.speed, 0) > 0) cmds.push(["set_property", "speed", o.speed])
  return cmds
}

// argv for a fresh, idle mpv with the IPC socket. Own systemd scope via uwsm-app when present so it
// survives a shell restart; volume is set at launch so the first sound is never louder than intended.
function mpvLaunchArgs(sock, opts) {
  var o = opts || {}
  var a = []
  if (o.uwsm) a.push("uwsm-app", "--")
  a.push("mpv", "--idle=yes", "--force-window=no", "--no-video", "--no-terminal", "--audio-display=no", "--keep-open=yes")
  if (num(o.volume, -1) >= 0) a.push("--volume=" + o.volume)
  a.push("--input-ipc-server=" + sock)
  return ["setsid", "-f"].concat(a)
}

// Where mpv's IPC socket goes. The socket takes the decryption key and accepts any mpv command
// (including `run`), so it must sit in a directory only this user can enter: $XDG_RUNTIME_DIR
// (0700, per user), else the plugin's private state directory. Never /tmp, where another user could
// bind the name first.
function socketPath(runtimeDir, stateDir) {
  var r = String(runtimeDir || "")
  if (/^\/./.test(r) && r.indexOf("/tmp") !== 0) return r.replace(/\/+$/, "") + "/omarchy-audible-mpv.sock"
  return String(stateDir) + "/mpv.sock"
}

// Argv for making the plugin's state directory private (owner only). The state files hold listening
// history and playback positions, so other local users must not be able to read them: the directory
// is created 0700, an older 0755 one is tightened, and any state file already there becomes 0600.
// The directory is passed as a positional argument, never interpolated into the script.
function privateDirArgs(dir) {
  return ["sh", "-c",
    "mkdir -p -m 700 -- \"$1\" && chmod 700 -- \"$1\" && { chmod 600 -- \"$1\"/*.json 2>/dev/null; true; }",
    "sh", String(dir)]
}

// Argv for making the Audible CLI's data directory and the books directory private (owner only).
// They hold the library database, the downloaded books and their covers, all named by ASIN, so
// another local user could otherwise list what this user owns and is listening to. Directories
// become 0700 (only the top two need it to lock others out; each book directory is tightened too)
// and files the CLI left world-readable become 0600. Paths are positional, never interpolated.
function privateDataDirArgs(dataDir, booksDir) {
  return ["sh", "-c",
    "for d in \"$1\" \"$2\"; do mkdir -p -m 700 -- \"$d\" && chmod 700 -- \"$d\" || exit 1; done; " +
    "find \"$1\" \"$2\" -mindepth 1 -maxdepth 2 -type d ! -perm 700 -exec chmod 700 -- {} + 2>/dev/null; " +
    "find \"$1\" \"$2\" -mindepth 1 -maxdepth 3 -type f -perm /077 -exec chmod go-rwx -- {} + 2>/dev/null; true",
    "sh", String(dataDir), String(booksDir)]
}

// argv that deletes one downloaded book, read as an ASIN from stdin, without naming it in any argv.
// $1 is the books directory. Anything but a plain ASIN on stdin does nothing.
function removeBookArgs(booksDir) {
  return ["sh", "-c",
    "IFS= read -r a || exit 1; case $a in ''|*[!A-Z0-9]*) exit 1;; esac; [ ${#a} -eq 10 ] || exit 1; " +
    "cd -- \"$1\" && cd -- \"$a\" 2>/dev/null || exit 0; find . -mindepth 1 -delete; " +
    "cd .. && find . -mindepth 1 -maxdepth 1 -type d -empty -delete",
    "sh", String(booksDir)]
}

if (typeof module !== "undefined") module.exports = {
  removeBookArgs: removeBookArgs,
  privateDirArgs: privateDirArgs,
  socketPath: socketPath,
  privateDataDirArgs: privateDataDirArgs,
  loadCommands: loadCommands,
  mpvLaunchArgs: mpvLaunchArgs,
  formatDuration: formatDuration,
  timeLeft: timeLeft,
  normalizeChapters: normalizeChapters,
  chapterIndexAt: chapterIndexAt,
  chapterProgress: chapterProgress,
  stepSpeed: stepSpeed,
  clampSpeed: clampSpeed,
  clampVolume: clampVolume,
  stepVolume: stepVolume,
  formatVolume: formatVolume,
  formatSpeed: formatSpeed,
  chapterTicks: chapterTicks,
  seekTarget: seekTarget,
  barLabel: barLabel
}
