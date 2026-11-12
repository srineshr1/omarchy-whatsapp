#!/usr/bin/env bash
# Exercise the real QML toggle with an isolated CLI, never the user's settings.
set -euo pipefail
ROOT="${WHATSAPP_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
command -v qs >/dev/null || { echo 'notification bell: SKIP (quickshell unavailable)'; exit 0; }
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin"
ln -s "${OMARCHY_PATH:-/usr/share/omarchy}/shell" "$scratch/qs"
export BELL_CALLS="$scratch/calls"
cat > "$scratch/bin/omarchy" <<'SH'
#!/bin/sh
if [ "${BELL_FAIL:-0}" = 1 ]; then exit 1; fi
printf '%s\n' "$*" >> "$BELL_CALLS"
SH
chmod +x "$scratch/bin/omarchy"
cat > "$scratch/shell.qml" <<EOF
import QtQuick
import Quickshell
import QtTest
ShellRoot {
  TestCase { id: probe; when: false }
  QtObject {
    id: barStub
    property color barForeground: "#cacccc"
    property color foreground: "#cacccc"
    property color urgent: "#ff5555"
    property string fontFamily: "sans-serif"
    function switchPanelFrom() { return false }
  }
  property int stage: 0
  property bool failMode: Quickshell.env("BELL_FAIL") === "1"
  function check(ok, label) {
    if (!ok) { console.error("BELL_FAIL: " + label); Qt.exit(1); return false }
    return true
  }
  Loader {
    id: loader
    source: "$ROOT/Panel.qml"
    onLoaded: {
      item.bar = barStub
      item.settings = { notifications: "On", notificationSound: "On" }
      if (!check(item.alertsEnabled === true, "default bell state")) return
      var bell = probe.findChild(item, "notificationBell")
      if (!check(bell !== null, "bell button exists")) return
      if (!check(bell.iconText === "\\uf0f3", "enabled bell icon")) return
      bell.clicked()
      check(item.notificationUpdatePending, "click starts persistence")
      bell.clicked() // A second click while saving must not start another write.
    }
  }
  Timer {
    interval: 40
    running: loader.status === Loader.Ready
    repeat: true
    onTriggered: {
      var panel = loader.item
      if (panel.notificationUpdatePending) return
      if (failMode) {
        if (check(panel.statusLine === "Could not update notification settings", "save failure is visible")
            && check(panel.alertsEnabled, "failed save leaves settings unchanged")) {
          console.log("BELL_OK"); Qt.exit(0)
        }
        return
      }
      if (stage === 0) {
        panel.settings = { notifications: "Off", notificationSound: "Off" }
        if (!check(panel.alertsEnabled === false, "muted bell state")) return
        var bell = probe.findChild(panel, "notificationBell")
        if (!check(bell.iconText === "\\uf1f6", "slashed bell icon")) return
        bell.clicked()
        stage = 1
      } else {
        panel.settings = { notifications: "On", notificationSound: "Off" }
        if (!check(panel.alertsEnabled === true, "silent popups still count as enabled")) return
        panel.settings = { notifications: "Off", notificationSound: "On" }
        if (!check(panel.alertsEnabled === true, "sound-only still counts as enabled")) return
        console.log("BELL_OK"); Qt.exit(0)
      }
    }
  }
  Timer { interval: 5000; running: true; onTriggered: { console.error("BELL_FAIL: timeout"); Qt.exit(1) } }
}
EOF
export PATH="$scratch/bin:$PATH"
for mode in 0 1; do
  : > "$BELL_CALLS"
  if ! output=$(BELL_FAIL="$mode" QML2_IMPORT_PATH="$scratch" timeout 10 qs -p "$scratch" 2>&1); then
    printf '%s\n' "$output"
    exit 1
  fi
  if ! grep -q BELL_OK <<< "$output"; then printf '%s\n' "$output"; exit 1; fi
  if [[ $mode == 0 ]]; then
    expected=$(printf 'bar set io.github.ricky.whatsapp notifications Off\nbar set io.github.ricky.whatsapp notificationSound Off\nbar set io.github.ricky.whatsapp notifications On\nbar set io.github.ricky.whatsapp notificationSound On')
    [[ $(< "$BELL_CALLS") == "$expected" ]]
  else
    [[ ! -s "$BELL_CALLS" ]]
  fi
done
echo 'notification bell: OK (mute, unmute, mixed settings, save failure)'
