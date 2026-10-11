import QtQuick
import Quickshell.Io

// One-shot command runner; Service.run() creates it and it destroys itself when done.
//   done(exitCode, stdoutText, stderrText)
// stdout is collected in one piece (the library API call prints ~2 MB / 57k lines, and any
// per-line handling of that on the shell's main thread stalls the whole shell).
// `input` is written to stdin once, then stdin is closed, so secrets never touch argv.
// For commands that report progress line by line, see CmdLines.qml.
Process {
  id: proc

  property var done: null
  property string input: ""
  property var extraEnv: null   // {NAME: value} added to the environment (secrets go here, never in argv)

  stdinEnabled: input.length > 0

  Component.onCompleted: { if (proc.extraEnv) proc.environment = proc.extraEnv }

  stdout: StdioCollector { id: out; waitForEnd: true }
  stderr: StdioCollector { id: err; waitForEnd: true }

  onStarted: {
    if (proc.input.length > 0) {
      proc.write(proc.input)
      proc.input = ""
      proc.stdinEnabled = false
    }
  }

  onExited: function(exitCode) {
    var cb = proc.done
    proc.done = null
    if (typeof cb === "function") cb(exitCode, String(out.text || ""), String(err.text || ""))
    proc.destroy(50)
  }
}
