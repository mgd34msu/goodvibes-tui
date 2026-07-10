#!/usr/bin/env bun
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKSUM_MANIFEST_NAME, parseChecksumFile, resolveArtifactNames, sha256, verifyChecksum } from '../src/runtime/release-artifacts.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const home = homedir();
const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const noDownload = process.argv.includes('--no-download') || process.env.GOODVIBES_SKIP_BINARY_DOWNLOAD === '1';

function isSourceCheckout() {
  return existsSync(join(projectRoot, '.git')) || existsSync(join(projectRoot, 'bun.lock'));
}

function prepareBinary(path) {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o755);
  }
}

function resolveRepositoryBaseUrl() {
  const repositoryUrl = typeof pkg.repository?.url === 'string' ? pkg.repository.url : '';
  const normalized = repositoryUrl
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  if (!normalized.startsWith('https://github.com/')) {
    throw new Error(`unsupported repository URL for binary downloads: ${repositoryUrl || '(missing)'}`);
  }
  return normalized;
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function downloadText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return await response.text();
}

async function installPlatformBinaries() {
  const artifacts = resolveArtifactNames(process.platform, process.arch);
  if (!artifacts) {
    console.log(`postinstall: no prebuilt binaries for ${process.platform}-${process.arch}; skipping binary install`);
    return;
  }

  if (noDownload) {
    console.log('postinstall: skipping binary install (--no-download)');
    return;
  }

  if (isSourceCheckout()) {
    console.log('postinstall: source checkout detected; skipping release-binary install');
    return;
  }

  const vendorDir = join(projectRoot, 'vendor');
  mkdirSync(vendorDir, { recursive: true });

  const localSourceDir = process.env.GOODVIBES_ASSET_SOURCE_DIR?.trim();
  if (localSourceDir) {
    for (const artifactName of [artifacts.app, artifacts.daemon]) {
      const sourcePath = join(localSourceDir, artifactName);
      if (!existsSync(sourcePath)) {
        throw new Error(`missing local release artifact for postinstall smoke: ${sourcePath}`);
      }
      const destination = join(vendorDir, artifactName);
      copyFileSync(sourcePath, destination);
      prepareBinary(destination);
    }
    console.log(`postinstall: installed local smoke-test binaries for ${process.platform}-${process.arch}`);
    return;
  }

  const releaseBaseUrl =
    process.env.GOODVIBES_RELEASE_BASE_URL?.trim() ||
    `${resolveRepositoryBaseUrl()}/releases/download/v${pkg.version}`;

  const checksumUrl = `${releaseBaseUrl}/SHA256SUMS.txt`;
  const checksumText = await downloadText(checksumUrl);
  writeFileSync(join(vendorDir, 'SHA256SUMS.txt'), checksumText);
  const checksums = parseChecksumFile(checksumText);

  for (const artifactName of [artifacts.app, artifacts.daemon]) {
    const destination = join(vendorDir, artifactName);
    const tempDestination = `${destination}.download`;
    rmSync(tempDestination, { force: true });
    await downloadFile(`${releaseBaseUrl}/${artifactName}`, tempDestination);
    const actual = sha256(readFileSync(tempDestination));
    const expected = checksums.get(artifactName);
    try {
      verifyChecksum(artifactName, actual, expected);
    } catch (error) {
      rmSync(tempDestination, { force: true });
      throw error;
    }
    rmSync(destination, { force: true });
    copyFileSync(tempDestination, destination);
    rmSync(tempDestination, { force: true });
    prepareBinary(destination);
  }

  console.log(`postinstall: installed release binaries for ${process.platform}-${process.arch}`);
}

function deployBundledFiles() {
  const targets = [
    { src: join(projectRoot, '.goodvibes', 'skills'), dest: join(home, '.goodvibes', 'tui', 'skills') },
    { src: join(projectRoot, '.goodvibes', 'agents'), dest: join(home, '.goodvibes', 'tui', 'agents') },
  ];

  let installed = 0;
  let skipped = 0;

  for (const { src, dest } of targets) {
    if (!existsSync(src)) continue;

    const entries = readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (existsSync(destPath)) {
        skipped++;
        continue;
      }

      mkdirSync(dest, { recursive: true });

      if (entry.isDirectory()) {
        cpSync(srcPath, destPath, { recursive: true });
        console.log(`  installed: ${entry.name}/`);
        installed++;
      } else if (entry.name.endsWith('.md')) {
        cpSync(srcPath, destPath);
        console.log(`  installed: ${entry.name}`);
        installed++;
      }
    }
  }

  const goodvibesSrc = join(projectRoot, '.goodvibes', 'GOODVIBES.md');
  const goodvibesDest = join(home, '.goodvibes', 'GOODVIBES.md');
  if (existsSync(goodvibesSrc) && !existsSync(goodvibesDest)) {
    mkdirSync(join(home, '.goodvibes'), { recursive: true });
    copyFileSync(goodvibesSrc, goodvibesDest);
    console.log(`  installed: ${basename(goodvibesDest)}`);
    installed++;
  } else if (existsSync(goodvibesDest)) {
    skipped++;
  }

  if (installed > 0 || skipped > 0) {
    console.log(`postinstall: ${installed} installed, ${skipped} already exist (skipped)`);
  } else {
    console.log('postinstall: nothing to deploy');
  }
}

async function main() {
  await installPlatformBinaries();
  deployBundledFiles();
}

// Guarded so this module can be imported by tests (to exercise
// verifyChecksum, parseChecksumFile, etc.) without triggering a real
// network install as a side effect of the import.
if (import.meta.main) {
  await main();
}

export { verifyChecksum, parseChecksumFile, sha256, resolveArtifactNames, CHECKSUM_MANIFEST_NAME };
