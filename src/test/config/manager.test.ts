import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { DEFAULT_CONFIG } from '@pellux/goodvibes-sdk/platform/config/schema';

// Helper to create an isolated temporary directory for each test suite.
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gv-config-test-'));
}

describe('ConfigManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    // Cleanup the isolated temp config directory.
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('loads defaults when no config files exist', () => {
    const cm = new ConfigManager({ surfaceRoot: 'tui',  configDir: tempDir, workingDir: tempDir });
    const all = cm.getAll();
    // Compare shallowly – deep equality is fine for our purposes.
    expect(all).toEqual(DEFAULT_CONFIG);
  });

  test('derives the control-plane config dir from an explicit home root', () => {
    const cm = new ConfigManager({ surfaceRoot: 'tui',  homeDir: tempDir, workingDir: tempDir });
    expect(cm.getControlPlaneConfigDir()).toBe(join(tempDir, '.goodvibes', 'tui'));
    expect(cm.getHomeDirectory()).toBe(tempDir);
    expect(cm.getWorkingDirectory()).toBe(tempDir);
  });

  test('rejects relative config roots', () => {
    expect(() => new ConfigManager({ surfaceRoot: 'tui',  configDir: 'relative-config-root' })).toThrow(
      'ConfigManager configDir must be an absolute path.',
    );
    expect(() => new ConfigManager({ surfaceRoot: 'tui',  homeDir: 'relative-home-root' })).toThrow(
      'ConfigManager homeDir must be an absolute path.',
    );
    expect(() => new ConfigManager({ surfaceRoot: 'tui',  configDir: tempDir, workingDir: 'relative-working-root' })).toThrow(
      'ConfigManager workingDir must be an absolute path.',
    );
  });

  test('set and get a simple key', () => {
    const cm = new ConfigManager({ surfaceRoot: 'tui',  configDir: tempDir, workingDir: tempDir });
    cm.set('provider.model', 'gpt-4');
    expect(cm.get('provider.model')).toBe('gpt-4');
    // Persisted to disk – create a new instance and verify value persists.
    const cm2 = new ConfigManager({ surfaceRoot: 'tui',  configDir: tempDir, workingDir: tempDir });
    expect(cm2.get('provider.model')).toBe('gpt-4');
  });

  test('reset a key restores default value', () => {
    const cm = new ConfigManager({ surfaceRoot: 'tui',  configDir: tempDir, workingDir: tempDir });
    cm.set('behavior.autoApprove', true);
    expect(cm.get('behavior.autoApprove')).toBe(true);
    cm.reset('behavior.autoApprove');
    expect(cm.get('behavior.autoApprove')).toBe(DEFAULT_CONFIG.behavior.autoApprove);
  });

  test('reset all keys restores defaults', () => {
    const cm = new ConfigManager({ surfaceRoot: 'tui',  configDir: tempDir, workingDir: tempDir });
    cm.set('provider.provider', 'anthropic');
    cm.set('behavior.autoApprove', true);
    cm.reset();
    const all = cm.getAll();
    expect(all).toEqual(DEFAULT_CONFIG);
  });

  test('set does not mutate DEFAULT_CONFIG nested objects', () => {
    const cm = new ConfigManager({ surfaceRoot: 'tui',  configDir: tempDir, workingDir: tempDir });
    const before = structuredClone(DEFAULT_CONFIG);
    cm.set('provider.provider', 'anthropic');
    cm.set('behavior.autoApprove', true);
    cm.set('display.lineNumbers', 'all');
    expect(DEFAULT_CONFIG).toEqual(before);
  });

  test('saveProject requires an explicit working dir', () => {
    const cm = new ConfigManager({ surfaceRoot: 'tui',  configDir: tempDir });
    expect(() => cm.saveProject()).toThrow('ConfigManager.saveProject requires an explicit workingDir.');
  });
});
