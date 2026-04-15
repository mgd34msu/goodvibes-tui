import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';

// Use a fresh ConfigManager instance for each test to avoid pollution from
// leaked module state in other test files that used to replace shared config helpers.
describe('ConfigManager reset functionality', () => {
  let mgr: ConfigManager;
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'goodvibes-config-reset-'));
    mgr = new ConfigManager({ surfaceRoot: 'tui',  configDir });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test('reset a specific key restores default value', () => {
    const defaults = new ConfigManager({ surfaceRoot: 'tui',  configDir }).getRaw();

    // Change a config value
    mgr.set('behavior.autoApprove', true);
    expect(mgr.getRaw().behavior.autoApprove).toBe(true);
    // Reset the key
    mgr.reset('behavior.autoApprove');
    expect(mgr.getRaw().behavior.autoApprove).toBe(defaults.behavior.autoApprove);
  });

  test('reset without key restores all defaults', () => {
    const defaults = new ConfigManager({ surfaceRoot: 'tui',  configDir }).getRaw();

    // Change multiple config values
    mgr.set('behavior.autoApprove', true);
    mgr.set('provider.model', 'gpt-4o-mini');
    expect(mgr.getRaw().behavior.autoApprove).toBe(true);
    expect(mgr.getRaw().provider.model).toBe('gpt-4o-mini');
    // Reset all
    mgr.reset();
    // Verify defaults
    expect(mgr.getRaw().behavior.autoApprove).toBe(defaults.behavior.autoApprove);
    expect(mgr.getRaw().provider.model).toBe(defaults.provider.model);
  });
});
