import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

// First-run setup for stewartjarod.audible. Shows service.setup (see SetupModel.js):
// one friendly title and message, a checklist of steps, ONE primary action
// (Enter), optional secondary actions (Tab to highlight, Enter to run), and the
// sign-in link while the browser login is waiting. There is deliberately no text
// input: a native one reads the clipboard whenever another app sets it, so the
// password for a locked login is typed in a terminal (SetupModel.terminalUnlockArgs).
Item {
  id: root

  property var service: null
  // Lets a host (the bar popup) size itself to the current state's content.
  implicitHeight: column.implicitHeight + Style.spacing.popupPadding * 2
  signal closeRequested()

  // Exposed so the host panel can focus this surface's key catcher on open.
  readonly property var focusTarget: keyCatcher

  readonly property var setup: service ? service.setup : null
  readonly property string stateName: setup ? (setup.state || "") : ""
  readonly property var primary: setup && setup.primary ? setup.primary : null
  readonly property var secondary: setup && setup.secondary ? setup.secondary : []
  readonly property var steps: setup && setup.steps ? setup.steps : []
  readonly property bool primaryBusy: !!(primary && primary.busy)
  readonly property string loginUrl: service && service.loginUrl ? service.loginUrl : ""
  readonly property string logLine: service && service.setupLog ? service.setupLog : ""

  // -1 = primary action; 0..n-1 = a secondary action highlighted with Tab.
  property int secondaryIndex: -1

  readonly property color fg: Color.foreground
  readonly property color muted: Color.muted
  readonly property color accent: Color.accent
  readonly property color urgent: Color.urgent

  readonly property string legend: {
    var parts = []
    if (secondaryIndex >= 0 && secondaryIndex < secondary.length) parts.push("Enter " + secondary[secondaryIndex].label.toLowerCase())
    else if (primary && !primaryBusy) parts.push("Enter " + primary.label.toLowerCase())
    if (secondary.length > 0) parts.push("Tab options")
    parts.push("r check again")
    parts.push("Esc close")
    return parts.join("  ·  ")
  }

  function runPrimary() {
    if (!service || !primary || primaryBusy) return
    service.runSetupAction(primary.id, {})
  }

  function runSecondary(i) {
    if (!service || i < 0 || i >= secondary.length) return
    secondaryIndex = -1
    service.runSetupAction(secondary[i].id, {})
  }

  function cycleSecondary(dir) {
    var slots = secondary.length + 1
    if (slots <= 1) return
    var pos = secondaryIndex + 1
    pos = (pos + dir + slots) % slots
    secondaryIndex = pos - 1
  }

  function recheck() {
    if (service) service.runSetupAction("recheck", {})
  }

  onStateNameChanged: secondaryIndex = -1

  PanelKeyCatcher {
    id: keyCatcher
    anchors.fill: parent

    onReturnRequested: {
      if (root.secondaryIndex >= 0) root.runSecondary(root.secondaryIndex)
      else root.runPrimary()
    }
    onTabRequested: function (direction) { root.cycleSecondary(direction) }
    onCloseRequested: root.closeRequested()
    onTextKey: function (t) {
      if (t === "r") root.recheck()
    }

    Column {
      id: column
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: Style.spacing.popupPadding
      spacing: Style.spacing.panelGap

      Text {
        id: placeholder
        visible: !root.setup
        width: column.width
        text: "Checking your Audible setup…"
        color: root.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        wrapMode: Text.WordWrap
        textFormat: Text.PlainText
      }

      Column {
        visible: !!root.setup
        width: column.width
        spacing: Style.spacing.lg

        Text {
          width: parent.width
          text: root.setup ? (root.setup.title || "") : ""
          color: root.fg
          font.family: Style.font.family
          font.pixelSize: Style.font.heading
          font.weight: Font.Medium
          wrapMode: Text.WordWrap
          textFormat: Text.PlainText
        }

        Text {
          width: parent.width
          text: root.setup ? (root.setup.message || "") : ""
          color: root.fg
          opacity: 0.85
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
          lineHeight: 1.2
          textFormat: Text.PlainText
        }

        // Version notice (SetupModel.versionNotice): only when the installed audible CLI is not the pinned one.
        Text {
          width: parent.width
          visible: !!(root.setup && root.setup.notice)
          text: root.setup && root.setup.notice ? root.setup.notice : ""
          color: root.urgent
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
          lineHeight: 1.2
          textFormat: Text.PlainText
        }

        // Checklist: done / current / todo.
        Column {
          width: parent.width
          spacing: Style.spacing.xs

          Repeater {
            model: root.steps
            delegate: Row {
              required property var modelData
              readonly property string status: modelData.status || "todo"
              spacing: Style.spacing.lg
              width: parent ? parent.width : 0

              Text {
                id: glyph
                width: Style.space(14)
                horizontalAlignment: Text.AlignHCenter
                text: status === "done" ? "✓" : (status === "current" ? "●" : "○")
                color: status === "done" ? root.accent : (status === "current" ? (root.stateName === "ready" ? root.accent : root.urgent) : root.muted)
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                textFormat: Text.PlainText
              }

              Text {
                width: parent.width - glyph.width - parent.spacing
                text: modelData.label || ""
                color: status === "todo" ? root.muted : root.fg
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                font.weight: status === "current" ? Font.Medium : Font.Normal
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
              }
            }
          }
        }

        // Primary action: Enter runs it.
        Rectangle {
          id: primaryButton
          visible: !!root.primary
          width: parent.width
          height: Style.spacing.controlHeight
          radius: Style.cornerRadius
          color: root.primaryBusy
            ? "transparent"
            : Style.selectedFillFor(root.fg, root.accent)
          border.width: Style.space(1)
          border.color: root.accent
          opacity: root.primaryBusy ? 0.7 : 1

          Text {
            anchors.centerIn: parent
            text: root.primary ? root.primary.label : ""
            color: root.fg
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            font.weight: Font.Medium
            textFormat: Text.PlainText
          }

          MouseArea {
            anchors.fill: parent
            enabled: !root.primaryBusy
            cursorShape: Qt.PointingHandCursor
            onClicked: root.runPrimary()
          }
        }

        // Secondary actions: Tab highlights one, Enter runs it.
        Flow {
          width: parent.width
          spacing: Style.spacing.controlGap
          visible: root.secondary.length > 0

          Repeater {
            model: root.secondary
            delegate: Rectangle {
              required property var modelData
              required property int index
              readonly property bool highlighted: index === root.secondaryIndex
              height: Style.spacing.controlHeight
              width: secondaryText.implicitWidth + Style.spacing.controlPaddingX * 2
              radius: Style.cornerRadius
              color: highlighted ? Style.focusFillFor(root.fg, root.accent) : "transparent"
              border.width: Style.space(1)
              border.color: highlighted ? root.accent : root.muted

              Text {
                id: secondaryText
                anchors.centerIn: parent
                text: modelData.label || ""
                color: root.fg
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                textFormat: Text.PlainText
              }

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.runSecondary(index)
              }
            }
          }
        }

        // Sign-in link while the browser login waits. Plain text, not a selectable text input (that
        // would read the clipboard); a click copies it.
        Text {
          id: loginLink
          visible: root.loginUrl !== ""
          width: parent.width
          text: root.loginUrl
          color: root.accent
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WrapAnywhere
          textFormat: Text.PlainText

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: {
              Quickshell.clipboardText = root.loginUrl
              if (root.service) root.service.setupLog = "Sign-in link copied."
            }
          }
        }

        Text {
          width: parent.width
          visible: root.logLine !== ""
          text: root.logLine
          color: root.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
          textFormat: Text.PlainText
        }
      }

      Text {
        width: column.width
        text: root.legend
        color: root.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
        textFormat: Text.PlainText
      }
    }
  }
}
