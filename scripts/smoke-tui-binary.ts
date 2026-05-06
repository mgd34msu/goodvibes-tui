#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();

function resolveArtifactName(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'linux' && arch === 'x64') return 'goodvibes-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'goodvibes-linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'goodvibes-macos-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'goodvibes-macos-arm64';
  return null;
}

const artifactName = resolveArtifactName(process.platform, process.arch);
if (!artifactName) {
  console.log(`tui smoke: no native TUI artifact for ${process.platform}-${process.arch}; skipping`);
  process.exit(0);
}

const binaryPath = join(root, 'dist', artifactName);
if (!existsSync(binaryPath)) {
  throw new Error(`tui smoke: missing binary ${binaryPath}`);
}

const cwd = join(tmpdir(), `goodvibes-tui-smoke-${process.pid}`);
rmSync(cwd, { recursive: true, force: true });
mkdirSync(cwd, { recursive: true });
try {
  const result = spawnSync(binaryPath, ['--version'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`tui smoke: ${artifactName} --version failed with status ${result.status}`);
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (output.includes('sqlite-vec') || output.includes('$bunfs/root')) {
    console.error(output);
    throw new Error('tui smoke: compiled TUI emitted a sqlite-vec or $bunfs module-resolution error');
  }

  if (!result.stdout.trim().startsWith('goodvibes ')) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error('tui smoke: unexpected --version output');
  }

  console.log(`tui smoke: ${artifactName} ${result.stdout.trim()}`);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
