#!/bin/bash
# Sourced by every omarchy-whatsapp script. Resolves the plugin root, the state
# directory, and a Node runtime new enough for Baileys.

set -euo pipefail

WA_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WA_ROOT="$(dirname "$WA_BIN_DIR")"
WA_DAEMON_DIR="$WA_ROOT/daemon"
WA_STATE_DIR="${OMARCHY_WHATSAPP_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/omarchy-whatsapp}"
WA_SOCKET="${OMARCHY_WHATSAPP_SOCKET:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/omarchy-whatsapp.sock}"

export OMARCHY_WHATSAPP_STATE="$WA_STATE_DIR"
export OMARCHY_WHATSAPP_SOCKET="$WA_SOCKET"

wa_die() {
  echo "omarchy-whatsapp: $*" >&2
  exit 1
}

# Version managers (mise, proto, fnm, nvm, volta) keep node off the default
# PATH of a systemd user unit, so probe their shim directories too.
wa_resolve_node() {
  if [[ -n ${OMARCHY_WHATSAPP_NODE:-} ]]; then
    printf '%s\n' "$OMARCHY_WHATSAPP_NODE"
    return 0
  fi

  local candidates=(
    "$(command -v node 2>/dev/null || true)"
    "$HOME/.local/share/mise/shims/node"
    "$HOME/.local/share/proto/shims/node"
    "$HOME/.local/share/fnm/aliases/default/bin/node"
    "$HOME/.volta/bin/node"
    "$HOME/.bun/bin/node"
    /usr/bin/node
    /usr/local/bin/node
  )

  local candidate major
  for candidate in "${candidates[@]}"; do
    [[ -n $candidate && -x $candidate ]] || continue
    major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if ((major >= 20)); then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

wa_node() {
  local node
  node="$(wa_resolve_node)" || wa_die "no Node.js >= 20 found. Install nodejs, or set OMARCHY_WHATSAPP_NODE=/path/to/node"
  printf '%s\n' "$node"
}

wa_ensure_deps() {
  [[ -d $WA_DAEMON_DIR/node_modules/baileys ]] && return 0

  local node npm
  node="$(wa_node)"
  npm="$(dirname "$node")/npm"
  [[ -x $npm ]] || npm="$(command -v npm 2>/dev/null || true)"
  [[ -n $npm && -x $npm ]] || wa_die "npm not found; run: (cd $WA_DAEMON_DIR && npm ci)"

  echo "omarchy-whatsapp: installing daemon dependencies (first run only)..." >&2
  # --no-bin-links keeps the plugin folder free of symlinks, which Omarchy's
  # plugin validation rejects.
  #
  # npm 12 defaults allow-git to none; baileys@6.7.24 pulls libsignal from
  # git. Fetch that public repo over HTTPS so a missing GitHub SSH key
  # cannot fail the clone (the lockfile used to record git+ssh).
  (cd "$WA_DAEMON_DIR" &&
    PATH="$(dirname "$node"):$PATH" \
    npm_config_allow_git="${npm_config_allow_git:-all}" \
    GIT_CONFIG_COUNT=2 \
    GIT_CONFIG_KEY_0='url.https://github.com/.insteadOf' \
    GIT_CONFIG_VALUE_0='ssh://git@github.com/' \
    GIT_CONFIG_KEY_1='url.https://github.com/.insteadOf' \
    GIT_CONFIG_VALUE_1='git@github.com:' \
    "$npm" ci --omit=dev --no-bin-links --no-audit --no-fund) \
    || wa_die "dependency install failed"
  find "$WA_DAEMON_DIR/node_modules" -type l -delete 2>/dev/null || true
}

WA_UNIT_NAME="omarchy-whatsapp.service"
WA_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
WA_BIN_LINK_DIR="$HOME/.local/bin"
WA_LIB_DIR="$HOME/.local/lib/omarchy-whatsapp"
WA_SWEEP_UNIT="omarchy-whatsapp-sweep.service"

wa_stop_service() {
  # A bar-widget disable unloads the QML component but does not know about
  # services started by the plugin. Keep the linked-device credentials so a
  # later re-enable can start the daemon again without another QR scan.
  systemctl --user disable --now "$WA_UNIT_NAME" >/dev/null 2>&1 || true
}

wa_ensure_cli() {
  mkdir -p "$WA_BIN_LINK_DIR"
  chmod +x "$WA_BIN_DIR"/* "$WA_DAEMON_DIR/ctl.js" 2>/dev/null || true
  local tool
  for tool in omarchy-whatsapp omarchy-whatsapp-ctl omarchy-whatsapp-focus omarchy-whatsapp-login omarchy-whatsapp-open omarchy-whatsapp-daemon; do
    ln -sfn "$WA_BIN_DIR/$tool" "$WA_BIN_LINK_DIR/$tool"
  done
}

wa_ensure_unit() {
  local node unit
  node="$(wa_node)"
  mkdir -p "$WA_UNIT_DIR"
  unit="$WA_UNIT_DIR/$WA_UNIT_NAME"
  sed -e "s|@PLUGIN_DIR@|$WA_ROOT|g" "$WA_ROOT/systemd/$WA_UNIT_NAME" >"$unit"
  if ! grep -q '^Environment=OMARCHY_WHATSAPP_NODE=' "$unit"; then
    sed -i "/^Environment=NODE_ENV=production/a Environment=OMARCHY_WHATSAPP_NODE=$node" "$unit"
  fi
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user enable "$WA_UNIT_NAME" >/dev/null 2>&1 || true
}

wa_ensure_sweep() {
  mkdir -p "$WA_LIB_DIR" "$WA_UNIT_DIR"
  cat >"$WA_LIB_DIR/sweep" <<'SWEEP'
#!/bin/bash
# Installed outside the plugin folder so it still runs after `omarchy plugin remove`.
set -euo pipefail
plugin="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/io.github.ricky.whatsapp"
[[ -d $plugin ]] && exit 0
systemctl --user disable --now omarchy-whatsapp.service >/dev/null 2>&1 || true
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/omarchy-whatsapp.service"
rm -f "$HOME/.local/bin/omarchy-whatsapp" \
  "$HOME/.local/bin/omarchy-whatsapp-ctl" \
  "$HOME/.local/bin/omarchy-whatsapp-focus" \
  "$HOME/.local/bin/omarchy-whatsapp-login" \
  "$HOME/.local/bin/omarchy-whatsapp-open" \
  "$HOME/.local/bin/omarchy-whatsapp-daemon"
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/omarchy-whatsapp" \
  "${XDG_CACHE_HOME:-$HOME/.cache}/omarchy-whatsapp"
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/omarchy-whatsapp-sweep.service"
rm -rf "$HOME/.local/lib/omarchy-whatsapp"
systemctl --user daemon-reload >/dev/null 2>&1 || true
SWEEP
  chmod +x "$WA_LIB_DIR/sweep"
  cat >"$WA_UNIT_DIR/$WA_SWEEP_UNIT" <<EOF
[Unit]
Description=Remove leftover WhatsApp bridge files if the plugin is gone
After=default.target

[Service]
Type=oneshot
ExecStart=$WA_LIB_DIR/sweep

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user enable "$WA_SWEEP_UNIT" >/dev/null 2>&1 || true
}

# Idempotent first-run setup so `omarchy plugin add --enable` is enough.
# The plugin manager never runs install.sh.
wa_ensure_setup() {
  chmod +x "$WA_BIN_DIR"/* "$WA_DAEMON_DIR/ctl.js" 2>/dev/null || true
  wa_ensure_deps
  wa_ensure_cli
  wa_ensure_unit
  wa_ensure_sweep
}

wa_purge_state() {
  rm -rf "$WA_STATE_DIR" \
    "${XDG_CACHE_HOME:-$HOME/.cache}/omarchy-whatsapp"
}

wa_uninstall() {
  systemctl --user disable --now "$WA_UNIT_NAME" >/dev/null 2>&1 || true
  systemctl --user disable --now "$WA_SWEEP_UNIT" >/dev/null 2>&1 || true
  rm -f "$WA_UNIT_DIR/$WA_UNIT_NAME" "$WA_UNIT_DIR/$WA_SWEEP_UNIT"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  local tool
  for tool in omarchy-whatsapp omarchy-whatsapp-ctl omarchy-whatsapp-focus omarchy-whatsapp-login omarchy-whatsapp-open omarchy-whatsapp-daemon; do
    [[ -L $WA_BIN_LINK_DIR/$tool || -f $WA_BIN_LINK_DIR/$tool ]] && rm -f "$WA_BIN_LINK_DIR/$tool"
  done
  wa_purge_state
  rm -rf "$WA_LIB_DIR"
}

wa_daemon_running() {
  [[ -S $WA_SOCKET ]] || return 1
  "$(wa_node)" "$WA_DAEMON_DIR/ctl.js" ping >/dev/null 2>&1
}
