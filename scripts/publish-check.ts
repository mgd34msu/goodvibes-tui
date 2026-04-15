#!/usr/bin/env bun
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
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

const packRaw = execSync('npm pack --json --dry-run', {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

const [packResult] = JSON.parse(packRaw);
const filePaths = Array.isArray(packResult.files) ? packResult.files.map((entry) => entry.path) : [];
const forbiddenPrefixes = ['.github/', 'src/test/', 'src/.test/', '.goodvibes/memory/'];
const requireVendor = process.env.GOODVIBES_REQUIRE_VENDOR === '1';

for (const filePath of filePaths) {
  if (forbiddenPrefixes.some((prefix) => filePath.startsWith(prefix))) {
    throw new Error(`published tarball includes forbidden path: ${filePath}`);
  }
}

for (const requiredPath of ['README.md', 'CHANGELOG.md', 'src/main.ts', 'src/daemon/cli.ts', 'bin/goodvibes', 'bin/goodvibes-daemon', 'scripts/postinstall.js', '.goodvibes/GOODVIBES.md']) {
  if (!filePaths.includes(requiredPath)) {
    throw new Error(`published tarball is missing required path: ${requiredPath}`);
  }
}

if (requireVendor) {
  for (const vendorPath of [
    'vendor/goodvibes-linux-x64',
    'vendor/goodvibes-linux-arm64',
    'vendor/goodvibes-macos-x64',
    'vendor/goodvibes-macos-arm64',
    'vendor/goodvibes-daemon-linux-x64',
    'vendor/goodvibes-daemon-linux-arm64',
    'vendor/goodvibes-daemon-macos-x64',
    'vendor/goodvibes-daemon-macos-arm64',
    'vendor/SHA256SUMS.txt',
  ]) {
    if (!filePaths.includes(vendorPath)) {
      throw new Error(`published tarball is missing required vendored release artifact: ${vendorPath}`);
    }
  }
}

console.log(`publish check passed (${packResult.entryCount} files, ${packResult.unpackedSize} bytes unpacked)`);
