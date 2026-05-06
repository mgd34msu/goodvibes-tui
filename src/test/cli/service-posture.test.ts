import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import {
  buildCliServicePosture,
  getServiceStateRoot,
  resolveGoodVibesDaemonExecutable,
} from '../../cli/service-posture.ts';

function makeExecutable(path: string): void {
  writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf-8');
  chmodSync(path, 0o755);
}

describe('CLI service posture', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'goodvibes-service-posture-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('resolves the daemon executable from package artifacts before PATH or source fallbacks', () => {
    const packageRoot = join(root, 'package');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(join(packageRoot, 'bin'), { recursive: true });
    const artifact = join(packageRoot, 'dist', 'goodvibes-daemon-linux-x64');
    const wrapper = join(packageRoot, 'bin', 'goodvibes-daemon');
    makeExecutable(artifact);
    makeExecutable(wrapper);

    const resolved = resolveGoodVibesDaemonExecutable({
      packageRoot,
      env: { PATH: '' } as NodeJS.ProcessEnv,
      argv: [],
      execPath: join(root, 'missing-goodvibes'),
    });

    expect(resolved).toEqual({
      command: artifact,
      source: 'package',
      absolute: true,
    });
  });

  test('resolves a global PATH daemon wrapper as an absolute command when package artifacts are unavailable', () => {
    const binDir = join(root, 'global-bin');
    mkdirSync(binDir, { recursive: true });
    const daemon = join(binDir, 'goodvibes-daemon');
    makeExecutable(daemon);

    const resolved = resolveGoodVibesDaemonExecutable({
      packageRoot: join(root, 'empty-package'),
      env: { PATH: binDir } as NodeJS.ProcessEnv,
      argv: [],
      execPath: join(root, 'missing-goodvibes'),
    });

    expect(resolved).toEqual({
      command: daemon,
      source: 'path',
      absolute: true,
    });
  });

  test('prefers the vendored daemon binary behind a global npm bin wrapper', () => {
    const packageRoot = join(root, 'global-package');
    const binDir = join(packageRoot, 'bin');
    const vendorDir = join(packageRoot, 'vendor');
    const pathDir = join(root, 'global-bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(vendorDir, { recursive: true });
    mkdirSync(pathDir, { recursive: true });
    const wrapper = join(binDir, 'goodvibes-daemon');
    const artifact = join(vendorDir, 'goodvibes-daemon-linux-x64');
    const globalWrapper = join(pathDir, 'goodvibes-daemon');
    makeExecutable(wrapper);
    makeExecutable(artifact);
    symlinkSync(wrapper, globalWrapper);

    const resolved = resolveGoodVibesDaemonExecutable({
      packageRoot: join(root, 'empty-package'),
      env: { PATH: pathDir } as NodeJS.ProcessEnv,
      argv: [],
      execPath: join(root, 'missing-goodvibes'),
    });

    expect(resolved).toEqual({
      command: artifact,
      source: 'path',
      absolute: true,
    });
  });

  test('service posture uses daemon-global state paths and does not synthesize project-local source commands', async () => {
    const projectRoot = join(root, 'project');
    const homeRoot = join(root, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });
    const config = new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: projectRoot,
      homeDir: homeRoot,
    });
    config.setDynamic('service.enabled', true);
    config.setDynamic('service.autostart', true);
    config.setDynamic('service.restartOnFailure', true);
    config.setDynamic('service.platform', 'manual');

    const posture = await buildCliServicePosture({
      configManager: config,
      workingDirectory: projectRoot,
      homeDirectory: homeRoot,
    });

    expect(getServiceStateRoot({ configManager: config, workingDirectory: projectRoot, homeDirectory: homeRoot }))
      .toBe(join(homeRoot, '.goodvibes', 'daemon'));
    expect(posture.managed.path).toBe(join(homeRoot, '.goodvibes', 'daemon', 'service', 'manual-service.txt'));
    expect(posture.managed.pidPath).toBe(join(homeRoot, '.goodvibes', 'daemon', 'service', 'manual.pid'));
    expect(posture.managed.commandPreview).not.toContain(join(projectRoot, 'src', 'daemon', 'cli.ts'));
    expect(posture.managed.commandPreview).not.toContain('src/daemon/cli.ts');
  });
});
