import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigManager } from '../../config/manager.ts';
import { detectSandboxHostStatus, getSandboxConfigSnapshot } from './manager.ts';
import type {
  SandboxBackendAvailability,
  SandboxBackendProbe,
  SandboxLaunchPlan,
  SandboxProfile,
  SandboxResolvedBackend,
} from './types.ts';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function hasCommand(command: string, args: readonly string[] = ['--version']): boolean {
  const result = spawnSync(command, [...args], {
    stdio: 'ignore',
    timeout: 1500,
    windowsHide: true,
  });
  return result.status === 0 || result.status === 1;
}

function qemuBinaryFor(manager: ConfigManager | { get: (key: string) => unknown }): string {
  const configured = `${manager.get('sandbox.qemuBinary' as never) ?? ''}`.trim();
  return configured || 'qemu-system-x86_64';
}

function qemuImageFor(manager: ConfigManager | { get: (key: string) => unknown }): string {
  return `${manager.get('sandbox.qemuImagePath' as never) ?? ''}`.trim();
}

function qemuExecWrapperFor(manager: ConfigManager | { get: (key: string) => unknown }): string {
  return `${manager.get('sandbox.qemuExecWrapper' as never) ?? ''}`.trim();
}

function qemuGuestHostFor(manager: ConfigManager | { get: (key: string) => unknown }): string {
  return `${manager.get('sandbox.qemuGuestHost' as never) ?? ''}`.trim();
}

function qemuGuestPortFor(manager: ConfigManager | { get: (key: string) => unknown }): string {
  const raw = manager.get('sandbox.qemuGuestPort' as never);
  return `${typeof raw === 'number' ? raw : Number.parseInt(`${raw ?? ''}`, 10) || 2222}`;
}

function qemuGuestUserFor(manager: ConfigManager | { get: (key: string) => unknown }): string {
  return `${manager.get('sandbox.qemuGuestUser' as never) ?? ''}`.trim();
}

function qemuWorkspacePathFor(manager: ConfigManager | { get: (key: string) => unknown }): string {
  return `${manager.get('sandbox.qemuWorkspacePath' as never) ?? ''}`.trim();
}

function qemuSessionModeFor(manager: ConfigManager | { get: (key: string) => unknown }): 'attach' | 'launch-per-command' {
  const configured = `${manager.get('sandbox.qemuSessionMode' as never) ?? ''}`.trim();
  return configured === 'launch-per-command' ? 'launch-per-command' : 'attach';
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function buildAvailability(
  id: SandboxResolvedBackend,
  available: boolean,
  detail: string,
): SandboxBackendAvailability {
  return Object.freeze({ id, available, detail });
}

export function probeSandboxBackends(
  manager: ConfigManager | { get: (key: string) => unknown },
): SandboxBackendProbe {
  const host = detectSandboxHostStatus(manager as ConfigManager);
  const config = getSandboxConfigSnapshot(manager as ConfigManager);
  const qemuBinary = qemuBinaryFor(manager);
  const qemuImage = qemuImageFor(manager);
  const qemuExecWrapper = qemuExecWrapperFor(manager);
  const qemuGuestHost = qemuGuestHostFor(manager);
  const backends: readonly SandboxBackendAvailability[] = [
    buildAvailability('local', true, 'host-local process isolation fallback is always available'),
    buildAvailability('qemu', hasCommand(qemuBinary), `requires ${qemuBinary} on PATH`),
  ];

  const requested = config.vmBackend;
  let resolved: SandboxResolvedBackend = 'local';
  if (config.vmBackend === 'qemu') {
    resolved = backends.find((entry) => entry.id === 'qemu')?.available ? 'qemu' : 'local';
  }

  const warnings: string[] = [];
  if (config.vmBackend === 'qemu' && resolved === 'local') {
    warnings.push(`Requested sandbox backend "${config.vmBackend}" is unavailable; falling back to local process isolation.`);
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
  if (host.windows && !host.runningInWsl && config.vmBackend === 'qemu') {
    warnings.push('QEMU sandboxing on Windows requires running GoodVibes inside WSL.');
  }

  return Object.freeze({
    requestedBackend: requested,
    resolvedBackend: resolved,
    backends,
    warnings,
  });
}

function buildCommandSummary(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ').trim();
}

export function buildSandboxLaunchPlan(
  profile: SandboxProfile,
  label: string,
  manager: ConfigManager,
  workspaceRoot: string = process.cwd(),
): SandboxLaunchPlan {
  const backendProbe = probeSandboxBackends(manager);
  const safeWorkspaceRoot = resolve(workspaceRoot);
  if (backendProbe.resolvedBackend === 'qemu') {
    const qemuBinary = qemuBinaryFor(manager);
    const qemuImage = qemuImageFor(manager);
    const guestPort = qemuGuestPortFor(manager);
    const args = [
      '-display', 'none',
      '-nodefaults',
      '-name', `gv-${profile.id}`,
      '-snapshot',
      '-m', '512',
      '-nic', `user,hostfwd=tcp::${guestPort}-:22`,
    ];
    if (qemuImage) args.push('-drive', `file=${qemuImage},if=virtio,format=qcow2`);
    return Object.freeze({
      backend: 'qemu',
      command: qemuBinary,
      args,
      workspaceRoot: safeWorkspaceRoot,
      summary: buildCommandSummary(qemuBinary, args),
      imagePath: qemuImage || undefined,
    });
  }
  const args = ['-lc', `echo "goodvibes sandbox ${profile.id}: ${label}"`];
  return Object.freeze({
    backend: 'local',
    command: process.env.SHELL || 'bash',
    args,
    workspaceRoot: safeWorkspaceRoot,
    summary: buildCommandSummary(process.env.SHELL || 'bash', args),
  });
}

export interface SandboxCommandPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly summary: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function resolveSandboxCommandPlan(
  launchPlan: SandboxLaunchPlan,
  command: string,
  args: readonly string[],
  manager?: ConfigManager | { get: (key: string) => unknown },
): SandboxCommandPlan {
  if (launchPlan.backend === 'qemu') {
    if (!launchPlan.imagePath) {
      throw new Error('QEMU-backed sandbox execution requires sandbox.qemuImagePath; guest launch planning is available, but command execution stays disabled until an image is configured.');
    }
    const wrapper = manager ? qemuExecWrapperFor(manager) : '';
    if (!wrapper) {
      throw new Error('QEMU-backed sandbox execution requires sandbox.qemuExecWrapper; image-backed launch planning is wired, but guest command execution stays disabled until a wrapper is configured.');
    }
    if (!existsSync(wrapper)) {
      throw new Error(`QEMU-backed sandbox execution requires an existing sandbox.qemuExecWrapper; missing: ${wrapper}`);
    }
    if (!isExecutableFile(wrapper)) {
      throw new Error(`QEMU-backed sandbox execution requires an executable sandbox.qemuExecWrapper; not executable: ${wrapper}`);
    }
    const guestHost = manager ? qemuGuestHostFor(manager) : '';
    const sessionMode = manager ? qemuSessionModeFor(manager) : 'attach';
    return Object.freeze({
      command: wrapper,
      args: [],
      env: {
        GV_SANDBOX_QEMU_BINARY: launchPlan.command,
        GV_SANDBOX_QEMU_ARGS: JSON.stringify(launchPlan.args),
        GV_SANDBOX_QEMU_IMAGE: launchPlan.imagePath,
        GV_SANDBOX_WORKSPACE_ROOT: launchPlan.workspaceRoot,
        GV_SANDBOX_GUEST_COMMAND: command,
        GV_SANDBOX_GUEST_ARGS: JSON.stringify(args),
        GV_SANDBOX_GUEST_HOST: guestHost,
        GV_SANDBOX_GUEST_PORT: manager ? qemuGuestPortFor(manager) : '2222',
        GV_SANDBOX_GUEST_USER: manager ? qemuGuestUserFor(manager) : '',
        GV_SANDBOX_GUEST_WORKSPACE: manager ? qemuWorkspacePathFor(manager) : '',
        GV_SANDBOX_WRAPPER_MODE: guestHost ? (sessionMode === 'launch-per-command' ? 'launch-qemu-ssh' : 'ssh-guest') : '',
        GV_SANDBOX_EXEC_MODE: 'wrapper',
      },
      summary: buildCommandSummary(wrapper, []),
    });
  }
  return Object.freeze({
    command,
    args,
    summary: buildCommandSummary(command, args),
  });
}

export interface SandboxCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runSandboxCommand(
  launchPlan: SandboxLaunchPlan,
  command: string,
  args: readonly string[],
  managerLike: ConfigManager | { get: (key: string) => unknown } | undefined,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly input?: string;
  } = {},
): SandboxCommandResult {
  const resolved = resolveSandboxCommandPlan(launchPlan, command, args, managerLike);
  const result = spawnSync(resolved.command, [...resolved.args], {
    cwd: options.cwd ?? launchPlan.workspaceRoot,
    env: { ...process.env, ...resolved.env, ...options.env },
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? 5000,
    input: options.input,
    windowsHide: true,
  });
  return Object.freeze({
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  });
}

export function executeSandboxCommand(
  launchPlan: SandboxLaunchPlan,
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
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
  manager: ConfigManager | { get: (key: string) => unknown },
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly input?: string;
  } = {},
): SandboxCommandResult {
  return runSandboxCommand(launchPlan, command, args, manager, options);
}
