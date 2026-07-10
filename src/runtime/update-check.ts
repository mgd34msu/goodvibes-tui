/**
 * Pure logic for `/update`: version comparison, the latest-release-tag
 * redirect lookup, and honest install-kind detection. No filesystem or
 * process side effects here — everything takes its inputs as arguments so
 * tests exercise it without touching the network or the host, matching the
 * repo rule that tests never compare against the live build VERSION and
 * never make live network calls.
 *
 * The self-update download/verify/swap orchestration that USES these lives
 * in src/input/commands/update-runtime.ts; this module only decides "is
 * there a newer version" and "can this install be swapped in place".
 */

export function normalizeVersion(version: string): string {
  return version.replace(/^v/i, '').trim();
}

/**
 * Compares two version strings component-wise as dotted non-negative
 * integers (a leading "v" is ignored, matching the "vX.Y.Z" release tag
 * format). Returns -1/0/1 for a<b / a==b / a>b. Non-numeric or missing
 * components are treated as 0, so "1.2" and "1.2.0" compare equal.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const partsA = normalizeVersion(a).split('.');
  const partsB = normalizeVersion(b).split('.');
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const x = Number.parseInt(partsA[i] ?? '0', 10) || 0;
    const y = Number.parseInt(partsB[i] ?? '0', 10) || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Extracts the release tag from a GitHub "/releases/latest" redirect
 * Location header, e.g. "https://github.com/mgd34msu/goodvibes-tui/releases/tag/v1.13.2"
 * -> "v1.13.2". Mirrors scripts/install.sh's own redirect-URL tag parsing
 * (it takes everything after the final slash of the redirect target).
 */
export function parseReleaseTagFromLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  const segments = location.split('/').filter((segment) => segment.length > 0);
  const tag = segments[segments.length - 1];
  return tag && tag.length > 0 ? tag : null;
}

/** Minimal shape of the subset of the fetch API this module needs, so tests inject a stub instead of the real network. */
export interface UpdateFetchLike {
  (url: string, init?: { method?: string; redirect?: 'manual' | 'follow' | 'error' }): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly url: string;
    readonly headers: { get(name: string): string | null };
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

/**
 * Resolves the latest release tag the same way scripts/install.sh does:
 * a HEAD request with redirects NOT followed, reading the tag out of the
 * response's redirect Location header. Throws if no tag can be resolved —
 * callers must not silently fall back to "already current".
 */
export async function resolveLatestReleaseTag(fetchImpl: UpdateFetchLike, releasesLatestUrl: string): Promise<string> {
  const response = await fetchImpl(releasesLatestUrl, { method: 'HEAD', redirect: 'manual' });
  const location = response.headers.get('location');
  const tag = parseReleaseTagFromLocation(location) ?? (response.url !== releasesLatestUrl ? parseReleaseTagFromLocation(response.url) : null);
  if (!tag) {
    throw new Error(`could not resolve the latest release tag from ${releasesLatestUrl} (no redirect Location header)`);
  }
  return tag;
}

/**
 * How this running process was installed, detected honestly from
 * process.execPath rather than assumed:
 *   - "binary": a standalone `bun build --compile` executable with no
 *     package-manager ancestry — the scripts/install.sh install path.
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
