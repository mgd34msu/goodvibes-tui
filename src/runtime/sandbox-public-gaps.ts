import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  detectSandboxHostStatus,
  getSandboxConfigSnapshot,
  type ConfigManagerLike,
  type SandboxBackendProbe,
  type SandboxLaunchPlan,
  type SandboxProfile,
} from '@pellux/goodvibes-sdk/platform/runtime/sandbox';

export interface SandboxGuestBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly guest: {
    readonly qemuBinary: string;
    readonly imagePath: string;
    readonly wrapperPath: string;
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly workspacePath: string;
    readonly sessionMode: string;
    readonly replJavaScriptCommand: string;
  };
  readonly nextSteps: readonly string[];
}

export interface SandboxQemuInitBundle {
  readonly directory: string;
  readonly wrapperPath: string;
  readonly guestBundlePath: string;
  readonly readmePath: string;
}

export interface SandboxQemuSetupBundle extends SandboxQemuInitBundle {
  readonly imagePath: string;
  readonly imageCreateScriptPath: string;
  readonly guestBootstrapScriptPath: string;
  readonly projectionPolicyPath: string;
  readonly sshConfigPath: string;
  readonly seedDirectory: string;
  readonly seedIsoPath: string;
  readonly sshKeyPath: string;
  readonly sshPublicKeyPath: string;
  readonly manifestPath: string;
}

export interface SandboxQemuSetupManifest {
  readonly version: 1;
  readonly createdAt: number;
  readonly wrapperPath: string;
  readonly imagePath: string;
  readonly imageCreateScriptPath: string;
  readonly guestBootstrapScriptPath: string;
  readonly projectionPolicyPath: string;
  readonly sshConfigPath: string;
  readonly seedDirectory: string;
  readonly seedIsoPath: string;
  readonly sshKeyPath: string;
  readonly sshPublicKeyPath: string;
  readonly recommendedSettings: {
    readonly backend: 'qemu';
    readonly qemuBinary: string;
    readonly wrapperPath: string;
    readonly imagePath: string;
    readonly guestHost: string;
    readonly guestPort: number;
    readonly guestUser: string;
    readonly guestWorkspacePath: string;
    readonly sessionMode: string;
    readonly replJavaScriptCommand: string;
  };
}

export interface SandboxProvisioningOptions {
  readonly surfaceRoot: string;
}

export interface WritableConfigManagerLike extends ConfigManagerLike {
  setDynamic(key: string, value: unknown): void;
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

export function probeSandboxBackends(manager: ConfigManagerLike): SandboxBackendProbe {
  const host = detectSandboxHostStatus(manager);
  const config = getSandboxConfigSnapshot(manager);
  const qemuBinary = config.qemuBinary || 'qemu-system-x86_64';
  const qemuImage = config.qemuImagePath || '';
  const qemuExecWrapper = config.qemuExecWrapper || '';
  const qemuGuestHost = config.qemuGuestHost || '';
  const qemuProbe = spawnSync(qemuBinary, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'buffer',
    timeout: 1500,
    windowsHide: true,
  });
  const qemuAvailable = qemuProbe.status === 0 || qemuProbe.status === 1;
  const qemuBlockedReason = host.windows && !host.runningInWsl
    ? 'QEMU sandboxing on Windows requires running GoodVibes inside WSL.'
    : '';
  const qemuDetail = qemuBlockedReason || (
    qemuAvailable
      ? `requires ${qemuBinary} on PATH`
      : `requires ${qemuBinary} on PATH (${qemuProbe.error instanceof Error ? qemuProbe.error.message : `exit ${qemuProbe.status ?? 'unknown'}`})`
  );
  const warnings: string[] = [];
  if (config.vmBackend === 'qemu' && !qemuAvailable) {
    warnings.push(`Requested sandbox backend "${config.vmBackend}" is unavailable; local process isolation will not be used unless sandbox.vmBackend is set to "local".`);
  }
  if (config.vmBackend === 'qemu' && !qemuImage) {
    warnings.push('QEMU backend selected without sandbox.qemuImagePath; sessions can be planned and reviewed, but guest execution remains disabled.');
  }
  if (config.vmBackend === 'qemu' && qemuImage && !qemuExecWrapper) {
    warnings.push('QEMU image is configured without sandbox.qemuExecWrapper; guest launch planning is wired, but command execution remains disabled until a host bridge is configured.');
  }
  if (config.vmBackend === 'qemu' && qemuExecWrapper && !qemuGuestHost) {
    warnings.push('QEMU wrapper is configured without sandbox.qemuGuestHost; host bridge mode is available, but real guest SSH transport remains disabled until the guest host is configured.');
  }
  if (config.vmBackend === 'qemu' && qemuExecWrapper && !existsSync(qemuExecWrapper)) {
    warnings.push(`Configured sandbox.qemuExecWrapper does not exist: ${qemuExecWrapper}`);
  }
  if (config.vmBackend === 'qemu' && qemuExecWrapper && existsSync(qemuExecWrapper) && !isExecutableFile(qemuExecWrapper)) {
    warnings.push(`Configured sandbox.qemuExecWrapper is not executable: ${qemuExecWrapper}`);
  }
  if (qemuBlockedReason) warnings.push(qemuBlockedReason);
  return {
    requestedBackend: config.vmBackend,
    resolvedBackend: config.vmBackend,
    backends: [
      { id: 'local', available: true, detail: 'host-local process isolation is available when explicitly selected' },
      { id: 'qemu', available: qemuAvailable && !qemuBlockedReason, detail: qemuDetail },
    ],
    warnings,
  };
}

export function buildSandboxLaunchPlan(
  profile: SandboxProfile,
  label: string,
  manager: ConfigManagerLike,
  workspaceRoot: string,
): SandboxLaunchPlan {
  const config = getSandboxConfigSnapshot(manager);
  const backendProbe = probeSandboxBackends(manager);
  const backend = backendProbe.resolvedBackend === 'qemu' ? 'qemu' : 'local';
  const safeWorkspaceRoot = resolve(workspaceRoot);
  if (backend === 'qemu') {
    const qemuAvailability = backendProbe.backends.find((entry) => entry.id === 'qemu');
    if (!qemuAvailability?.available) {
      throw new Error(`Requested QEMU sandbox backend is unavailable (${qemuAvailability?.detail ?? 'probe failed'}); refusing to downgrade to local process isolation. Set sandbox.vmBackend to "local" to use host-local isolation explicitly.`);
    }
    const guestPort = config.qemuGuestPort || 2222;
    const wrapperDirectory = config.qemuExecWrapper ? dirname(config.qemuExecWrapper) : resolve(safeWorkspaceRoot, '.goodvibes/tui/sandbox');
    const serialLog = resolve(wrapperDirectory, `logs/serial-${guestPort}.log`);
    const monitorSocket = resolve(wrapperDirectory, `run/monitor-${guestPort}.sock`);
    const seedIso = resolve(wrapperDirectory, 'seed/nocloud.iso');
    ensureDir(dirname(serialLog));
    ensureDir(dirname(monitorSocket));
    const args = [
      '-display', 'none',
      '-name', `gv-${profile.id}`,
      '-serial', `file:${serialLog}`,
      '-monitor', `unix:${monitorSocket},server,nowait`,
      '-m', '1024',
      '-smp', '2',
      '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${guestPort}-:22`,
      '-device', 'virtio-net-pci,netdev=net0',
      '-smbios', 'type=1,serial=ds=nocloud',
    ];
    if (config.qemuImagePath) args.push('-drive', `file=${config.qemuImagePath},if=virtio,format=qcow2`);
    if (existsSync(seedIso)) args.push('-drive', `file=${seedIso},if=virtio,media=cdrom,readonly=on`);
    return {
      backend,
      command: config.qemuBinary || 'qemu-system-x86_64',
      args,
      workspaceRoot: safeWorkspaceRoot,
      summary: buildCommandSummary(config.qemuBinary || 'qemu-system-x86_64', args),
      imagePath: config.qemuImagePath || undefined,
    };
  }
  return {
    backend: 'local',
    command: process.env.SHELL || 'bash',
    args: ['-lc', `echo "goodvibes sandbox ${profile.id}: ${label}"`],
    workspaceRoot: safeWorkspaceRoot,
    summary: buildCommandSummary(process.env.SHELL || 'bash', ['-lc', `echo "goodvibes sandbox ${profile.id}: ${label}"`]),
  };
}

export interface SandboxCommandPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly summary: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface SandboxCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function buildCommandSummary(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ').trim();
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function resolveSandboxCommandPlan(
  launchPlan: SandboxLaunchPlan,
  command: string,
  args: readonly string[],
  manager?: ConfigManagerLike,
): SandboxCommandPlan {
  if (launchPlan.backend === 'qemu') {
    if (!launchPlan.imagePath) {
      throw new Error('QEMU-backed sandbox execution requires sandbox.qemuImagePath; guest launch planning is available, but command execution stays disabled until an image is configured.');
    }
    const config = manager ? getSandboxConfigSnapshot(manager) : undefined;
    const wrapper = config?.qemuExecWrapper || '';
    if (!wrapper) {
      throw new Error('QEMU-backed sandbox execution requires sandbox.qemuExecWrapper; image-backed launch planning is wired, but guest command execution stays disabled until a wrapper is configured.');
    }
    if (!existsSync(wrapper)) {
      throw new Error(`QEMU-backed sandbox execution requires an existing sandbox.qemuExecWrapper; missing: ${wrapper}`);
    }
    if (!isExecutableFile(wrapper)) {
      throw new Error(`QEMU-backed sandbox execution requires an executable sandbox.qemuExecWrapper; not executable: ${wrapper}`);
    }
    const guestHost = config?.qemuGuestHost || '';
    const sessionMode = config?.qemuSessionMode === 'launch-per-command' ? 'launch-per-command' : 'attach';
    return {
      command: wrapper,
      args: [command, ...args],
      env: {
        GV_SANDBOX_QEMU_BINARY: launchPlan.command,
        GV_SANDBOX_QEMU_ARGS: JSON.stringify(launchPlan.args),
        GV_SANDBOX_QEMU_IMAGE: launchPlan.imagePath,
        GV_SANDBOX_WORKSPACE_ROOT: launchPlan.workspaceRoot,
        GV_SANDBOX_GUEST_COMMAND: command,
        GV_SANDBOX_GUEST_ARGS: JSON.stringify(args),
        GV_SANDBOX_GUEST_HOST: guestHost,
        GV_SANDBOX_GUEST_PORT: `${config?.qemuGuestPort || 2222}`,
        GV_SANDBOX_GUEST_USER: config?.qemuGuestUser || '',
        GV_SANDBOX_GUEST_WORKSPACE: config?.qemuWorkspacePath || '',
        GV_SANDBOX_WRAPPER_MODE: guestHost ? (sessionMode === 'launch-per-command' ? 'launch-qemu-ssh' : 'ssh-guest') : '',
        GV_SANDBOX_EXEC_MODE: 'wrapper',
      },
      summary: buildCommandSummary(wrapper, [command, ...args]),
    };
  }
  return {
    command,
    args,
    summary: buildCommandSummary(command, args),
  };
}

export function executeSandboxCommand(
  launchPlan: SandboxLaunchPlan,
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly inheritHostEnv?: boolean;
    readonly timeoutMs?: number;
    readonly input?: string;
  } = {},
): SandboxCommandResult {
  return runSandboxCommand(launchPlan, command, args, undefined, options);
}

export function executeSandboxManagedCommand(
  launchPlan: SandboxLaunchPlan,
  command: string,
  args: readonly string[],
  manager: ConfigManagerLike,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly inheritHostEnv?: boolean;
    readonly timeoutMs?: number;
    readonly input?: string;
  } = {},
): SandboxCommandResult {
  return runSandboxCommand(launchPlan, command, args, manager, options);
}

function runSandboxCommand(
  launchPlan: SandboxLaunchPlan,
  command: string,
  args: readonly string[],
  manager: ConfigManagerLike | undefined,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly inheritHostEnv?: boolean;
    readonly timeoutMs?: number;
    readonly input?: string;
  },
): SandboxCommandResult {
  const resolved = resolveSandboxCommandPlan(launchPlan, command, args, manager);
  const result = spawnSync(resolved.command, [...resolved.args], {
    cwd: options.cwd ?? launchPlan.workspaceRoot,
    env: options.inheritHostEnv === false ? { ...resolved.env, ...options.env } : { ...process.env, ...resolved.env, ...options.env },
    input: options.input,
    timeout: options.timeoutMs ?? 5000,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error) : ''),
  };
}

function resolveWorkspacePath(workspaceRoot: string, pathArg: string): string {
  return resolve(workspaceRoot, pathArg);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function ensureQemuSshKey(directory: string): { readonly keyPath: string; readonly publicKeyPath: string; readonly publicKey: string } {
  const keyPath = resolve(directory, 'keys/goodvibes_qemu_ed25519');
  const publicKeyPath = `${keyPath}.pub`;
  ensureDir(dirname(keyPath));
  if (!existsSync(keyPath) || !existsSync(publicKeyPath)) {
    const generated = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'goodvibes-qemu', '-f', keyPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
    });
    if (generated.status !== 0) {
      writeFileSync(resolve(directory, 'keys/README.txt'), [
        'ssh-keygen was not available when this bundle was scaffolded.',
        'Generate the key manually before building the image:',
        `  ssh-keygen -t ed25519 -N '' -C goodvibes-qemu -f ${keyPath}`,
        '',
      ].join('\n'));
    }
  }
  const publicKey = existsSync(publicKeyPath) ? readFileSync(publicKeyPath, 'utf8').trim() : '';
  return { keyPath, publicKeyPath, publicKey };
}

function renderQemuUserData(publicKey: string): string {
  const authorizedKeys = publicKey
    ? `    ssh_authorized_keys:\n      - ${publicKey}\n`
    : '    # Generate keys/goodvibes_qemu_ed25519.pub before rebuilding nocloud.iso.\n';
  return `#cloud-config
users:
  - default
  - name: goodvibes
    groups: [sudo]
    shell: /bin/bash
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    lock_passwd: true
${authorizedKeys}
ssh_pwauth: false
disable_root: true
manage_etc_hosts: true

bootcmd:
  - [ sh, -c, 'systemctl disable systemd-networkd-wait-online.service || true' ]
  - [ sh, -c, 'systemctl mask systemd-networkd-wait-online.service || true' ]

runcmd:
  - [ mkdir, -p, /workspace ]
  - [ chown, goodvibes:goodvibes, /workspace ]
  - [ sh, -c, 'systemctl enable ssh ssh.service 2>/dev/null || true' ]
  - [ sh, -c, 'systemctl restart ssh ssh.service 2>/dev/null || true' ]
`;
}

function renderQemuNetworkConfig(): string {
  return `version: 2
ethernets:
  ens3:
    match:
      name: "ens3"
    dhcp4: true
    dhcp6: false
    optional: true
`;
}

function renderQemuImageCreateScript(directory: string, imagePath: string, sizeGb: number): string {
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

function renderQemuGuestBootstrapScript(): string {
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

function renderQemuSetupReadme(directory: string, imagePath: string, seedIsoPath: string): string {
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

export function scaffoldSandboxQemuInitBundle(
  manager: ConfigManagerLike,
  workspaceRoot: string,
  pathArg: string,
  _options: SandboxProvisioningOptions,
): SandboxQemuInitBundle {
  const directory = resolveWorkspacePath(workspaceRoot, pathArg);
  ensureDir(directory);
  const wrapperPath = resolve(directory, 'qemu-wrapper.sh');
  const guestBundlePath = resolve(directory, 'guest-bundle.json');
  const readmePath = resolve(directory, 'README.txt');
  writeFileSync(wrapperPath, renderQemuWrapperTemplate(), { mode: 0o755 });
  const guestBundle = buildGuestBundle(manager, workspaceRoot, guestBundlePath);
  writeFileSync(guestBundlePath, `${JSON.stringify(guestBundle, null, 2)}\n`);
  writeFileSync(readmePath, 'GoodVibes QEMU sandbox bootstrap files.\n');
  return { directory, wrapperPath, guestBundlePath, readmePath };
}

function buildGuestBundle(manager: ConfigManagerLike, _workspaceRoot: string, wrapperPath: string): SandboxGuestBundle {
  const config = getSandboxConfigSnapshot(manager);
  return {
    version: 1,
    exportedAt: Date.now(),
    guest: {
      qemuBinary: config.qemuBinary,
      imagePath: config.qemuImagePath,
      wrapperPath,
      host: config.qemuGuestHost,
      port: config.qemuGuestPort,
      user: config.qemuGuestUser,
      workspacePath: config.qemuWorkspacePath,
      sessionMode: config.qemuSessionMode,
      replJavaScriptCommand: config.replJavaScriptCommand,
    },
    nextSteps: ['Create the QEMU image, provision guest runtimes, then run /sandbox guest-test eval-py.'],
  };
}

export function scaffoldSandboxQemuSetupBundle(
  manager: ConfigManagerLike,
  workspaceRoot: string,
  pathArg: string,
  options: SandboxProvisioningOptions,
): SandboxQemuSetupBundle {
  const init = scaffoldSandboxQemuInitBundle(manager, workspaceRoot, pathArg, options);
  const imagePath = resolve(init.directory, 'goodvibes-sandbox.qcow2');
  const imageCreateScriptPath = resolve(init.directory, 'create-image.sh');
  const guestBootstrapScriptPath = resolve(init.directory, 'guest-bootstrap.sh');
  const projectionPolicyPath = resolve(init.directory, 'projection-policy.json');
  const sshConfigPath = resolve(init.directory, 'ssh-config');
  const manifestPath = resolve(init.directory, 'setup-manifest.json');
  const seedDirectory = resolve(init.directory, 'seed');
  const seedIsoPath = resolve(seedDirectory, 'nocloud.iso');
  const logsDirectory = resolve(init.directory, 'logs');
  const runDirectory = resolve(init.directory, 'run');
  const imagesDirectory = resolve(init.directory, 'images');
  const config = getSandboxConfigSnapshot(manager);
  const qemuBinary = config.qemuBinary || 'qemu-system-x86_64';
  const guestPort = config.qemuGuestPort || 2222;
  const guestUser = config.qemuGuestUser || 'goodvibes';
  const guestWorkspacePath = config.qemuWorkspacePath || '/workspace';
  const replJavaScriptCommand = `/home/${guestUser}/.bun/bin/bun`;
  const sshKey = ensureQemuSshKey(init.directory);
  const manifest: SandboxQemuSetupManifest = {
    version: 1,
    createdAt: Date.now(),
    wrapperPath: init.wrapperPath,
    imagePath,
    imageCreateScriptPath,
    guestBootstrapScriptPath,
    projectionPolicyPath,
    sshConfigPath,
    seedDirectory,
    seedIsoPath,
    sshKeyPath: sshKey.keyPath,
    sshPublicKeyPath: sshKey.publicKeyPath,
    recommendedSettings: {
      backend: 'qemu',
      qemuBinary,
      wrapperPath: init.wrapperPath,
      imagePath,
      guestHost: config.qemuGuestHost || '127.0.0.1',
      guestPort,
      guestUser,
      guestWorkspacePath,
      sessionMode: 'launch-per-command',
      replJavaScriptCommand,
    },
  };
  ensureDir(seedDirectory);
  ensureDir(logsDirectory);
  ensureDir(runDirectory);
  ensureDir(imagesDirectory);
  writeFileSync(resolve(seedDirectory, 'meta-data'), 'instance-id: goodvibes-qemu-sandbox\nlocal-hostname: goodvibes-qemu\n');
  writeFileSync(resolve(seedDirectory, 'user-data'), renderQemuUserData(sshKey.publicKey));
  writeFileSync(resolve(seedDirectory, 'network-config'), renderQemuNetworkConfig());
  writeFileSync(imageCreateScriptPath, renderQemuImageCreateScript(init.directory, imagePath, 20), { mode: 0o755 });
  writeFileSync(guestBootstrapScriptPath, renderQemuGuestBootstrapScript(), { mode: 0o755 });
  writeFileSync(projectionPolicyPath, `${JSON.stringify({ version: 1, workspace: '/workspace' }, null, 2)}\n`);
  writeFileSync(sshConfigPath, [
    'Host goodvibes-qemu',
    '  HostName 127.0.0.1',
    `  Port ${guestPort}`,
    `  User ${guestUser}`,
    `  IdentityFile ${sshKey.keyPath}`,
    '  StrictHostKeyChecking accept-new',
    '',
  ].join('\n'));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(init.readmePath, renderQemuSetupReadme(init.directory, imagePath, seedIsoPath));
  return {
    ...init,
    imagePath,
    imageCreateScriptPath,
    guestBootstrapScriptPath,
    projectionPolicyPath,
    sshConfigPath,
    seedDirectory,
    seedIsoPath,
    sshKeyPath: sshKey.keyPath,
    sshPublicKeyPath: sshKey.publicKeyPath,
    manifestPath,
  };
}

export function bootstrapSandboxQemuSetupBundle(
  manager: WritableConfigManagerLike,
  workspaceRoot: string,
  pathArg: string,
  _sizeGb: number,
  options: SandboxProvisioningOptions,
): SandboxQemuSetupBundle {
  const bundle = scaffoldSandboxQemuSetupBundle(manager, workspaceRoot, pathArg, options);
  const manifest = loadSandboxQemuSetupManifest(workspaceRoot, bundle.manifestPath);
  applySandboxQemuSetupManifest(manager, manifest);
  manager.setDynamic('sandbox.replIsolation', 'shared-vm');
  manager.setDynamic('sandbox.mcpIsolation', 'shared-vm');
  return bundle;
}

export function inspectSandboxQemuSetupManifest(manifest: SandboxQemuSetupManifest): string {
  return [
    'QEMU sandbox setup manifest',
    `  wrapper: ${manifest.wrapperPath}`,
    `  image: ${manifest.imagePath}`,
    `  guest: ${manifest.recommendedSettings.guestUser}@${manifest.recommendedSettings.guestHost}:${manifest.recommendedSettings.guestPort}`,
    `  workspace: ${manifest.recommendedSettings.guestWorkspacePath}`,
  ].join('\n');
}

export function loadSandboxQemuSetupManifest(workspaceRoot: string, pathArg: string): SandboxQemuSetupManifest {
  return JSON.parse(readFileSync(resolveWorkspacePath(workspaceRoot, pathArg), 'utf8')) as SandboxQemuSetupManifest;
}

export function applySandboxQemuSetupManifest(manager: WritableConfigManagerLike, manifest: SandboxQemuSetupManifest): void {
  manager.setDynamic('sandbox.vmBackend', 'qemu');
  manager.setDynamic('sandbox.qemuBinary', manifest.recommendedSettings.qemuBinary);
  manager.setDynamic('sandbox.qemuExecWrapper', manifest.recommendedSettings.wrapperPath);
  manager.setDynamic('sandbox.qemuImagePath', manifest.recommendedSettings.imagePath);
  manager.setDynamic('sandbox.qemuGuestHost', manifest.recommendedSettings.guestHost);
  manager.setDynamic('sandbox.qemuGuestPort', manifest.recommendedSettings.guestPort);
  manager.setDynamic('sandbox.qemuGuestUser', manifest.recommendedSettings.guestUser);
  manager.setDynamic('sandbox.qemuWorkspacePath', manifest.recommendedSettings.guestWorkspacePath);
  manager.setDynamic('sandbox.qemuSessionMode', manifest.recommendedSettings.sessionMode);
  manager.setDynamic('sandbox.replJavaScriptCommand', manifest.recommendedSettings.replJavaScriptCommand);
}

export function exportSandboxGuestBundle(
  manager: ConfigManagerLike,
  workspaceRoot: string,
  pathArg: string,
  _options: SandboxProvisioningOptions,
): { readonly path: string; readonly bundle: SandboxGuestBundle } {
  const path = resolveWorkspacePath(workspaceRoot, pathArg);
  ensureDir(dirname(path));
  const bundle = buildGuestBundle(manager, workspaceRoot, path);
  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`);
  return { path, bundle };
}

export function inspectSandboxGuestBundle(bundle: SandboxGuestBundle): string {
  return [
    'Sandbox guest bundle',
    `  wrapper: ${bundle.guest.wrapperPath}`,
    `  image: ${bundle.guest.imagePath || '(not configured)'}`,
    `  guest: ${bundle.guest.user}@${bundle.guest.host}:${bundle.guest.port}`,
    `  workspace: ${bundle.guest.workspacePath}`,
    ...bundle.nextSteps.map((step) => `  next: ${step}`),
  ].join('\n');
}

export function renderSandboxDoctor(manager: ConfigManagerLike): string {
  const probe = probeSandboxBackends(manager);
  return [
    'Sandbox doctor',
    `  backend: ${probe.resolvedBackend}`,
    ...probe.backends.map((backend) => `  ${backend.id}: ${backend.available ? 'available' : 'missing'} (${backend.detail})`),
    ...probe.warnings.map((warning) => `  warning: ${warning}`),
  ].join('\n');
}
