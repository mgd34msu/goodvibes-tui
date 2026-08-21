#!/usr/bin/env bun
/**
 * Publish the assembled @pellux/goodvibes-tui-<os>-<arch> platform packages.
 *
 * Run after scripts/assemble-platform-packages.ts has populated each package's
 * bin/ from the release binaries. Publishes to GOODVIBES_PUBLISH_REGISTRY
 * (default: npm). A package whose bin/ was not assembled is a hard error unless
 * --allow-missing is passed.
 *
 * Idempotent: before publishing, checks whether name@version already exists on
 * the target registry and skips (does not error) if so. A re-dispatched
 * release run, the tag-redo path, or a retry after a later job in the same
 * run failed, must be able to re-run this step without an npm E403 /
 * GitHub Packages E409 "cannot publish over existing version" failure.
 *
 * Usage:
 *   bun run scripts/publish-platform-packages.ts            # publish all
 *   bun run scripts/publish-platform-packages.ts --dry-run  # npm pack instead
 *   bun run scripts/publish-platform-packages.ts --only linux-x64
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
// Optional scope override for mirror registries (e.g. GitHub Packages requires
// every package under the repo owner's scope). When set (e.g. "@mgd34msu"), each
// platform package's @pellux scope is rewritten to the override before publish so
// the mirrored set matches the mirrored main package's rescoped optionalDependencies.
// Unset on the npm path, which publishes the packages under their @pellux names.
const scopeOverride = process.env.GOODVIBES_PUBLIC_PACKAGE_SCOPE?.trim().replace(/\/+$/, '') || '';

/** Rewrite a @scope/goodvibes-tui-<os>-<arch> name onto the override scope. */
function rescopeName(name: string): string {
  if (!scopeOverride) return name;
  const match = /^@[^/]+\/(goodvibes-tui-.+)$/.exec(name);
  return match ? `${scopeOverride}/${match[1]}` : name;
}

/**
 * True if name@version already exists on the target registry. `npm view`
 * exits non-zero (unpublished name, unpublished version, or a registry that
 * 404s the lookup) when it does not, which we treat the same as "not
 * published yet", the subsequent `npm publish` remains the source of truth
 * for any real failure.
 */
function alreadyPublished(name: string, version: string): boolean {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version', '--registry', registry], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return out === version;
  } catch {
    return false;
  }
}

const mainVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

const targets = only ? PLATFORM_PACKAGES.filter((p) => p.dir === only) : PLATFORM_PACKAGES;
if (only && targets.length === 0) {
  throw new Error(`unknown target '${only}'. Known: ${PLATFORM_PACKAGES.map((p) => p.dir).join(', ')}`);
}

let published = 0;
for (const pkg of targets) {
  const pkgDir = join(packagesRoot, pkg.dir);
  const app = join(pkgDir, 'bin', pkg.appArtifact);

  if (!existsSync(app)) {
    if (allowMissing) {
      console.log(`skip ${pkg.name}: not assembled`);
      continue;
    }
    throw new Error(`${pkg.name} is not assembled (missing binary in ${pkgDir}/bin); run assemble-platform-packages first`);
  }

  const pkgJsonPath = join(pkgDir, 'package.json');
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version: string; name: string };
  const version = pkgJson.version;
  if (version !== mainVersion) {
    throw new Error(`${pkg.name} version ${version} does not match main package ${mainVersion}; re-run assembly`);
  }

  // Apply the mirror scope override in place before publishing. On the npm path
  // scopeOverride is empty and the name is left as its @pellux original.
  const publishName = rescopeName(pkg.name);
  if (publishName !== pkgJson.name) {
    pkgJson.name = publishName;
    writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
  }

  if (!dryRun && alreadyPublished(publishName, version)) {
    console.log(`skip ${publishName}@${version}: already published to ${registry}`);
    continue;
  }

  const npmArgs = dryRun
    ? ['pack']
    : ['publish', '--access', 'public', '--registry', registry];
  console.log(`${dryRun ? 'pack' : 'publish'} ${publishName}@${version} -> ${registry}`);
  execFileSync('npm', npmArgs, { cwd: pkgDir, stdio: 'inherit', env: process.env });
  published++;
}

console.log(`Done: ${published}/${targets.length} platform package(s) ${dryRun ? 'packed' : 'published'}.`);
