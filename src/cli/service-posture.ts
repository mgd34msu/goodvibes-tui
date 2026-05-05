import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
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

function pidFilePath(runtime: CliServiceRuntime, platform: ManagedServiceStatus['platform']): string {
  return join(runtime.workingDirectory, '.goodvibes', 'tui', 'service', `${platform}.pid`);
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
  return new PlatformServiceManager(runtime.configManager, {
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
    surfaceRoot: 'tui',
    binaryBaseName: 'goodvibes-daemon',
    defaultServiceName: 'goodvibes',
    defaultServiceDescription: 'GoodVibes daemon, control-plane, listener, and web host',
  });
}

export async function buildCliServicePosture(
  runtime: CliServiceRuntime,
  options: { readonly probe?: boolean; readonly logTailBytes?: number } = {},
): Promise<CliServicePosture> {
  const manager = createPlatformServiceManager(runtime);
  const status = manager.status();
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
