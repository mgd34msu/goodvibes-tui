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
      // When the payload package is rescoped for a mirror registry (GitHub
      // Packages requires every package to live under the repo owner's scope),
      // the per-platform optionalDependencies must be rescoped in lockstep so
      // the mirrored main package resolves the mirrored platform packages
      // instead of the npm-only @pellux ones. The npm publish path never sets
      // an override, so its @pellux optionalDependencies are left untouched.
      const overrideScope = packageNameOverride.includes('/')
        ? packageNameOverride.slice(0, packageNameOverride.indexOf('/'))
        : '';
      if (overrideScope && pkg.optionalDependencies && typeof pkg.optionalDependencies === 'object') {
        const rescoped: Record<string, string> = {};
        for (const [depName, depVersion] of Object.entries(pkg.optionalDependencies as Record<string, string>)) {
          const match = /^@[^/]+\/(goodvibes-tui-.+)$/.exec(depName);
          rescoped[match ? `${overrideScope}/${match[1]}` : depName] = depVersion;
        }
        pkg.optionalDependencies = rescoped;
      }
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    }

    const args = dryRun
      ? ['pack', '--json']
      : ['publish', '--access', 'public', '--registry', registry];

    // Run npm with output piped so we can surface it on failure.
    // For interactive dry-run (pack --json) we still need the JSON on stdout, so
    // use pipe for both stdout and stderr in all cases.
    let npmStdout = '';
    let npmStderr = '';
    try {
      const result = execFileSync('npm', args, {
        cwd: stageDir,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: process.env,
        encoding: 'utf8',
      });
      npmStdout = result;
      if (npmStdout) process.stdout.write(npmStdout);
    } catch (err: unknown) {
      // execFileSync throws a ChildProcessError when the child exits non-zero.
      // Recover captured output from the error object before re-throwing.
      if (
        err !== null &&
        typeof err === 'object' &&
        'stdout' in err &&
        'stderr' in err
      ) {
        const captured = err as { stdout: string | Buffer | null; stderr: string | Buffer | null; status?: number | null; message?: string };
        npmStdout = typeof captured.stdout === 'string' ? captured.stdout : (captured.stdout?.toString() ?? '');
        npmStderr = typeof captured.stderr === 'string' ? captured.stderr : (captured.stderr?.toString() ?? '');
      }
      process.stderr.write('\n--- npm output (stdout) ---\n');
      process.stderr.write(npmStdout || '(empty)\n');
      process.stderr.write('\n--- npm output (stderr) ---\n');
      process.stderr.write(npmStderr || '(empty)\n');
      process.stderr.write('\n--- end npm output ---\n');
      throw err;
    }
  });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
