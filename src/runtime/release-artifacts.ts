/**
 * Shared release-artifact naming and checksum-verification logic.
 *
 * This is the one place that knows the release asset naming convention
 * (`goodvibes[-daemon]-{platform}-{arch}`) and how to verify a downloaded
 * artifact against SHA256SUMS.txt. Two callers share it and must stay in
 * lockstep:
 *   - scripts/postinstall.js (npm install-time binary download)
 *   - src/input/commands/update-runtime.ts (the /update command's self-update)
 *
 * A downloaded artifact with NO entry in the checksum manifest is just as
 * unverified as one with a mismatching entry — verifyChecksum() throws in
 * both cases, never silently skips.
 */
import { createHash } from 'node:crypto';

export const CHECKSUM_MANIFEST_NAME = 'SHA256SUMS.txt';

export type SupportedPlatform = 'linux' | 'darwin';
export type SupportedArch = 'x64' | 'arm64';

export interface ReleaseArtifactNames {
  readonly app: string;
  readonly daemon: string;
}

/** Release-asset platform tag as used in artifact filenames ("linux" | "macos"). */
const PLATFORM_TAGS: Record<SupportedPlatform, string> = {
  linux: 'linux',
  darwin: 'macos',
};

export function resolveArtifactNames(platform: string, arch: string): ReleaseArtifactNames | null {
  const platformTag = PLATFORM_TAGS[platform as SupportedPlatform];
  if (!platformTag || (arch !== 'x64' && arch !== 'arm64')) {
    return null;
  }
  const suffix = `${platformTag}-${arch}`;
  return {
    app: `goodvibes-${suffix}`,
    daemon: `goodvibes-daemon-${suffix}`,
  };
}

export interface SqliteVecAsset {
  /** Release asset filename, e.g. `sqlite-vec-linux-x64.so`. */
  readonly assetName: string;
  /** Directory name the SDK loader resolves, e.g. `sqlite-vec-linux-x64`. */
  readonly dirName: string;
  /** File the loader opens inside that directory, e.g. `vec0.so`. */
  readonly fileName: string;
}

/**
 * Names the sqlite-vec native addon for a platform/arch. Unlike the binaries
 * (whose release tag maps darwin→"macos"), the addon keeps the Node-style
 * platform tag ("linux" | "darwin") because that is exactly what the SDK's
 * loader resolves at `<execDir>/lib/sqlite-vec-<process.platform>-<process.arch>/vec0.<suffix>`.
 * The scripts/install.sh installer and the release workflow name the asset the
 * same way; all three must stay in lockstep.
 */
export function resolveSqliteVecAsset(platform: string, arch: string): SqliteVecAsset | null {
  if ((platform !== 'linux' && platform !== 'darwin') || (arch !== 'x64' && arch !== 'arm64')) {
    return null;
  }
  const suffix = platform === 'darwin' ? 'dylib' : 'so';
  const dirName = `sqlite-vec-${platform}-${arch}`;
  return {
    assetName: `${dirName}.${suffix}`,
    dirName,
    fileName: `vec0.${suffix}`,
  };
}

export function sha256(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function parseChecksumFile(contents: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

/**
 * Verify a downloaded artifact's checksum against the parsed manifest.
 * An artifact with no entry in the manifest is a hard failure, identical
 * in severity to a mismatching entry — never treated as "unverifiable, so
 * skip the check". Throws naming the artifact and the manifest.
 */
export function verifyChecksum(
  artifactName: string,
  actual: string,
  expected: string | undefined,
  manifestName: string = CHECKSUM_MANIFEST_NAME,
): void {
  if (expected === undefined) {
    throw new Error(`no checksum entry for ${artifactName} in ${manifestName} — refusing to install an unverified binary`);
  }
  if (expected !== actual) {
    throw new Error(`checksum mismatch for ${artifactName}: expected ${expected}, got ${actual}`);
  }
}
