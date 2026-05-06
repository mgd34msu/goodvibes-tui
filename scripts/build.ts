import { execSync, spawnSync } from 'child_process';
import { statSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { patchBunCompileCompatibility } from './bun-compile-compat.ts';

/**
 * Production build script — compiles binaries for all targets and reports sizes.
 *
 * Usage:
 *   bun run scripts/build.ts                     # build for current platform
 *   bun run scripts/build.ts --all               # build all platform targets
 *   bun run scripts/build.ts --target linux-x64  # build a specific target
 *
 * Targets:
 *   linux-x64    bun-linux-x64    → dist/goodvibes-linux-x64
 *   linux-arm64  bun-linux-arm64  → dist/goodvibes-linux-arm64
 *   darwin-x64   bun-darwin-x64   → dist/goodvibes-macos-x64
 *   darwin-arm64 bun-darwin-arm64 → dist/goodvibes-macos-arm64
 */

const root = process.cwd();
const distDir = join(root, 'dist');

const TARGETS: Record<string, { bunTarget: string; outfile: string; sqliteVecPackage: string }> = {
  'linux-x64': { bunTarget: 'bun-linux-x64', outfile: 'goodvibes-linux-x64', sqliteVecPackage: 'sqlite-vec-linux-x64' },
  'linux-arm64': { bunTarget: 'bun-linux-arm64', outfile: 'goodvibes-linux-arm64', sqliteVecPackage: 'sqlite-vec-linux-arm64' },
  'darwin-x64': { bunTarget: 'bun-darwin-x64', outfile: 'goodvibes-macos-x64', sqliteVecPackage: 'sqlite-vec-darwin-x64' },
  'darwin-arm64': { bunTarget: 'bun-darwin-arm64', outfile: 'goodvibes-macos-arm64', sqliteVecPackage: 'sqlite-vec-darwin-arm64' },
};

// F5: sqlite-vec native addon must be shipped alongside binaries.
// Map from package name to the .so/.dylib filename inside that package.
const SQLITE_VEC_NATIVE_FILENAMES: Record<string, string> = {
  'sqlite-vec-linux-x64': 'vec0.so',
  'sqlite-vec-linux-arm64': 'vec0.so',
  'sqlite-vec-darwin-x64': 'vec0.dylib',
  'sqlite-vec-darwin-arm64': 'vec0.dylib',
};

const args = process.argv.slice(2);
const buildAll = args.includes('--all');
const daemonOnly = args.includes('--daemon-only');
const targetIdx = args.indexOf('--target');
const specificTarget = targetIdx !== -1 ? args[targetIdx + 1] : null;

// Daemon-only aliases: "daemon-linux-x64" → "linux-x64" in daemon-only mode
const DAEMON_ONLY_ALIASES: Record<string, string> = {
  'daemon-linux-x64': 'linux-x64',
  'daemon-linux-arm64': 'linux-arm64',
  'daemon-macos-x64': 'darwin-x64',
  'daemon-macos-arm64': 'darwin-arm64',
};

// Ensure dist/ exists
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return -1;
  }
}

function buildTarget(
  name: string,
  config: { bunTarget: string; outfile: string; sqliteVecPackage: string },
  opts: { daemonOnly?: boolean } = {},
): boolean {
  const outPath = join(distDir, config.outfile);

  // F5: Bun compile cannot embed native addons, so only the platform-specific
  // native addon package stays external. The sqlite-vec JS wrapper itself must
  // be bundled because the SDK imports it statically before choosing the
  // compiled-binary native-addon path.
  const externalFlags = [
    '--external', config.sqliteVecPackage,
  ];

  console.log(`\nBuilding ${name}${opts.daemonOnly ? ' (daemon only)' : ''} → dist/${config.outfile}`);

  if (!opts.daemonOnly) {
    const tuiResult = spawnSync('bun', [
      'build', 'src/main.ts',
      '--compile',
      `--target=${config.bunTarget}`,
      '--outfile', outPath,
      ...externalFlags,
    ], { cwd: root, stdio: 'inherit' });

    if (tuiResult.status !== 0) {
      console.error(`  TUI FAILED (exit ${tuiResult.status})`);
      return false;
    }
  }

  // Derive daemon outfile from TUI outfile: strip 'goodvibes-' prefix from config.outfile
  // and prefix with 'goodvibes-daemon-' so the mapping stays in one place (TARGETS).
  const daemonSuffix = config.outfile.replace(/^goodvibes-/, '');
  const daemonOutfile = `goodvibes-daemon-${daemonSuffix}`;
  const daemonOutPathFull = join(distDir, daemonOutfile);

  console.log(`  Building daemon → dist/${daemonOutfile}`);
  const daemonResult = spawnSync('bun', [
    'build', 'src/daemon/cli.ts',
    '--compile',
    `--target=${config.bunTarget}`,
    '--outfile', daemonOutPathFull,
    ...externalFlags,
  ], { cwd: root, stdio: 'inherit' });

  if (daemonResult.status !== 0) {
    console.error(`  DAEMON FAILED (exit ${daemonResult.status})`);
    return false;
  }

  // F5: Copy sqlite-vec native addon to dist/lib/<package>/<filename>
  const nativeFilename = SQLITE_VEC_NATIVE_FILENAMES[config.sqliteVecPackage];
  if (nativeFilename !== undefined) {
    const srcAddon = join(root, 'node_modules', config.sqliteVecPackage, nativeFilename);
    const libDir = join(distDir, 'lib', config.sqliteVecPackage);
    mkdirSync(libDir, { recursive: true });
    if (existsSync(srcAddon)) {
      copyFileSync(srcAddon, join(libDir, nativeFilename));
      console.log(`  Copied native addon: lib/${config.sqliteVecPackage}/${nativeFilename}`);
    } else {
      // Determine whether this build target matches the runner's own platform.
      // A cross-target build (e.g. linux-x64 runner building linux-arm64 or darwin-arm64)
      // will not have the target platform's addon installed by `bun install`.
      // In that case we warn and continue — the target-native CI runner owns that binary.
      // For same-platform builds the addon MUST be present; we hard-fail.
      const runnerPlatform = process.platform; // 'linux' | 'darwin' | 'win32'
      const runnerArch = process.arch;         // 'x64' | 'arm64'
      const runnerKey = `${runnerPlatform}-${runnerArch === 'arm64' ? 'arm64' : 'x64'}`;
      const isSamePlatform = name === runnerKey;
      if (isSamePlatform) {
        throw new Error(
          `Build failed: native addon not found at ${srcAddon}.\n` +
          `Platform: ${config.sqliteVecPackage}\n` +
          `Run 'bun install' to ensure ${config.sqliteVecPackage} is installed in node_modules/.`
        );
      } else {
        console.warn(
          `  [WARN] Cross-target build: native addon for ${config.sqliteVecPackage} not found at ${srcAddon}.` +
          ` This runner (${runnerKey}) cannot bundle addons for target '${name}'.` +
          ` The target-native runner is responsible for copying this addon.`
        );
      }
    }
  }

  if (!opts.daemonOnly) {
    const size = getFileSize(outPath);
    if (size >= 0) {
      console.log(`  TUI OK — ${formatBytes(size)}`);
    } else {
      console.log('  TUI OK (size unknown)');
    }
  }

  return true;
}

// --- Run prebuild first ---
patchBunCompileCompatibility(root);

console.log('Running prebuild...');
execSync('bun run scripts/prebuild.ts', { cwd: root, stdio: 'inherit' });

// --- Determine targets to build ---
let targetsToBuild: [string, { bunTarget: string; outfile: string; sqliteVecPackage: string }][];

// Resolve daemon-only alias if provided
let resolvedTarget = specificTarget;
let isDaemonOnly = daemonOnly;
if (specificTarget && DAEMON_ONLY_ALIASES[specificTarget]) {
  resolvedTarget = DAEMON_ONLY_ALIASES[specificTarget];
  isDaemonOnly = true;
}

if (buildAll) {
  targetsToBuild = Object.entries(TARGETS);
} else if (resolvedTarget) {
  if (!TARGETS[resolvedTarget]) {
    const available = [...Object.keys(TARGETS), ...Object.keys(DAEMON_ONLY_ALIASES)].join(', ');
    console.error(`Unknown target '${specificTarget}'. Available: ${available}`);
    process.exit(1);
  }
  targetsToBuild = [[resolvedTarget, TARGETS[resolvedTarget]]];
} else {
  // Default: build native platform binary
  const platform = process.platform;
  const arch = process.arch;
  if (platform !== 'linux' && platform !== 'darwin') {
    console.error(`Unsupported platform '${platform}'. Only linux and darwin are supported. Use --target or --all to specify a target explicitly.`);
    process.exit(1);
  }
  const nativeKey = `${platform}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (!TARGETS[nativeKey]) {
    console.error(`No built-in target for ${platform}/${arch}. Use --target or --all.`);
    process.exit(1);
  }
  targetsToBuild = [[nativeKey, TARGETS[nativeKey]]];
}

// --- Build ---
console.log(`\nBuilding ${targetsToBuild.length} target(s)...`);

const results: { name: string; success: boolean; size: number }[] = [];

for (const [name, config] of targetsToBuild) {
  const success = buildTarget(name, config, { daemonOnly: isDaemonOnly });
  const outPath = join(distDir, config.outfile);
  results.push({ name, success, size: getFileSize(outPath) });
}

// --- Summary ---
console.log('\n--- Build Summary ---');
for (const r of results) {
  const status = r.success ? 'OK ' : 'FAIL';
  const size = r.size >= 0 ? formatBytes(r.size) : 'N/A';
  console.log(`  [${status}] ${r.name.padEnd(12)} ${size}`);
}

const allPassed = results.every(r => r.success);
if (!allPassed) {
  console.error('\nOne or more targets failed.');
  process.exit(1);
}

console.log('\nBuild complete.');
