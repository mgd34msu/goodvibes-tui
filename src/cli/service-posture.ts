import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import net from 'node:net';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlatformServiceManager } from '@pellux/goodvibes-sdk/platform/daemon';
import type { ManagedServiceStatus } from '@pellux/goodvibes-sdk/platform/daemon';
import type { ConfigManager } from '../config/index.ts';
import { resolveRuntimeEndpointBinding } from './endpoints.ts';
import type { RuntimeEndpointBinding, RuntimeEndpointId } from './endpoints.ts';
import { classifyBindPosture, isNetworkFacing } from './network-posture.ts';
import { redactText } from './redaction.ts';

export interface CliServiceRuntime {
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

export interface CliServiceEndpointPosture {
  readonly id: RuntimeEndpointId;
  readonly label: string;
  readonly enabled: boolean;
  readonly binding: RuntimeEndpointBinding;
  readonly bindPosture: ReturnType<typeof classifyBindPosture>;
  readonly networkFacing: boolean;
  readonly reachable?: boolean;
}

export interface CliServiceLogPosture {
  readonly path: string | null;
  readonly exists: boolean;
  readonly size: number;
  readonly modifiedAt: number | null;
  readonly tail?: string;
  readonly readError?: string;
}

export interface CliServicePosture {
  readonly config: {
    readonly enabled: boolean;
    readonly autostart: boolean;
    readonly restartOnFailure: boolean;
    readonly daemonEnabled: boolean;
  };
  readonly managed: ManagedServiceStatus & {
    readonly pidPath: string;
    readonly lastError: string | null;
  };
  readonly endpoints: readonly CliServiceEndpointPosture[];
  readonly log: CliServiceLogPosture;
  readonly issues: readonly string[];
}

const ENDPOINTS: readonly { readonly id: RuntimeEndpointId; readonly label: string; readonly enabledKey: string }[] = [
  { id: 'controlPlane', label: 'control plane', enabledKey: 'controlPlane.enabled' },
  { id: 'httpListener', label: 'HTTP listener', enabledKey: 'danger.httpListener' },
  { id: 'web', label: 'web surface', enabledKey: 'web.enabled' },
];

const SOURCE_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface DaemonExecutableResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly execPath?: string;
  readonly packageRoot?: string;
}

export interface DaemonExecutableResolution {
  readonly command: string;
  readonly source: 'env' | 'sibling' | 'package' | 'path' | 'fallback';
  readonly absolute: boolean;
}

interface ServiceDefinitionOverride {
  readonly name: string;
  readonly description: string;
  readonly workingDirectory: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly restartOnFailure: boolean;
}

interface CliServiceStatusCommandResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface CliServiceStatusManager {
  status(): ManagedServiceStatus;
}

interface CliServicePostureOptions {
  readonly probe?: boolean;
  readonly logTailBytes?: number;
  readonly manager?: CliServiceStatusManager;
  readonly runCommand?: (command: string, args: readonly string[]) => CliServiceStatusCommandResult;
}

function connectHostForBindHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host || '127.0.0.1';
}

async function probeTcp(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: connectHostForBindHost(host), port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function platformDaemonArtifactName(platform = process.platform, arch = process.arch): string {
  if (platform === 'linux' && arch === 'x64') return 'goodvibes-daemon-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'goodvibes-daemon-linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'goodvibes-daemon-macos-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'goodvibes-daemon-macos-arm64';
  if (platform === 'win32') return 'goodvibes-daemon-windows.exe';
  return 'goodvibes-daemon';
}

function executablePathCandidates(path: string): string[] {
  if (!path.trim() || !isAbsolute(path)) return [];
  const dir = dirname(path);
  const name = basename(path);
  const artifact = platformDaemonArtifactName();
  const candidates = [
    join(dir, 'goodvibes-daemon'),
    join(dir, artifact),
  ];
  if (name.startsWith('goodvibes-') && !name.startsWith('goodvibes-daemon-')) {
    candidates.push(join(dir, name.replace(/^goodvibes-/, 'goodvibes-daemon-')));
  }
  if (name === 'goodvibes') candidates.push(join(dir, 'goodvibes-daemon'));
  return [...new Set(candidates)];
}

function resolveCommandFromPath(command: string, pathValue: string | undefined): string | null {
  const pathEntries = (pathValue ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(entry, `${command}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function firstExecutable(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (isExecutable(path)) return path;
  }
  return null;
}

function packageArtifactForBinWrapper(path: string): string | null {
  let realPath = path;
  try {
    realPath = realpathSync(path);
  } catch {
    // Keep the original path if resolving a symlink fails.
  }
  if (basename(realPath) !== 'goodvibes-daemon') return null;
  const binDir = dirname(realPath);
  if (basename(binDir) !== 'bin') return null;
  const packageRoot = dirname(binDir);
  return firstExecutable([
    join(packageRoot, 'vendor', platformDaemonArtifactName()),
    join(packageRoot, 'dist', platformDaemonArtifactName()),
    join(packageRoot, 'dist', 'goodvibes-daemon'),
  ]);
}

export function resolveGoodVibesDaemonExecutable(
  options: DaemonExecutableResolutionOptions = {},
): DaemonExecutableResolution {
  const env = options.env ?? process.env;
  const override = env.GOODVIBES_DAEMON_COMMAND?.trim();
  if (override) {
    return { command: override, source: 'env', absolute: isAbsolute(override) };
  }

  const packageRoot = options.packageRoot ?? SOURCE_PACKAGE_ROOT;
  const packaged = firstExecutable([
    join(packageRoot, 'dist', platformDaemonArtifactName()),
    join(packageRoot, 'dist', 'goodvibes-daemon'),
    join(packageRoot, 'vendor', platformDaemonArtifactName()),
    join(packageRoot, 'bin', 'goodvibes-daemon'),
  ]);
  if (packaged) return { command: packaged, source: 'package', absolute: true };

  const argv = options.argv ?? process.argv;
  const execPath = options.execPath ?? process.execPath;
  const sibling = firstExecutable([
    ...executablePathCandidates(execPath),
    ...executablePathCandidates(argv[1] ?? ''),
  ]);
  if (sibling) {
    return {
      command: packageArtifactForBinWrapper(sibling) ?? sibling,
      source: 'sibling',
      absolute: true,
    };
  }

  const pathResolved = resolveCommandFromPath('goodvibes-daemon', env.PATH);
  if (pathResolved) {
    return {
      command: packageArtifactForBinWrapper(pathResolved) ?? pathResolved,
      source: 'path',
      absolute: true,
    };
  }

  return { command: 'goodvibes-daemon', source: 'fallback', absolute: false };
}

export function getServiceStateRoot(runtime: CliServiceRuntime): string {
  return join(runtime.homeDirectory, '.goodvibes', 'daemon');
}

function pidFilePath(runtime: CliServiceRuntime, platform: ManagedServiceStatus['platform']): string {
  return join(getServiceStateRoot(runtime), 'service', `${platform}.pid`);
}

function runStatusCommand(
  command: string,
  args: readonly string[],
  options: CliServicePostureOptions,
): CliServiceStatusCommandResult {
  if (options.runCommand) return options.runCommand(command, args);
  return spawnSync(command, [...args], {
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 1500,
  });
}

function parseSystemdShowValue(lines: readonly string[], key: string): string | null {
  const prefix = `${key}=`;
  const match = lines.find((line) => line.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : null;
}

function reconcileSystemdServiceStatus(
  runtime: CliServiceRuntime,
  status: ManagedServiceStatus,
  options: CliServicePostureOptions,
): ManagedServiceStatus {
  if (status.platform !== 'systemd') return status;

  const name = String(runtime.configManager.get('service.serviceName') ?? 'goodvibes').trim() || 'goodvibes';
  const result = runStatusCommand('systemctl', [
    '--user',
    'show',
    `${name}.service`,
    '--property=LoadState,ActiveState,UnitFileState,MainPID',
    '--no-page',
  ], options);
  if ((result.status ?? 1) !== 0) return status;

  const lines = (result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const loadState = parseSystemdShowValue(lines, 'LoadState');
  const activeState = parseSystemdShowValue(lines, 'ActiveState');
  const unitFileState = parseSystemdShowValue(lines, 'UnitFileState');
  const rawPid = Number.parseInt(parseSystemdShowValue(lines, 'MainPID') ?? '', 10);
  const pid = Number.isFinite(rawPid) && rawPid > 0 ? rawPid : undefined;

  return {
    ...status,
    installed: loadState === 'loaded' || status.installed,
    autostart: unitFileState === 'enabled' || unitFileState === 'linked' || status.autostart,
    running: activeState === 'active',
    ...(pid === undefined ? {} : { pid }),
  };
}

function readLogPosture(path: string | undefined, tailBytes: number): CliServiceLogPosture {
  if (!path) return { path: null, exists: false, size: 0, modifiedAt: null };
  if (!existsSync(path)) return { path, exists: false, size: 0, modifiedAt: null };
  try {
    const stat = statSync(path);
    const length = Math.min(stat.size, Math.max(0, tailBytes));
    if (length === 0) {
      return { path, exists: true, size: stat.size, modifiedAt: stat.mtimeMs, tail: '' };
    }
    const raw = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, raw, 0, length, Math.max(0, stat.size - length));
    } finally {
      closeSync(fd);
    }
    return {
      path,
      exists: true,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      tail: redactText(raw.toString('utf-8')),
    };
  } catch (error) {
    return {
      path,
      exists: true,
      size: 0,
      modifiedAt: null,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}

function endpointsConflict(a: CliServiceEndpointPosture, b: CliServiceEndpointPosture): boolean {
  if (a.binding.port !== b.binding.port) return false;
  const hostA = a.binding.host;
  const hostB = b.binding.host;
  return hostA === hostB || hostA === '0.0.0.0' || hostB === '0.0.0.0' || hostA === '::' || hostB === '::';
}

export function createPlatformServiceManager(runtime: CliServiceRuntime): PlatformServiceManager {
  const daemonHomeDir = getServiceStateRoot(runtime);
  const serviceName = String(runtime.configManager.get('service.serviceName') ?? 'goodvibes').trim() || 'goodvibes';
  const daemonExecutable = resolveGoodVibesDaemonExecutable();
  const definition: ServiceDefinitionOverride = {
    name: serviceName,
    description: 'GoodVibes daemon, control-plane, listener, and web host',
    workingDirectory: daemonHomeDir,
    command: daemonExecutable.command,
    args: [],
    env: {
      GOODVIBES_DAEMON_HOME: daemonHomeDir,
      GOODVIBES_DAEMON_TOKEN: process.env.GOODVIBES_DAEMON_TOKEN ?? '',
      GOODVIBES_HTTP_TOKEN: process.env.GOODVIBES_HTTP_TOKEN ?? '',
      NODE_ENV: process.env.NODE_ENV ?? 'production',
    },
    restartOnFailure: runtime.configManager.get('service.restartOnFailure') === true,
  };
  return new PlatformServiceManager(runtime.configManager, {
    workingDirectory: runtime.homeDirectory,
    homeDirectory: runtime.homeDirectory,
    surfaceRoot: 'daemon',
    definitionOverride: definition,
    defaultServiceName: 'goodvibes',
    defaultServiceDescription: 'GoodVibes daemon, control-plane, listener, and web host',
  });
}

export async function buildCliServicePosture(
  runtime: CliServiceRuntime,
  options: CliServicePostureOptions = {},
): Promise<CliServicePosture> {
  const manager = options.manager ?? createPlatformServiceManager(runtime);
  const status = reconcileSystemdServiceStatus(runtime, manager.status(), options);
  const endpoints = await Promise.all(ENDPOINTS.map(async (endpoint): Promise<CliServiceEndpointPosture> => {
    const enabled = runtime.configManager.get(endpoint.enabledKey as never) === true;
    const binding = resolveRuntimeEndpointBinding(runtime.configManager, endpoint.id);
    return {
      id: endpoint.id,
      label: endpoint.label,
      enabled,
      binding,
      bindPosture: classifyBindPosture(binding),
      networkFacing: isNetworkFacing(enabled, binding),
      ...(options.probe && enabled ? { reachable: await probeTcp(binding.host, binding.port) } : {}),
    };
  }));

  const config = {
    enabled: runtime.configManager.get('service.enabled') === true,
    autostart: runtime.configManager.get('service.autostart') === true,
    restartOnFailure: runtime.configManager.get('service.restartOnFailure') === true,
    daemonEnabled: runtime.configManager.get('danger.daemon') === true,
  };
  const serverBackedEnabled = config.daemonEnabled || endpoints.some((endpoint) => endpoint.enabled);
  const issues: string[] = [];

  if (serverBackedEnabled && !config.enabled) {
    issues.push('Server-backed surfaces are enabled but service mode is off.');
  }
  if (config.enabled && !config.autostart) {
    issues.push('Service mode is enabled but autostart is off.');
  }
  if (config.enabled && !config.restartOnFailure) {
    issues.push('Service mode is enabled but restart-on-failure is off.');
  }
  if (config.enabled && !status.installed) {
    issues.push('Service mode is enabled but no platform service definition is installed.');
  }
  if (config.enabled && !status.running) {
    issues.push('Service mode is enabled but the managed service is not running.');
  }
  if (status.actionError) {
    issues.push(`Service manager reported an error: ${status.actionError}`);
  }
  for (const endpoint of endpoints) {
    if (endpoint.enabled && options.probe && endpoint.reachable === false) {
      issues.push(`${endpoint.label} is enabled but not reachable on ${endpoint.binding.host}:${endpoint.binding.port}.`);
    }
  }
  const enabledEndpoints = endpoints.filter((endpoint) => endpoint.enabled);
  for (let outer = 0; outer < enabledEndpoints.length; outer += 1) {
    for (let inner = outer + 1; inner < enabledEndpoints.length; inner += 1) {
      const left = enabledEndpoints[outer]!;
      const right = enabledEndpoints[inner]!;
      if (endpointsConflict(left, right)) {
        issues.push(`${left.label} and ${right.label} are configured to bind the same host/port envelope (${left.binding.host}:${left.binding.port}, ${right.binding.host}:${right.binding.port}).`);
      }
    }
  }
  const log = readLogPosture(status.logPath, options.logTailBytes ?? 4096);
  if (log.readError) {
    issues.push(`Service log exists but could not be read: ${log.readError}`);
  }

  return {
    config,
    managed: {
      ...status,
      pidPath: pidFilePath(runtime, status.platform),
      lastError: status.actionError ?? null,
    },
    endpoints,
    log,
    issues,
  };
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

export function formatCliServicePosture(posture: CliServicePosture, json = false): string {
  if (json) return JSON.stringify(posture, null, 2);
  return [
    'GoodVibes service',
    `  enabled: ${yesNo(posture.config.enabled)}`,
    `  autostart: ${yesNo(posture.config.autostart)}`,
    `  restartOnFailure: ${yesNo(posture.config.restartOnFailure)}`,
    `  daemon flag: ${yesNo(posture.config.daemonEnabled)}`,
    '',
    'Managed service:',
    `  platform: ${posture.managed.platform}`,
    `  installed: ${yesNo(posture.managed.installed)}`,
    `  running: ${yesNo(posture.managed.running)}`,
    `  pid: ${posture.managed.pid ?? 'n/a'}`,
    `  definition: ${posture.managed.path}`,
    `  pid file: ${posture.managed.pidPath}`,
    `  log: ${posture.log.path ?? 'n/a'} (${posture.log.exists ? 'present' : 'missing'})`,
    ...(posture.log.readError ? [`  log read error: ${posture.log.readError}`] : []),
    `  command: ${posture.managed.commandPreview}`,
    '',
    'Endpoints:',
    ...posture.endpoints.map((endpoint) =>
      `  ${endpoint.label}: enabled=${yesNo(endpoint.enabled)} ${endpoint.binding.hostMode} ${endpoint.binding.host}:${endpoint.binding.port} posture=${endpoint.bindPosture.label}${endpoint.reachable === undefined ? '' : ` reachable=${yesNo(endpoint.reachable)}`}`,
    ),
    '',
    posture.issues.length === 0 ? 'Readiness: ready' : 'Readiness: needs attention',
    ...posture.issues.map((issue) => `  - ${issue}`),
  ].join('\n');
}
