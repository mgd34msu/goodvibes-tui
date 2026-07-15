/**
 * The unattended startup reconcile for the redundant install-script
 * `goodvibes-daemon.service` unit — split out of `legacy-daemon-migration.ts`
 * (which owns the shared unit definition, detection, and the CONSENTED
 * `migrate-service` engine) so each module stays within the architecture
 * gate's file-size cap. Same layer (`src/runtime/`), same injectable-seam
 * discipline; see the sibling module's banner for the naming and layering
 * rationale.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import {
  defaultActionRunner,
  defaultPortProbe,
  legacyUnitPath,
  parseMainPid,
  LEGACY_SERVICE_UNIT_NAME,
  SYSTEMCTL_TIMEOUT_MS,
  type ManagedServiceActionRunner,
} from './legacy-daemon-migration.ts';

type ManagedServiceActionResult = ReturnType<ManagedServiceActionRunner>;

/**
 * The exact marker string scripts/install.sh writes into every unit it
 * creates (as a `# managed by goodvibes install.sh` comment). The reconcile
 * check below keys on it to tell an installer-created legacy unit — safe to
 * auto-retire — apart from a hand-written one that must only ever be reported.
 * Kept in lockstep with `INSTALLER_MARKER` in scripts/install.sh.
 */
export const INSTALLER_UNIT_MARKER = 'managed by goodvibes install.sh';



/**
 * CUMULATIVE ceiling on the reconcile's whole boot-path pass. Per-call
 * timeouts alone still allow ~5 sequential slow-but-completing calls to stack
 * up (a degraded — not wedged — user bus), blocking the already-listening
 * daemon's event loop for tens of seconds. One overall deadline covers the
 * pass: once it is exceeded, every remaining call is skipped (reported as
 * `status: null`, which the guards treat as unknown → refusal) and the result
 * carries a notice saying so.
 */
export const RECONCILE_DEADLINE_MS = 8_000;



/**
 * Wrap a runner with the reconcile's cumulative deadline: calls after the
 * deadline are skipped outright; calls near it get only the remaining budget
 * as their per-call timeout (default runner only — injected runners are test
 * fakes that answer instantly).
 */
function makeDeadlineBoundRunner(
  injected: ManagedServiceActionRunner | undefined,
  perCallTimeoutMs: number,
  deadlineMs: number,
): { run: ManagedServiceActionRunner; deadlineHit: () => boolean } {
  const startedAt = Date.now();
  let hit = false;
  const run: ManagedServiceActionRunner = (command, args) => {
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      hit = true;
      return { status: null, stdout: '', stderr: 'reconcile time budget exceeded — call skipped' } as ManagedServiceActionResult;
    }
    if (injected) return injected(command, args);
    return defaultActionRunner(Math.min(perCallTimeoutMs, remaining))(command, args);
  };
  return { run, deadlineHit: () => hit };
}



export interface ReconcileRedundantLegacyUnitInput {
  readonly homeDir: string;
  /** The unit name this tool manages (e.g. 'goodvibes'). */
  readonly trackedServiceName: string;
  /**
   * The endpoint CLIENTS resolve from settings.json (no runtime flag
   * overrides). When provided, the reconcile requires this endpoint to be
   * answering before it retires anything: a canonical daemon that is alive on
   * some other port must never retire the unit clients actually reach.
   */
  readonly configuredEndpoint?: { readonly host: string; readonly port: number } | undefined;
  /** Injectable probe of the configured endpoint. Defaults to `defaultPortProbe`. */
  readonly endpointProbe?: ((host: string, port: number) => boolean | Promise<boolean>) | undefined;
  /** Injectable existsSync so tests never touch the host filesystem. */
  readonly legacyUnitFileExists?: ((path: string) => boolean) | undefined;
  /** Injectable unit-file read for the installer-marker check. */
  readonly legacyUnitFileRead?: ((path: string) => string) | undefined;
  /** Injectable removal of the legacy unit file. Defaults to a real `rmSync`. */
  readonly legacyUnitFileRemove?: ((path: string) => void) | undefined;
  /** Injectable systemctl runner (is-active/MainPID probes + disable/daemon-reload). */
  readonly actionRunner?: ManagedServiceActionRunner | undefined;
  /** Injectable liveness check for unit MainPIDs. Defaults to a signal-0 probe. */
  readonly processAlive?: ((pid: number) => boolean) | undefined;
  /** This process's pid, for the self-supervision guard. Defaults to `process.pid`. */
  readonly ownPid?: number | undefined;
  /** Injectable /proc/self/cgroup read, for the self-supervision guard. */
  readonly readOwnCgroup?: (() => string) | undefined;
  /** Timeout applied to the DEFAULT systemctl runner only. Defaults to SYSTEMCTL_TIMEOUT_MS. */
  readonly systemctlTimeoutMs?: number | undefined;
  /** Cumulative budget for the whole pass. Defaults to RECONCILE_DEADLINE_MS. */
  readonly deadlineMs?: number | undefined;
}

export type ReconcileRedundantLegacyUnitReason =
  | 'no-legacy-unit'
  | 'canonical-not-active'
  | 'canonical-mainpid-not-alive'
  | 'self-supervised-by-legacy'
  | 'legacy-running'
  | 'configured-endpoint-unserved'
  | 'hand-written'
  | 'marker-unreadable'
  | 'disable-failed'
  | 'disable-timeout'
  | 'retired';

export interface ReconcileRedundantLegacyUnitResult {
  /**
   * 'removed' = legacy unit auto-retired; 'notice' = left alone with a printed
   * hint (hand-written, or unreadable); 'failed' = retirement was attempted but
   * a destructive step failed or its outcome could not be confirmed (this tool
   * removed nothing); 'noop' = guard refused or nothing to do.
   */
  readonly action: 'removed' | 'notice' | 'noop' | 'failed';
  /** Machine-readable why, so callers can leave a breadcrumb for every refusal. */
  readonly reason: ReconcileRedundantLegacyUnitReason;
  readonly lines: readonly string[];
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultReadOwnCgroup(): string {
  try {
    return readFileSync('/proc/self/cgroup', 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Cheap, unattended startup reconcile for the exact host state the production
 * incident surfaced: an installer-managed legacy `goodvibes-daemon.service`
 * unit sitting ENABLED alongside the canonical `goodvibes.service` that is
 * ENABLED + ACTIVE. Nothing ever disabled the redundant legacy unit, so a
 * bare-args second daemon could boot and fight the real one for the port.
 *
 * This runs on daemon startup (no user invocation needed) and, guard-railed:
 *   - Only acts when the canonical unit is CONFIRMED serving: `is-active`
 *     reports active AND its MainPID resolves to a live process. `is-active`
 *     alone is not proof — a Type=simple unit reports active from fork onward,
 *     including the pre-bind window of a daemon that is about to crash-loop.
 *   - NEVER acts from inside the legacy unit itself: if this process IS the
 *     legacy unit's MainPID, or /proc/self/cgroup names the legacy unit,
 *     running `disable --now` would SIGTERM the very daemon executing this
 *     code (mid-boot, from inside a blocking spawnSync). Refuses instead.
 *   - NEVER stops a RUNNING legacy daemon: if the legacy unit's MainPID is a
 *     live process, it may be the daemon serving the endpoint clients are
 *     configured to reach (the wrong-port two-daemon state) — the unattended
 *     path only retires enabled-but-NOT-running legacy units; a running one
 *     gets a notice pointing at the consented migrate-service.
 *   - Requires the CONFIGURED endpoint (the one clients resolve from
 *     settings.json, no runtime overrides) to be answering before retiring —
 *     a canonical daemon alive on some other port proves nothing about the
 *     endpoint clients use.
 *   - AUTO-RETIRES only an installer-MARKER-managed legacy unit, and only
 *     removes its unit file AFTER `disable --now` reports success. A NONZERO
 *     exit leaves everything in place and says so; a TIMED-OUT disable
 *     (status null) has an UNKNOWN outcome — the enablement state is
 *     re-inspected before anything is printed, and the receipt states what
 *     was actually confirmed, never a blanket claim.
 *   - A hand-written legacy unit (no marker) is never touched — a one-line
 *     actionable notice. An UNREADABLE unit file is reported as unreadable,
 *     never misdiagnosed as hand-written.
 *   - The whole pass shares ONE cumulative time budget (RECONCILE_DEADLINE_MS)
 *     on top of the per-call timeout, so even a degraded-but-completing user
 *     bus cannot stack five slow calls into a half-minute boot stall.
 * Every side effect goes through the same injectable seams the migration engine
 * uses, so tests exercise it deterministically and never touch a real service.
 */
export async function reconcileRedundantLegacyUnit(
  input: ReconcileRedundantLegacyUnitInput,
): Promise<ReconcileRedundantLegacyUnitResult> {
  const path = legacyUnitPath(input.homeDir);
  const fileExists = input.legacyUnitFileExists ?? existsSync;
  if (!fileExists(path)) return { action: 'noop', reason: 'no-legacy-unit', lines: [] };

  const { run, deadlineHit } = makeDeadlineBoundRunner(
    input.actionRunner,
    input.systemctlTimeoutMs ?? SYSTEMCTL_TIMEOUT_MS,
    input.deadlineMs ?? RECONCILE_DEADLINE_MS,
  );
  const canonicalUnit = `${input.trackedServiceName}.service`;
  const legacyUnit = `${LEGACY_SERVICE_UNIT_NAME}.service`;
  const deadlineNote = (): string[] =>
    deadlineHit()
      ? ['note: the reconcile hit its overall time budget — remaining checks were skipped; it will re-run at the next daemon start.']
      : [];

  // Guard 1: the canonical unit must report active. (A timed-out, skipped, or
  // failed probe — e.g. a wedged user bus — lands here too and refuses.)
  const probe = run('systemctl', ['--user', 'is-active', canonicalUnit]);
  const canonicalActive = (probe.status ?? 1) === 0 && (probe.stdout ?? '').trim() === 'active';
  if (!canonicalActive) {
    return {
      action: 'noop',
      reason: 'canonical-not-active',
      lines: [
        `legacy-unit reconcile: a ${legacyUnit} unit file exists at ${path} but ${canonicalUnit} is not confirmably active — ` +
          'left untouched (it may be the only daemon).',
        ...deadlineNote(),
      ],
    };
  }

  // Guard 2: 'active' alone does not prove the canonical unit is the daemon
  // actually serving (Type=simple reports active from fork onward). Require
  // its MainPID to resolve and be a live process.
  const canonicalPid = parseMainPid(run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', canonicalUnit]));
  const alive = input.processAlive ?? defaultProcessAlive;
  if (canonicalPid === undefined || !alive(canonicalPid)) {
    return {
      action: 'noop',
      reason: 'canonical-mainpid-not-alive',
      lines: [
        `legacy-unit reconcile: ${canonicalUnit} reports active but its MainPID could not be confirmed alive — ` +
          `left the ${legacyUnit} unit untouched.`,
        ...deadlineNote(),
      ],
    };
  }

  // Guard 3: never disable the unit that launched THIS process. `disable
  // --now` on our own supervising unit would SIGTERM this daemon's whole
  // cgroup mid-boot, from inside the blocking systemctl call.
  const ownPid = input.ownPid ?? process.pid;
  const legacyPid = parseMainPid(run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', legacyUnit]));
  const ownCgroup = (input.readOwnCgroup ?? defaultReadOwnCgroup)();
  if (legacyPid === ownPid || ownCgroup.includes(legacyUnit)) {
    return {
      action: 'noop',
      reason: 'self-supervised-by-legacy',
      lines: [
        `legacy-unit reconcile: this daemon appears to be running UNDER ${legacyUnit} itself — refusing to disable ` +
          `the unit supervising the current process. Migrate from the canonical side instead: goodvibes-daemon migrate-service`,
      ],
    };
  }

  // Guard 4: never stop a RUNNING legacy daemon from the unattended path. A
  // live legacy MainPID means a second daemon is actually serving something —
  // possibly the endpoint clients resolve from settings.json (the wrong-port
  // two-daemon state). Retiring an enabled-but-idle unit needs no --now kill;
  // stopping a serving one needs consent.
  if (legacyPid !== undefined && alive(legacyPid)) {
    return {
      action: 'noop',
      reason: 'legacy-running',
      lines: [
        `legacy-unit reconcile: ${legacyUnit} has a live main process (pid ${legacyPid}) — a second daemon is ` +
          'actually running, and it may be the one serving the endpoint your clients are configured to reach. ' +
          'Refusing to stop it unattended; migrate deliberately with: goodvibes-daemon migrate-service',
      ],
    };
  }

  // Guard 5: the endpoint clients resolve from settings.json must be answered
  // before anything is retired. The canonical daemon being alive proves only
  // that A daemon runs — not that the configured endpoint is served (its unit
  // may pin different launch args).
  if (input.configuredEndpoint) {
    const endpointProbe = input.endpointProbe ?? defaultPortProbe;
    const served = await endpointProbe(input.configuredEndpoint.host, input.configuredEndpoint.port);
    if (!served) {
      return {
        action: 'noop',
        reason: 'configured-endpoint-unserved',
        lines: [
          `legacy-unit reconcile: nothing is answering on the CONFIGURED endpoint ` +
            `${input.configuredEndpoint.host}:${input.configuredEndpoint.port} — the canonical daemon is alive but not ` +
            `provably serving what clients resolve from settings. Left the ${legacyUnit} unit untouched; check the ` +
            "canonical unit's launch arguments against the controlPlane settings.",
        ],
      };
    }
  }

  const readFile = input.legacyUnitFileRead ?? ((p: string) => readFileSync(p, 'utf-8'));
  let marked = false;
  let readError: string | undefined;
  try {
    marked = readFile(path).includes(INSTALLER_UNIT_MARKER);
  } catch (error) {
    readError = summarizeError(error);
  }

  if (readError !== undefined) {
    // Fail closed, and say what actually happened: the file could not be READ.
    // Asserting "hand-written (no installer marker)" here would be a false
    // provenance claim about a file whose contents were never established.
    return {
      action: 'notice',
      reason: 'marker-unreadable',
      lines: [
        `note: ${canonicalUnit} is active and a separate ${legacyUnit} exists at ${path}, but its unit file could not ` +
          `be read (${readError}) — left untouched. Inspect it yourself; if it is redundant, retire it with: ` +
          `systemctl --user disable --now ${legacyUnit} && rm ${path} && systemctl --user daemon-reload`,
      ],
    };
  }

  if (!marked) {
    return {
      action: 'notice',
      reason: 'hand-written',
      lines: [
        `note: ${canonicalUnit} is active but a separate ${legacyUnit} also exists at ${path}. ` +
          'It is hand-written (no installer marker) so it was left untouched; retire it yourself to stop two daemons ' +
          `competing for the same port: systemctl --user disable --now ${legacyUnit} && rm ${path} && ` +
          'systemctl --user daemon-reload',
      ],
    };
  }

  // Installer-marker-managed and redundant: disable first, and only remove the
  // unit file if the disable actually succeeded — otherwise the enablement
  // symlink dangles at a deleted file and this tool can never repair it (the
  // next pass no-ops at the file-exists check).
  const disableResult = run('systemctl', ['--user', 'disable', '--now', legacyUnit]);
  const disableStatus = disableResult.status ?? 1;
  if (disableStatus !== 0) {
    if (disableResult.status === null) {
      // TIMED OUT: the outcome is UNKNOWN, not failed — `disable --now`
      // removes the enablement symlinks synchronously BEFORE waiting on the
      // stop job, so the disable may well have taken effect even though the
      // client was killed. Re-inspect instead of printing a blanket denial.
      const reinspect = run('systemctl', ['--user', 'is-enabled', legacyUnit]);
      const reinspectOut = (reinspect.stdout ?? '').trim();
      const confirmedDisabled = (reinspect.status !== null)
        && (reinspectOut === 'disabled' || reinspectOut === 'not-found');
      if (confirmedDisabled) {
        // The disable took effect; only the client timed out waiting on the
        // stop job. Proceed as success, saying exactly that.
        const removeFileAfterTimeout = input.legacyUnitFileRemove ?? ((p: string) => rmSync(p, { force: true }));
        let removeErrorAfterTimeout: string | undefined;
        try {
          removeFileAfterTimeout(path);
        } catch (error) {
          removeErrorAfterTimeout = summarizeError(error);
        }
        run('systemctl', ['--user', 'daemon-reload']);
        const lines = [
          `reconciled: the disable command timed out waiting on the stop job, but re-inspection confirms the ` +
            `installer-managed ${legacyUnit} is no longer enabled${removeErrorAfterTimeout ? '' : ` — its unit file was removed (${path})`}. ` +
            'Its stop may still be completing.',
        ];
        if (removeErrorAfterTimeout) {
          lines.push(`note: could not remove ${path}: ${removeErrorAfterTimeout} — remove it by hand.`);
        }
        lines.push(...deadlineNote());
        return { action: 'removed', reason: 'retired', lines };
      }
      return {
        action: 'failed',
        reason: 'disable-timeout',
        lines: [
          `legacy-unit reconcile: the disable of ${legacyUnit} timed out and its outcome is UNKNOWN — the enablement ` +
            `state could not be re-confirmed. This tool removed nothing; the unit file at ${path} was left in place ` +
            'and will be re-checked at the next daemon start.',
          `Verify it yourself: systemctl --user is-enabled ${legacyUnit}`,
          ...deadlineNote(),
        ],
      };
    }
    const detail = (disableResult.stderr ?? disableResult.stdout ?? '').trim() || 'no output';
    return {
      action: 'failed',
      reason: 'disable-failed',
      lines: [
        `legacy-unit reconcile: the disable of the redundant installer-managed ${legacyUnit} reported failure ` +
          `(${detail}) — this tool removed nothing; the unit file at ${path} was left in place.`,
        `Verify its state and retire it yourself: systemctl --user is-enabled ${legacyUnit} ; ` +
          `systemctl --user disable --now ${legacyUnit} && rm ${path} && systemctl --user daemon-reload`,
      ],
    };
  }

  const removeFile = input.legacyUnitFileRemove ?? ((p: string) => rmSync(p, { force: true }));
  let removeError: string | undefined;
  try {
    removeFile(path);
  } catch (error) {
    removeError = summarizeError(error);
  }
  run('systemctl', ['--user', 'daemon-reload']);

  const lines = [
    `reconciled: ${canonicalUnit} is active and serving, so the redundant installer-managed ${legacyUnit} ` +
      `was disabled${removeError ? '' : ` and removed (${path})`}.`,
  ];
  if (removeError) {
    lines.push(`note: could not remove ${path}: ${removeError} — remove it by hand.`);
  }
  lines.push(...deadlineNote());
  return { action: 'removed', reason: 'retired', lines };
}
