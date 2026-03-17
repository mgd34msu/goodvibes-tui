import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '../../config/manager.ts';
import { DEFAULT_CONFIG } from '../../config/schema.ts';

// Helper to create an isolated temporary directory for each test suite.
function makeTempDir(): string {
  const dir = join('/tmp', `gv-config-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('ConfigManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    // Point ConfigManager to this directory for both global and project config.
    ConfigManager.setTestMode(tempDir);
  });

  afterEach(() => {
    // Cleanup and reset test mode.
    rmSync(tempDir, { recursive: true, force: true });
    ConfigManager.setTestMode(undefined);
  });

  test('loads defaults when no config files exist', () => {
    const cm = new ConfigManager();
    const all = cm.getAll();
    // Compare shallowly – deep equality is fine for our purposes.
    expect(all).toEqual(DEFAULT_CONFIG);
  });

  test('set and get a simple key', () => {
    const cm = new ConfigManager();
    cm.set('provider.model', 'gpt-4');
    expect(cm.get('provider.model')).toBe('gpt-4');
    // Persisted to disk – create a new instance and verify value persists.
    const cm2 = new ConfigManager();
    expect(cm2.get('provider.model')).toBe('gpt-4');
  });

  test('reset a key restores default value', () => {
    const cm = new ConfigManager();
    cm.set('behavior.autoApprove', true);
    expect(cm.get('behavior.autoApprove')).toBe(true);
    cm.reset('behavior.autoApprove');
    expect(cm.get('behavior.autoApprove')).toBe(DEFAULT_CONFIG.behavior.autoApprove);
  });

  test('reset all keys restores defaults', () => {
    const cm = new ConfigManager();
    cm.set('provider.provider', 'anthropic');
    cm.set('behavior.autoApprove', true);
    cm.reset();
    const all = cm.getAll();
    expect(all).toEqual(DEFAULT_CONFIG);
  });

  test('migrates old flat config format', () => {
    // Write an old‑style config file directly.
    const oldConfig = {
      model: 'gpt-3.5-turbo',
      provider: 'openai',
      autoApprove: true,
    };
    const configPath = join(tempDir, 'settings.json');
    writeFileSync(configPath, JSON.stringify(oldConfig, null, 2));
    // Instantiate – it should migrate and save the new format.
    const cm = new ConfigManager();
    expect(cm.get('provider.model')).toBe('gpt-3.5-turbo');
    expect(cm.get('provider.provider')).toBe('openai');
    expect(cm.get('behavior.autoApprove')).toBe(true);
    // Verify the migrated file now contains nested structure.
    const migrated = JSON.parse(readFileSync(configPath, 'utf-8')) as any;
    expect(migrated.provider?.model).toBe('gpt-3.5-turbo');
    expect(migrated.provider?.provider).toBe('openai');
    expect(migrated.behavior?.autoApprove).toBe(true);
  });
});
