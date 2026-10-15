.pragma library

// How every command the plugin starts is wrapped. Pure: builds argv, runs nothing.
//   - A fixed PATH, never the shell's inherited one. System directories come first, so a file in the
//     user-writable ~/.local/bin can only add a tool (audible-rs lives there), never shadow one.
//   - A deadline: GNU timeout is the outermost process. It runs the command in its own process
//     group, so the deadline, or a signal sent to it (cancelling the sign-in), stops the whole group.
//   - A byte ceiling on the producer side: stdout and stderr go through `head -c`, so a runaway or
//     hostile reply cannot grow the shell's memory without bound. Going over the ceiling ends the
//     command (SIGPIPE), and the caller sees a failure instead of a truncated reply.

var SAFE_PATH = "/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
var PATH_LINE = "PATH=\"" + SAFE_PATH + "\"; export PATH"
var STDOUT_MAX = 32 * 1024 * 1024   // the full library reply is about 2 MB
var STDERR_MAX = 1024 * 1024
var DEFAULT_DEADLINE_SEC = 120
var KILL_AFTER_SEC = 5               // SIGKILL if the command ignores the deadline's SIGTERM

// The capped runner, run by timeout. Exit status: the command's own, >128 when it was stopped by a
// signal, or 141 when its stdout went over the ceiling (checked, not inferred from SIGPIPE: output
// that still fits the pipe never raises one). Over-long stderr is only cut short.
// fds: 3 = real stdout, 4 = into the stdout ceiling, 5 = status channel ($? and an overflow mark).
var CAPPED = "exec 3>&1; " +
  "rc=$( { { { \"$@\" 3>&- 4>&- 5>&-; echo $? >&5; } 2>&1 1>&4 4>&- | head -c " + STDERR_MAX + " >&2 3>&- 4>&- 5>&-; } " +
  "4>&1 | { head -c " + STDOUT_MAX + " >&3; [ \"$(head -c 1 | wc -c)\" -eq 0 ] || echo X >&5; } 4>&-; } 5>&1 ); " +
  "case $rc in *X*) exit 141;; esac; rc=$(printf %s \"$rc\" | tr -dc 0-9); exit \"${rc:-1}\""

function deadlineOf(sec) {
  var n = Math.round(Number(sec))
  return isFinite(n) && n >= 1 ? n : DEFAULT_DEADLINE_SEC
}

// argv for Quickshell's Process: argv runs with the safe PATH, a deadline and output ceilings.
function wrap(argv, deadlineSec) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("empty command")
  return ["/bin/sh", "-c", PATH_LINE + "; t=$1; shift; exec timeout -k " + KILL_AFTER_SEC + " \"$t\" /bin/sh -c '" + CAPPED + "' sh \"$@\"",
    "sh", String(deadlineOf(deadlineSec))].concat(argv.map(String))
}

// argv for Quickshell.execDetached: the same fixed PATH, no deadline (players and terminals live on).
function detached(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("empty command")
  return ["/bin/sh", "-c", PATH_LINE + "; exec \"$@\"", "sh"].concat(argv.map(String))
}

if (typeof module !== "undefined") module.exports = { SAFE_PATH, PATH_LINE, STDOUT_MAX, STDERR_MAX, DEFAULT_DEADLINE_SEC, deadlineOf, wrap, detached }
