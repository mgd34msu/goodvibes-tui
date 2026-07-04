#!/usr/bin/env bun
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

for (const field of ['name', 'version', 'description', 'license', 'homepage']) {
  if (typeof pkg[field] !== 'string' || pkg[field].trim().length === 0) {
    throw new Error(`package.json missing required publish field: ${field}`);
  }
}

if (!pkg.repository || typeof pkg.repository.url !== 'string') {
  throw new Error('package.json missing repository metadata');
}

if (!pkg.bin || typeof pkg.bin.goodvibes !== 'string' || typeof pkg.bin['goodvibes-daemon'] !== 'string') {
  throw new Error('package.json must expose goodvibes and goodvibes-daemon bin entries');
}

// The local-SDK overlay (scripts/sdk-dev.ts link) and non-exact SDK pins are
// development-only states; both are publish-blocking.
if (existsSync(join(root, 'node_modules/@pellux/goodvibes-sdk/.local-sdk-overlay.json'))) {
  throw new Error('local SDK overlay is active — run `bun scripts/sdk-dev.ts restore` before publishing');
}
const sdkPin = (pkg.dependencies ?? {})['@pellux/goodvibes-sdk'];
if (typeof sdkPin !== 'string' || !/^\d+\.\d+\.\d+$/.test(sdkPin)) {
  throw new Error(`@pellux/goodvibes-sdk dependency must be an exact semver to publish (found: ${String(sdkPin)})`);
}

// The pin, the lockfile resolution, and the installed package must all agree —
// a pin bump whose lockfile never moved ships the OLD SDK silently (bun can
// serve a cached older resolution; caught live on the 0.37.2 bump).
{
  const installedPkgPath = join(root, 'node_modules/@pellux/goodvibes-sdk/package.json');
  const installed = existsSync(installedPkgPath)
    ? (JSON.parse(readFileSync(installedPkgPath, 'utf8')) as { version?: string }).version
    : undefined;
  if (installed !== sdkPin) {
    throw new Error(`installed @pellux/goodvibes-sdk (${String(installed)}) does not match the pin (${sdkPin}) — run bun update @pellux/goodvibes-sdk and commit the lockfile`);
  }
  const lock = readFileSync(join(root, 'bun.lock'), 'utf8');
  if (!lock.includes(`@pellux/goodvibes-sdk@${sdkPin}`)) {
    throw new Error(`bun.lock does not resolve @pellux/goodvibes-sdk@${sdkPin} — the lockfile lagged the pin bump`);
  }
}

// No TUI source may import the SDK by anything but the npm specifier —
// local-path imports (relative, absolute, file:) must never ship.
// scripts/sdk-dev.ts is the sole sanctioned local-path holder (the dev tool).
{
  const offenders: string[] = [];
  const importOfSdk = /(?:from\s+|require\(|import\()\s*['"]([^'"]*goodvibes-sdk[^'"]*)['"]/g;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.ts')) {
        const text = readFileSync(join(root, rel), 'utf8');
        for (const m of text.matchAll(importOfSdk)) {
          if (!m[1].startsWith('@pellux/goodvibes-sdk')) offenders.push(`${rel}: ${m[1]}`);
        }
      }
    }
  };
  walk('src');
  if (offenders.length > 0) {
    throw new Error(`non-npm goodvibes-sdk imports found in source:\n${offenders.join('\n')}`);
  }
}

for (const binTarget of [pkg.bin.goodvibes, pkg.bin['goodvibes-daemon']]) {
  const binPath = join(root, binTarget);
  if (!existsSync(binPath)) {
    throw new Error(`missing publish bin target: ${binTarget}`);
  }

  const binMode = statSync(binPath).mode;
  if ((binMode & 0o111) === 0) {
    throw new Error(`publish bin is not executable: ${binTarget}`);
  }
}

const registry = process.env.GOODVIBES_PUBLISH_REGISTRY?.trim() || 'https://registry.npmjs.org';
const skipAuthCheck = process.env.GOODVIBES_SKIP_NPM_AUTH_CHECK === '1';

// Registry auth probe — verifies the npm token is valid for the target registry
// before binaries and the GitHub release are produced. Skippable via
// GOODVIBES_SKIP_NPM_AUTH_CHECK=1 for offline / dry-run contexts.
// GitHub Packages whoami is unreliable; that job uses post-publish npm view instead.
const isGitHubPackages = registry.includes('npm.pkg.github.com');
if (!skipAuthCheck && !isGitHubPackages) {
  try {
    execSync(`npm whoami --registry ${registry}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch {
    throw new Error(
      `npm token invalid for ${registry} — refresh NPM_TOKEN / npm login\n` +
        '  (set GOODVIBES_SKIP_NPM_AUTH_CHECK=1 to bypass in offline/dry-run contexts)',
    );
  }
}

const packRaw = execSync('npm pack --json --dry-run', {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

const [packResult] = JSON.parse(packRaw);
const filePaths = Array.isArray(packResult.files) ? packResult.files.map((entry) => entry.path) : [];
const forbiddenPrefixes = ['.github/', 'src/test/', 'src/.test/', '.goodvibes/memory/'];
for (const filePath of filePaths) {
  if (forbiddenPrefixes.some((prefix) => filePath.startsWith(prefix))) {
    throw new Error(`published tarball includes forbidden path: ${filePath}`);
  }
  if (filePath.startsWith('vendor/')) {
    throw new Error(`published tarball should not include vendored release binaries: ${filePath}`);
  }
}

for (const requiredPath of ['README.md', 'CHANGELOG.md', 'src/main.ts', 'src/daemon/cli.ts', 'bin/goodvibes', 'bin/goodvibes-daemon', 'scripts/check-bun.sh', 'scripts/postinstall.js', '.goodvibes/GOODVIBES.md']) {
  if (!filePaths.includes(requiredPath)) {
    throw new Error(`published tarball is missing required path: ${requiredPath}`);
  }
}

if (typeof packResult.size === 'number' && packResult.size > 50 * 1024 * 1024) {
  throw new Error(`published tarball is too large: ${packResult.size} bytes`);
}

console.log(`publish check passed (${packResult.entryCount} files, ${packResult.unpackedSize} bytes unpacked)`);
