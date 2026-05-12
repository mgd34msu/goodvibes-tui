import { resolve } from 'node:path';

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderQemuWrapperTemplate(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

mode="\${GV_SANDBOX_WRAPPER_MODE:-\${GOODVIBES_QEMU_WRAPPER_MODE:-ssh-guest}}"
script_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
host="\${GV_SANDBOX_GUEST_HOST:-\${GOODVIBES_QEMU_GUEST_HOST:-127.0.0.1}}"
port="\${GV_SANDBOX_GUEST_PORT:-\${GOODVIBES_QEMU_GUEST_PORT:-2222}}"
user="\${GV_SANDBOX_GUEST_USER:-\${GOODVIBES_QEMU_GUEST_USER:-goodvibes}}"
workspace="\${GV_SANDBOX_GUEST_WORKSPACE:-\${GOODVIBES_QEMU_WORKSPACE:-/workspace}}"
workspace_root="\${GV_SANDBOX_WORKSPACE_ROOT:-$PWD}"
qemu_bin="\${GV_SANDBOX_QEMU_BINARY:-\${GOODVIBES_QEMU_BINARY:-qemu-system-x86_64}}"
qemu_image="\${GV_SANDBOX_QEMU_IMAGE:-\${GOODVIBES_QEMU_IMAGE:-$script_dir/goodvibes-sandbox.qcow2}}"
ssh_key="\${GV_SANDBOX_SSH_KEY:-\${GOODVIBES_QEMU_SSH_KEY:-$script_dir/keys/goodvibes_qemu_ed25519}}"
known_hosts="\${GV_SANDBOX_KNOWN_HOSTS:-$script_dir/known_hosts}"
logs_dir="\${GV_SANDBOX_LOGS_DIR:-$script_dir/logs}"
run_dir="\${GV_SANDBOX_RUN_DIR:-$script_dir/run}"
seed_iso="\${GV_SANDBOX_SEED_ISO:-$script_dir/seed/nocloud.iso}"
ssh_timeout="\${GOODVIBES_QEMU_SSH_TIMEOUT:-300}"

mkdir -p "$logs_dir" "$run_dir"

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known_hosts" -p "$port")
if [[ -f "$ssh_key" ]]; then
  chmod 600 "$ssh_key" 2>/dev/null || true
  ssh_opts=(-i "$ssh_key" "\${ssh_opts[@]}")
fi

shell_quote() {
  printf '%q' "$1"
}

remote_command() {
  local remote="export PATH=\\$HOME/.bun/bin:\\$HOME/.deno/bin:\\$HOME/.local/bin:\\$PATH; cd $(shell_quote "$workspace") && exec"
  for arg in "$@"; do
    remote+=" $(shell_quote "$arg")"
  done
  printf '%s' "$remote"
}

wait_for_ssh() {
  local timeout="$1"
  local start now
  start="$(date +%s)"
  while true; do
    if ssh "\${ssh_opts[@]}" "$user@$host" "true" >/dev/null 2>&1; then
      return 0
    fi
    now="$(date +%s)"
    if (( now - start >= timeout )); then
      echo "Timed out waiting for SSH on $host:$port" >&2
      return 1
    fi
    sleep 2
  done
}

sync_workspace() {
  if [[ "\${GV_SANDBOX_SYNC_WORKSPACE:-1}" == "0" ]]; then
    return 0
  fi
  tar -C "$workspace_root" \\
    --exclude='./.git' \\
    --exclude='./.goodvibes/tui/sandbox' \\
    -cf - . \\
    | ssh "\${ssh_opts[@]}" "$user@$host" "mkdir -p $(shell_quote "$workspace") && tar -C $(shell_quote "$workspace") -xf -"
}

run_guest_command() {
  ssh "\${ssh_opts[@]}" "$user@$host" "$(remote_command "$@")"
}

start_qemu() {
  if [[ ! -f "$qemu_image" ]]; then
    echo "QEMU image not found: $qemu_image" >&2
    return 1
  fi
  local pidfile="$run_dir/qemu-$port.pid"
  local serial_log="$logs_dir/serial-$port.log"
  local qemu_log="$logs_dir/qemu-$port.log"
  local monitor_sock="$run_dir/monitor-$port.sock"
  rm -f "$monitor_sock"
  if [[ -f "$pidfile" ]]; then
    local old_pid
    old_pid="$(<"$pidfile")"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      return 0
    fi
    rm -f "$pidfile"
  fi
  local qemu_args=(
    -display none
    -serial "file:$serial_log"
    -monitor "unix:$monitor_sock,server,nowait"
    -m "\${GOODVIBES_QEMU_MEMORY:-1024}"
    -smp "\${GOODVIBES_QEMU_CPUS:-2}"
    -drive "file=$qemu_image,if=virtio,format=qcow2"
    -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$port-:22"
    -device "virtio-net-pci,netdev=net0"
    -smbios "type=1,serial=ds=nocloud"
  )
  if [[ -r "$seed_iso" ]]; then
    qemu_args+=( -drive "file=$seed_iso,if=virtio,media=cdrom,readonly=on" )
  fi
  if [[ -e /dev/kvm && -r /dev/kvm && -w /dev/kvm && "\${GOODVIBES_QEMU_ENABLE_KVM:-1}" != "0" ]]; then
    qemu_args=( -enable-kvm "\${qemu_args[@]}" )
  fi
  "$qemu_bin" "\${qemu_args[@]}" >"$qemu_log" 2>&1 &
  echo "$!" > "$pidfile"
}

stop_qemu() {
  local pidfile="$run_dir/qemu-$port.pid"
  local pid=""
  if [[ -f "$pidfile" ]]; then
    pid="$(<"$pidfile")"
  fi
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile" "$run_dir/monitor-$port.sock"
}

if [[ "$mode" == "host-exec" ]]; then
  exec "$@"
fi

if [[ "$mode" == "ssh-guest" ]]; then
  wait_for_ssh "$ssh_timeout"
  sync_workspace
  run_guest_command "$@"
  exit $?
fi

if [[ "$mode" == "launch-qemu-ssh" ]]; then
  start_qemu
  trap stop_qemu EXIT
  wait_for_ssh "$ssh_timeout"
  sync_workspace
  run_guest_command "$@"
  exit $?
fi

echo "Unknown GV_SANDBOX_WRAPPER_MODE: $mode" >&2
exit 2
`;
}

export function renderQemuImageCreateScript(directory: string, imagePath: string, sizeGb: number): string {
  const baseImage = resolve(directory, 'images/debian-12-genericcloud-amd64.qcow2');
  const seedIso = resolve(directory, 'seed/nocloud.iso');
  return `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="\${GOODVIBES_QEMU_BASE_IMAGE_URL:-https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2}"
BASE_IMAGE="\${GOODVIBES_QEMU_BASE_IMAGE:-${baseImage}}"
TARGET_IMAGE="\${1:-${imagePath}}"
SIZE="\${2:-${sizeGb}G}"
SEED_DIR="$SCRIPT_DIR/seed"
SEED_ISO="\${GOODVIBES_QEMU_SEED_ISO:-${seedIso}}"

mkdir -p "$(dirname "$BASE_IMAGE")" "$(dirname "$TARGET_IMAGE")" "$SEED_DIR"

if [[ ! -f "$BASE_IMAGE" ]]; then
  if command -v curl >/dev/null 2>&1; then
    curl -fL "$BASE_URL" -o "$BASE_IMAGE"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$BASE_IMAGE" "$BASE_URL"
  else
    echo "curl or wget is required to download $BASE_URL" >&2
    exit 1
  fi
fi

cp "$BASE_IMAGE" "$TARGET_IMAGE"
qemu-img resize "$TARGET_IMAGE" "$SIZE" >/dev/null

if command -v xorriso >/dev/null 2>&1; then
  ( cd "$SEED_DIR" && xorriso -as mkisofs -quiet -output "$SEED_ISO" -volid CIDATA -joliet -rock user-data meta-data network-config )
elif command -v genisoimage >/dev/null 2>&1; then
  ( cd "$SEED_DIR" && genisoimage -quiet -output "$SEED_ISO" -volid CIDATA -joliet -rock user-data meta-data network-config )
elif command -v mkisofs >/dev/null 2>&1; then
  ( cd "$SEED_DIR" && mkisofs -quiet -output "$SEED_ISO" -volid CIDATA -joliet -rock user-data meta-data network-config )
else
  echo "xorriso, genisoimage, or mkisofs is required to build $SEED_ISO" >&2
  exit 1
fi

chmod 600 "$SCRIPT_DIR/keys/goodvibes_qemu_ed25519" 2>/dev/null || true
echo "QEMU image ready: $TARGET_IMAGE"
echo "NoCloud seed ready: $SEED_ISO"
`;
}

export function renderQemuGuestBootstrapScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

sudo apt-get update
sudo apt-get install -y \\
  ca-certificates \\
  curl \\
  wget \\
  git \\
  jq \\
  tar \\
  unzip \\
  xz-utils \\
  build-essential \\
  python3 \\
  python3-pip \\
  python3-venv \\
  nodejs \\
  npm \\
  sqlite3 \\
  postgresql-client \\
  mariadb-client \\
  openssh-server \\
  ripgrep \\
  fd-find \\
  shellcheck \\
  make \\
  pkg-config \\
  libssl-dev \\
  python3-dev \\
  golang \\
  cargo \\
  ruby \\
  ruby-dev

if command -v fdfind >/dev/null 2>&1 && ! command -v fd >/dev/null 2>&1; then
  sudo ln -sf /usr/bin/fdfind /usr/local/bin/fd
fi

if command -v npm >/dev/null 2>&1; then
  sudo npm install -g typescript tsx ts-node graphql || true
  sudo npm install -g graphql-cli || true
fi

if [[ "\${GOODVIBES_QEMU_INSTALL_BUN:-1}" == "1" ]]; then
  curl -fsSL https://bun.sh/install | bash || true
fi

if [[ "\${GOODVIBES_QEMU_INSTALL_DENO:-1}" == "1" ]]; then
  curl -fsSL https://deno.land/install.sh | sh || true
fi

if [[ "\${GOODVIBES_QEMU_INSTALL_UV:-1}" == "1" ]]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh || true
fi

if [[ "\${GOODVIBES_QEMU_INSTALL_DUCKDB:-1}" == "1" ]]; then
  curl https://install.duckdb.org | sh || true
fi

if [[ -x "$HOME/.bun/bin/bun" ]]; then
  sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi
if [[ -x "$HOME/.deno/bin/deno" ]]; then
  sudo ln -sf "$HOME/.deno/bin/deno" /usr/local/bin/deno
fi
if [[ -x "$HOME/.local/bin/uv" ]]; then
  sudo ln -sf "$HOME/.local/bin/uv" /usr/local/bin/uv
fi
if [[ -x "$HOME/.duckdb/cli/latest/duckdb" ]]; then
  sudo ln -sf "$HOME/.duckdb/cli/latest/duckdb" /usr/local/bin/duckdb
fi

grep -qxF 'export PATH="$HOME/.bun/bin:$HOME/.deno/bin:$HOME/.local/bin:$PATH"' "$HOME/.profile" 2>/dev/null \\
  || echo 'export PATH="$HOME/.bun/bin:$HOME/.deno/bin:$HOME/.local/bin:$PATH"' >> "$HOME/.profile"

mkdir -p /workspace
sudo chown goodvibes:goodvibes /workspace

echo "GoodVibes guest bootstrap complete."
`;
}

export function renderQemuSetupReadme(directory: string, imagePath: string, seedIsoPath: string): string {
  return `GoodVibes QEMU sandbox bootstrap bundle

Host prerequisites:
  qemu-system-x86_64 qemu-img ssh ssh-keygen curl-or-wget xorriso-or-genisoimage
  KVM is optional but strongly recommended: /dev/kvm

Generated files:
  qemu-wrapper.sh                         launch/attach wrapper used by GoodVibes
  create-image.sh                         downloads Debian 12 cloud image, clones it, resizes it, builds NoCloud ISO
  guest-bootstrap.sh                      run inside the guest to install REPL/MCP-friendly runtimes
  keys/goodvibes_qemu_ed25519             SSH key for goodvibes guest user
  seed/user-data                          cloud-init user/bootstrap config
  seed/meta-data                          cloud-init identity
  seed/network-config                     cloud-init ens3 DHCP config
  seed/nocloud.iso                        generated cloud-init ISO
  logs/                                   QEMU and serial logs
  run/                                    pid/socket runtime files

First-run workflow:
  1. Run: ${shellSingleQuote(resolve(directory, 'create-image.sh'))} ${shellSingleQuote(imagePath)} 20G
  2. GoodVibes settings should point to:
       sandbox.vmBackend = qemu
       sandbox.qemuBinary = qemu-system-x86_64
       sandbox.qemuImagePath = ${imagePath}
       sandbox.qemuExecWrapper = ${resolve(directory, 'qemu-wrapper.sh')}
       sandbox.qemuGuestHost = 127.0.0.1
       sandbox.qemuGuestPort = 2222
       sandbox.qemuGuestUser = goodvibes
       sandbox.qemuWorkspacePath = /workspace
       sandbox.qemuSessionMode = launch-per-command
       sandbox.replJavaScriptCommand = /home/goodvibes/.bun/bin/bun
  3. Provision guest runtimes:
       GV_SANDBOX_SYNC_WORKSPACE=0 GV_SANDBOX_WRAPPER_MODE=launch-qemu-ssh ${shellSingleQuote(resolve(directory, 'qemu-wrapper.sh'))} bash -s < ${shellSingleQuote(resolve(directory, 'guest-bootstrap.sh'))}
  4. Run: /sandbox guest-test eval-py

Guest runtimes installed by guest-bootstrap.sh:
  python3, pip, venv, nodejs, npm, typescript, tsx, ts-node, sqlite3,
  postgresql-client, mariadb-client, GraphQL tools, Bun, Deno, uv,
  DuckDB, Go, Rust/Cargo, Ruby, ripgrep, fd, shellcheck, make, pkg-config,
  libssl-dev, and python3-dev.

Debugging:
  serial log: ${resolve(directory, 'logs/serial-2222.log')}
  qemu log:   ${resolve(directory, 'logs/qemu-2222.log')}
  seed ISO:   ${seedIsoPath}

The wrapper accepts GOODVIBES_QEMU_SSH_TIMEOUT, defaulting to 300 seconds, because first boot cloud-init can be slow.
`;
}
