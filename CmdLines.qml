import QtQuick
import Quickshell.Io

// Like Cmd.qml, but also calls line(text) for every stdout AND stderr line as it arrives (the
// sign-in server prints its URL on stderr; sync prints progress). done() still gets the two
// streams separately. Only use it for commands with short
// output: lines are kept in a plain JS array (never in a growing QML string property).
Process {
  id: proc

  property var done: null
  property var line: null
  property string input: ""
  property var extraEnv: null   // {NAME: value} added to the environment (secrets go here, never in argv)

  property var _lines: []
  property var _errLines: []

  stdinEnabled: input.length > 0

  Component.onCompleted: { if (proc.extraEnv) proc.environment = proc.extraEnv }

  stdout: SplitParser {
    splitMarker: "\n"
    onRead: function(data) {
      proc._lines.push(String(data)); if (proc._lines.length > 400) proc._lines.shift()
      if (typeof proc.line === "function") proc.line(String(data))
    }
  }
  stderr: SplitParser {
    splitMarker: "\n"
    onRead: function(data) {
      proc._errLines.push(String(data)); if (proc._errLines.length > 400) proc._errLines.shift()
      if (typeof proc.line === "function") proc.line(String(data))
    }
  }

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
    if (typeof cb === "function") cb(exitCode, out, proc._errLines.join("\n"))
    proc.destroy(50)
  }
}
