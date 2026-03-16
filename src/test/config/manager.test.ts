import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigManager } from '../config/manager.ts';
import { ConfigError, DEFAULT_CONFIG } from '../config/manager.ts';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { homedir } from 'os';

const originalHome = homedir();

function setTempHome(tempDir: string) {
  // Override HOME env var for the process; homedir() reads from env.
  process.env.HOME = tempDir;
}

function resetHome() {
  process.env.HOME = originalHome;
}

describe('ConfigManager', () => {
  let tempHome: string;

  beforeEach(() => {
    // Create a temporary directory for HOME
    tempHome = join(__dirname, '..', '..', 'tmp-test-home', Math.random().toString(36).substring(2, 8));
    mkdirSync(tempHome, { recursive: true });
    setTempHome(tempHome);
  });

  afterEach(() => {
    // Cleanup temp home
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {}
    resetHome();
  });

  it('loads default config when no files exist', () => {
    const manager = new ConfigManager();
    const all = manager.getAll();
    expect(all).toEqual(DEFAULT_CONFIG);
  });

  it('set and get simple config key', () => {
    const manager = new ConfigManager();
    manager.set('provider.model', 'gpt-4');
    expect(manager.get('provider.model')).toBe('gpt-4');
    // Ensure persisted file contains the new value
    const settingsPath = join(tempHome, '.goodvibes', 'tui', 'settings.json');
    expect(existsSync(settingsPath)).toBeTrue();
  });

  it('rejects invalid enum values', () => {
    const manager = new ConfigManager();
    expect(() => manager.set('provider.reasoningEffort' as any, 'invalid' as any)).toThrow(ConfigError);
  });

  it('reset a key restores default value', () => {
    const manager = new ConfigManager();
    manager.set('provider.model', 'gpt-4');
    expect(manager.get('provider.model')).toBe('gpt-4');
    manager.reset('provider.model');
    expect(manager.get('provider.model')).toBe(DEFAULT_CONFIG.provider.model);
  });

  it('reset all restores defaults', () => {
    const manager = new ConfigManager();
    manager.set('provider.model', 'gpt-4');
    manager.set('behavior.autoApprove', true);
    manager.reset();
    const all = manager.getAll();
    expect(all).toEqual(DEFAULT_CONFIG);
  });
});
