#!/usr/bin/env bun
/**
 * Assemble the @pellux/goodvibes-tui-<os>-<arch> platform packages from built
 * binaries in dist/. Run at release time after scripts/build.ts has produced
 * the target binaries.
 *
 * Usage:
 *   bun run scripts/assemble-platform-packages.ts            # all targets present in dist/
 *   bun run scripts/assemble-platform-packages.ts --only linux-x64
 *   bun run scripts/assemble-platform-packages.ts --require-all   # every target must be present
 *
 * For each target it:
 *   1. copies dist/<appArtifact> and dist/<daemonArtifact> into
 *      platform-packages/<dir>/bin/ (chmod +x),
 *   2. copies the matching sqlite-vec native addon (dist/lib/...) beside them
 *      under bin/lib/ when present, so semantic memory works out of the box,
 *   3. stamps the platform package.json version to match the main package.
 *
 * Targets whose binaries are absent from dist/ are skipped unless --require-all
 * is passed (each CI runner builds one target, so a partial dist/ is normal for
 * local validation).
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_PACKAGES, type PlatformPackage } from './platform-packages.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distDir = join(root, 'dist');
const packagesRoot = join(root, 'platform-packages');

const args = process.argv.slice(2);
const requireAll = args.includes('--require-all');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;

const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

function assemble(pkg: PlatformPackage): 'assembled' | 'skipped' {
  const pkgDir = join(packagesRoot, pkg.dir);
  const binDir = join(pkgDir, 'bin');
  const app = join(distDir, pkg.appArtifact);
  const daemon = join(distDir, pkg.daemonArtifact);

  if (!existsSync(app) || !existsSync(daemon)) {
    if (requireAll) {
      throw new Error(
        `missing built binaries for ${pkg.name}: expected ${pkg.appArtifact} and ${pkg.daemonArtifact} in dist/`,
      );
    }
    console.log(`  skip ${pkg.name}: binaries not present in dist/`);
    return 'skipped';
  }

  mkdirSync(binDir, { recursive: true });

  for (const artifact of [pkg.appArtifact, pkg.daemonArtifact]) {
    const dest = join(binDir, artifact);
    copyFileSync(join(distDir, artifact), dest);
    chmodSync(dest, 0o755);
  }

  // sqlite-vec native addon, resolved at runtime as <execDir>/lib/<pkg>/<file>.
  const addonSrc = join(distDir, 'lib', pkg.sqliteVecPackage, pkg.sqliteVecFilename);
  if (existsSync(addonSrc)) {
    const addonDestDir = join(binDir, 'lib', pkg.sqliteVecPackage);
    mkdirSync(addonDestDir, { recursive: true });
    copyFileSync(addonSrc, join(addonDestDir, pkg.sqliteVecFilename));
    console.log(`  + ${pkg.sqliteVecPackage}/${pkg.sqliteVecFilename}`);
  } else {
    console.log(`  note ${pkg.name}: no sqlite-vec addon in dist/lib (semantic memory will degrade)`);
  }

  // Stamp version to match the main package.
  const pkgJsonPath = join(pkgDir, 'package.json');
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version: string };
  pkgJson.version = version;
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);

  console.log(`  assembled ${pkg.name}@${version}`);
  return 'assembled';
}

const targets = only ? PLATFORM_PACKAGES.filter((p) => p.dir === only) : PLATFORM_PACKAGES;
if (only && targets.length === 0) {
  throw new Error(`unknown target '${only}'. Known: ${PLATFORM_PACKAGES.map((p) => p.dir).join(', ')}`);
}

console.log(`Assembling platform packages (version ${version})`);
let assembled = 0;
for (const pkg of targets) {
  if (assemble(pkg) === 'assembled') assembled++;
}
console.log(`Done: ${assembled}/${targets.length} target(s) assembled.`);
if (requireAll && assembled !== targets.length) {
  process.exit(1);
}
