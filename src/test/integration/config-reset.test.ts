import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { configManager, config } from '../../config/index.ts';
import { DEFAULT_CONFIG } from '../../config/schema.ts';

describe('ConfigManager reset functionality', () => {
  const originalAutoApprove = config.behavior?.autoApprove;
  const originalModel = config.provider?.model;

  afterEach(() => {
    // Restore original values after each test
    if (originalAutoApprove !== undefined) configManager.set('behavior.autoApprove', originalAutoApprove);
    if (originalModel !== undefined) configManager.set('provider.model', originalModel);
  });

  test('reset a specific key restores default value', () => {
    // Change a config value
    configManager.set('behavior.autoApprove', true);
    expect(config.behavior?.autoApprove).toBe(true);
    // Reset the key
    configManager.reset('behavior.autoApprove');
    expect(config.behavior?.autoApprove).toBe(DEFAULT_CONFIG.behavior.autoApprove);
  });

  test('reset without key restores all defaults', () => {
    // Change multiple config values
    configManager.set('behavior.autoApprove', true);
    configManager.set('provider.model', 'gpt-4o-mini');
    expect(config.behavior?.autoApprove).toBe(true);
    expect(config.provider?.model).toBe('gpt-4o-mini');
    // Reset all
    configManager.reset();
    // Verify defaults
    expect(config.behavior?.autoApprove).toBe(DEFAULT_CONFIG.behavior.autoApprove);
    expect(config.provider?.model).toBe(DEFAULT_CONFIG.provider.model);
  });
});
