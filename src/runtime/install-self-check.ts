/**
 * install-self-check.ts — cheap, non-fatal detection of an incomplete
 * install, run at TUI startup and re-surfaced by `goodvibes doctor`.
 *
 * A packaged install (the standalone `install.sh` binary, or the
 * `bun add -g` vendored package) is only usable if its release binaries are
 * actually present: the app binary the user is running, plus the separate
 * background daemon binary. Two things can go wrong after a partial or
 * interrupted install:
 *   1. the vendored release binaries were never downloaded into <root>/vendor
 *      (scripts/postinstall.js downloads them for packaged installs), and
 *   2. the daemon launch path resolves to nothing runnable, so any
 *      daemon/control-plane/listener/web surface silently fails to start.
 *
 * This module decides those two facts from injected inputs only — an
 * install kind, a package root, the resolved daemon executable, and a
 * `fileExists` predicate — so it is pure and testable with fake paths and
 * never touches the network. The production wiring (real existsSync + the
 * real daemon resolution) lives in install-self-check-startup.ts and in the
 * CLI status/doctor entrypoint; this file only makes the judgement.
 *
 * A `source` checkout run via `bun src/main.ts` is NOT an incomplete
 * install — there is no vendor directory to populate and the daemon runs
 * from source — so it is never flagged.
 *
 * Install-kind detection and the per-kind repair one-liner are reused from
 * update-check.ts rather than re-derived here.
 */

import { join } from 'node:path';
import { detectInstallKind, fallbackUpdateCommand, type InstallKind } from './update-check.ts';
import { resolveArtifactNames } from './release-artifacts.ts';

/**
 * The subset of a resolved daemon executable this check needs. Structurally
 * matches the CLI's DaemonExecutableResolution without importing it from the
 * cli layer (that would create an import cycle: cli imports this pure module,
 * so this module must not import back into cli).
 */
export interface DaemonPathResolution {
  readonly command: string;
  /** How the path was resolved. 'fallback' means no runnable file was found — a bare PATH command. */
  readonly source: string;
  readonly absolute: boolean;
}

export type InstallSelfCheckFindingId = 'missing-vendor-binaries' | 'broken-daemon-path';

export interface InstallSelfCheckFinding {
  readonly id: InstallSelfCheckFindingId;
  readonly summary: string;
  readonly detail: string;
  /** The exact command to run to repair this install kind. */
  readonly repairCommand: string;
}

export interface InstallSelfCheckInput {
  readonly installKind: InstallKind;
  readonly packageRoot: string;
  readonly platform: string;
  readonly arch: string;
  readonly daemon: DaemonPathResolution;
  readonly fileExists: (path: string) => boolean;
}

/**
 * The exact repair command per install kind. A standalone `binary` install is
 * repaired by re-running the installer (which places both binaries); the other
 * non-binary kinds reuse update-check.ts's fallbackUpdateCommand verbatim.
 */
export function repairCommandForInstallKind(kind: InstallKind): string {
  if (kind === 'binary') return 'curl -fsSL https://goodvibes.sh/install.sh | sh';
  return fallbackUpdateCommand(kind);
}

/**
 * Decide, from injected inputs only, whether this install is missing pieces.
 * Returns zero findings for a source checkout (complete by definition) and for
 * a healthy packaged install.
 */
export function evaluateInstallSelfCheck(input: InstallSelfCheckInput): InstallSelfCheckFinding[] {
  if (input.installKind === 'source') return [];

  const findings: InstallSelfCheckFinding[] = [];
  const repairCommand = repairCommandForInstallKind(input.installKind);
  const artifacts = resolveArtifactNames(input.platform, input.arch);

  // (1) Missing vendored binaries. Only the vendored package install ships a
  // <root>/vendor directory (postinstall.js downloads app + daemon there); a
  // standalone compiled binary has none, so this check applies only to the
  // bun-global-package kind.
  if (input.installKind === 'bun-global-package' && artifacts) {
    const vendorDir = join(input.packageRoot, 'vendor');
    const missing = [artifacts.app, artifacts.daemon].filter(
      (name) => !input.fileExists(join(vendorDir, name)),
    );
    if (missing.length > 0) {
      findings.push({
        id: 'missing-vendor-binaries',
        summary: 'Vendored release binaries are missing from this install.',
        detail: `${missing.join(', ')} not found under ${vendorDir}.`,
        repairCommand,
      });
    }
  }

  // (2) Broken daemon path. The daemon runs as a separate binary; if the
  // resolver fell back to a bare PATH command (nothing runnable was found on
  // the packaged search paths) or the resolved absolute path does not exist,
  // any daemon/control-plane/listener/web surface will fail to start.
  const daemonMissing = input.daemon.source === 'fallback'
    || (input.daemon.absolute && !input.fileExists(input.daemon.command));
  if (daemonMissing) {
    findings.push({
      id: 'broken-daemon-path',
      summary: 'The background daemon binary could not be located.',
      detail: input.daemon.source === 'fallback'
        ? `No daemon executable was found on the packaged search paths; the launcher falls back to a bare "${input.daemon.command}" on PATH.`
        : `The resolved daemon path ${input.daemon.command} does not exist.`,
      repairCommand,
    });
  }

  return findings;
}

/**
 * Convenience wrapper that detects the install kind from an exec path (reusing
 * update-check.ts) and then evaluates. Platform/arch default to the running
 * host but are injectable for tests. The daemon resolution and fileExists are
 * always injected so this stays free of process/filesystem coupling of its own.
 */
export function runInstallSelfCheck(input: {
  readonly execPath: string;
  readonly packageRoot: string;
  readonly daemon: DaemonPathResolution;
  readonly fileExists: (path: string) => boolean;
  readonly platform?: string;
  readonly arch?: string;
}): InstallSelfCheckFinding[] {
  return evaluateInstallSelfCheck({
    installKind: detectInstallKind(input.execPath),
    packageRoot: input.packageRoot,
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    daemon: input.daemon,
    fileExists: input.fileExists,
  });
}
