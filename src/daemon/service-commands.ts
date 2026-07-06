/**
 * D7a Layer 1 (TUI wiring) — `goodvibes-daemon install-service | uninstall-service
 * | service-status`.
 *
 * The daemon is a SYSTEM SERVICE. These subcommands install it as a durable host
 * service (systemd user unit on Linux, launchd agent on macOS, a Scheduled Task
 * on Windows) so N surfaces share ONE daemon that survives reboots, instead of
 * every surface spawning a session-scoped daemon.
 *
 * W3 drift note: the SDK's D7a-era `systemd-user-service.ts` (a Linux-only,
 * bespoke systemd shim) was dead code and got deleted in SDK W3-S5. The SDK's
 * REAL wired service machinery — reached in production by the daemon's own HTTP
 * `/api/service/*` routes via facade-composition.ts — is
 * `PlatformServiceManager` (`@pellux/goodvibes-sdk/platform/daemon`): a single
 * systemd/launchd/windows-aware manager with install/uninstall/status/start/
 * stop/restart and a `suggestedCommands` hint list. This module now rewires the
 * three CLI subcommands onto that manager instead of the deleted shim.
 *
 * Two real behavioral differences from the old shim, called out honestly:
 *   - `install()` only WRITES the unit/plist/task; it does not enable/start it.
 *     So `install-service` here calls `install()` then `start()` to preserve the
 *     old "install implies enabled + running" behavior.
 *   - `uninstall()` only REMOVES the unit file; there is no manager-level
 *     `disable` verb (only start/stop/restart exist). So `uninstall-service`
 *     calls `stop()` then `uninstall()`, and honestly tells the caller that a
 *     stray "enabled" symlink may remain until `systemctl --user daemon-reload`
 *     (offered back as a suggested follow-up) or the next login cleans it up.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { PlatformServiceManager, type ManagedServiceStatus } from '@pellux/goodvibes-sdk/platform/daemon';

/** Structurally derived from `PlatformServiceManager`'s own constructor — the
 * SDK's public `platform/daemon` entry point only re-exports the class and
 * `ManagedServiceStatus`, not the options/definition/action-runner interfaces
 * by name, so we pull their shapes off the class itself rather than reaching
 * past the package's declared export map. */
type ManagedServiceManagerOptions = ConstructorParameters<typeof PlatformServiceManager>[1];
type ManagedServiceDefinition = NonNullable<ManagedServiceManagerOptions['definitionOverride']>;
export type ManagedServiceActionRunner = NonNullable<ManagedServiceManagerOptions['actionRunner']>;

// Fallback only: `service.serviceName`/nothing-set config default is 'goodvibes'
// (schema-domain-runtime.ts), which is what PlatformServiceManager actually
// resolves to in the common case via `resolveServiceName()`'s `config.get(...)
// ?? defaultServiceName`. Using the same name here (rather than the old shim's
// bespoke 'goodvibes-daemon') means this CLI manages the exact same unit the
// SDK's own facade-composition.ts would manage — one shared service, one name.
const SERVICE_NAME = 'goodvibes';
const SERVICE_DESCRIPTION = 'GoodVibes daemon (shared session broker + companion host)';

export type DaemonServiceSubcommand = 'install-service' | 'uninstall-service' | 'service-status';

export function isDaemonServiceSubcommand(value: string | undefined): value is DaemonServiceSubcommand {
  return value === 'install-service' || value === 'uninstall-service' || value === 'service-status';
}

export interface ResolveDaemonBinaryOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** `import.meta.url` of the caller so the packaged `bin/goodvibes-daemon` can be located. */
  readonly moduleUrl?: string | undefined;
  readonly execPath?: string | undefined;
  readonly fileExists?: ((path: string) => boolean) | undefined;
}

/**
 * Resolve the absolute path to the installed daemon binary used for the unit's
 * `ExecStart`. Preference order:
 *   1. `GOODVIBES_DAEMON_BINARY` env override.
 *   2. The packaged `bin/goodvibes-daemon` launcher next to this checkout.
 *   3. `process.execPath` when this IS the compiled daemon binary.
 *   4. Bare `goodvibes-daemon` (resolved on PATH by systemd's service environment).
 */
export function resolveInstalledDaemonBinary(options: ResolveDaemonBinaryOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.GOODVIBES_DAEMON_BINARY?.trim();
  if (override) return override;

  const fileExists = options.fileExists ?? existsSync;
  if (options.moduleUrl) {
    try {
      // src/daemon/service-commands.ts -> package root is two directories up.
      const here = dirname(fileURLToPath(options.moduleUrl));
      const launcher = join(here, '..', '..', 'bin', 'goodvibes-daemon');
      if (fileExists(launcher)) return launcher;
    } catch {
      // fall through to execPath / PATH resolution
    }
  }

  const execPath = options.execPath ?? process.execPath;
  if (execPath && /goodvibes-daemon/.test(execPath)) return execPath;

  return 'goodvibes-daemon';
}

export interface DaemonServiceCliInput {
  readonly subcommand: DaemonServiceSubcommand;
  readonly binaryPath: string;
  readonly homeDir: string;
  readonly host: string;
  readonly port: number;
  /** Defaults to `homeDir` — overridable so tests can scope both to one tempdir. */
  readonly workingDirectory?: string | undefined;
  /** Injected in tests; a real `ConfigManager` rooted at `homeDir` otherwise. */
  readonly configManager?: ConfigManager | undefined;
  /** Injectable systemctl/launchctl/schtasks runner so tests never touch the host. */
  readonly actionRunner?: ManagedServiceActionRunner | undefined;
}

export interface DaemonServiceCliResult {
  readonly ok: boolean;
  readonly exitCode: number;
  /** Honest, human-readable stdout lines describing exactly what happened. */
  readonly lines: readonly string[];
  readonly status: ManagedServiceStatus;
}

function buildDefinition(input: DaemonServiceCliInput, workingDirectory: string): ManagedServiceDefinition {
  return {
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    workingDirectory,
    command: input.binaryPath,
    args: ['--daemon-home', input.homeDir, '--hostname', input.host, '--port', String(input.port)],
    env: {},
    restartOnFailure: true,
  };
}

function buildManager(input: DaemonServiceCliInput): PlatformServiceManager {
  const workingDirectory = input.workingDirectory ?? input.homeDir;
  const configManager = input.configManager ?? new ConfigManager({
    workingDir: workingDirectory,
    homeDir: input.homeDir,
    surfaceRoot: 'tui',
  });
  return new PlatformServiceManager(configManager, {
    workingDirectory,
    homeDirectory: input.homeDir,
    definitionOverride: buildDefinition(input, workingDirectory),
    defaultServiceName: SERVICE_NAME,
    defaultServiceDescription: SERVICE_DESCRIPTION,
    actionRunner: input.actionRunner,
    // No `featureFlags` passed: `isFeatureGateEnabled` treats a missing reader as
    // always-open. These three subcommands ARE the user's explicit request to
    // manage the service, unlike the daemon's own HTTP /api/service/* routes
    // (which gate on the real, config-backed 'service-management' flag).
  });
}

function statusLines(status: ManagedServiceStatus): string[] {
  const lines = [
    `platform: ${status.platform}`,
    `installed: ${status.installed}`,
    `running: ${status.running}`,
    `unit path: ${status.path}`,
  ];
  if (status.pid !== undefined) lines.push(`pid: ${status.pid}`);
  if (status.platform !== 'manual' && status.installed && !status.running) {
    lines.push(
      `note: 'running' here only reflects processes this tool started directly; ` +
        `for the authoritative state run: ${status.suggestedCommands[status.suggestedCommands.length - 1] ?? 'the platform service-status command'}`,
    );
  }
  return lines;
}

function ok(action: 'install' | 'uninstall' | 'status', status: ManagedServiceStatus, extra: string[] = []): DaemonServiceCliResult {
  const lines: string[] = [];
  if (action === 'install') {
    lines.push(`installed the ${status.platform} service at ${status.path}`);
    if (status.running) lines.push('service is enabled and running');
    lines.push('suggested follow-ups if it did not start automatically:');
    for (const cmd of status.suggestedCommands) lines.push(`  ${cmd}`);
  } else if (action === 'uninstall') {
    lines.push(`removed the ${status.platform} service at ${status.path}`);
    if (status.platform === 'systemd') {
      lines.push(
        "note: this removes the unit file but does not run `disable` — run " +
          "`systemctl --user daemon-reload` to clear any stale enablement symlink.",
      );
    }
  } else {
    lines.push(...statusLines(status));
  }
  lines.push(...extra);
  return { ok: true, exitCode: 0, lines, status };
}

function failed(action: 'install' | 'uninstall' | 'status', status: ManagedServiceStatus): DaemonServiceCliResult {
  return {
    ok: false,
    exitCode: 1,
    lines: [`service ${action} failed: ${status.actionError ?? 'unknown error'}`],
    status,
  };
}

/** Dispatch a daemon service subcommand to the SDK's `PlatformServiceManager`. */
export function runDaemonServiceCli(input: DaemonServiceCliInput): DaemonServiceCliResult {
  const manager = buildManager(input);
  switch (input.subcommand) {
    case 'install-service': {
      const installed = manager.install();
      if (installed.actionError) return failed('install', installed);
      const started = manager.start();
      // start()'s actionError (e.g. a platform this manager can't dispatch
      // actions for) doesn't undo the write — report install as ok, but surface
      // the follow-up problem honestly instead of claiming it is running.
      return started.actionError
        ? ok('install', { ...started, running: false }, [`could not start it automatically: ${started.actionError}`])
        : ok('install', started);
    }
    case 'uninstall-service': {
      const stopped = manager.stop();
      const uninstalled = manager.uninstall();
      if (uninstalled.actionError) return failed('uninstall', uninstalled);
      return stopped.actionError
        ? ok('uninstall', uninstalled, [`(it may not have been running: ${stopped.actionError})`])
        : ok('uninstall', uninstalled);
    }
    case 'service-status': {
      const status = manager.status();
      return status.actionError ? failed('status', status) : ok('status', status);
    }
  }
}
