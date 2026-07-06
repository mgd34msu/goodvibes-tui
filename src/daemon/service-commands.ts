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
 *
 * W4-D1: a fourth subcommand, `migrate-service`, closes the Wave-3 "detect and
 * disclose only" inheritance (W3 Finding 4, below) with a GUIDED, CONSENTED
 * takeover of the legacy `goodvibes-daemon.service` unit. Design constraints,
 * all load-bearing:
 *   - NEVER auto-migrate. Without explicit consent (`confirmMigration`, wired
 *     from the CLI's existing `-y`/`--yes` flag) this prints the exact plan
 *     and touches nothing.
 *   - NEW-UP-THEN-OLD-DOWN. The new `goodvibes.service` unit is installed,
 *     started, and verified healthy (a fresh `status().running` read, which
 *     honestly queries systemd via the injected actionRunner) BEFORE the
 *     legacy unit is stopped, disabled, or removed. A failed or unhealthy new
 *     unit rolls itself back (uninstalled) and never touches the legacy one
 *     — a botched takeover must never cost the user their working daemon.
 *   - ADOPT-OR-WARN, NEVER KILL. If the legacy unit file is simply absent but
 *     something is already listening on the configured host:port (Mike's real
 *     dev-host case: a manual `nohup`'d daemon with no unit at all), this is
 *     an unidentified process, not a managed unit — there is nothing to stop
 *     or disable, and this module will not attempt to kill it. It warns and
 *     leaves the decision to the operator.
 *   - Every action (legacy stop/disable, unit-file removal, daemon-reload)
 *     goes through the SAME injectable `actionRunner`/`legacyUnitFileRemove`
 *     seams tests already use — this module never has a code path that bypasses
 *     them, so the migration is exercised deterministically via fakes and never
 *     touches a real running service in tests.
 */

import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { PlatformServiceManager, type ManagedServiceStatus } from '@pellux/goodvibes-sdk/platform/daemon';
import {
  buildManagedDaemonServiceManager,
  detectLegacyUnit,
  legacyUnitNote,
  resolveManagedUnitName,
  runLegacyDaemonMigration,
  LEGACY_SERVICE_UNIT_NAME,
  MANAGED_SERVICE_NAME as SERVICE_NAME,
  MANAGED_SERVICE_DESCRIPTION as SERVICE_DESCRIPTION,
  type LegacyUnitInfo,
  type ManagedServiceActionRunner,
} from '../runtime/legacy-daemon-migration.ts';

// `resolveInstalledDaemonBinary` lives in the runtime module (shared with the
// onboarding guided UX) — re-exported here so this module stays the CLI's
// stable public surface (and so existing test imports keep working).
export {
  resolveInstalledDaemonBinary,
  type ResolveDaemonBinaryOptions,
} from '../runtime/legacy-daemon-migration.ts';
export type { ManagedServiceActionRunner } from '../runtime/legacy-daemon-migration.ts';

// ---------------------------------------------------------------------------
// W3 Finding 4: legacy-unit detection. W4-D1: guided migration.
//
// The prior D7a-era command installed the daemon's systemd unit under the
// literal name `goodvibes-daemon.service`. This module (rewired onto
// PlatformServiceManager, see the file banner above) manages a DIFFERENT
// unit name (`goodvibes`, SERVICE_NAME). A host that still has the legacy
// unit installed — this dev machine included — would otherwise see
// service-status honestly report installed:false/running:false for the
// tracked name while the legacy unit keeps running untouched underneath it,
// uninstall-service would silently leave the legacy unit orphaned with no
// mention, and install-service could start a SECOND daemon competing for the
// same port.
//
// The detection (`detectLegacyUnit`/`legacyUnitNote`) and the guided
// migration engine (`runLegacyDaemonMigration`) both live in
// `../runtime/legacy-daemon-migration.ts` rather than here, so the TUI's
// onboarding UX (`src/input/handler-onboarding-daemon-adopt.ts`) can reuse
// them directly — the architecture gate forbids `src/input/**` from
// importing `src/daemon/**` (input must stay entrypoint-agnostic), so the
// shared engine lives in the entrypoint-agnostic `runtime` layer instead and
// this CLI module is just one of its two consumers.
//
// This detection is entirely independent of PlatformServiceManager's own
// status() — it does not rely on (or get invalidated by) the parallel SDK
// fix that makes status().running itself query systemd honestly for the
// TRACKED unit name.
// ---------------------------------------------------------------------------

export type DaemonServiceSubcommand = 'install-service' | 'uninstall-service' | 'service-status' | 'migrate-service';

export function isDaemonServiceSubcommand(value: string | undefined): value is DaemonServiceSubcommand {
  return value === 'install-service' || value === 'uninstall-service' || value === 'service-status' || value === 'migrate-service';
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
  /** Injectable existsSync for the legacy-unit file check (W3 Finding 4) so tests never touch the host filesystem. */
  readonly legacyUnitFileExists?: ((path: string) => boolean) | undefined;
  /**
   * `migrate-service` only: explicit consent to actually execute the
   * migration (wired from the CLI's `-y`/`--yes` flag). Without it, the
   * subcommand prints the exact plan and changes nothing — never auto-migrate.
   */
  readonly confirmMigration?: boolean | undefined;
  /**
   * `migrate-service` only: injectable port-liveness check for the
   * legacy-absent branch (never a raw network call in tests). Defaults to a
   * real, read-only TCP connect attempt.
   */
  readonly portProbe?: ((host: string, port: number) => boolean | Promise<boolean>) | undefined;
  /**
   * `migrate-service` only: injectable removal of the legacy unit file, so
   * tests never call a raw fs op against a real path. Defaults to a real
   * `rmSync`.
   */
  readonly legacyUnitFileRemove?: ((path: string) => void) | undefined;
}

export interface DaemonServiceCliResult {
  readonly ok: boolean;
  readonly exitCode: number;
  /** Honest, human-readable stdout lines describing exactly what happened. */
  readonly lines: readonly string[];
  readonly status: ManagedServiceStatus;
}

/**
 * The manager's definition (`ExecStart` command/args, name, description) is
 * built once, in `../runtime/legacy-daemon-migration.ts`, and shared with the
 * onboarding guided UX — see that module's doc comment for why.
 */
function buildManager(input: DaemonServiceCliInput): PlatformServiceManager {
  return buildManagedDaemonServiceManager({
    binaryPath: input.binaryPath,
    homeDir: input.homeDir,
    host: input.host,
    port: input.port,
    workingDirectory: input.workingDirectory,
    configManager: input.configManager,
    actionRunner: input.actionRunner,
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
    // W3 Finding 4: this used to assert "'running' here only reflects
    // processes this tool started directly" — true for the pid-file-only
    // check the (currently linked) SDK still uses, but the parallel SDK
    // batch is making status().running query systemd honestly via
    // `is-active`, which would make that specific claim stale. Drop the
    // claim about HOW running was computed and just offer the escape
    // hatch — true and useful under either SDK version.
    lines.push(
      `note: if this looks wrong, verify directly: ${status.suggestedCommands[status.suggestedCommands.length - 1] ?? 'the platform service-status command'}`,
    );
  }
  return lines;
}

/**
 * Build the install-branch's result lines. Exported for direct unit
 * coverage: the "suggested follow-ups" block is gated on the actual
 * not-started case (W3 Finding 4 friction fix) rather than printed
 * unconditionally, and driving that through the full
 * PlatformServiceManager/systemd integration can't reliably produce
 * `running: true` under the (currently linked) SDK build, whose systemd
 * status check is still pid-file-only (see the honesty note above).
 */
export function buildInstallResultLines(status: ManagedServiceStatus): string[] {
  const lines = [`installed the ${status.platform} service at ${status.path}`];
  if (status.running) {
    lines.push('service is enabled and running');
  } else {
    lines.push('suggested follow-ups if it did not start automatically:');
    for (const cmd of status.suggestedCommands) lines.push(`  ${cmd}`);
  }
  return lines;
}

function ok(action: 'install' | 'uninstall' | 'status', status: ManagedServiceStatus, extra: string[] = []): DaemonServiceCliResult {
  const lines: string[] = [];
  if (action === 'install') {
    lines.push(...buildInstallResultLines(status));
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

/**
 * `migrate-service`: the guided, consented takeover of the legacy
 * `goodvibes-daemon.service` unit (W4-D1). Thin wrapper over
 * `runLegacyDaemonMigration` (`../runtime/legacy-daemon-migration.ts`) — see
 * that module for the design constraints (never auto-migrate,
 * new-up-then-old-down, adopt-or-warn/never kill an unrecognized process,
 * every action through an injectable seam) and the onboarding UX consumer.
 */
function runMigrateService(
  input: DaemonServiceCliInput,
  manager: PlatformServiceManager,
  legacy: LegacyUnitInfo,
): Promise<DaemonServiceCliResult> {
  return runLegacyDaemonMigration(
    {
      host: input.host,
      port: input.port,
      trackedServiceName: SERVICE_NAME,
      confirmMigration: input.confirmMigration,
      portProbe: input.portProbe,
      legacyUnitFileRemove: input.legacyUnitFileRemove,
      actionRunner: input.actionRunner,
    },
    manager,
    legacy,
  );
}

/** Dispatch a daemon service subcommand to the SDK's `PlatformServiceManager`. */
export async function runDaemonServiceCli(input: DaemonServiceCliInput): Promise<DaemonServiceCliResult> {
  const manager = buildManager(input);
  const legacy = detectLegacyUnit(input);
  switch (input.subcommand) {
    case 'migrate-service':
      return runMigrateService(input, manager, legacy);
    case 'install-service': {
      // W3 Finding 4: refuse rather than risk starting a second daemon
      // alongside an already-installed legacy unit. Refuses whenever the
      // legacy unit is present at all (not just when currently active) —
      // an installed-but-inactive legacy unit can still be enabled and
      // start competing for the same port later, and "never silently
      // start a second daemon" is the bar here, not "never right now."
      if (legacy.present) {
        const status = manager.status();
        const resolvedName = resolveManagedUnitName(status);
        return {
          ok: false,
          exitCode: 1,
          lines: [
            `service install refused: a service is already installed under the legacy name ${LEGACY_SERVICE_UNIT_NAME}.service.`,
            legacyUnitNote(legacy, resolvedName),
            `Installing this tool's ${resolvedName}.service alongside it risks two daemons competing for the same port.`,
          ],
          status,
        };
      }
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
      const extra: string[] = [];
      if (stopped.actionError) extra.push(`(it may not have been running: ${stopped.actionError})`);
      // W3 Finding 4: this command only ever touches the TRACKED unit
      // (whatever name/path actually resolved, per F2 — not necessarily the
      // SERVICE_NAME constant) above — say so explicitly when a legacy unit
      // also exists, so its continued presence is never a silent surprise.
      if (legacy.present) extra.push(legacyUnitNote(legacy, resolveManagedUnitName(uninstalled)));
      return ok('uninstall', uninstalled, extra);
    }
    case 'service-status': {
      const status = manager.status();
      if (status.actionError) return failed('status', status);
      return ok('status', status, legacy.present ? [legacyUnitNote(legacy, resolveManagedUnitName(status))] : []);
    }
  }
}
