import QtQuick
import Quickshell.Io

// Like Cmd.qml, but also calls line(text) for every stdout line as it arrives (the sign-in
// server prints its URL early; sync prints progress). Only use it for commands with short
// output: lines are kept in a plain JS array (never in a growing QML string property).
Process {
  id: proc

  property var done: null
  property var line: null
  property string input: ""

  property var _lines: []

  stdinEnabled: input.length > 0

  stdout: SplitParser {
    splitMarker: "\n"
    onRead: function(data) {
      proc._lines.push(String(data))
      if (typeof proc.line === "function") proc.line(String(data))
    }
  }
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
    var out = proc._lines.join("\n")
    proc.done = null
    proc.line = null
    if (typeof cb === "function") cb(exitCode, out, String(err.text || ""))
    proc.destroy(50)
  }
}
