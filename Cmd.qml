import QtQuick
import Quickshell.Io

// One-shot command runner. Create with Service.run(); it destroys itself when done.
//   done(exitCode, stdoutText, stderrText)
// `line` (optional) receives each stdout line as it arrives (for long-running commands
// like the sign-in server). `input` is written to stdin once, then stdin is closed, so
// secrets never touch argv.
Process {
  id: proc

  property var done: null
  property var line: null
  property string input: ""

  stdinEnabled: input.length > 0

  stdout: SplitParser {
    splitMarker: "\n"
    onRead: function(data) {
      proc._out += data + "\n"
      if (typeof proc.line === "function") proc.line(String(data))
    }
  }
  stderr: StdioCollector { id: err; waitForEnd: true }

  property string _out: ""

  onStarted: {
    if (proc.input.length > 0) {
      proc.write(proc.input)
      proc.input = ""
      proc.stdinEnabled = false
    }
  }

  onExited: function(exitCode) {
    var cb = proc.done
    var out = proc._out
    var errText = String(err.text || "")
    proc.done = null
    proc.line = null
    if (typeof cb === "function") cb(exitCode, out, errText)
    proc.destroy(50)
  }
}
