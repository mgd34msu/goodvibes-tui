import { execSync, spawnSync } from 'child_process';
import { statSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

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

const TARGETS: Record<string, { bunTarget: string; outfile: string }> = {
  'linux-x64': { bunTarget: 'bun-linux-x64', outfile: 'goodvibes-linux-x64' },
  'linux-arm64': { bunTarget: 'bun-linux-arm64', outfile: 'goodvibes-linux-arm64' },
  'darwin-x64': { bunTarget: 'bun-darwin-x64', outfile: 'goodvibes-macos-x64' },
  'darwin-arm64': { bunTarget: 'bun-darwin-arm64', outfile: 'goodvibes-macos-arm64' },
};

const args = process.argv.slice(2);
const buildAll = args.includes('--all');
const targetIdx = args.indexOf('--target');
const specificTarget = targetIdx !== -1 ? args[targetIdx + 1] : null;

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

function buildTarget(name: string, config: { bunTarget: string; outfile: string }): boolean {
  const outPath = join(distDir, config.outfile);
  const cmd = [
    'bun build src/main.ts',
    '--compile',
    `--target=${config.bunTarget}`,
    `--outfile ${outPath}`,
  ].join(' ');

  console.log(`\nBuilding ${name} → dist/${config.outfile}`);
  console.log(`  ${cmd}`);

  const result = spawnSync('bun', [
    'build', 'src/main.ts',
    '--compile',
    `--target=${config.bunTarget}`,
    '--outfile', outPath,
  ], { cwd: root, stdio: 'inherit' });

  if (result.status !== 0) {
    console.error(`  FAILED (exit ${result.status})`);
    return false;
  }

  const size = getFileSize(outPath);
  if (size >= 0) {
    console.log(`  OK — ${formatBytes(size)}`);
  } else {
    console.log('  OK (size unknown)');
  }

  return true;
}

// --- Run prebuild first ---
console.log('Running prebuild...');
execSync('bun run scripts/prebuild.ts', { cwd: root, stdio: 'inherit' });

// --- Determine targets to build ---
let targetsToBuild: [string, { bunTarget: string; outfile: string }][];

if (buildAll) {
  targetsToBuild = Object.entries(TARGETS);
} else if (specificTarget) {
  if (!TARGETS[specificTarget]) {
    console.error(`Unknown target '${specificTarget}'. Available: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }
  targetsToBuild = [[specificTarget, TARGETS[specificTarget]]];
} else {
  // Default: build native platform binary
  const platform = process.platform;
  const arch = process.arch;
  const nativeKey = `${platform === 'linux' ? 'linux' : 'darwin'}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
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
  const success = buildTarget(name, config);
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
