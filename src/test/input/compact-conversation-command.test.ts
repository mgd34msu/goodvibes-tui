/**
 *, TUI-side compaction wiring regression tests.
 *
 * compactConversation() (src/input/commands/runtime-services.ts) previously:
 *  1. Filtered agents down to running/pending only before building
 *     CompactionContext.agents, discarding all completed/failed subagent work
 *     before the SDK's compaction section builders ever saw it.
 *  2. Never set CompactionContext.originalTask at all, so the SDK's
 *     "Original task" fallback (meant only for the very first compaction of a
 *     session) fired on every manual /compact, mislabeling the current task
 *     as "original".
 *
 * These tests capture the CompactionContext actually passed to
 * conversationManager.compact(...) and assert both are fixed.
 */
import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { compactConversation } from '../../input/commands/runtime-services.ts';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import type { CompactionContext } from '@pellux/goodvibes-sdk/platform/core';

function makeAgentRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    template: overrides.template ?? 'engineer',
    tools: [],
    status: 'completed',
    startedAt: Date.now(),
    toolCallCount: 2,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  } as AgentRecord;
}

function makeContext(opts: {
  exportedAgents: AgentRecord[];
  originalTask: string | null;
  capturedCtx: { value: CompactionContext | null };
}): CommandContext {
  return {
    session: {
      runtime: {
        model: 'test-model',
        provider: 'test-provider',
        sessionId: 'session-1',
      },
      conversationManager: {
        getMessagesForLLM: () => [],
        replaceMessagesForLLM: () => {},
        compact: async (
          _registry: unknown,
          _model: string,
          _trigger: string,
          _provider: string,
          ctx: CompactionContext,
        ) => {
          opts.capturedCtx.value = ctx;
        },
      },
      sessionMemoryStore: { list: () => [] },
      sessionLineageTracker: {
        getEntries: () => [],
        getCompactionCount: () => 1,
        getOriginalTask: () => opts.originalTask,
      },
      wrfcController: { listChains: () => [] },
    },
    provider: {
      providerRegistry: {
        getCurrentModel: () => ({ id: 'test-model' }),
        getContextWindowForModel: () => 200_000,
      },
    },
    ops: {
      agentManager: { exportState: () => opts.exportedAgents },
      planManager: { getActive: () => null },
    },
  } as unknown as CommandContext;
}

describe('compactConversation: agents pass through unfiltered (premature-filter bug)', () => {
  test('the full agent list (running, pending, completed, failed) reaches CompactionContext.agents', async () => {
    const captured: { value: CompactionContext | null } = { value: null };
    const agents = [
      makeAgentRecord({ id: 'running-1', task: 'still going', status: 'running' }),
      makeAgentRecord({ id: 'pending-1', task: 'queued', status: 'pending' }),
      makeAgentRecord({ id: 'completed-1', task: 'finished work', status: 'completed' }),
      makeAgentRecord({ id: 'failed-1', task: 'blew up', status: 'failed' }),
    ];
    const context = makeContext({ exportedAgents: agents, originalTask: 'the real original task', capturedCtx: captured });

    await compactConversation(context);

    expect(captured.value).not.toBeNull();
    expect(captured.value!.agents).toHaveLength(4);
    // Spot-check: a completed record specifically survives into the passed context.
    const completed = captured.value!.agents.find((a) => a.id === 'completed-1');
    expect(completed).toBeDefined();
    expect(completed!.status).toBe('completed');
    const failed = captured.value!.agents.find((a) => a.id === 'failed-1');
    expect(failed).toBeDefined();
    expect(failed!.status).toBe('failed');
  });
});

describe('compactConversation: originalTask wiring ("Original task" mislabel bug)', () => {
  test('CompactionContext.originalTask is populated from sessionLineageTracker.getOriginalTask()', async () => {
    const captured: { value: CompactionContext | null } = { value: null };
    const context = makeContext({
      exportedAgents: [],
      originalTask: 'Implement the reversibility wave',
      capturedCtx: captured,
    });

    await compactConversation(context);

    expect(captured.value).not.toBeNull();
    expect(captured.value!.originalTask).toBe('Implement the reversibility wave');
  });

  test('CompactionContext.originalTask is undefined (not silently substituted) when the tracker has none', async () => {
    const captured: { value: CompactionContext | null } = { value: null };
    const context = makeContext({ exportedAgents: [], originalTask: null, capturedCtx: captured });

    await compactConversation(context);

    expect(captured.value).not.toBeNull();
    expect(captured.value!.originalTask).toBeUndefined();
  });
});
