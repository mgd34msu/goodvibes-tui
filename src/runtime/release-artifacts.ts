/**
 * Release-artifact naming and checksum verification, re-exported from the
 * SDK's canonical update policy module (platform/runtime/self-update), which
 * was hoisted from this file's semantics. One mechanism everywhere: the
 * asset naming convention (`goodvibes[-daemon]-{platform}-{arch}`), the
 * sqlite-vec addon naming, and the "no manifest entry is as fatal as a
 * mismatch" verification rule now have a single owner. Consumers that must
 * stay in lockstep:
 *   - scripts/postinstall.js (npm install-time binary download)
 *   - src/input/commands/update-runtime.ts (the /update self-update)
 *   - the suite installer (goodvibes-daemon scripts/install.sh; mirrors the
 *     same names)
 */
export {
  CHECKSUM_MANIFEST_NAME,
  parseChecksumFile,
  resolveArtifactNames,
  resolveSqliteVecAsset,
  sha256,
  verifyChecksum,
  type ReleaseArtifactNames,
  type SqliteVecAsset,
} from '@pellux/goodvibes-sdk/platform/runtime/self-update';

export type SupportedPlatform = 'linux' | 'darwin';
export type SupportedArch = 'x64' | 'arm64';
