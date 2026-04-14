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

if (!pkg.bin || typeof pkg.bin.goodvibes !== 'string') {
  throw new Error('package.json must expose a goodvibes bin entry');
}

const binPath = join(root, pkg.bin.goodvibes);
if (!existsSync(binPath)) {
  throw new Error(`missing publish bin target: ${pkg.bin.goodvibes}`);
}

const binMode = statSync(binPath).mode;
if ((binMode & 0o111) === 0) {
  throw new Error(`publish bin is not executable: ${pkg.bin.goodvibes}`);
}

const packRaw = execSync('npm pack --json --dry-run', {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

const [packResult] = JSON.parse(packRaw);
const filePaths = Array.isArray(packResult.files) ? packResult.files.map((entry) => entry.path) : [];
const forbiddenPrefixes = ['.github/', 'src/test/', 'src/.test/', '.goodvibes/memory/', 'vendor/'];

for (const filePath of filePaths) {
  if (forbiddenPrefixes.some((prefix) => filePath.startsWith(prefix))) {
    throw new Error(`published tarball includes forbidden path: ${filePath}`);
  }
}

for (const requiredPath of ['README.md', 'CHANGELOG.md', 'src/main.ts', 'bin/goodvibes', 'scripts/postinstall.mjs', '.goodvibes/GOODVIBES.md']) {
  if (!filePaths.includes(requiredPath)) {
    throw new Error(`published tarball is missing required path: ${requiredPath}`);
  }
}

console.log(`publish check passed (${packResult.entryCount} files, ${packResult.unpackedSize} bytes unpacked)`);
