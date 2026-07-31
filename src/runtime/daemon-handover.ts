/**
 * daemon-handover.ts — the one-time old→new daemon handover.
 *
 * THE PROBLEM THIS SOLVES, precisely.
 *
 * Every daemon binary shipped up to and including 1.27.1 was compiled against
 * SDK 1.20.0, whose `update.releasesUrl` schema DEFAULT is
 * `https://github.com/mgd34msu/goodvibes-tui/releases/latest`. A schema default
 * is not a persisted value: it lives in the compiled binary, no settings file
 * carries it, and no settings migration rewrites it. Those daemons therefore
 * resolve release tags from the TERMINAL app's repository forever, and that
 * repository no longer builds daemon binaries. On the next terminal release the
 * installed daemon sees a newer tag, asks for `goodvibes-daemon-<os>-<arch>`,
 * gets a 404, and fails — hourly, on a loop, with nothing on the far side.
 *
 * WHY POINTING THE OLD DAEMON AT THE NEW REPOSITORY DOES NOT FIX IT.
 *
 * The obvious repair — write a persisted `update.releasesUrl` override naming
 * the daemon's own repository — is genuinely reachable (the key is client-scope
 * in config-ownership.ts, so the shipped daemon reads it out of
 * `~/.goodvibes/tui/settings.json`, a file this terminal writes). It still does
 * not work, for a reason that only shows up in the shipped updater's target
 * selection: `resolveDaemonInstalledFiles` adds the TERMINAL app binary to the
 * daemon's update target set whenever `goodvibes` sits beside `goodvibes-daemon`
 * in the install directory — and scripts/install.sh puts all three binaries in
 * exactly one directory. `applyVerifiedUpdate` downloads and verifies EVERY
 * target before it writes anything, and the daemon's repository deliberately
 * does not publish a `goodvibes-<os>-<arch>` asset. So the old daemon pointed at
 * the new repository asks for a terminal binary that is not there, takes the
 * 404, and applies nothing. Both repositories are a dead end for it.
 *
 * There is also no remote write path to reach it with: the control plane's
 * `config.set` verb exists as a catalog DESCRIPTOR and nothing registers a
 * handler for it, in the shipped SDK or in the daemon that embeds it.
 *
 * WHAT THIS MODULE DOES INSTEAD.
 *
 * The terminal performs the handover itself, once, at launch. It reads the
 * version of the `goodvibes-daemon` binary installed beside it; if that binary
 * predates the split it downloads the current daemon from the daemon's own
 * repository, checksum-verifies it against that release's SHA256SUMS.txt, swaps
 * it atomically with the outgoing build kept at `<path>.previous`, and restarts
 * the service so the running process is the new one. After that the installed
 * daemon is 1.28.0 or newer, its own baked default already names its own
 * repository, and this path goes quiet permanently.
 *
 * IT REPLACES EXACTLY ONE FILE: the daemon binary. Not the terminal binary
 * beside it — that is this product's own, on its own release line, updated by
 * `/update`. Not the shared sqlite-vec addon in `lib/`, which serves all three
 * binaries and travels with the terminal's own updates. Replacing only the file
 * whose product this handover is about is what keeps it from being the same
 * cross-product overreach that broke the shipped updater.
 *
 * HONESTY RULES.
 *   - A daemon binary whose version cannot be READ is never swapped. "I could
 *     not identify it" and "it is old" are different answers and only the
 *     second one justifies replacing a working file.
 *   - A package-manager-managed daemon is never swapped in place; that fights
 *     the next `bun add -g`, exactly as the terminal's own updater refuses to.
 *   - The resolved release must itself be at or above the split floor. A
 *     handover that installed something older than what it replaced would be a
 *     downgrade wearing a migration's name.
 *   - Every swap prints a receipt naming both versions and how the running
 *     daemon was restarted, so the replacement is never silent.
 *
 * Fetch, filesystem, subprocess and clock are all injectable, so the whole
 * decision and the whole swap are provable under test without a network, a real
 * binary, or a real service manager.
 */
import { spawnSync } from 'node:child_process';
import {
  applyVerifiedUpdate,
  realUpdateFileIo,
  type UpdateFileIo,
} from '@pellux/goodvibes-sdk/platform/runtime/self-update';
import { resolveArtifactNames } from './release-artifacts.ts';
import {
  compareVersions,
  detectInstallKind,
  normalizeVersion,
  resolveLatestReleaseTag,
  type UpdateFetchLike,
} from './update-check.ts';
import { resolveConfiguredServiceName } from './legacy-daemon-migration.ts';

/** The daemon's own repository — the only place daemon binaries are published. */
export const DAEMON_REPO_RELEASES_LATEST_URL = 'https://github.com/mgd34msu/goodvibes-daemon/releases/latest';

/** `https://github.com/o/r/releases/download/<tag>` for the daemon repository. */
export function daemonReleaseDownloadBaseUrl(tag: string): string {
  return `https://github.com/mgd34msu/goodvibes-daemon/releases/download/${tag}`;
}

/**
 * The first daemon version released from the daemon's own repository. A binary
 * below this was built from the terminal repository against SDK 1.20.0 and
 * carries the wrong baked releases URL; a binary at or above it resolves its
 * own repository without help and must be left alone.
 */
export const DAEMON_SPLIT_FLOOR_VERSION = '1.28.0';

/** How long the `--version` probe is allowed to take before it counts as unreadable. */
export const DAEMON_VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Injectable so tests never spawn a real binary. */
export type RunCommandLike = (
  command: string,
  args: readonly string[],
) => { readonly status: number | null; readonly stdout: string };

const defaultRunCommand: RunCommandLike = (command, args) => {
  try {
    const result = spawnSync(command, [...args], {
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: DAEMON_VERSION_PROBE_TIMEOUT_MS,
    });
    return { status: result.status, stdout: result.stdout ?? '' };
  } catch {
    return { status: null, stdout: '' };
  }
};

/**
 * Pulls the version out of `goodvibes-daemon --version` output, which the
 * shipped daemon prints as `goodvibes-daemon 1.27.1`. Deliberately strict: only
 * a dotted numeric version is accepted, so a binary that printed a usage error,
 * a stack trace, or nothing at all reads as unidentifiable rather than being
 * coerced into a number that would justify replacing it.
 */
export function parseDaemonVersionOutput(output: string): string | null {
  const match = output.trim().match(/(?:^|\s)v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\s*$/);
  return match?.[1] ?? null;
}

/** Runs `<binaryPath> --version` and returns the parsed version, or null. */
export function readInstalledDaemonVersion(
  binaryPath: string,
  runCommand: RunCommandLike = defaultRunCommand,
): string | null {
  const result = runCommand(binaryPath, ['--version']);
  if (result.status !== 0) return null;
  return parseDaemonVersionOutput(result.stdout);
}

/** True when `version` predates the daemon's own repository. */
export function isPreSplitDaemonVersion(version: string): boolean {
  return compareVersions(version, DAEMON_SPLIT_FLOOR_VERSION) < 0;
}

export type DaemonHandoverSkipReason =
  /** The operator turned launch-time binary swapping off. */
  | 'disabled'
  /** No `goodvibes-daemon` binary was found beside this install. */
  | 'no-daemon-binary'
  /** The daemon is package-manager managed; swapping it in place would fight the package manager. */
  | 'not-swappable-install'
  /** The binary did not answer `--version` with something identifiable. */
  | 'version-unreadable'
  /** The installed daemon already comes from its own repository. */
  | 'already-split'
  /** No daemon assets are published for this platform/arch. */
  | 'unsupported-platform';

export type DaemonHandoverDecision =
  | { readonly action: 'skip'; readonly reason: DaemonHandoverSkipReason }
  | {
      readonly action: 'handover';
      readonly binaryPath: string;
      readonly fromVersion: string;
      readonly assetName: string;
    };

export interface DaemonHandoverDecisionInput {
  /** The resolved `goodvibes-daemon` path, or null when none was found. */
  readonly binaryPath: string | null;
  /** The version that binary reported, or null when it could not be read. */
  readonly installedVersion: string | null;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

/**
 * The whole decision, as a pure function of what was observed. Every skip
 * carries the reason it skipped so the caller can say which one happened
 * instead of reporting a single undifferentiated "nothing to do".
 */
export function decideDaemonHandover(input: DaemonHandoverDecisionInput): DaemonHandoverDecision {
  const binaryPath = input.binaryPath?.trim();
  if (!binaryPath) return { action: 'skip', reason: 'no-daemon-binary' };
  if (detectInstallKind(binaryPath) !== 'binary') {
    return { action: 'skip', reason: 'not-swappable-install' };
  }
  if (!input.installedVersion) return { action: 'skip', reason: 'version-unreadable' };
  if (!isPreSplitDaemonVersion(input.installedVersion)) {
    return { action: 'skip', reason: 'already-split' };
  }
  const artifacts = resolveArtifactNames(input.platform, input.arch);
  if (!artifacts) return { action: 'skip', reason: 'unsupported-platform' };
  return {
    action: 'handover',
    binaryPath,
    fromVersion: input.installedVersion,
    assetName: artifacts.daemon,
  };
}

/**
 * Tracks whether the swap has begun, so a budget that runs out can say what is
 * actually true: cancelled before anything was touched, or the file WAS
 * replaced and only the restart is outstanding. Reads leave the flag alone.
 */
export interface DaemonHandoverProgress {
  begun: boolean;
  tag: string | null;
}

export function createDaemonHandoverProgress(): DaemonHandoverProgress {
  return { begun: false, tag: null };
}

function trackHandoverProgress(io: UpdateFileIo, progress: DaemonHandoverProgress): UpdateFileIo {
  const begin = (): void => {
    progress.begun = true;
  };
  return {
    writeFile: (path, data) => {
      begin();
      io.writeFile(path, data);
    },
    rename: (from, to) => {
      begin();
      io.rename(from, to);
    },
    chmod: (path, mode) => {
      begin();
      io.chmod(path, mode);
    },
    mkdir: (path) => {
      begin();
      io.mkdir(path);
    },
    exists: (path) => io.exists(path),
  };
}

/** The failure an aborted handover ends with — raised only while nothing has been written. */
export const HANDOVER_ABORTED_MESSAGE = 'daemon handover cancelled before any file was replaced';

type AbortableFetchInit = NonNullable<Parameters<UpdateFetchLike>[1]> & { signal?: AbortSignal };

function abortableFetch(fetchImpl: UpdateFetchLike, signal: AbortSignal | undefined): UpdateFetchLike {
  if (!signal) return fetchImpl;
  const withSignal = fetchImpl as (url: string, init?: AbortableFetchInit) => ReturnType<UpdateFetchLike>;
  return async (url, init) => {
    if (signal.aborted) throw new Error(HANDOVER_ABORTED_MESSAGE);
    return await withSignal(url, { ...init, signal });
  };
}

export interface PerformDaemonHandoverOptions {
  readonly fetchImpl: UpdateFetchLike;
  /** The daemon binary to replace. */
  readonly binaryPath: string;
  /** The release asset that replaces it. */
  readonly assetName: string;
  readonly signal?: AbortSignal;
  readonly progress?: DaemonHandoverProgress;
  /** Injectable so tests never touch a real file. */
  readonly io?: UpdateFileIo;
  readonly releasesLatestUrl?: string;
  readonly downloadBaseUrl?: (tag: string) => string;
}

/**
 * Resolves the daemon repository's current release, verifies the daemon asset
 * against that release's SHA256SUMS.txt, and swaps it into place with the
 * outgoing binary kept at `<path>.previous`.
 *
 * The floor is re-checked against the RESOLVED tag, not only against the
 * installed version: a handover exists to move a daemon onto its own release
 * line, and a release below the split floor is not on that line. Without this
 * check an unexpected tag would be installed simply because it was newer than
 * what was there.
 */
export async function performDaemonHandover(
  options: PerformDaemonHandoverOptions,
): Promise<{ readonly tag: string }> {
  const progress = options.progress ?? createDaemonHandoverProgress();
  const fetchImpl = abortableFetch(options.fetchImpl, options.signal);
  const releasesLatestUrl = options.releasesLatestUrl ?? DAEMON_REPO_RELEASES_LATEST_URL;
  const tag = await resolveLatestReleaseTag(fetchImpl, releasesLatestUrl);
  if (compareVersions(tag, DAEMON_SPLIT_FLOOR_VERSION) < 0) {
    throw new Error(
      `the daemon repository's current release is ${tag}, below the ${DAEMON_SPLIT_FLOOR_VERSION} split floor — refusing to hand over to it`,
    );
  }
  progress.tag = tag;
  if (options.signal?.aborted) throw new Error(HANDOVER_ABORTED_MESSAGE);
  const baseIo = options.io ?? realUpdateFileIo;
  await applyVerifiedUpdate({
    fetchImpl,
    downloadBaseUrl: (options.downloadBaseUrl ?? daemonReleaseDownloadBaseUrl)(tag),
    targets: [
      {
        label: 'daemon binary',
        path: options.binaryPath,
        assetName: options.assetName,
        executable: true,
      },
    ],
    io: trackHandoverProgress(baseIo, progress),
  });
  return { tag };
}

export interface DaemonRestartOutcome {
  /** True when a restart was actually issued and the service manager accepted it. */
  readonly restarted: boolean;
  readonly unitName: string;
  /** What happened, in the words the receipt uses. */
  readonly detail: string;
}

/**
 * Restarts the handed-over daemon so the RUNNING process is the new binary.
 * A swap replaces the file; the process that opened the old inode keeps running
 * it until it is restarted, so without this the handover would be true on disk
 * and false in memory.
 *
 * Only systemd user units are restarted here, and only when the unit is
 * genuinely active. On every other platform and posture this reports honestly
 * that the new binary takes effect on the daemon's next start rather than
 * printing a command that would not work.
 */
export function restartHandedOverDaemon(
  platform: NodeJS.Platform,
  configManager: { get(key: string): unknown },
  runCommand: RunCommandLike = defaultRunCommand,
): DaemonRestartOutcome {
  const unitName = resolveConfiguredServiceName(configManager);
  if (platform !== 'linux') {
    return {
      restarted: false,
      unitName,
      detail: 'the new daemon takes effect the next time the daemon starts',
    };
  }
  const active = runCommand('systemctl', ['--user', 'is-active', `${unitName}.service`]);
  if (active.status !== 0 || active.stdout.trim() !== 'active') {
    return {
      restarted: false,
      unitName,
      detail: 'the new daemon takes effect the next time the daemon starts',
    };
  }
  const restart = runCommand('systemctl', ['--user', 'restart', `${unitName}.service`]);
  if (restart.status !== 0) {
    return {
      restarted: false,
      unitName,
      detail: `the swap is on disk but restarting ${unitName}.service failed — run: systemctl --user restart ${unitName}.service`,
    };
  }
  return {
    restarted: true,
    unitName,
    detail: `restarted ${unitName}.service onto it`,
  };
}

export type DaemonHandoverOutcome =
  | { readonly action: 'skipped'; readonly reason: DaemonHandoverSkipReason }
  | {
      readonly action: 'handed-over';
      readonly fromVersion: string;
      readonly toTag: string;
      readonly restarted: boolean;
      readonly unitName: string;
    }
  /** The budget ran out before anything was written; the download was cancelled. */
  | { readonly action: 'deferred' }
  /** The budget ran out after the swap began; the binary WAS replaced. */
  | { readonly action: 'swapped-needs-restart'; readonly toTag: string }
  | { readonly action: 'failed'; readonly detail: string };

export interface RunDaemonHandoverOptions {
  readonly fetchImpl: UpdateFetchLike;
  /** The resolved `goodvibes-daemon` path, or null when none was found. */
  readonly binaryPath: string | null;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly configManager: { get(key: string): unknown };
  readonly print: (line: string) => void;
  /** Injectable so tests observe the probe instead of spawning a binary. */
  readonly runCommand?: RunCommandLike;
  /** Injectable so tests observe the swap instead of replacing a real file. */
  readonly performHandover?: (options: PerformDaemonHandoverOptions) => Promise<{ readonly tag: string }>;
  readonly restartDaemon?: typeof restartHandedOverDaemon;
  readonly io?: UpdateFileIo;
  readonly timeoutMs?: number;
}

/** Default budget for the whole handover — generous (a daemon binary is large) but bounded. */
export const DAEMON_HANDOVER_TIMEOUT_MS = 90_000;

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
 * The complete handover: probe, decide, swap, restart, report. Never throws —
 * a terminal launch is never held hostage by the state of the daemon beside it.
 */
export async function runDaemonHandover(options: RunDaemonHandoverOptions): Promise<DaemonHandoverOutcome> {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const installedVersion = options.binaryPath
    ? readInstalledDaemonVersion(options.binaryPath, runCommand)
    : null;
  const decision = decideDaemonHandover({
    binaryPath: options.binaryPath,
    installedVersion,
    platform: options.platform,
    arch: options.arch,
  });
  if (decision.action === 'skip') {
    return { action: 'skipped', reason: decision.reason };
  }

  const from = normalizeVersion(decision.fromVersion);
  options.print(
    `daemon handover: the installed daemon is v${from}, from before the daemon became its own product — fetching the current one…`,
  );

  const controller = new AbortController();
  const progress = createDaemonHandoverProgress();
  try {
    const perform = options.performHandover ?? performDaemonHandover;
    const work = perform({
      fetchImpl: options.fetchImpl,
      binaryPath: decision.binaryPath,
      assetName: decision.assetName,
      signal: controller.signal,
      progress,
      ...(options.io ? { io: options.io } : {}),
    });
    // Losing the race abandons this promise and a cancelled download rejects
    // shortly after; that rejection is the expected end of the work, not an
    // unhandled failure. The race below still sees every rejection that
    // arrives before the budget runs out.
    work.catch(() => {});
    const result = await withTimeout(work, options.timeoutMs ?? DAEMON_HANDOVER_TIMEOUT_MS);
    if (result === 'timeout') {
      if (!progress.begun) {
        controller.abort();
        options.print('daemon handover deferred — will retry next launch');
        return { action: 'deferred' };
      }
      const tag = normalizeVersion(progress.tag ?? '');
      options.print(
        `daemon handover: the daemon binary was replaced with v${tag}; restart it to run the new one`,
      );
      return { action: 'swapped-needs-restart', toTag: progress.tag ?? '' };
    }

    const restart = (options.restartDaemon ?? restartHandedOverDaemon)(
      options.platform,
      options.configManager,
      runCommand,
    );
    options.print(
      `daemon handover: replaced the daemon v${from} with v${normalizeVersion(result.tag)} from its own repository — ${restart.detail}.`
        + ` The build it replaced is kept beside it for one-command rollback.`,
    );
    return {
      action: 'handed-over',
      fromVersion: decision.fromVersion,
      toTag: result.tag,
      restarted: restart.restarted,
      unitName: restart.unitName,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.print(
      `daemon handover failed: ${detail} — the installed daemon v${from} is unchanged and will be retried next launch`,
    );
    return { action: 'failed', detail };
  }
}
