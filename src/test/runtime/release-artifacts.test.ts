import { describe, expect, test } from 'bun:test';
import { resolveArtifactNames, resolveSqliteVecAsset } from '../../runtime/release-artifacts.ts';

// These names are a wire contract shared by three places that must stay in
// lockstep: the release workflow (which names the flat assets + SHA256SUMS
// entries), scripts/install.sh (which downloads and places them), and the
// /update self-update path (update-runtime.ts). A change here that isn't
// mirrored in the other two silently breaks pure-binary vector search.

describe('resolveSqliteVecAsset', () => {
  test('linux keeps the node platform tag and the .so suffix', () => {
    expect(resolveSqliteVecAsset('linux', 'x64')).toEqual({
      assetName: 'sqlite-vec-linux-x64.so',
      dirName: 'sqlite-vec-linux-x64',
      fileName: 'vec0.so',
    });
    expect(resolveSqliteVecAsset('linux', 'arm64')).toEqual({
      assetName: 'sqlite-vec-linux-arm64.so',
      dirName: 'sqlite-vec-linux-arm64',
      fileName: 'vec0.so',
    });
  });

  test('darwin uses the darwin tag (not the binaries\' "macos") and the .dylib suffix', () => {
    // The binaries map darwin→"macos" in their release names; the addon does NOT
    // — it must match process.platform, which is what the SDK loader resolves.
    expect(resolveArtifactNames('darwin', 'arm64')?.app).toBe('goodvibes-macos-arm64');
    expect(resolveSqliteVecAsset('darwin', 'arm64')).toEqual({
      assetName: 'sqlite-vec-darwin-arm64.dylib',
      dirName: 'sqlite-vec-darwin-arm64',
      fileName: 'vec0.dylib',
    });
    expect(resolveSqliteVecAsset('darwin', 'x64')).toEqual({
      assetName: 'sqlite-vec-darwin-x64.dylib',
      dirName: 'sqlite-vec-darwin-x64',
      fileName: 'vec0.dylib',
    });
  });

  test('returns null for unsupported platform or arch', () => {
    expect(resolveSqliteVecAsset('win32', 'x64')).toBeNull();
    expect(resolveSqliteVecAsset('linux', 'riscv64')).toBeNull();
  });
});
