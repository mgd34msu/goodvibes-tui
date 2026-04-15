#!/usr/bin/env node
import { chmodSync, cpSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const home = homedir();

function resolveArtifactName(platform, arch) {
  if (platform === 'linux' && arch === 'x64') return 'goodvibes-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'goodvibes-linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'goodvibes-macos-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'goodvibes-macos-arm64';
  return null;
}

function resolveDaemonArtifactName(platform, arch) {
  if (platform === 'linux' && arch === 'x64') return 'goodvibes-daemon-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'goodvibes-daemon-linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'goodvibes-daemon-macos-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'goodvibes-daemon-macos-arm64';
  return null;
}

function prepareVendoredBinaries() {
  const vendorDir = join(projectRoot, 'vendor');
  let prepared = 0;
  for (const artifactName of [
    resolveArtifactName('linux', 'x64'),
    resolveArtifactName('linux', 'arm64'),
    resolveArtifactName('darwin', 'x64'),
    resolveArtifactName('darwin', 'arm64'),
    resolveDaemonArtifactName('linux', 'x64'),
    resolveDaemonArtifactName('linux', 'arm64'),
    resolveDaemonArtifactName('darwin', 'x64'),
    resolveDaemonArtifactName('darwin', 'arm64'),
  ]) {
    if (!artifactName) continue;
    const binaryPath = join(vendorDir, artifactName);
    if (!existsSync(binaryPath)) continue;
    if (process.platform !== 'win32') {
      chmodSync(binaryPath, 0o755);
    }
    prepared++;
  }
  if (prepared > 0) {
    console.log(`postinstall: prepared ${prepared} bundled binaries`);
  } else {
    console.log('postinstall: no bundled binaries found');
  }
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
  prepareVendoredBinaries();
  deployBundledFiles();
}

await main();
