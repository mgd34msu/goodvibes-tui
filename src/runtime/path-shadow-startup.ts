/**
 * path-shadow-startup.ts — this terminal's boot-time reachability report.
 *
 * The check itself (the PATH scan, the `--version` probes, the cost discipline
 * that keeps a healthy start free of spawns and network calls, and the wording)
 * belongs to the platform. All this supplies is what only this product knows:
 * which command name the shell resolves it by, which package a package-managed
 * install would be upgraded through, which release lookup answers "what is
 * current", and where the lines are printed.
 */

import { announceReachability, boundedLatestRelease } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { UpdateFetchLike } from './update-check.ts';
import { checkForUpdate } from '../input/commands/update-runtime.ts';
import { VERSION } from '../version.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';

/** The package a package-managed install of this terminal is upgraded through. */
const TERMINAL_PACKAGE_NAME = '@pellux/goodvibes-tui';

/** The command name the shell resolves this terminal by. */
const TERMINAL_COMMAND_NAME = 'goodvibes';

/** The same release lookup `/update` uses — there is deliberately no second source of truth. */
function resolveLatestRelease(): Promise<string | undefined> {
  return boundedLatestRelease(async () => {
    const result = await checkForUpdate(fetch as UpdateFetchLike, VERSION);
    return result.latestTag;
  });
}

/**
 * Boot-time wiring. Prints one high-priority system message per line so the
 * report reads as prose rather than a single wrapped paragraph, and swallows
 * everything — a reachability check must never block or crash boot.
 */
export async function announceInstallReachability(router: SystemMessageRouter): Promise<void> {
  await announceReachability(
    {
      execPath: process.execPath,
      pathValue: process.env['PATH'],
      homeDir: process.env['HOME'] ?? '',
      runningVersion: VERSION,
      commandName: TERMINAL_COMMAND_NAME,
      packageName: TERMINAL_PACKAGE_NAME,
      resolveLatest: resolveLatestRelease,
    },
    (line) => router.high(`[Install] ${line}`),
  );
}
