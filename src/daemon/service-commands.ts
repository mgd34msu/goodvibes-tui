/**
 * D7a Layer 1 (TUI wiring) — `goodvibes-daemon install-service | uninstall-service
 * | service-status`.
 *
 * The daemon is a SYSTEM SERVICE. These subcommands install it as a systemd USER
 * unit so N surfaces share ONE daemon that survives reboots, instead of every
 * surface spawning a session-scoped daemon. The actual unit generation +
 * systemctl orchestration lives in the SDK (`@pellux/goodvibes-sdk/platform/daemon`,
 * a pure + injectable-runner design); this module only resolves the concrete
 * `goodvibes-daemon` binary path + home/host/port and formats honest stdout.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installGoodvibesDaemonUserService,
  uninstallGoodvibesDaemonUserService,
  goodvibesDaemonUserServiceStatus,
  type DaemonServiceEnvironment,
  type DaemonServiceResult,
} from '@pellux/goodvibes-sdk/platform/daemon';

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
  /** Injectable environment (platform + systemctl runner) so tests never call real systemctl. */
  readonly env?: DaemonServiceEnvironment | undefined;
}

/** Dispatch a daemon service subcommand to the SDK implementation. */
export function runDaemonServiceCli(input: DaemonServiceCliInput): DaemonServiceResult {
  const unit = {
    binaryPath: input.binaryPath,
    homeDir: input.homeDir,
    host: input.host,
    port: input.port,
  };
  switch (input.subcommand) {
    case 'install-service':
      return installGoodvibesDaemonUserService(unit, input.env);
    case 'uninstall-service':
      return uninstallGoodvibesDaemonUserService({ homeDir: input.homeDir }, input.env);
    case 'service-status':
      return goodvibesDaemonUserServiceStatus({ homeDir: input.homeDir }, input.env);
  }
}
