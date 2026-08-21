#!/usr/bin/env bun
/**
 * sync-platform-optional-deps.ts, release-time version-sync step.
 *
 * The main package.json declares the four platform binary packages as
 * optionalDependencies pinned to the exact current version, so the package
 * manager only ever resolves the matching just-published payload package. The
 * shared toolchain `release-cut` bumps the root `version` and each platform
 * manifest's `version`, but it does not know about the root
 * optionalDependencies map, that is TUI-specific. This script re-stamps those
 * entries to the (already-bumped) root version and runs as a `release-cut`
 * syncCommand (see toolchain.config.json → releaseCut.syncCommands).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM_PACKAGES } from './platform-packages.ts';

const root = process.cwd();
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
  version: string;
  optionalDependencies?: Record<string, string>;
};

const version = pkg.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`sync-platform-optional-deps: root version is not an exact semver: ${String(version)}`);
  process.exit(1);
}

if (pkg.optionalDependencies) {
  let changed = 0;
  for (const platformPkg of PLATFORM_PACKAGES) {
    if (platformPkg.name in pkg.optionalDependencies) {
      if (pkg.optionalDependencies[platformPkg.name] !== version) changed += 1;
      pkg.optionalDependencies[platformPkg.name] = version;
    }
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`sync-platform-optional-deps: stamped ${PLATFORM_PACKAGES.length} platform optionalDependencies to ${version} (${changed} changed)`);
} else {
  console.log('sync-platform-optional-deps: no optionalDependencies map; nothing to stamp');
}
