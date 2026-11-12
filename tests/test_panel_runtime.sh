#!/usr/bin/env bash
# The panel is loaded by the shell, and a QML object that cannot be created
# takes the whole panel with it: the warning is in the log, and the panel does
# not open.
#
# qmllint does not catch it: it checks the signals of the files whose types it
# can resolve, and it says nothing about the signals of this one. So the
# panel is loaded here, in a shell of its own, and the log is read.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
SHELL_DIR="${OMARCHY_PATH:-/usr/share/omarchy}/shell"

if ! command -v qs >/dev/null 2>&1; then
  echo "panel runtime: SKIP, no quickshell on this machine"
  exit 0
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
ln -s "$SHELL_DIR" "$scratch/qs"

# The panel is loaded on its own, without the bar of the shell, so the bar is
# a stub here. Without it the panel says the colour of the bar is undefined,
# which is the harness talking and not the panel.
cat > "$scratch/shell.qml" <<EOF
import QtQuick
import Quickshell

ShellRoot {
  QtObject {
    id: barStub
    property color barForeground: "#cacccc"
    property color foreground: "#cacccc"
    property color urgent: "#ff5555"
    property string fontFamily: "sans-serif"
    function switchPanelFrom() { return false }
  }

  // The client is a file of its own, and the panel only uses the one the bar
  // hands it: it is loaded here too, or its QML would never be checked.
  Loader {
    id: clientLoader
    source: "$ROOT/WhatsAppClient.qml"
    onLoaded: {
      clientLoader.item.pluginDir = ""
      clientLoader.item.autostartDaemon = false
      clientLoader.item.socketPath = ""
      console.log("CLIENT_LOADED")
    }
  }

  Loader {
    id: loader
    source: "$ROOT/Panel.qml"
    onLoaded: {
      loader.item.bar = barStub
      console.log("PANEL_LOADED")
      Qt.exit(0)
    }
  }
}
EOF

out=$(QML2_IMPORT_PATH="$scratch" timeout 30 qs -p "$scratch" 2>&1)

if ! echo "$out" | grep -q "PANEL_LOADED"; then
  echo "panel runtime: FAIL, the panel did not load"
  echo "$out" | grep -iE "cannot assign|is not a type|no matching|is not a function|TypeError" | head -10
  exit 1
fi

if ! echo "$out" | grep -q "CLIENT_LOADED"; then
  echo "panel runtime: FAIL, the client did not load"
  echo "$out" | grep -iE "cannot assign|is not a type|no matching|is not a function|TypeError" | head -10
  exit 1
fi

broken=$(echo "$out" | grep -iE "cannot assign to non-existent property|is not a type|no matching signal|is not a function" | head -10)
if [ -n "$broken" ]; then
  echo "panel runtime: FAIL, the panel loaded with a warning"
  echo "$broken"
  exit 1
fi

echo "panel runtime: OK, the panel loads without a warning"
