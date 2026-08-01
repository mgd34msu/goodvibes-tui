// Deliberately per-repo test, byte-identical to the sibling product's copy by design: the module it exercises is this repo's own and has diverged from the sibling's, so the two copies prove different code and neither can stand in for the other.
import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestConfigManager } from '../helpers/test-managers.ts';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines } from '@/runtime/index.ts';

const configManager = createTestConfigManager();

describe('session maintenance', () => {
  beforeEach(() => {
    configManager.setDynamic('behavior.autoCompactThreshold', 80);
    configManager.setDynamic('behavior.staleContextWarnings', true);
    configManager.setDynamic('behavior.guidanceMode', 'minimal');
  });

  test('suggests compaction under high context pressure', () => {
    const status = evaluateSessionMaintenance({
      configManager,
      currentTokens: 82_000,
      contextWindow: 100_000,
      messageCount: 28,
      sessionMemoryCount: 2,
      session: {
        compactionState: 'idle',
        recoveryState: 'ready',
        revision: 0,
        lastUpdatedAt: 0,
        source: 'test',
        id: 'sess-1',
        projectRoot: '/tmp',
        status: 'active',
        startedAt: Date.now(),
        isResumed: false,
        wasRepaired: false,
        lineageId: 'sess-1',
        lineage: [],
      },
    });

    expect(status.level).toBe('suggest-compact');
    expect(status.compactRecommended).toBe(true);
    expect(status.nextSteps).toContain('/compact');
  });

  test('formats guided lines with reasons and next steps', () => {
    configManager.setDynamic('behavior.guidanceMode', 'guided');
    const status = evaluateSessionMaintenance({
      configManager,
      currentTokens: 60_000,
      contextWindow: 100_000,
      messageCount: 30,
      sessionMemoryCount: 1,
      session: {
        compactionState: 'idle',
        recoveryState: 'ready',
        revision: 0,
        lastUpdatedAt: 0,
        source: 'test',
        id: 'sess-2',
        projectRoot: '/tmp',
        status: 'active',
        startedAt: Date.now(),
        isResumed: false,
        wasRepaired: false,
        lineageId: 'sess-2',
        lineage: [],
      },
    });
    const lines = formatSessionMaintenanceLines(status, 'guided');
    expect(lines[0]).toContain('Maintenance:');
    expect(lines.join('\n')).toContain('Next:');
  });
});
