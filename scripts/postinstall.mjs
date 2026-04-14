#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const home = homedir();
const skipDownload = process.argv.includes('--no-download') || process.env.GOODVIBES_SKIP_BINARY_DOWNLOAD === '1';
const isSourceCheckout = existsSync(join(projectRoot, '.git'));

function resolveArtifactName(platform, arch) {
  if (platform === 'linux' && arch === 'x64') return 'goodvibes-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'goodvibes-linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'goodvibes-macos-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'goodvibes-macos-arm64';
  return null;
}

function shouldSkipBinaryDownload() {
  return skipDownload || isSourceCheckout;
}

function getPackageVersion() {
  return JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version;
}

function getReleaseBaseUrl(version) {
  const override = process.env.GOODVIBES_BINARY_BASE_URL;
  if (override) {
    return override.replace(/\/+$/, '');
  }
  return `https://github.com/mgd34msu/goodvibes-tui/releases/download/v${version}`;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fetchWithRetry(url, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = new Error(`failed to download ${url} (${response.status})`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function downloadBinary() {
  if (shouldSkipBinaryDownload()) {
    console.log(
      isSourceCheckout
        ? 'postinstall: skipping binary download inside source checkout'
        : 'postinstall: skipping binary download (GOODVIBES_SKIP_BINARY_DOWNLOAD=1)',
    );
    return;
  }

  const artifactName = resolveArtifactName(process.platform, process.arch);
  if (!artifactName) {
    console.log(`postinstall: no prebuilt binary for ${process.platform}-${process.arch}; supported npm binary targets are linux and macOS (WSL uses linux)`);
    return;
  }

  const version = getPackageVersion();
  const baseUrl = getReleaseBaseUrl(version);
  const vendorDir = join(projectRoot, 'vendor');
  const binaryPath = join(vendorDir, artifactName);
  const checksumsPath = join(vendorDir, 'SHA256SUMS.txt');

  mkdirSync(vendorDir, { recursive: true });

  const binaryUrl = `${baseUrl}/${artifactName}`;
  const checksumsUrl = `${baseUrl}/SHA256SUMS.txt`;

  const [binaryResponse, checksumsResponse] = await Promise.all([
    fetchWithRetry(binaryUrl),
    fetchWithRetry(checksumsUrl),
  ]);

  const [binaryBuffer, checksumsText] = await Promise.all([
    binaryResponse.arrayBuffer(),
    checksumsResponse.text(),
  ]);

  const checksums = Object.fromEntries(
    checksumsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sum, file] = line.split(/\s+/, 2);
        return [file, sum];
      }),
  );

  const expected = checksums[artifactName];
  if (!expected) {
    throw new Error(`SHA256SUMS.txt does not include ${artifactName}`);
  }

  const buffer = Buffer.from(binaryBuffer);
  const actual = sha256(buffer);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${artifactName}`);
  }

  writeFileSync(binaryPath, buffer);
  writeFileSync(checksumsPath, checksumsText);
  if (process.platform !== 'win32') {
    chmodSync(binaryPath, 0o755);
  }
  console.log(`postinstall: downloaded ${artifactName}`);
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
    console.log('  installed: ~/.goodvibes/GOODVIBES.md');
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
  try {
    await downloadBinary();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`postinstall: binary download skipped: ${message}`);
    const artifactName = resolveArtifactName(process.platform, process.arch);
    if (artifactName) {
      const binaryPath = join(projectRoot, 'vendor', artifactName);
      if (existsSync(binaryPath)) {
        try {
          unlinkSync(binaryPath);
        } catch {}
      }
    }
  }

  deployBundledFiles();
}

await main();
