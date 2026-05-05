import { describe, expect, test } from 'bun:test';
import { evaluateOrchestrationSpawn } from '@/runtime/index.ts';
import { createTestConfigManager } from '../../helpers/test-managers.ts';

const configManager = createTestConfigManager();

describe('evaluateOrchestrationSpawn', () => {
  test('blocks plan auto-spawn when recursive orchestration is disabled', () => {
    const result = evaluateOrchestrationSpawn({
      configManager,
      mode: 'plan-auto',
      activeAgents: 0,
      requestedDepth: 1,
      overrides: {
        recursionEnabled: false,
        maxAgents: 8,
        maxDepth: 0,
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('disabled');
  });

  test('allows manual batch spawn under the configured capacity ceiling', () => {
    const result = evaluateOrchestrationSpawn({
      configManager,
      mode: 'manual-batch',
      activeAgents: 1,
      requestedDepth: 0,
      overrides: {
        recursionEnabled: false,
        maxAgents: 4,
        maxDepth: 0,
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.availableSlots).toBe(3);
  });

  test('blocks recursive child spawn when requested depth exceeds the configured maximum', () => {
    const result = evaluateOrchestrationSpawn({
      configManager,
      mode: 'recursive-child',
      activeAgents: 0,
      requestedDepth: 2,
      overrides: {
        recursionEnabled: true,
        maxAgents: 8,
        maxDepth: 1,
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeds');
  });
});
