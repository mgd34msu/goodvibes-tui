/**
 * Session maintenance config-driven tests — TASK-058.
 *
 * Validates that evaluateSessionMaintenance reads behavior.autoCompactThreshold correctly.
 * The SDK schema validates threshold in range [10, 100]; the key cannot be set to 0.
 * When the key holds its schema default (80), autoCompactEnabled is true.
 * suggest-compact fires at the configured threshold value or at the 80% safety floor.
 */
import { describe, test, expect } from 'bun:test';
import { createTestConfigManager } from '../helpers/test-managers.ts';
import { evaluateSessionMaintenance } from '@/runtime/index.ts';

const BASE_SESSION = {
  compactionState: 'idle' as const,
  recoveryState: 'ready' as const,
  revision: 0,
  lastUpdatedAt: 0,
  source: 'test' as const,
  id: 'sess-cfg',
  projectRoot: '/tmp',
  status: 'active' as const,
  startedAt: Date.now(),
  isResumed: false,
  wasRepaired: false,
  lineageId: 'sess-cfg',
  lineage: [],
};

describe('evaluateSessionMaintenance config path (TASK-058)', () => {
  test('autoCompactEnabled is true with SDK schema default threshold (80)', () => {
    // createTestConfigManager loads schema defaults: behavior.autoCompactThreshold = 80.
    // autoCompactEnabled = (80 > 0) = true.
    const configManager = createTestConfigManager();
    const status = evaluateSessionMaintenance({
      configManager,
      currentTokens: 50_000,
      contextWindow: 100_000,
      session: BASE_SESSION,
    });
    expect(status.autoCompactEnabled).toBe(true);
  });

  test('autoCompactEnabled is true when threshold explicitly set to 80', () => {
    const configManager = createTestConfigManager();
    configManager.setDynamic('behavior.autoCompactThreshold', 80);
    const status = evaluateSessionMaintenance({
      configManager,
      currentTokens: 50_000,
      contextWindow: 100_000,
      session: BASE_SESSION,
    });
    expect(status.autoCompactEnabled).toBe(true);
  });

  test('suggest-compact triggers at configured threshold (75%)', () => {
    const configManager = createTestConfigManager();
    configManager.setDynamic('behavior.autoCompactThreshold', 75);
    // 76% usage — at or above threshold
    const status = evaluateSessionMaintenance({
      configManager,
      currentTokens: 76_000,
      contextWindow: 100_000,
      session: BASE_SESSION,
    });
    expect(status.level).toBe('suggest-compact');
    expect(status.compactRecommended).toBe(true);
  });

  test('suggest-compact triggers at 80% safety floor (SDK default threshold = 80)', () => {
    // SDK default threshold = 80. 82% usage is at or above the threshold AND the safety floor.
    const configManager = createTestConfigManager();
    const status = evaluateSessionMaintenance({
      configManager,
      currentTokens: 82_000,
      contextWindow: 100_000,
      session: BASE_SESSION,
    });
    expect(status.level).toBe('suggest-compact');
  });

  test('stable below threshold at 60% usage with default threshold (80)', () => {
    // 60% usage — below 70% watch band and below 80% threshold/floor.
    const configManager = createTestConfigManager();
    const status = evaluateSessionMaintenance({
      configManager,
      currentTokens: 60_000,
      contextWindow: 100_000,
      session: BASE_SESSION,
    });
    expect(status.level).toBe('stable');
  });
});
