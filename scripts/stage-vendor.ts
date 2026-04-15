#!/usr/bin/env bun
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const root = process.cwd();
const sourceDir = resolve(root, process.env.GOODVIBES_VENDOR_SOURCE_DIR || 'dist');
const vendorDir = resolve(root, process.env.GOODVIBES_VENDOR_DEST_DIR || 'vendor');
const clean = process.argv.includes('--clean');

const requiredArtifacts = [
  'goodvibes-linux-x64',
  'goodvibes-linux-arm64',
  'goodvibes-macos-x64',
  'goodvibes-macos-arm64',
  'goodvibes-daemon-linux-x64',
  'goodvibes-daemon-linux-arm64',
  'goodvibes-daemon-macos-x64',
  'goodvibes-daemon-macos-arm64',
] as const;

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

if (!existsSync(sourceDir)) {
  throw new Error(`vendor source directory does not exist: ${sourceDir}`);
}

mkdirSync(vendorDir, { recursive: true });

if (clean) {
  for (const entry of readdirSync(vendorDir)) {
    rmSync(join(vendorDir, entry), { force: true, recursive: true });
  }
}

const checksumLines: string[] = [];

for (const artifact of requiredArtifacts) {
  const src = join(sourceDir, artifact);
  const dest = join(vendorDir, artifact);
  if (!existsSync(src)) {
    throw new Error(`missing release artifact: ${src}`);
  }
  copyFileSync(src, dest);
  const buffer = Bun.file(dest);
  const bytes = Buffer.from(await buffer.arrayBuffer());
  checksumLines.push(`${sha256(bytes)}  ${artifact}`);
  const mode = statSync(dest).mode;
  if ((mode & 0o111) === 0) {
    chmodSync(dest, 0o755);
  }
}

writeFileSync(join(vendorDir, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`);
console.log(`staged vendor binaries from ${sourceDir} -> ${vendorDir}`);
