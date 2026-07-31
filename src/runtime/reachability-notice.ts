/**
 * reachability-notice.ts — the two ways a running build can be the wrong one,
 * stated in plain words at startup.
 *
 * The platform's guarantee is that clients auto-update at startup, the daemon
 * checks hourly, and nothing ever drifts. Two things break that guarantee
 * without breaking anything visible:
 *
 *   1. Another copy of this command sits EARLIER on PATH. The updater keeps
 *      maintaining the copy it installed; the shell keeps running the other
 *      one. Both installs "succeed", the version number reports itself
 *      current, and an older build answers every question.
 *   2. This build is simply behind the latest release and, for whatever
 *      reason, did not update itself — a package-managed install, a failed
 *      swap, a check that could not reach the network.
 *
 * Either way the user finds out by being told a capability does not exist. A
 * build that knows it is not the current one must say so before anything
 * else, so this module turns those two facts into lines and the wiring in
 * path-shadow-startup.ts prints them ahead of the session.
 *
 * Pure by construction: it is handed a completed scan and two version strings
 * and decides only what to say.
 */

import { compareVersions, normalizeVersion } from './update-check.ts';
import { describeShadowReport, type ShadowScanResult } from '@pellux/goodvibes-sdk/platform/runtime/path-shadow';

export type ReachabilityNoticeKind = 'shadowed' | 'not-on-path' | 'behind';

export interface ReachabilityNotice {
  readonly kind: ReachabilityNoticeKind;
  /** Plain lines, already in the order they should be read. */
  readonly lines: readonly string[];
}

export interface ReachabilityNoticeInput {
  /** The completed PATH scan for this command. */
  readonly scan: ShadowScanResult;
  /** The version this process is running. */
  readonly runningVersion: string;
  /** The newest released version, or undefined when it could not be determined. */
  readonly latestVersion?: string | undefined;
  /** The exact command that brings this install up to date. */
  readonly updateCommand: string;
}

/**
 * Builds the notices for this startup. Returns an empty list for the healthy
 * case — one reachable copy, running the latest release — so a normal start
 * says nothing at all.
 */
export function buildReachabilityNotices(input: ReachabilityNoticeInput): ReachabilityNotice[] {
  const notices: ReachabilityNotice[] = [];

  for (const report of input.scan.shadowed) {
    const lines = describeShadowReport(report);
    if (lines.length === 0) continue;
    notices.push({
      kind: report.installDirNotOnPath ? 'not-on-path' : 'shadowed',
      lines: [
        ...lines,
        report.installDirNotOnPath
          ? 'Until then, run it by its full path.'
          : 'Until then, updating this install changes nothing you can reach by name.',
      ],
    });
  }

  const behind = describeVersionGap(input);
  if (behind) notices.push(behind);

  return notices;
}

/**
 * The staleness line. Deliberately silent when the latest version is unknown:
 * an unreachable network is not evidence of being behind, and saying so would
 * be the same kind of false certainty this module exists to remove.
 */
function describeVersionGap(input: ReachabilityNoticeInput): ReachabilityNotice | undefined {
  if (!input.latestVersion) return undefined;
  const running = normalizeVersion(input.runningVersion);
  const latest = normalizeVersion(input.latestVersion);
  if (running.length === 0 || latest.length === 0) return undefined;
  if (compareVersions(running, latest) >= 0) return undefined;
  return {
    kind: 'behind',
    lines: [
      `This build is v${running}. The current release is v${latest}, so what you are running is behind.`,
      `Anything added since v${running} is genuinely absent from this build — if it says it cannot do something, that may be why.`,
      `Update with: ${input.updateCommand}`,
    ],
  };
}

/** One flat list of lines, for a surface that prints rather than groups. */
export function reachabilityNoticeLines(notices: readonly ReachabilityNotice[]): string[] {
  return notices.flatMap((notice) => [...notice.lines]);
}
