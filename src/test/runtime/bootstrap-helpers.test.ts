import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { loadBootstrapSystemPrompt } from '../../runtime/bootstrap-helpers.ts';

function makeTempDir(): string {
  const path = join(tmpdir(), `gv-bootstrap-helpers-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path, { recursive: true });
  return path;
}

describe('loadBootstrapSystemPrompt', () => {
  let root: string;
  let homeDirectory: string;
  let workingDirectory: string;

  beforeEach(() => {
    root = makeTempDir();
    homeDirectory = join(root, 'home');
    workingDirectory = join(root, 'workspace');
    mkdirSync(homeDirectory, { recursive: true });
    mkdirSync(workingDirectory, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('resolves provider.systemPromptFile relative to the explicit working directory', () => {
    const configManager = new ConfigManager({ surfaceRoot: 'tui',  homeDir: homeDirectory, workingDir: workingDirectory });
    const relativePromptPath = join('prompts', 'runtime.md');
    const promptPath = join(workingDirectory, relativePromptPath);

    mkdirSync(join(workingDirectory, 'prompts'), { recursive: true });
    writeFileSync(promptPath, 'relative-config-prompt', 'utf8');
    configManager.set('provider.systemPromptFile', relativePromptPath);

    expect(loadBootstrapSystemPrompt(configManager)).toBe('relative-config-prompt');
  });

  test('rejects config managers that do not own both working and home directories', () => {
    const configDir = join(root, '.goodvibes', 'tui');
    mkdirSync(configDir, { recursive: true });
    const configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir });

    expect(() => loadBootstrapSystemPrompt(configManager)).toThrow(
      'loadBootstrapSystemPrompt requires ConfigManager with explicit workingDirectory.',
    );
  });
});
