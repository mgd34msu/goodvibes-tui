import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { parseGoodVibesCli } from '@pellux/goodvibes-terminal-shell';
import { handleHooksCommand } from '../../cli/hooks-command.ts';
import { handlePluginCommand } from '../../cli/plugin-command.ts';
import type { CliCommandRuntime } from '@pellux/goodvibes-terminal-shell';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeRuntime(root: string, args: readonly string[]): CliCommandRuntime {
  const configManager = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
  return {
    cli: parseGoodVibesCli(args, 'goodvibes'),
    configManager,
    workingDirectory: root,
    homeDirectory: root,
  };
}

describe('goodvibes hooks validate', () => {
  let root = '';
  beforeEach(() => { root = makeProjectTempDir('goodvibes-hooks'); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('passes with exit 0 for a valid hooks.json', async () => {
    writeFileSync(join(root, 'hooks.json'), JSON.stringify({
      hooks: { 'Pre:tool:*': [{ name: 'guard', match: 'Pre:tool:*', type: 'command', command: 'echo hi' }] },
    }), 'utf-8');
    const result = await handleHooksCommand(makeRuntime(root, ['hooks', 'validate']));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('PASS');
    expect(result.output).toContain('Pre:tool:*');
  });

  test('fails with nonzero exit and names the unrecognized hook event point', async () => {
    writeFileSync(join(root, 'hooks.json'), JSON.stringify({
      hooks: { 'Pre:bogus:thing': [{ name: 'bad', match: 'Pre:bogus:thing', type: 'command', command: 'echo x' }] },
    }), 'utf-8');
    const result = await handleHooksCommand(makeRuntime(root, ['hooks', 'validate']));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('FAIL');
    expect(result.output).toContain('Pre:bogus:thing');
    expect(result.output).toContain('not a recognized hook event point');
  });

  test('fails when the loader rejects a hook with an invalid type', async () => {
    writeFileSync(join(root, 'hooks.json'), JSON.stringify({
      hooks: { 'Pre:tool:*': [{ name: 'weird', match: 'Pre:tool:*', type: 'banana' }] },
    }), 'utf-8');
    const result = await handleHooksCommand(makeRuntime(root, ['hooks', 'validate']));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('FAIL');
  });

  test('reports invalid JSON with a nonzero exit', async () => {
    writeFileSync(join(root, 'hooks.json'), '{ not json', 'utf-8');
    const result = await handleHooksCommand(makeRuntime(root, ['hooks', 'validate']));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('not valid JSON');
  });

  test('passes with exit 0 when no hooks file exists', async () => {
    const result = await handleHooksCommand(makeRuntime(root, ['hooks', 'validate']));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('nothing to validate');
  });
});

describe('goodvibes plugin init / validate', () => {
  let root = '';
  beforeEach(() => { root = makeProjectTempDir('goodvibes-plugin'); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('init scaffolds a plugin that its own validate accepts (round-trip)', async () => {
    const initResult = await handlePluginCommand(makeRuntime(root, ['plugin', 'init', 'demo-plugin']));
    expect(initResult.exitCode).toBe(0);
    const pluginDir = join(root, '.goodvibes', 'plugins', 'demo-plugin');
    expect(existsSync(join(pluginDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(pluginDir, 'index.js'))).toBe(true);
    expect(initResult.output).toContain('PASS');

    const validateResult = await handlePluginCommand(makeRuntime(root, ['plugin', 'validate', pluginDir]));
    expect(validateResult.exitCode).toBe(0);
    expect(validateResult.output).toContain('PASS');
    expect(validateResult.output).toContain('demo-plugin');
  });

  test('validate fails and names the missing field for a manifest missing name/version', async () => {
    const pluginDir = join(root, 'plugins', 'broken');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({ description: 'no name or version' }), 'utf-8');
    const result = await handlePluginCommand(makeRuntime(root, ['plugin', 'validate', pluginDir]));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('FAIL');
    expect(result.output.toLowerCase()).toContain('name');
  });

  test('validate fails when the manifest.json is missing entirely', async () => {
    const pluginDir = join(root, 'plugins', 'empty');
    mkdirSync(pluginDir, { recursive: true });
    const result = await handlePluginCommand(makeRuntime(root, ['plugin', 'validate', pluginDir]));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('manifest.json not found');
  });

  test('validate fails for a nonexistent directory', async () => {
    const result = await handlePluginCommand(makeRuntime(root, ['plugin', 'validate', join(root, 'nope')]));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('directory not found');
  });

  test('init writes a valid manifest with a relative main and a non-version-pinned scaffold', async () => {
    await handlePluginCommand(makeRuntime(root, ['plugin', 'init', 'shape-check']));
    const manifest = JSON.parse(readFileSync(join(root, '.goodvibes', 'plugins', 'shape-check', 'manifest.json'), 'utf-8'));
    expect(typeof manifest.name).toBe('string');
    expect(typeof manifest.version).toBe('string');
    expect(manifest.main).toBe('index.js');
  });
});
