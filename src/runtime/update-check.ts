/**
 * Pure logic for `/update`: version comparison, the latest-release-tag
 * redirect lookup, and honest install-kind detection.
 *
 * Version comparison and the release-tag lookup are re-exported from the
 * SDK's canonical update policy module (platform/runtime/self-update), which
 * was hoisted from this file's semantics — one mechanism everywhere.
 * Install-kind detection stays local: it encodes how THIS package is
 * installed (compiled binary vs bun/npm package vs source run) and what
 * command replaces a swap for each kind.
 *
 * The self-update download/verify/swap orchestration that USES these lives
 * in src/input/commands/update-runtime.ts; this module only decides "is
 * there a newer version" and "can this install be swapped in place".
 */
export {
  compareVersions,
  normalizeVersion,
  parseReleaseTagFromLocation,
  resolveLatestReleaseTag,
  type UpdateFetchLike,
} from '@pellux/goodvibes-sdk/platform/runtime/self-update';

/**
 * How this running process was installed, detected honestly from
 * process.execPath rather than assumed:
 *   - "binary": a standalone `bun build --compile` executable with no
 *     package-manager ancestry — the suite-installer install path.
 *     Swappable in place.
 *   - "bun-global-package": running the vendored binary shipped inside an
 *     npm/bun-managed package install (execPath contains a "node_modules"
 *     path segment — true for both `bun add -g` and a local project
 *     dependency). Managed by the package manager; swapping the vendored
 *     file in place would fight the next `bun add -g` upgrade, so this is
 *     never swapped — the user re-runs their package manager instead.
 *   - "source": running directly via the `bun` interpreter (`bun run
 *     src/main.ts`), not a compiled binary at all.
 */
export type InstallKind = 'binary' | 'bun-global-package' | 'source';

export function detectInstallKind(execPath: string): InstallKind {
  const segments = execPath.split(/[\\/]/);
  const execName = (segments[segments.length - 1] ?? '').toLowerCase();
  if (execName === 'bun' || execName === 'bun.exe') {
    return 'source';
  }
  if (segments.includes('node_modules')) {
    return 'bun-global-package';
  }
  return 'binary';
}

/** The exact command to tell the user to run instead of a swap, for each non-binary install kind. */
export function fallbackUpdateCommand(kind: Exclude<InstallKind, 'binary'>): string {
  if (kind === 'bun-global-package') {
    return 'bun add -g @pellux/goodvibes-tui';
  }
  return 'curl -fsSL https://goodvibes.sh/install.sh | sh';
}
