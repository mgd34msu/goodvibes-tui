/**
 * W4-D1: the legacy `goodvibes-daemon.service` detect/migrate engine, shared
 * by the daemon CLI (`src/daemon/service-commands.ts`, the `migrate-service`
 * subcommand) and the interactive TUI's onboarding guided UX
 * (`src/input/handler-onboarding-daemon-adopt.ts`).
 *
 * This lives under `src/runtime/` — not `src/daemon/` — specifically so the
 * `input` layer can consume it directly: the architecture gate's
 * `input-no-entrypoints` rule forbids `src/input/**` from importing
 * `src/daemon/**` (input must stay a pure event-handling layer, never
 * depending on CLI/daemon entrypoint concerns), and `src/runtime/**` is the
 * shared, entrypoint-agnostic layer both sides are already allowed to import.
 *
 * Wave 3 (W3 Finding 4) shipped DETECT + DISCLOSE only: a read-only check for
 * the prior D7a-era systemd unit name plus a manual-removal hint, never
 * touching it. This module adds the guided, CONSENTED migration itself.
 * Design constraints, all load-bearing (see also the per-function docs):
 *   - NEVER auto-migrate. Without explicit consent nothing runs except a
 *     dry-run plan.
 *   - NEW-UP-THEN-OLD-DOWN. The new unit is installed, started, and verified
 *     healthy (a fresh, honest systemd `is-active` read through the injected
 *     actionRunner) BEFORE the legacy unit is stopped, disabled, or removed.
 *     A new unit that fails or doesn't come up healthy rolls itself back
 *     (uninstalled) and never touches the legacy one.
 *   - ADOPT-OR-WARN, NEVER KILL. If the legacy unit file is simply absent but
 *     something is already listening on the configured host:port (this dev
 *     host's real case: a manually `nohup`'d daemon with no unit at all),
 *     that is an unidentified process, not a managed unit — nothing to stop
 *     or disable, and this module never attempts to kill it.
 *   - Every action (legacy stop/disable, unit-file removal, daemon-reload)
 *     goes through the injectable `actionRunner`/`legacyUnitFileRemove` seams
 *     tests use — no code path here bypasses them, so the migration is
 *     exercised deterministically via fakes and never touches a real running
 *     service in tests.
 */
import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { PlatformServiceManager, type ManagedServiceStatus } from '@pellux/goodvibes-sdk/platform/daemon';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/** Structurally derived from `PlatformServiceManager`'s own constructor — the
 * SDK's public `platform/daemon` entry point only re-exports the class and
 * `ManagedServiceStatus`, not the options/definition/action-runner interfaces
 * by name, so we pull their shapes off the class itself rather than reaching
 * past the package's declared export map. */
type ManagedServiceManagerOptions = ConstructorParameters<typeof PlatformServiceManager>[1];
type ManagedServiceDefinition = NonNullable<ManagedServiceManagerOptions['definitionOverride']>;
export type ManagedServiceActionRunner = NonNullable<ManagedServiceManagerOptions['actionRunner']>;
type ManagedServiceActionResult = ReturnType<ManagedServiceActionRunner>;

// The one unit name/description this tool manages — shared by the daemon CLI
// (`goodvibes-daemon install-service|uninstall-service|service-status|migrate-service`)
// and the TUI onboarding UX, so both build the EXACT same service definition.
// `service.serviceName`/nothing-set config default is 'goodvibes'
// (schema-domain-runtime.ts), which is what PlatformServiceManager actually
// resolves to in the common case via `resolveServiceName()`'s `config.get(...)
// ?? defaultServiceName`.
export const MANAGED_SERVICE_NAME = 'goodvibes';
export const MANAGED_SERVICE_DESCRIPTION = 'GoodVibes daemon (shared session broker + companion host)';

export interface BuildManagedDaemonServiceManagerParams {
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

/**
 * Build the ONE `PlatformServiceManager` this tool manages — the single
 * source of truth for the unit's definition (`ExecStart` command/args,
 * name, description). Both `src/daemon/service-commands.ts` (the CLI) and
 * `src/input/handler-onboarding-daemon-adopt.ts` (the onboarding guided UX)
 * call this so a migration triggered from either surface installs the
 * identical unit — no risk of the two consumers drifting apart.
 */
export function buildManagedDaemonServiceManager(params: BuildManagedDaemonServiceManagerParams): PlatformServiceManager {
  const workingDirectory = params.workingDirectory ?? params.homeDir;
  const configManager = params.configManager ?? new ConfigManager({
    workingDir: workingDirectory,
    homeDir: params.homeDir,
    surfaceRoot: 'tui',
  });
  const definition: ManagedServiceDefinition = {
    name: MANAGED_SERVICE_NAME,
    description: MANAGED_SERVICE_DESCRIPTION,
    workingDirectory,
    command: params.binaryPath,
    args: ['--daemon-home', params.homeDir, '--hostname', params.host, '--port', String(params.port)],
    env: {},
    restartOnFailure: true,
  };
  return new PlatformServiceManager(configManager, {
    workingDirectory,
    homeDirectory: params.homeDir,
    definitionOverride: definition,
    defaultServiceName: MANAGED_SERVICE_NAME,
    defaultServiceDescription: MANAGED_SERVICE_DESCRIPTION,
    actionRunner: params.actionRunner,
    // No `featureFlags` passed: `isFeatureGateEnabled` treats a missing reader
    // as always-open. Both consumers here are the user's explicit request to
    // manage the service, unlike the daemon's own HTTP /api/service/* routes
    // (which gate on the real, config-backed 'service-management' flag).
  });
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
 *
 * Lives here (not in `src/daemon/service-commands.ts`) so both consumers can
 * call it: it only needs the CALLER's own `import.meta.url` to locate the
 * packaged `bin/` directory two levels up from ANY `src/<layer>/*.ts` file
 * (`src/daemon/service-commands.ts` and `src/input/handler-onboarding-daemon-adopt.ts`
 * are equally one level deep under `src/`), so the resolution has no actual
 * CLI/daemon-specific dependency.
 */
export function resolveInstalledDaemonBinary(options: ResolveDaemonBinaryOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.GOODVIBES_DAEMON_BINARY?.trim();
  if (override) return override;

  const fileExists = options.fileExists ?? existsSync;
  if (options.moduleUrl) {
    try {
      // e.g. src/daemon/service-commands.ts -> package root is two directories up.
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

export const LEGACY_SERVICE_UNIT_NAME = 'goodvibes-daemon';

export interface LegacyUnitInfo {
  readonly present: boolean;
  readonly active: boolean;
  readonly path: string;
}

export function legacyUnitPath(homeDir: string): string {
  return join(homeDir, '.config', 'systemd', 'user', `${LEGACY_SERVICE_UNIT_NAME}.service`);
}

export interface DetectLegacyUnitInput {
  readonly homeDir: string;
  /** Injectable existsSync so tests never touch the host filesystem. */
  readonly legacyUnitFileExists?: ((path: string) => boolean) | undefined;
  /** Injectable systemctl/launchctl/schtasks runner so tests never touch the host. */
  readonly actionRunner?: ManagedServiceActionRunner | undefined;
}

/**
 * Read-only detection: does a legacy `goodvibes-daemon.service` unit file
 * exist, and if so, is it currently active? Never stops, disables, or
 * modifies anything — a file-existence check plus a read-only
 * `systemctl --user is-active` query through the injected actionRunner.
 */
export function detectLegacyUnit(input: DetectLegacyUnitInput): LegacyUnitInfo {
  const path = legacyUnitPath(input.homeDir);
  const fileExists = input.legacyUnitFileExists ?? existsSync;
  if (!fileExists(path)) return { present: false, active: false, path };
  const run: ManagedServiceActionRunner = input.actionRunner
    ?? ((command, args) => spawnSync(command, args, { stdio: 'pipe', encoding: 'utf-8' }) as ManagedServiceActionResult);
  const result = run('systemctl', ['--user', 'is-active', `${LEGACY_SERVICE_UNIT_NAME}.service`]);
  const state = (result.stdout ?? '').trim();
  const active = (result.status ?? 1) === 0 && state === 'active';
  return { present: true, active, path };
}

/**
 * F1: the unit name `PlatformServiceManager` is ACTUALLY about to mutate can
 * differ from `MANAGED_SERVICE_NAME` / `definitionOverride.name`. The SDK's
 * internal `resolveServiceName()` — used by `install()`, `uninstall()`, and
 * `status()` alike to compute the unit file PATH — resolves from the
 * `service.serviceName` CONFIG key first, falling back to the
 * `defaultServiceName` this module passes only when that key is unset. It
 * never consults `definitionOverride.name` for the path. So if a host's
 * config sets `service.serviceName` to the legacy unit's own name
 * (`goodvibes-daemon`), `install()` writes over the legacy unit file,
 * `uninstall()` (used for this engine's failed-health rollback) removes it,
 * and a "successful" migration would immediately retire the very unit it
 * just installed.
 *
 * This resolves the name actually in play so callers can detect that
 * collision before mutating anything: it prefers `status.serviceName` when
 * the linked SDK build carries it (a parallel SDK change adds this field to
 * `ManagedServiceStatus` precisely so callers never have to guess), and
 * falls back to the basename of `status.path` with its unit-file extension
 * stripped against an SDK build that predates that field. The fallback only
 * has to handle the systemd `<name>.service` (and launchd `<name>.plist`)
 * shapes: every call site in this module reaches this after already
 * confirming the platform is 'systemd' (a non-systemd host is refused
 * earlier, before any mutation), so the basename fallback is never
 * exercised against the windows/manual path shapes that don't embed the
 * name in their basename.
 */
export function resolveManagedUnitName(status: ManagedServiceStatus): string {
  const carried = (status as { readonly serviceName?: unknown }).serviceName;
  if (typeof carried === 'string' && carried.trim()) return carried.trim();
  return basename(status.path).replace(/\.(service|plist)$/, '');
}

/** Honest one-line disclosure of the legacy unit's presence/state plus a manual migration hint — never auto-acted-on. */
export function legacyUnitNote(legacy: LegacyUnitInfo, trackedServiceName: string): string {
  const stateWord = legacy.active ? 'installed and RUNNING' : 'installed (not currently active)';
  return (
    `note: a service under the legacy name ${LEGACY_SERVICE_UNIT_NAME}.service is ${stateWord} at ${legacy.path} — ` +
    `this tool manages a different unit name (${trackedServiceName}.service) and will not touch the legacy one automatically. ` +
    `Remove it yourself when ready: systemctl --user disable --now ${LEGACY_SERVICE_UNIT_NAME}.service && rm ${legacy.path} && systemctl --user daemon-reload`
  );
}

/**
 * Read-only, best-effort TCP connect probe used ONLY by the legacy-absent
 * branch to tell "nothing is listening on this port" apart from "an
 * unmanaged process (e.g. a manual `nohup`) already owns it." Never used to
 * identify or act on that process — a positive result only produces a
 * warning, never a kill. Tests always inject a fake `portProbe`; this default
 * is never exercised against a real host in this repo's test suite.
 */
export function defaultPortProbe(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : (host || '127.0.0.1');
    const socket = net.createConnection({ host: connectHost, port });
    const finish = (value: boolean): void => {
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

export interface RunLegacyDaemonMigrationParams {
  readonly host: string;
  readonly port: number;
  /** The unit name this tool manages (e.g. 'goodvibes') — distinct from LEGACY_SERVICE_UNIT_NAME. */
  readonly trackedServiceName: string;
  /**
   * Explicit consent to actually execute the migration. Without it, the
   * result is a printed plan only — never auto-migrate.
   */
  readonly confirmMigration?: boolean | undefined;
  /** Injectable port-liveness check for the legacy-absent branch. Defaults to `defaultPortProbe`. */
  readonly portProbe?: ((host: string, port: number) => boolean | Promise<boolean>) | undefined;
  /** Injectable removal of the legacy unit file. Defaults to a real `rmSync`. */
  readonly legacyUnitFileRemove?: ((path: string) => void) | undefined;
  /** Injectable systemctl runner for the legacy stop/disable/daemon-reload steps. */
  readonly actionRunner?: ManagedServiceActionRunner | undefined;
}

/**
 * F1 belt-and-braces guard: throws if the resolved unit `status` is the
 * legacy unit. Called immediately before the two mutation calls
 * (`manager.install()`, and `manager.uninstall()` on the failed-health
 * rollback path) that would otherwise write to or remove that path. This is
 * an internal invariant check, not a normal user-facing error path — the
 * pre-flight collision check in `runLegacyDaemonMigration` already returns
 * before either call site is reached whenever this would trip, so tripping
 * here means that earlier check regressed, not that the user did anything
 * wrong.
 */
function assertUnitIsNotLegacy(status: ManagedServiceStatus, legacy: LegacyUnitInfo, action: string): void {
  if (status.path === legacy.path || resolveManagedUnitName(status) === LEGACY_SERVICE_UNIT_NAME) {
    throw new Error(
      `refusing to ${action}: the resolved managed unit (${resolveManagedUnitName(status)} at ${status.path}) is the ` +
        `legacy ${LEGACY_SERVICE_UNIT_NAME}.service unit — this should already have been caught by the pre-flight ` +
        'collision check in runLegacyDaemonMigration',
    );
  }
}

export interface LegacyDaemonMigrationResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly lines: readonly string[];
  readonly status: ManagedServiceStatus;
}

/**
 * The guided, consented takeover itself. See the file banner for the design
 * constraints (never auto-migrate, new-up-then-old-down, adopt-or-warn/never
 * kill an unrecognized process, every action through an injectable seam).
 */
export async function runLegacyDaemonMigration(
  params: RunLegacyDaemonMigrationParams,
  manager: PlatformServiceManager,
  legacy: LegacyUnitInfo,
): Promise<LegacyDaemonMigrationResult> {
  const { trackedServiceName } = params;
  // Computed once, up front, and reused for every branch below (this is the
  // exact same single call each branch made individually before — see the
  // F1 fix note on `resolveManagedUnitName` for why the name/path it reports
  // can differ from `trackedServiceName`).
  const currentStatus = manager.status();
  const resolvedUnitName = resolveManagedUnitName(currentStatus);

  if (!legacy.present) {
    const probe = params.portProbe ?? defaultPortProbe;
    const occupied = await probe(params.host, params.port);
    if (occupied) {
      return {
        ok: false,
        exitCode: 1,
        lines: [
          `migrate-service: no legacy ${LEGACY_SERVICE_UNIT_NAME}.service unit was found, but something is already ` +
            `listening on ${params.host}:${params.port}.`,
          "That looks like a process this tool doesn't manage (for example, a manually-started `nohup` daemon) rather " +
            'than a systemd unit — there is nothing here to stop or disable, and this tool will not attempt to kill an ' +
            'unrecognized process.',
          'Stop that process yourself (or point this TUI at it instead — see the onboarding "connect to an existing ' +
            'daemon" option), then re-run migrate-service or install-service once the port is free.',
        ],
        status: currentStatus,
      };
    }
    return {
      ok: true,
      exitCode: 0,
      lines: [
        `migrate-service: no legacy ${LEGACY_SERVICE_UNIT_NAME}.service unit was found and ${params.host}:${params.port} ` +
          'is free — there is nothing to migrate.',
        `Run install-service to set up the managed ${resolvedUnitName}.service directly.`,
      ],
      status: currentStatus,
    };
  }

  if (currentStatus.platform !== 'systemd') {
    return {
      ok: false,
      exitCode: 1,
      lines: [
        `migrate-service: this host's detected service platform is '${currentStatus.platform}', not systemd, but a ` +
          `legacy unit file exists at ${legacy.path}.`,
        'The legacy unit is systemd-specific and this tool only knows how to migrate a systemd legacy unit today — ' +
          'nothing was changed.',
      ],
      status: currentStatus,
    };
  }

  // F1: before any mutation, confirm the unit PlatformServiceManager is
  // actually about to install/uninstall isn't the legacy unit itself. This
  // happens when the host's `service.serviceName` config key is set to the
  // legacy unit's own name — see `resolveManagedUnitName`'s doc comment for
  // why the SDK resolves mutation paths from that config key rather than
  // from the definition this engine passes. Without this check, `install()`
  // below would overwrite the legacy unit file, a failed-health rollback
  // (`uninstall()`) would DELETE it while still claiming it was "never
  // touched," and a successful migration would immediately retire the unit
  // it just installed.
  if (resolvedUnitName === LEGACY_SERVICE_UNIT_NAME || currentStatus.path === legacy.path) {
    return {
      ok: false,
      exitCode: 1,
      lines: [
        `migrate-service aborted: this host's 'service.serviceName' config key resolves to '${resolvedUnitName}', which ` +
          `is the exact legacy unit name (${LEGACY_SERVICE_UNIT_NAME}.service at ${legacy.path}) this migration is ` +
          'supposed to retire.',
        'Installing or rolling back a unit under that name would overwrite or delete the legacy unit instead of ' +
          'managing a separate one, so nothing has been changed.',
        `Fix: set the 'service.serviceName' config key to something other than '${LEGACY_SERVICE_UNIT_NAME}' (for ` +
          `example, the default '${trackedServiceName}') and re-run migrate-service.`,
      ],
      status: currentStatus,
    };
  }

  if (!params.confirmMigration) {
    return {
      ok: true,
      exitCode: 0,
      lines: [
        legacyUnitNote(legacy, resolvedUnitName),
        'migrate-service (dry run — re-run with confirmation to execute): this would',
        `  1. install and start the new ${resolvedUnitName}.service unit`,
        '  2. verify it comes up healthy (a fresh, honest systemd is-active check)',
        `  3. only if that succeeds, stop, disable, and remove the legacy ${LEGACY_SERVICE_UNIT_NAME}.service unit ` +
          'and run `systemctl --user daemon-reload`',
        'Nothing has been changed. Nothing is migrated automatically — re-run with explicit confirmation ' +
          "(the CLI's -y/--yes flag) to execute this plan.",
      ],
      status: currentStatus,
    };
  }

  // Consented: new-up-then-old-down. The legacy unit is not touched until the
  // new unit is verified healthy.
  // Belt-and-braces (F1): the collision check above already returns before
  // reaching here whenever the resolved unit is the legacy one — this
  // re-asserts the same invariant right at the mutation site so a future
  // change to the check above can never silently reopen the hole.
  assertUnitIsNotLegacy(currentStatus, legacy, 'install the new unit');
  const installed = manager.install();
  if (installed.actionError) {
    return {
      ok: false,
      exitCode: 1,
      lines: [
        `migrate-service aborted: could not write the new ${resolvedUnitName}.service unit (${installed.actionError}).`,
        `The legacy ${LEGACY_SERVICE_UNIT_NAME}.service unit was never touched.`,
      ],
      status: installed,
    };
  }
  const started = manager.start();
  const healthCheck = manager.status();
  const healthy = !started.actionError && healthCheck.running;
  if (!healthy) {
    assertUnitIsNotLegacy(installed, legacy, 'roll back (uninstall) the new unit');
    const rollback = manager.uninstall();
    const rollbackNote = rollback.actionError
      ? `rolling back the new unit ALSO hit an error (${rollback.actionError}) — remove ${installed.path} by hand.`
      : 'the newly-written unit has been rolled back (removed).';
    return {
      ok: false,
      exitCode: 1,
      lines: [
        `migrate-service aborted: the new ${resolvedUnitName}.service unit did not come up healthy` +
          (started.actionError ? ` (${started.actionError}).` : '.'),
        rollbackNote,
        `The legacy ${LEGACY_SERVICE_UNIT_NAME}.service unit was never touched and should still be running as before.`,
      ],
      status: healthCheck,
    };
  }

  // New unit verified healthy — now, and only now, retire the legacy unit.
  const run: ManagedServiceActionRunner = params.actionRunner
    ?? ((command, args) => spawnSync(command, args, { stdio: 'pipe', encoding: 'utf-8' }) as ManagedServiceActionResult);
  const stopResult = run('systemctl', ['--user', 'stop', `${LEGACY_SERVICE_UNIT_NAME}.service`]);
  const disableResult = run('systemctl', ['--user', 'disable', `${LEGACY_SERVICE_UNIT_NAME}.service`]);
  const removeFile = params.legacyUnitFileRemove ?? ((path: string) => rmSync(path, { force: true }));
  let removeError: string | undefined;
  try {
    removeFile(legacy.path);
  } catch (error) {
    removeError = summarizeError(error);
  }
  run('systemctl', ['--user', 'daemon-reload']);

  const lines = [`migrated: the new ${resolvedUnitName}.service unit is installed, enabled, and running.`];
  if ((stopResult.status ?? 1) !== 0) {
    lines.push(
      `note: stopping the legacy unit reported a non-zero exit (${stopResult.stderr ?? stopResult.stdout ?? 'no output'}); ` +
        'it may already have been stopped.',
    );
  }
  if ((disableResult.status ?? 1) !== 0) {
    lines.push(
      `note: disabling the legacy unit reported a non-zero exit (${disableResult.stderr ?? disableResult.stdout ?? 'no output'}); ` +
        'it may already have been disabled.',
    );
  }
  if (removeError) {
    lines.push(`note: could not remove the legacy unit file at ${legacy.path}: ${removeError} — remove it by hand.`);
  } else {
    lines.push(`the legacy ${LEGACY_SERVICE_UNIT_NAME}.service unit has been stopped, disabled, and removed.`);
  }
  lines.push('ran `systemctl --user daemon-reload`.');
  return { ok: true, exitCode: 0, lines, status: healthCheck };
}
