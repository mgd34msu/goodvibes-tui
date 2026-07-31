/**
 * connected-daemon-autostart.ts — starting a daemon that is installed but not
 * running, once, at boot.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * This app used to solve "no daemon on the port" by BEING one: it embedded a
 * `DaemonServer` in the interactive process. That is gone — the daemon is its
 * own product and this app adopts one or does without.
 *
 * Which leaves a case that must not become the user's problem: the daemon is
 * installed on this machine, the service is simply stopped, and the app boots
 * to "no daemon" with a suggestion to go type something. So boot discovery gets
 * exactly one recovery step — ask the platform service manager whether the
 * daemon's service entry exists, start it if it does, wait a bounded time, and
 * re-probe. This is the agent's proven shape (its
 * runtime/bootstrap-external-services.ts + connected-host-autostart.ts), which
 * has been the reference client for this posture all along.
 *
 * ── The boundaries, which stay strict ──────────────────────────────────────
 *
 * - A REACHABLE daemon is never restarted. Adopting is the whole point.
 * - A HELD port — `blocked` (an unverified process) or `incompatible` (a
 *   GoodVibes daemon on a wire version this build refuses) — is left alone.
 *   Those are the closest states a probe has to "another owner is mid-update",
 *   and stepping on either turns a transient state into an outage.
 * - A service the manager already reports ACTIVE gets a bounded wait, never a
 *   second start underneath it.
 * - A daemon that is genuinely NOT installed gets honest guidance and nothing
 *   else. This app never spawns one.
 * - Every failure is reported and none of them break boot. Discovery failing is
 *   a reason to say so, not a reason to refuse to start.
 */
import { PlatformServiceManager } from '@pellux/goodvibes-sdk/platform/daemon';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

/** The daemon's managed service name (what the installer registers). */
export const MANAGED_DAEMON_SERVICE_NAME = 'goodvibes';
/** The unit name older installs registered. */
export const LEGACY_DAEMON_SERVICE_NAME = 'goodvibes-daemon';

/** One candidate service entry, as the platform service manager sees it. */
export interface DaemonServiceSnapshot {
  readonly serviceName: string;
  readonly installed: boolean;
  readonly running: boolean;
  /**
   * False on the 'manual' platform: there the SDK manager would spawn its own
   * locally-resolved command, which this app cannot honestly resolve for a
   * daemon it does not own — those stay on the guidance path.
   */
  readonly startSupported: boolean;
}

export interface DaemonServiceStartResult {
  readonly ok: boolean;
  readonly error?: string | undefined;
}

/** The narrow detector/starter seam, so tests never touch the host's services. */
export interface DaemonServiceControl {
  snapshot(): readonly DaemonServiceSnapshot[];
  start(serviceName: string): DaemonServiceStartResult;
}

export interface DaemonServiceControlOptions {
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** Injectable systemctl/launchctl/schtasks runner. */
  readonly actionRunner?: ((command: string, args: readonly string[]) => { status: number | null; stdout?: string | undefined; stderr?: string | undefined }) | undefined;
}

/**
 * Build the detector/starter over the SDK's `PlatformServiceManager`.
 *
 * When `service.serviceName` is configured to something other than the managed
 * default, that is an explicit operator choice and is trusted exclusively;
 * otherwise the managed name AND the older unit name are both checked, so an
 * install that predates the rename is still found.
 */
export function createDaemonServiceControl(options: DaemonServiceControlOptions): DaemonServiceControl {
  const primaryName = String(options.configManager.get('service.serviceName') ?? '').trim() || MANAGED_DAEMON_SERVICE_NAME;
  const candidateNames = primaryName === MANAGED_DAEMON_SERVICE_NAME
    ? [MANAGED_DAEMON_SERVICE_NAME, LEGACY_DAEMON_SERVICE_NAME]
    : [primaryName];
  // Pin each manager's view of `service.serviceName` to its candidate so the
  // SDK's own resolution yields exactly that unit; the schema default would
  // otherwise shadow every `defaultServiceName`.
  const pinnedConfigView = (serviceName: string): ConfigManager => ({
    get: (key: string) => key === 'service.serviceName' ? serviceName : options.configManager.get(key as Parameters<ConfigManager['get']>[0]),
  }) as unknown as ConfigManager;
  const managers = candidateNames.map((resolvedName) => ({
    resolvedName,
    manager: new PlatformServiceManager(pinnedConfigView(resolvedName), {
      workingDirectory: options.workingDirectory,
      homeDirectory: options.homeDirectory,
      // Match the daemon's own service scope (log/pid layout on the manual
      // platform); systemd/launchd/windows entries are home-scoped anyway.
      surfaceRoot: 'daemon',
      defaultServiceName: resolvedName,
      ...(options.actionRunner ? { actionRunner: options.actionRunner } : {}),
    }),
  }));

  return {
    snapshot: () => managers.map(({ resolvedName, manager }) => {
      try {
        const status = manager.status();
        return {
          serviceName: resolvedName,
          installed: status.installed === true,
          running: status.running === true,
          startSupported: status.platform !== 'manual',
        };
      } catch (error) {
        logger.debug('[startup] reading the daemon service entry failed', { serviceName: resolvedName, error: summarizeError(error) });
        return { serviceName: resolvedName, installed: false, running: false, startSupported: false };
      }
    }),
    start: (serviceName) => {
      const entry = managers.find((candidate) => candidate.resolvedName === serviceName);
      if (!entry) return { ok: false, error: `no service manager for '${serviceName}'` };
      try {
        // `start()` returns a fresh status rather than throwing; `actionError`
        // is where the manager records a refusal.
        const result = entry.manager.start();
        return result.actionError
          ? { ok: false, error: result.actionError }
          : { ok: true };
      } catch (error) {
        return { ok: false, error: summarizeError(error) };
      }
    },
  };
}

/** What the one boot-time recovery step did. */
export type DaemonAutostartOutcome =
  | { readonly action: 'none' }
  | { readonly action: 'not-installed' }
  | { readonly action: 'started'; readonly serviceName: string }
  | { readonly action: 'came-online'; readonly serviceName: string }
  | { readonly action: 'start-failed'; readonly serviceName: string; readonly reason: string };

export interface DaemonAutostartOptions {
  /** The probe's verdict for the configured daemon port. */
  readonly daemonMode: string;
  readonly control: DaemonServiceControl;
  /** Is a daemon answering yet? Polled until the timeout. */
  readonly isReachable: () => Promise<boolean>;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_WAIT_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 400;

/**
 * Start an installed-but-stopped daemon once, and wait a bounded time for it.
 *
 * Returns what happened rather than throwing: the caller renders it, and a
 * failure here never breaks boot.
 */
export async function autostartInstalledDaemon(options: DaemonAutostartOptions): Promise<DaemonAutostartOutcome> {
  // Only the "nothing is there" verdict is recoverable. 'embedded'/'external'
  // mean a daemon answers; 'blocked'/'incompatible' mean the port is held by
  // someone whose restart is not ours to force; 'disabled' means the user said no.
  if (options.daemonMode !== 'unavailable') return { action: 'none' };

  const candidates = options.control.snapshot().filter((entry) => entry.installed && entry.startSupported);
  if (candidates.length === 0) return { action: 'not-installed' };
  // Prefer a unit already running (wait only) over one that needs starting.
  const alreadyRunning = candidates.find((entry) => entry.running);
  const target = alreadyRunning ?? candidates[0];
  if (!target) return { action: 'not-installed' };

  if (!alreadyRunning) {
    const started = options.control.start(target.serviceName);
    if (!started.ok) {
      return { action: 'start-failed', serviceName: target.serviceName, reason: started.error ?? 'the service manager refused the start' };
    }
  }

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  const deadline = Date.now() + (options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (Date.now() < deadline) {
    await sleep(interval);
    let reachable = false;
    try {
      reachable = await options.isReachable();
    } catch (error) {
      logger.debug('[startup] re-probing the daemon failed', { error: summarizeError(error) });
    }
    if (reachable) {
      return alreadyRunning
        ? { action: 'came-online', serviceName: target.serviceName }
        : { action: 'started', serviceName: target.serviceName };
    }
  }
  return {
    action: 'start-failed',
    serviceName: target.serviceName,
    reason: `the service was ${alreadyRunning ? 'already starting' : 'started'} but did not answer within ${Math.round((options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) / 1000)}s`,
  };
}

/**
 * Render one autostart outcome as the line the user reads.
 *
 * Kept beside the outcome type so the wording and the states it covers cannot
 * drift apart, and so the boot path in bootstrap.ts stays a call rather than a
 * switch.
 */
export function describeDaemonAutostart(
  outcome: DaemonAutostartOutcome,
  adoptedAfterwards: boolean,
  adoptionFailureReason?: string | undefined,
): { readonly level: 'low' | 'high'; readonly text: string } | null {
  const suffix = adoptedAfterwards ? '' : ` — but adopting it still failed: ${adoptionFailureReason ?? 'unknown reason'}`;
  switch (outcome.action) {
    case 'started':
      return { level: 'low', text: `[Startup] The daemon was installed but stopped; started it (service "${outcome.serviceName}")${suffix}.` };
    case 'came-online':
      return { level: 'low', text: `[Startup] The daemon service "${outcome.serviceName}" was already starting; connected once it answered${suffix}.` };
    case 'start-failed':
      return { level: 'high', text: `[Startup] The daemon is installed but not answering, and starting it did not succeed: ${outcome.reason}. Start it manually with: goodvibes service start` };
    case 'not-installed':
    case 'none':
      return null;
  }
}
