/**
 * lifecycle.ts — resolve THIS binary's update-artifact identity for the SDK
 * DaemonServer facade's auto-update lifecycle.
 *
 * The SDK facade now runs the entire self-update loop itself when handed a
 * DaemonUpdateArtifact ({version, execPath}): it compares the HOST binary's
 * version against the release tags (no longer the version-blind sdk-package
 * comparison that used to restart-loop), swaps only at an idle moment, keeps
 * the outgoing file at `<path>.previous`, and leaves a receipt in the store it
 * serves on /status. When the artifact is ABSENT, updates are host-managed —
 * the facade runs no loop (the safe embedded default).
 *
 * The one guard the facade does NOT apply is install-kind: it must never swap a
 * dev `bun run daemon` interpreter or a bun-global package install. This helper
 * is that guard — it hands the facade an artifact ONLY for a compiled binary
 * install, so a dev run resolves to `undefined` (host-managed, no loop) and
 * only a real self-contained binary self-updates.
 */
import type { DaemonUpdateArtifact } from '@pellux/goodvibes-sdk/platform/daemon';
import { VERSION } from '../version.ts';
import { detectInstallKind } from '../runtime/update-check.ts';

export interface ResolveDaemonUpdateArtifactOptions {
  /** The executable to identify; defaults to process.execPath. */
  readonly execPath?: string;
  /** Injectable so tests pin a fixture version — never the live build VERSION. */
  readonly version?: string;
}

/**
 * The update-artifact identity to hand the DaemonServer facade, or `undefined`
 * for a non-binary install (dev/source or bun-global package) — in which case
 * the facade keeps updates host-managed and runs no swap loop.
 */
export function resolveDaemonUpdateArtifact(
  options: ResolveDaemonUpdateArtifactOptions = {},
): DaemonUpdateArtifact | undefined {
  const execPath = options.execPath ?? process.execPath;
  if (detectInstallKind(execPath) !== 'binary') return undefined;
  return { version: options.version ?? VERSION, execPath };
}
