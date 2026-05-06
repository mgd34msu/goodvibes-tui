import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { ManagedServiceStatus } from '@pellux/goodvibes-sdk/platform/daemon';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import {
  createPlatformServiceManager,
  getServiceStateRoot,
  type CliServiceRuntime,
} from '../cli/service-posture.ts';

type ManagedServiceAction = 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'status';

export interface ServiceManagerLike {
  status(): ManagedServiceStatus;
  install(): ManagedServiceStatus;
  uninstall(): ManagedServiceStatus;
  start(): ManagedServiceStatus;
  stop(): ManagedServiceStatus;
  restart(): ManagedServiceStatus;
}

export interface CommandResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface ServiceSettingsSyncChange {
  readonly key: ConfigKey;
  readonly previousValue: unknown;
  readonly value: unknown;
}

export interface ServiceSettingsSyncResult {
  readonly handled: boolean;
  readonly action?: ManagedServiceAction | 'install-start' | 'disable';
  readonly status?: ManagedServiceStatus;
  readonly message?: string;
  readonly error?: string;
}

export interface ServiceSettingsSyncOptions {
  readonly createManager?: (runtime: CliServiceRuntime) => ServiceManagerLike;
  readonly runCommand?: (command: string, args: readonly string[]) => CommandResult;
  readonly mkdir?: typeof mkdirSync;
}

const SERVICE_DEFINITION_KEYS = new Set<ConfigKey>([
  'service.restartOnFailure',
  'service.platform',
  'service.serviceName',
  'service.logPath',
] as ConfigKey[]);

function runCommand(command: string, args: readonly string[], options: ServiceSettingsSyncOptions): CommandResult {
  if (options.runCommand) return options.runCommand(command, args);
  return spawnSync(command, [...args], { stdio: 'pipe', encoding: 'utf-8' });
}

function commandError(result: CommandResult): string | null {
  if ((result.status ?? 1) === 0) return null;
  return ((result.stderr ?? '') || (result.stdout ?? '') || `command exited with ${result.status}`).trim();
}

function serviceName(runtime: CliServiceRuntime, fallback = 'goodvibes'): string {
  return String(runtime.configManager.get('service.serviceName') ?? fallback).trim() || fallback;
}

function runSystemd(runtime: CliServiceRuntime, args: readonly string[], options: ServiceSettingsSyncOptions): string | null {
  const result = runCommand('systemctl', ['--user', ...args], options);
  return commandError(result);
}

function reloadSystemdIfNeeded(
  runtime: CliServiceRuntime,
  status: ManagedServiceStatus,
  options: ServiceSettingsSyncOptions,
): string | null {
  if (status.platform !== 'systemd') return null;
  return runSystemd(runtime, ['daemon-reload'], options);
}

function disableSystemService(
  runtime: CliServiceRuntime,
  manager: ServiceManagerLike,
  options: ServiceSettingsSyncOptions,
): ServiceSettingsSyncResult {
  const before = manager.status();
  let disableError: string | null = null;
  if (before.platform === 'systemd') {
    disableError = before.installed || before.running
      ? runSystemd(runtime, ['disable', '--now', `${serviceName(runtime)}.service`], options)
      : null;
    if (disableError) {
      logger.warn('Settings service sync: systemd disable failed', { error: disableError });
    }
  } else if (before.running || before.installed) {
    const stopped = manager.stop();
    if (stopped.actionError) {
      return {
        handled: true,
        action: 'stop',
        status: stopped,
        message: `Service disable failed: ${stopped.actionError}`,
        error: stopped.actionError,
      };
    }
  }

  const uninstalled = manager.uninstall();
  const reloadError = reloadSystemdIfNeeded(runtime, uninstalled, options);
  const error = uninstalled.actionError ?? reloadError ?? disableError ?? undefined;
  return {
    handled: true,
    action: 'disable',
    status: uninstalled,
    message: error ? `Service disable failed: ${error}` : 'OS service disabled',
    ...(error ? { error } : {}),
  };
}

function installAndStartSystemService(
  runtime: CliServiceRuntime,
  manager: ServiceManagerLike,
  options: ServiceSettingsSyncOptions,
): ServiceSettingsSyncResult {
  (options.mkdir ?? mkdirSync)(getServiceStateRoot(runtime), { recursive: true });
  const installed = manager.install();
  if (installed.actionError) {
    return {
      handled: true,
      action: 'install',
      status: installed,
      message: `Service install failed: ${installed.actionError}`,
      error: installed.actionError,
    };
  }

  const reloadError = reloadSystemdIfNeeded(runtime, installed, options);
  if (reloadError) {
    return {
      handled: true,
      action: 'install',
      status: installed,
      message: `Service install failed: ${reloadError}`,
      error: reloadError,
    };
  }

  const started = manager.start();
  const error = started.actionError ?? undefined;
  return {
    handled: true,
    action: 'install-start',
    status: started,
    message: error ? `Service start failed: ${error}` : 'OS service installed and started',
    ...(error ? { error } : {}),
  };
}

function refreshInstalledSystemService(
  runtime: CliServiceRuntime,
  manager: ServiceManagerLike,
  options: ServiceSettingsSyncOptions,
): ServiceSettingsSyncResult {
  const before = manager.status();
  if (!before.installed && runtime.configManager.get('service.autostart') !== true) {
    return {
      handled: true,
      action: 'status',
      status: before,
      message: 'Service setting saved',
    };
  }

  const installed = manager.install();
  if (installed.actionError) {
    return {
      handled: true,
      action: 'install',
      status: installed,
      message: `Service update failed: ${installed.actionError}`,
      error: installed.actionError,
    };
  }

  const reloadError = reloadSystemdIfNeeded(runtime, installed, options);
  if (reloadError) {
    return {
      handled: true,
      action: 'install',
      status: installed,
      message: `Service update failed: ${reloadError}`,
      error: reloadError,
    };
  }

  const next = before.running ? manager.restart() : manager.start();
  const error = next.actionError ?? undefined;
  return {
    handled: true,
    action: before.running ? 'restart' : 'start',
    status: next,
    message: error ? `Service update failed: ${error}` : 'OS service updated',
    ...(error ? { error } : {}),
  };
}

export function syncServiceSettingToPlatform(
  runtime: CliServiceRuntime,
  change: ServiceSettingsSyncChange,
  options: ServiceSettingsSyncOptions = {},
): ServiceSettingsSyncResult {
  if (!String(change.key).startsWith('service.')) return { handled: false };
  if (change.previousValue === change.value) return { handled: true, message: 'Service setting unchanged' };

  const manager = options.createManager?.(runtime) ?? createPlatformServiceManager(runtime);

  try {
    if (change.key === 'service.autostart') {
      if (change.value === true) {
        if (runtime.configManager.get('service.enabled') !== true) {
          runtime.configManager.setDynamic('service.enabled', true);
        }
        return installAndStartSystemService(runtime, manager, options);
      }
      return disableSystemService(runtime, manager, options);
    }

    if (change.key === 'service.enabled') {
      if (change.value === false) {
        if (runtime.configManager.get('service.autostart') === true) {
          runtime.configManager.setDynamic('service.autostart', false);
        }
        return disableSystemService(runtime, manager, options);
      }
      if (runtime.configManager.get('service.autostart') === true) {
        return installAndStartSystemService(runtime, manager, options);
      }
      return {
        handled: true,
        action: 'status',
        status: manager.status(),
        message: 'Service mode saved; enable autostart to install the OS service',
      };
    }

    if (SERVICE_DEFINITION_KEYS.has(change.key)) {
      if (runtime.configManager.get('service.enabled') === true && runtime.configManager.get('service.autostart') === true) {
        return refreshInstalledSystemService(runtime, manager, options);
      }
      return {
        handled: true,
        action: 'status',
        status: manager.status(),
        message: 'Service setting saved; enable autostart to install the OS service',
      };
    }
  } catch (error) {
    const summarized = summarizeError(error);
    logger.error('Settings service sync failed', { key: change.key, error: summarized });
    return {
      handled: true,
      action: 'status',
      status: manager.status(),
      message: `Service sync failed: ${summarized}`,
      error: summarized,
    };
  }

  return { handled: false };
}
