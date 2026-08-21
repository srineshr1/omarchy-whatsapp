#!/bin/bash

set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/omarchy-whatsapp-test.XXXXXX")"
trap 'rm -r -- "$tmp_dir"' EXIT

log_file="$tmp_dir/systemctl.log"
mkdir -p "$tmp_dir/bin"
cat >"$tmp_dir/bin/systemctl" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >>"$TEST_SYSTEMCTL_LOG"
EOF
chmod +x "$tmp_dir/bin/systemctl"

TEST_SYSTEMCTL_LOG="$log_file" PATH="$tmp_dir/bin:$PATH" \
  "$repo_dir/bin/omarchy-whatsapp-stop"

expected='--user disable --now omarchy-whatsapp.service'
actual="$(<"$log_file")"
[[ "$actual" == "$expected" ]] || {
  printf 'expected systemctl call %q, got %q\n' "$expected" "$actual" >&2
  exit 1
}

echo "lifecycle stop helper: OK"
