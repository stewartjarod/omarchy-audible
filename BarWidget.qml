import QtQuick
import qs.Commons
import qs.Ui
import "PlayerModel.js" as Model

// Audible bar widget. The Service lives on the shell (one per shell), so this
// widget only reads it. The bar is instantiated once per monitor, so this file
// adds no IPC target; the Service owns that.
BarWidget {
  id: root
  moduleName: "jarod.audible"

  readonly property var service: bar?.shell?.serviceFor("jarod.audible") ?? null
  readonly property bool ready: service ? service.ready === true : false
  readonly property bool hasBook: service ? service.hasBook === true : false
  readonly property bool paused: service ? service.paused === true : true

  readonly property var label: Model.barLabel({
    title: service ? (service.title || "") : "",
    position: service ? Number(service.position) || 0 : 0,
    duration: service ? Number(service.duration) || 0 : 0,
    speed: service ? Number(service.speed) || 1 : 1,
    playing: service ? service.playing === true : false,
    hasBook: hasBook,
    setupReady: ready
  }, { maxTitle: Number(root.setting("maxTitleChars", 28)) || 28 })

  // The bar text is only shown while a book is actually playing; paused or idle is icon-only.
  // Exception: while a book is being downloaded or started, say so (otherwise the bar is silent for
  // the whole download).
  readonly property string barText: {
    if (!service) return ""
    if (service.playing === true) return root.label.text
    return service.pendingStatus ? String(service.pendingStatus) : ""
  }

  // Icon tooltip: the playback summary, or an offer to continue the last book when idle.
  readonly property string iconTip: {
    if (hasBook) return root.label.tooltip
    var b = service ? service.lastBook : null
    return b && b.title ? "Continue: " + b.title : root.label.tooltip
  }

  readonly property string bookGlyph: "\uDB80\uDCBA" // nerd-font book icon, U+F00BA
  readonly property int labelMaxWidth: Style.space(260)

  // ---- panel lifecycle, forwarded for shell.summon/hide/toggle routing ----
  //      Bar.findPanelWidget requires open/close/opened on the bar-widget root.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  // ---- player commands from the bar -----------------------------------------
  function togglePause() { if (service) service.togglePause() }
  function openLibrary() { if (service) service.openLibrary() }
  function stepSpeed(dir) { if (service) service.stepSpeed(dir) }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("service" in target) target.service = root.service
    if ("anchorItem" in target) target.anchorItem = popupAnchor
    if ("hostWidget" in target) target.hostWidget = root
  }

  // The Service is shared by every bar instance; the widget's shell.json settings are
  // pushed into it (speed step/limits, skip length).
  function pushSettings() { if (service && "applySettings" in service) service.applySettings(root.settings) }

  onBarChanged: injectPanel()
  onSettingsChanged: { pushSettings(); injectPanel() }
  onServiceChanged: { pushSettings(); injectPanel() }

  // The Service asks for the popup (e.g. after a summon). Only open it here if
  // it is not already open, so one request opens one popup.
  Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onPopupRequested() { if (!root.opened) root.open() }
  }

  implicitWidth: button.implicitWidth + (labelButton.visible ? labelButton.implicitWidth : 0)
  implicitHeight: button.implicitHeight

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // The popup opens from the right edge of the whole widget (icon + text). The text only shows
  // while playing, which moves the icon; the right edge stays put, so the popup does not jump
  // when you pause or stop. The popup centres on its anchor, so the anchor is as wide as the popup
  // and pinned to the widget's right edge, making the popup's right edge line up with it.
  Item {
    id: popupAnchor
    width: Style.space(360)
    height: parent.height
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    opacity: 0
    enabled: false
  }

  // The icon is the fixed anchor: pinned to the widget's right edge, so it never moves when the text
  // appears (playing) or disappears (paused). The text grows to its left. This widget is the first in
  // its section, so nothing else on the bar shifts either.
  BarIconButton {
    id: button
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    bar: root.bar
    text: root.bookGlyph
    // Glyph turns urgent when setup is needed; dims while paused.
    active: !root.ready
    dimmed: root.hasBook && root.paused
    tooltipText: root.iconTip
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) root.openLibrary()
      else if (buttonCode === Qt.MiddleButton) root.togglePause()
      else root.togglePanel()
    }
    onWheelMoved: function(delta) {
      if (delta > 0) root.stepSpeed(1)
      else if (delta < 0) root.stepSpeed(-1)
    }
  }

  // The title / time-left text is its own bar click target (same primitive as the icon), so
  // clicking it opens the popup, right-click opens the library, middle-click plays/pauses and
  // the wheel changes speed, exactly like the icon.
  WidgetButton {
    id: labelButton
    anchors.right: button.left
    anchors.verticalCenter: parent.verticalCenter
    bar: root.bar
    visible: !root.vertical && root.barText !== "" && root.ready
    text: root.barText
    horizontalMargin: 4
    dimmed: root.hasBook && root.paused
    tooltipText: root.label.tooltip
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) root.openLibrary()
      else if (buttonCode === Qt.MiddleButton) root.togglePause()
      else root.togglePanel()
    }
    onWheelMoved: function(delta) {
      if (delta > 0) root.stepSpeed(1)
      else if (delta < 0) root.stepSpeed(-1)
    }
  }
}
