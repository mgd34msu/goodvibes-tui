/**
 * path-shadow-startup.ts — the boot-time surfacing of "is this the build you
 * are actually reaching, and is it the current one".
 *
 * It wires the real host inputs (this process's executable, the real PATH,
 * existsSync/realpathSync, and a bounded `<path> --version` spawn) into the
 * pure scan in path-shadow.ts and the pure wording in reachability-notice.ts,
 * then prints the result through the same SystemMessageRouter the rest of
 * startup uses, at high priority, before the session gets going.
 *
 * Cost discipline, because this runs on every start:
 *   - the first scan is existence-only: no process is spawned while there is
 *     nothing to report, which is the overwhelmingly common case;
 *   - versions are probed only after a shadow has already been found, and
 *     only with `--version`, bounded by a short timeout;
 *   - the latest-release lookup only happens when it can actually change what
 *     the user should do: a package-managed or source install (which will
 *     never swap itself), or an install that has just been found unreachable.
 *     A healthy binary install has already been brought to the latest release
 *     by the launch auto-updater, so asking again would be a network round
 *     trip that can only confirm what just happened.
 *
 * Every failure is swallowed. A reachability check must never block or crash
 * boot.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { detectInstallKind, fallbackUpdateCommand, type UpdateFetchLike } from './update-check.ts';
import { checkForUpdate } from '../input/commands/update-runtime.ts';
import {
  scanCommandShadows,
  splitPathEntries,
  type ShadowScanResult,
} from '@pellux/goodvibes-sdk/platform/runtime/path-shadow';
import { buildReachabilityNotices, type ReachabilityNotice } from './reachability-notice.ts';
import { VERSION } from '../version.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';

/** The commands a goodvibes install places side by side in one directory. */
export const INSTALLED_COMMANDS = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'] as const;

/** How long a `<path> --version` probe may take before it is abandoned. */
const VERSION_PROBE_TIMEOUT_MS = 3000;
/** How long the latest-release lookup may take before startup moves on without it. */
const LATEST_LOOKUP_TIMEOUT_MS = 2500;

function safeRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    // Any execute bit is enough: the shell searches for an executable file,
    // and which bit applies depends on ownership we are not going to compute.
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Runs `<path> --version` and returns its first line. Never inherits stdio, so
 * a binary that tries to draw a terminal cannot disturb this one.
 */
export function probeVersionLine(path: string): string | undefined {
  try {
    const result = spawnSync(path, ['--version'], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (result.error || typeof result.stdout !== 'string') return undefined;
    return result.stdout.split('\n')[0];
  } catch {
    return undefined;
  }
}

/**
 * The PATH directory that provides THIS running executable, which is the
 * position everything else is measured against.
 *
 * Preferred answer: the first PATH entry whose `<dir>/<command>` resolves,
 * through symlinks, to this same file. That is exactly "where the shell would
 * find me", and it is right for a linked package install as well as a
 * standalone binary.
 *
 * Fallback, for a standalone binary only: the directory the executable sits
 * in. That directory being absent from PATH is itself worth reporting — an
 * installed binary nobody can reach by name. For a package-managed install
 * the executable lives inside node_modules, which is never on PATH and never
 * meant to be, so there is nothing honest to say and the check stays silent.
 */
export function resolveSelfDirectory(input: {
  readonly execPath: string;
  readonly command: string;
  readonly pathEntries: readonly string[];
  readonly realPath: (path: string) => string;
  readonly isExecutableFile: (path: string) => boolean;
}): string | undefined {
  const self = input.realPath(input.execPath);
  for (const directory of input.pathEntries) {
    const candidate = join(directory, input.command);
    if (!input.isExecutableFile(candidate)) continue;
    if (input.realPath(candidate) === self) return directory;
  }
  if (detectInstallKind(input.execPath) === 'binary') return dirname(self);
  return undefined;
}

/** Which of the installed commands actually sit in this directory. */
function commandsPresentIn(directory: string, exists: (path: string) => boolean): string[] {
  return INSTALLED_COMMANDS.filter((command) => exists(join(directory, command)));
}

export interface ReachabilityCheckResult {
  readonly notices: readonly ReachabilityNotice[];
  readonly scan?: ShadowScanResult | undefined;
}

/**
 * The whole check, with the network lookup injected so tests never reach it.
 * Returns the notices to print; an empty list is the healthy case.
 */
export async function runReachabilityCheck(input: {
  readonly execPath: string;
  readonly pathValue: string | undefined;
  readonly homeDir: string;
  readonly runningVersion: string;
  readonly commandName?: string | undefined;
  /** Resolves the newest released version, or undefined when it cannot be determined. */
  readonly resolveLatest: () => Promise<string | undefined>;
  // The host touches, injectable so a test drives a whole scenario with fake
  // paths and never spawns anything. Production passes none of these.
  readonly isExecutableFile?: ((path: string) => boolean) | undefined;
  readonly realPath?: ((path: string) => string) | undefined;
  readonly probeVersion?: ((path: string) => string | undefined) | undefined;
}): Promise<ReachabilityCheckResult> {
  const command = input.commandName ?? basename(input.execPath);
  const pathEntries = splitPathEntries(input.pathValue);
  const installKind = detectInstallKind(input.execPath);
  const fileIsExecutable = input.isExecutableFile ?? isExecutableFile;
  const resolvePath = input.realPath ?? safeRealPath;
  const versionProbe = input.probeVersion ?? probeVersionLine;

  // A source checkout is not an install: there is no maintained copy to be
  // shadowed and no release to be behind.
  if (installKind === 'source') return { notices: [] };

  const selfDirectory = resolveSelfDirectory({
    execPath: input.execPath,
    command,
    pathEntries,
    realPath: resolvePath,
    isExecutableFile: fileIsExecutable,
  });
  if (!selfDirectory) return { notices: [] };

  const commands = commandsPresentIn(selfDirectory, fileIsExecutable);
  const base = {
    commands: commands.length > 0 ? commands : [command],
    installDir: selfDirectory,
    pathEntries,
    homeDir: input.homeDir,
    isExecutableFile: fileIsExecutable,
    realPath: resolvePath,
  };

  // Existence-only first: nothing is spawned while there is nothing to report.
  const cheapScan = scanCommandShadows(base);
  const scan = cheapScan.hasProblem
    ? scanCommandShadows({ ...base, probeVersion: versionProbe })
    : cheapScan;

  const latestVersion = scan.hasProblem || installKind !== 'binary'
    ? await input.resolveLatest()
    : undefined;

  return {
    scan,
    notices: buildReachabilityNotices({
      scan,
      runningVersion: input.runningVersion,
      latestVersion,
      updateCommand: installKind === 'binary'
        ? 'curl -fsSL https://goodvibes.sh/install.sh | sh'
        : fallbackUpdateCommand(installKind),
    }),
  };
}

/** The real latest-release lookup, bounded so a slow network cannot hold up boot. */
async function resolveLatestReleaseBounded(): Promise<string | undefined> {
  try {
    // The same release lookup /update uses — there is deliberately no second
    // source of truth for what the latest version is.
    const lookup = checkForUpdate(fetch as UpdateFetchLike, VERSION).then((result) => result.latestTag);
    const timed = await Promise.race([
      lookup,
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), LATEST_LOOKUP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    return timed ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Boot-time wiring. Prints one high-priority system message per line so the
 * report reads as prose rather than a single wrapped paragraph, and swallows
 * everything.
 */
export async function announceReachability(router: SystemMessageRouter): Promise<void> {
  try {
    const result = await runReachabilityCheck({
      execPath: process.execPath,
      pathValue: process.env['PATH'],
      homeDir: process.env['HOME'] ?? '',
      runningVersion: VERSION,
      commandName: 'goodvibes',
      resolveLatest: resolveLatestReleaseBounded,
    });
    for (const notice of result.notices) {
      for (const line of notice.lines) {
        router.high(`[Install] ${line}`);
      }
    }
  } catch {
    // Best-effort — a reachability check must never block or crash boot.
  }
}
