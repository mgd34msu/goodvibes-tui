import { describe, test, expect, beforeEach } from 'bun:test';
import { ConfigManager } from '../../config/manager.ts';
import { DEFAULT_CONFIG } from '../../config/schema.ts';

// Use a fresh ConfigManager instance for each test to avoid pollution from
// module mocks in other test files that replace the shared configManager singleton.
describe('ConfigManager reset functionality', () => {
  let mgr: ConfigManager;

  beforeEach(() => {
    mgr = new ConfigManager();
  });

  test('reset a specific key restores default value', () => {
    // Change a config value
    mgr.set('behavior.autoApprove', true);
    expect(mgr.getRaw().behavior.autoApprove).toBe(true);
    // Reset the key
    mgr.reset('behavior.autoApprove');
    expect(mgr.getRaw().behavior.autoApprove).toBe(DEFAULT_CONFIG.behavior.autoApprove);
  });

  test('reset without key restores all defaults', () => {
    // Change multiple config values
    mgr.set('behavior.autoApprove', true);
    mgr.set('provider.model', 'gpt-4o-mini');
    expect(mgr.getRaw().behavior.autoApprove).toBe(true);
    expect(mgr.getRaw().provider.model).toBe('gpt-4o-mini');
    // Reset all
    mgr.reset();
    // Verify defaults
    expect(mgr.getRaw().behavior.autoApprove).toBe(DEFAULT_CONFIG.behavior.autoApprove);
    expect(mgr.getRaw().provider.model).toBe(DEFAULT_CONFIG.provider.model);
  });
});
