#!/usr/bin/env bun
/**
 * Publish the assembled @pellux/goodvibes-tui-<os>-<arch> platform packages.
 *
 * Run after scripts/assemble-platform-packages.ts has populated each package's
 * bin/ from the release binaries. Publishes to GOODVIBES_PUBLISH_REGISTRY
 * (default: npm). A package whose bin/ was not assembled is a hard error unless
 * --allow-missing is passed.
 *
 * Usage:
 *   bun run scripts/publish-platform-packages.ts            # publish all
 *   bun run scripts/publish-platform-packages.ts --dry-run  # npm pack instead
 *   bun run scripts/publish-platform-packages.ts --only linux-x64
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_PACKAGES } from './platform-packages.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const packagesRoot = join(root, 'platform-packages');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const allowMissing = args.includes('--allow-missing');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
const registry = process.env.GOODVIBES_PUBLISH_REGISTRY?.trim() || 'https://registry.npmjs.org';

const mainVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

const targets = only ? PLATFORM_PACKAGES.filter((p) => p.dir === only) : PLATFORM_PACKAGES;
if (only && targets.length === 0) {
  throw new Error(`unknown target '${only}'. Known: ${PLATFORM_PACKAGES.map((p) => p.dir).join(', ')}`);
}

let published = 0;
for (const pkg of targets) {
  const pkgDir = join(packagesRoot, pkg.dir);
  const app = join(pkgDir, 'bin', pkg.appArtifact);
  const daemon = join(pkgDir, 'bin', pkg.daemonArtifact);

  if (!existsSync(app) || !existsSync(daemon)) {
    if (allowMissing) {
      console.log(`skip ${pkg.name}: not assembled`);
      continue;
    }
    throw new Error(`${pkg.name} is not assembled (missing binaries in ${pkgDir}/bin) — run assemble-platform-packages first`);
  }

  const version = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string }).version;
  if (version !== mainVersion) {
    throw new Error(`${pkg.name} version ${version} does not match main package ${mainVersion} — re-run assembly`);
  }

  const npmArgs = dryRun
    ? ['pack']
    : ['publish', '--access', 'public', '--registry', registry];
  console.log(`${dryRun ? 'pack' : 'publish'} ${pkg.name}@${version} -> ${registry}`);
  execFileSync('npm', npmArgs, { cwd: pkgDir, stdio: 'inherit', env: process.env });
  published++;
}

console.log(`Done: ${published}/${targets.length} platform package(s) ${dryRun ? 'packed' : 'published'}.`);
