#!/usr/bin/env bun
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncProjectSurfaces } from './project-surfaces.ts';
import { withWorkspaceLock } from './workspace-lock.ts';

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const registry = process.env.GOODVIBES_PUBLISH_REGISTRY?.trim() || 'https://registry.npmjs.org';
const packageNameOverride = process.env.GOODVIBES_PUBLIC_PACKAGE_NAME?.trim() || '';

const tempBase = join(root, '.test-tmp');
mkdirSync(tempBase, { recursive: true });
const tempRoot = mkdtempSync(join(tempBase, 'publish-'));
const stageDir = join(tempRoot, 'package');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stagedEntries = new Set<string>([
  'package.json',
  'README.md',
  'CHANGELOG.md',
  ...((pkg.files as string[]).filter((entry) => typeof entry === 'string' && !entry.startsWith('!'))),
]);

function shouldExclude(relativePath: string) {
  return (
    relativePath === 'src/test' ||
    relativePath.startsWith('src/test/') ||
    relativePath === 'src/.test' ||
    relativePath.startsWith('src/.test/') ||
    relativePath.endsWith('.test.ts')
  );
}

function copyEntry(relativePath: string) {
  const source = join(root, relativePath);
  if (!existsSync(source)) {
    return;
  }

  const destination = join(stageDir, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (src) => {
      const normalized = src.startsWith(root) ? src.slice(root.length).replace(/^\/+/, '') : src;
      if (!normalized) return true;
      return !shouldExclude(normalized);
    },
  });
}

try {
  withWorkspaceLock('stage publish package', () => {
    syncProjectSurfaces(root);

    mkdirSync(stageDir, { recursive: true });

    for (const entry of stagedEntries) {
      copyEntry(entry);
    }

    if (packageNameOverride) {
      const pkgPath = join(stageDir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      pkg.name = packageNameOverride;
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    }

    const args = dryRun
      ? ['pack', '--json']
      : ['publish', '--access', 'public', '--registry', registry];

    execFileSync('npm', args, {
      cwd: stageDir,
      stdio: 'inherit',
      env: process.env,
    });
  });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
