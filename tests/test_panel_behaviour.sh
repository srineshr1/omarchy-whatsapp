#!/usr/bin/env bash
# The panel is loaded by the shell, and a QML object that cannot be created
# takes the whole panel with it: the warning is in the log, and the panel does
# not open. The decisions the panel makes are also made only in the panel.
#
# qmllint does not catch the first one: it checks the signals of the files
# whose types it can resolve, and it says nothing about the signals of this
# one. So the panel is loaded here, in a shell of its own, and the log and
# the decisions are read.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
SHELL_DIR="${OMARCHY_PATH:-/usr/share/omarchy}/shell"

if ! command -v qs >/dev/null 2>&1; then
  echo "panel runtime: FAIL, no quickshell on this machine"
  echo "  the panel is a plugin of the Omarchy shell: without it there is nothing to check"
  exit 1
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# Expose the host shell modules under their declared qs namespace.
ln -s "$SHELL_DIR" "$scratch/qs"
sed "s|PANEL_PATH|$ROOT/Panel.qml|" "$HERE/panel_behaviour.qml" > "$scratch/shell.qml"

out=$(QML2_IMPORT_PATH="$scratch" timeout 10 qs -p "$scratch" 2>&1)

# Any warning about the panel is a warning about a panel that may not open.
broken=$(echo "$out" | grep -E "WARN|ERROR" | grep -F "$ROOT/Panel.qml" | head -10)
if [ -n "$broken" ]; then
  echo "panel runtime: FAIL, the panel loaded with a warning"
  echo "$broken"
  exit 1
fi

if ! echo "$out" | grep -q "PANEL_BEHAVIOUR_OK"; then
  echo "panel runtime: FAIL, the panel did not load or did not behave"
  echo "$out" | grep -E "PANEL_BEHAVIOUR|TypeError|ReferenceError|is not a function|is not defined" | head -10
  exit 1
fi

echo "panel runtime: OK, the panel loads without a warning and behaves"
