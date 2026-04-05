import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
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
    const cm = new ConfigManager({ workingDir: tempDir });
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

  test('set does not mutate DEFAULT_CONFIG nested objects', () => {
    const cm = new ConfigManager();
    const before = structuredClone(DEFAULT_CONFIG);
    cm.set('provider.provider', 'anthropic');
    cm.set('behavior.autoApprove', true);
    cm.set('display.lineNumbers', true);
    expect(DEFAULT_CONFIG).toEqual(before);
  });
});
