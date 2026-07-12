/**
 * Launch-time self-update — clients land on the newest release at startup so
 * an installed binary never drifts behind. At TUI launch (before any runtime
 * bootstrap or terminal mode change) this runs a quick version check and, when
 * a newer release exists, installs it through the SAME checksum-verified
 * download/verify/swap path `/update apply` and scripts/install.sh use
 * (src/input/commands/update-runtime.ts — there is deliberately no second
 * updater), then asks the caller to restart onto the new binary.
 *
 * Honesty rules, in both directions:
 *   - the check gets a short timeout; when it cannot complete (offline, slow
 *     network) the CURRENT version starts with exactly one line saying the
 *     check was skipped — launch is never held hostage by the network.
 *   - a successful update restarts into the new binary and the restarted
 *     process prints a receipt naming both versions, so the swap is never
 *     silent.
 *   - every swap keeps the outgoing file at `<path>.previous`; rollback is
 *     one command (`/update rollback`).
 *
 * The feature is a real configurable setting (`update.autoUpdateAtLaunch` in
 * settings.json, read via readUpdateSettings): default ON, off with an
 * explicit false. Only binary installs self-update — package-manager and
 * from-source runs are skipped silently because a swap there would fight the
 * package manager (see detectInstallKind).
 *
 * Everything effectful is injectable; tests drive the decision logic with a
 * stubbed fetch, a stubbed apply, and pinned fixture versions — never the
 * live build VERSION and never the real network.
 */
import { spawnSync } from 'node:child_process';
import { detectInstallKind, normalizeVersion, type UpdateFetchLike } from '../runtime/update-check.ts';
import { applyUpdate, checkForUpdate, type ApplyUpdateOptions } from '../input/commands/update-runtime.ts';
import { readUpdateSettings, type UpdateSettings } from '../config/tui-extension-settings.ts';
import type { ConfigManager } from '../config/index.ts';
import { VERSION } from '../version.ts';

/**
 * Set on the restarted process by restartOntoUpdatedBinary, carrying the
 * version that performed the update. Its presence means "an update already
 * happened this launch": the restarted process prints the receipt and skips
 * its own check, which also makes an update-that-didn't-change-the-version
 * structurally unable to restart-loop.
 */
export const LAUNCH_UPDATED_FROM_ENV = 'GOODVIBES_LAUNCH_UPDATED_FROM';

/** Default budget for the launch-time version check; user-tunable via update.launchCheckTimeoutMs. */
export const LAUNCH_UPDATE_CHECK_TIMEOUT_MS = 2500;

export type LaunchAutoUpdateOutcome =
  | {
      readonly action: 'continue';
      readonly reason: 'just-updated' | 'disabled' | 'not-swappable-install' | 'already-current' | 'check-skipped' | 'update-failed';
    }
  | { readonly action: 'restart'; readonly latestTag: string };

export interface RunLaunchAutoUpdateOptions {
  readonly fetchImpl: UpdateFetchLike;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly currentVersion: string;
  readonly settings: UpdateSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly print: (line: string) => void;
  readonly configManager: { get(key: string): unknown };
  /** Injectable so tests observe the install step instead of swapping real files. */
  readonly apply?: (options: ApplyUpdateOptions) => Promise<void>;
  readonly timeoutMs?: number;
}

/** Resolves to 'timeout' when `promise` does not settle within `ms`; the timer never keeps the process alive. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The launch-time decision: receipt-and-continue (restarted process), skip
 * (disabled / unswappable / current / unreachable), install-and-restart, or
 * fail-and-continue on the current version. Never throws.
 */
export async function runLaunchAutoUpdate(options: RunLaunchAutoUpdateOptions): Promise<LaunchAutoUpdateOutcome> {
  const updatedFrom = options.env[LAUNCH_UPDATED_FROM_ENV];
  if (typeof updatedFrom === 'string' && updatedFrom.length > 0) {
    // Consumed here so sessions spawned from inside this one never inherit it.
    delete options.env[LAUNCH_UPDATED_FROM_ENV];
    options.print(`auto-update: updated from v${normalizeVersion(updatedFrom)} to v${normalizeVersion(options.currentVersion)} at launch`);
    return { action: 'continue', reason: 'just-updated' };
  }

  if (!(options.settings.autoUpdateAtLaunch ?? true)) {
    return { action: 'continue', reason: 'disabled' };
  }

  if (detectInstallKind(options.execPath) !== 'binary') {
    return { action: 'continue', reason: 'not-swappable-install' };
  }

  const timeoutMs = options.timeoutMs ?? options.settings.launchCheckTimeoutMs ?? LAUNCH_UPDATE_CHECK_TIMEOUT_MS;
  let check: Awaited<ReturnType<typeof checkForUpdate>> | 'timeout';
  try {
    check = await withTimeout(checkForUpdate(options.fetchImpl, options.currentVersion), timeoutMs);
  } catch {
    check = 'timeout';
  }
  if (check === 'timeout') {
    options.print('update check skipped: offline');
    return { action: 'continue', reason: 'check-skipped' };
  }
  if (check.isCurrent) {
    return { action: 'continue', reason: 'already-current' };
  }

  try {
    const apply = options.apply ?? applyUpdate;
    await apply({
      fetchImpl: options.fetchImpl,
      execPath: options.execPath,
      platform: options.platform,
      arch: options.arch,
      currentVersion: options.currentVersion,
      print: options.print,
      configManager: options.configManager,
    });
    options.print(`auto-update: ${check.latestTag} installed — restarting onto the new version`);
    return { action: 'restart', latestTag: check.latestTag };
  } catch (error) {
    options.print(
      `auto-update failed: ${error instanceof Error ? error.message : String(error)} — starting the current version v${normalizeVersion(options.currentVersion)}`,
    );
    return { action: 'continue', reason: 'update-failed' };
  }
}

export interface SelfUpdateAtLaunchParams {
  readonly configManager: Pick<ConfigManager, 'get' | 'getRaw'>;
  readonly stdout: { write(chunk: string): unknown };
}

/**
 * The complete launch wiring for main(), with real host inputs: run the
 * decision above; when an update was installed, restart onto the swapped
 * binary and EXIT THIS PROCESS with the new instance's exit code (this call
 * never returns in that case); otherwise return the honest lines that were
 * printed (receipt / skipped check / failed update) so the caller can
 * re-surface them through the system message router once it exists — the
 * stdout copies written here are wiped by the TUI's alternate screen.
 */
export async function selfUpdateAtLaunch(params: SelfUpdateAtLaunchParams): Promise<readonly string[]> {
  const lines: string[] = [];
  const outcome = await runLaunchAutoUpdate({
    fetchImpl: fetch as UpdateFetchLike,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    currentVersion: VERSION,
    settings: readUpdateSettings(params.configManager),
    env: process.env,
    configManager: params.configManager,
    print: (line) => {
      lines.push(line);
      params.stdout.write(`${line}\n`);
    },
  });
  if (outcome.action === 'restart') {
    process.exit(
      restartOntoUpdatedBinary({
        execPath: process.execPath,
        argv: process.argv.slice(2),
        env: process.env,
        fromVersion: VERSION,
      }),
    );
  }
  return lines;
}

export interface RestartOntoUpdatedBinaryOptions {
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** The version that performed the update — the restarted process prints it in its receipt line. */
  readonly fromVersion: string;
  /** Injectable so tests observe the restart instead of spawning a process. */
  readonly spawn?: (execPath: string, argv: readonly string[], env: NodeJS.ProcessEnv) => number | null;
}

/**
 * Runs the (just-swapped) binary at execPath with the original CLI arguments
 * and an inherited terminal, blocking until it exits, and returns its exit
 * code for the caller to process.exit with. The receipt marker travels in the
 * child's environment, never on the command line.
 */
export function restartOntoUpdatedBinary(options: RestartOntoUpdatedBinaryOptions): number {
  const spawn =
    options.spawn ??
    ((execPath: string, argv: readonly string[], env: NodeJS.ProcessEnv) =>
      spawnSync(execPath, [...argv], { stdio: 'inherit', env }).status);
  const status = spawn(options.execPath, options.argv, {
    ...options.env,
    [LAUNCH_UPDATED_FROM_ENV]: options.fromVersion,
  });
  return status ?? 0;
}
