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
  readonly recommendedSettings: {
    readonly backend: 'qemu';
    readonly wrapperPath: string;
    readonly imagePath: string;
    readonly guestHost: string;
    readonly guestPort: number;
    readonly guestUser: string;
    readonly guestWorkspacePath: string;
    readonly sessionMode: string;
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
mode="\${GV_SANDBOX_WRAPPER_MODE:-ssh-guest}"
if [[ "$mode" == "host-exec" ]]; then
  exec "$@"
fi
host="\${GOODVIBES_QEMU_GUEST_HOST:-127.0.0.1}"
port="\${GOODVIBES_QEMU_GUEST_PORT:-2222}"
user="\${GOODVIBES_QEMU_GUEST_USER:-goodvibes}"
workspace="\${GOODVIBES_QEMU_WORKSPACE:-/workspace}"
exec ssh -o StrictHostKeyChecking=accept-new -p "$port" "$user@$host" "cd '$workspace' && exec \\"$@\\""
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
    const args = [
      '-display', 'none',
      '-nodefaults',
      '-name', `gv-${profile.id}`,
      '-snapshot',
      '-m', '512',
      '-nic', `user,hostfwd=tcp::${guestPort}-:22`,
    ];
    if (config.qemuImagePath) args.push('-drive', `file=${config.qemuImagePath},if=virtio,format=qcow2`);
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
    },
    nextSteps: ['Create or attach a QEMU guest, run the bootstrap script, then run /sandbox guest-test eval-js.'],
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
  const config = getSandboxConfigSnapshot(manager);
  const manifest: SandboxQemuSetupManifest = {
    version: 1,
    createdAt: Date.now(),
    wrapperPath: init.wrapperPath,
    imagePath,
    imageCreateScriptPath,
    guestBootstrapScriptPath,
    projectionPolicyPath,
    sshConfigPath,
    recommendedSettings: {
      backend: 'qemu',
      wrapperPath: init.wrapperPath,
      imagePath,
      guestHost: config.qemuGuestHost || '127.0.0.1',
      guestPort: config.qemuGuestPort || 2222,
      guestUser: config.qemuGuestUser || 'goodvibes',
      guestWorkspacePath: config.qemuWorkspacePath || '/workspace',
      sessionMode: config.qemuSessionMode || 'attach',
    },
  };
  writeFileSync(imageCreateScriptPath, '#!/usr/bin/env bash\nset -euo pipefail\nqemu-img create -f qcow2 "$1" "${2:-20G}"\n', { mode: 0o755 });
  writeFileSync(guestBootstrapScriptPath, '#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p /workspace\n');
  writeFileSync(projectionPolicyPath, `${JSON.stringify({ version: 1, workspace: '/workspace' }, null, 2)}\n`);
  writeFileSync(sshConfigPath, 'Host goodvibes-qemu\n  HostName 127.0.0.1\n  Port 2222\n  User goodvibes\n');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...init, imagePath, imageCreateScriptPath, guestBootstrapScriptPath, projectionPolicyPath, sshConfigPath, manifestPath };
}

export function bootstrapSandboxQemuSetupBundle(
  manager: WritableConfigManagerLike,
  workspaceRoot: string,
  pathArg: string,
  _sizeGb: number,
  options: SandboxProvisioningOptions,
): SandboxQemuSetupBundle {
  const bundle = scaffoldSandboxQemuSetupBundle(manager, workspaceRoot, pathArg, options);
  manager.setDynamic('sandbox.vmBackend', 'qemu');
  manager.setDynamic('sandbox.qemuExecWrapper', bundle.wrapperPath);
  manager.setDynamic('sandbox.qemuImagePath', bundle.imagePath);
  return bundle;
}

export function createSandboxQemuImage(workspaceRoot: string, imagePathArg: string, sizeGb: number): { readonly path: string; readonly sizeGb: number } {
  const path = resolveWorkspacePath(workspaceRoot, imagePathArg);
  ensureDir(dirname(path));
  if (!existsSync(path)) writeFileSync(path, '');
  return { path, sizeGb };
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
  manager.setDynamic('sandbox.qemuExecWrapper', manifest.recommendedSettings.wrapperPath);
  manager.setDynamic('sandbox.qemuImagePath', manifest.recommendedSettings.imagePath);
  manager.setDynamic('sandbox.qemuGuestHost', manifest.recommendedSettings.guestHost);
  manager.setDynamic('sandbox.qemuGuestPort', manifest.recommendedSettings.guestPort);
  manager.setDynamic('sandbox.qemuGuestUser', manifest.recommendedSettings.guestUser);
  manager.setDynamic('sandbox.qemuWorkspacePath', manifest.recommendedSettings.guestWorkspacePath);
  manager.setDynamic('sandbox.qemuSessionMode', manifest.recommendedSettings.sessionMode);
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
