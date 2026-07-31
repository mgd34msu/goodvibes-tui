/**
 * Platform binary package descriptors — the one place that knows the
 * @pellux/goodvibes-tui-<os>-<arch> package set (the esbuild / biome pattern).
 *
 * Each descriptor names a per-platform npm package that carries the prebuilt
 * `goodvibes` binary (and the matching sqlite-vec native addon). It used to
 * carry `goodvibes-daemon` too, because one repository built both; the daemon
 * is its own product with its own npm package now, which the main package
 * declares as a dependency so an npm install still brings the whole suite.
 * The main package declares all four platform packages as optionalDependencies with
 * os/cpu fields, so the package manager installs exactly the one that matches
 * the host — with registry integrity, and with no lifecycle script (zero
 * trust). Shared by:
 *   - scripts/assemble-platform-packages.ts (populates bin/ from a build)
 *   - scripts/publish-platform-packages.ts  (publishes each package)
 *   - scripts/release.ts                     (keeps versions in lockstep)
 *
 * bin/launcher-support.js duplicates the name mapping (it is plain JS shipped
 * in the tarball and cannot import this TS module); keep the two in sync.
 */

export interface PlatformPackage {
  /** Directory under platform-packages/. */
  readonly dir: string;
  /** Full npm package name. */
  readonly name: string;
  /** node process.platform value for the os field. */
  readonly os: 'linux' | 'darwin';
  /** node process.arch value for the cpu field. */
  readonly cpu: 'x64' | 'arm64';
  /** Release-asset filename for the TUI binary (e.g. goodvibes-linux-x64). */
  readonly appArtifact: string;
  /** sqlite-vec native addon package name, matched to build.ts. */
  readonly sqliteVecPackage: string;
  /** Native addon filename inside that package. */
  readonly sqliteVecFilename: string;
}

const SCOPE = '@pellux/goodvibes-tui';

export const PLATFORM_PACKAGES: readonly PlatformPackage[] = [
  {
    dir: 'linux-x64',
    name: `${SCOPE}-linux-x64`,
    os: 'linux',
    cpu: 'x64',
    appArtifact: 'goodvibes-linux-x64',
    sqliteVecPackage: 'sqlite-vec-linux-x64',
    sqliteVecFilename: 'vec0.so',
  },
  {
    dir: 'linux-arm64',
    name: `${SCOPE}-linux-arm64`,
    os: 'linux',
    cpu: 'arm64',
    appArtifact: 'goodvibes-linux-arm64',
    sqliteVecPackage: 'sqlite-vec-linux-arm64',
    sqliteVecFilename: 'vec0.so',
  },
  {
    dir: 'darwin-x64',
    name: `${SCOPE}-darwin-x64`,
    os: 'darwin',
    cpu: 'x64',
    appArtifact: 'goodvibes-macos-x64',
    sqliteVecPackage: 'sqlite-vec-darwin-x64',
    sqliteVecFilename: 'vec0.dylib',
  },
  {
    dir: 'darwin-arm64',
    name: `${SCOPE}-darwin-arm64`,
    os: 'darwin',
    cpu: 'arm64',
    appArtifact: 'goodvibes-macos-arm64',
    sqliteVecPackage: 'sqlite-vec-darwin-arm64',
    sqliteVecFilename: 'vec0.dylib',
  },
];

/** The optionalDependencies map the main package.json should carry. */
export function platformOptionalDependencies(version: string): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const p of PLATFORM_PACKAGES) {
    deps[p.name] = version;
  }
  return deps;
}
