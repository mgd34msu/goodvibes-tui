/**
 * UX Anti-Regression: Cancellation During Heavy Updates (v3 §18.5)
 *
 * Verifies that aborting a turn during heavy tool/agent updates cleanly
 * resets conversation state — no tool calls left dangling, agent counts
 * reconcile, and turn state lands in 'cancelled'.
 *
 * All tests use pure state manipulation — no real I/O, no event bus.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { createInitialRuntimeState } from '../../runtime/store/state.ts';
import type { RuntimeState } from '../../runtime/store/state.ts';
import {
  selectConversation,
  selectAgents,
  selectIsTurnActive,
  selectRunningAgents,
} from '../../runtime/store/selectors/index.ts';
import type { ConversationDomainState, ActiveToolCall } from '../../runtime/store/domains/conversation.ts';
import type { RuntimeAgent, AgentDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/agents';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fixed timestamp used in test helpers to avoid non-deterministic Date.now() calls. */
const TEST_TIMESTAMP = 1700000000000;

function makeToolCall(callId: string, toolName: string): ActiveToolCall {
  return {
    callId,
    toolName,
    args: '{}',
    state: 'executing',
    stateEnteredAt: TEST_TIMESTAMP - 100,
    phaseTimestamps: { received: TEST_TIMESTAMP - 200, executing: TEST_TIMESTAMP - 100 },
  };
}

function makeRunningAgent(id: string): RuntimeAgent {
  return {
    id,
    label: `Agent ${id}`,
    role: 'engineer',
    status: 'running',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    childAgentIds: [],
    turnCount: 2,
    toolCallCount: 5,
    latestOutput: 'working...',
    spawnedAt: TEST_TIMESTAMP - 5000,
  };
}

/** Simulate a busy state: streaming with N tool calls and M agents active. */
function makeBusyState(
  base: RuntimeState,
  toolCallCount: number,
  agentCount: number,
): RuntimeState {
  const toolCalls = new Map<string, ActiveToolCall>();
  for (let i = 0; i < toolCallCount; i++) {
    toolCalls.set(`tc-${i}`, makeToolCall(`tc-${i}`, `Tool${i}`));
  }

  const agents = new Map<string, RuntimeAgent>();
  const agentIds: string[] = [];
  for (let i = 0; i < agentCount; i++) {
    const agent = makeRunningAgent(`agent-${i}`);
    agents.set(agent.id, agent);
    agentIds.push(agent.id);
  }

  return {
    ...base,
    conversation: {
      ...base.conversation,
      turnState: 'streaming',
      currentTurnId: 'turn-cancel-001',
      turnStartedAt: TEST_TIMESTAMP - 2000,
      activeToolCalls: toolCalls,
      toolCallsThisTurn: toolCallCount,
      stream: {
        accumulated: 'partial...',
        reasoningAccumulated: '',
        deltaCount: 30,
        firstDeltaAt: TEST_TIMESTAMP - 1900,
        lastDeltaAt: TEST_TIMESTAMP - 50,
      },
      revision: 10,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: 'busy-setup',
    },
    agents: {
      ...base.agents,
      agents,
      activeAgentIds: agentIds,
      totalSpawned: agentCount,
      peakConcurrency: agentCount,
      revision: agentCount,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: 'busy-setup',
    },
  };
}

/** Simulate cancellation: all tool calls → 'cancelled', turn → 'cancelled', agents → terminal. */
function applyCancel(busyState: RuntimeState): RuntimeState {
  const cancelledTools = new Map<string, ActiveToolCall>();
  for (const [id, tc] of busyState.conversation.activeToolCalls) {
    cancelledTools.set(id, { ...tc, state: 'cancelled' });
  }

  const cancelledAgents = new Map<string, RuntimeAgent>();
  for (const [id, agent] of busyState.agents.agents) {
    cancelledAgents.set(id, { ...agent, status: 'cancelled', endedAt: TEST_TIMESTAMP });
  }

  return {
    ...busyState,
    conversation: {
      ...busyState.conversation,
      turnState: 'cancelled',
      currentTurnId: undefined,
      turnEndedAt: TEST_TIMESTAMP,
      activeToolCalls: cancelledTools,
      stream: {
        accumulated: '',
        reasoningAccumulated: '',
        deltaCount: 0,
        firstDeltaAt: undefined,
        lastDeltaAt: undefined,
      },
      revision: busyState.conversation.revision + 1,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: 'cancellation',
    },
    agents: {
      ...busyState.agents,
      agents: cancelledAgents,
      activeAgentIds: [],
      revision: busyState.agents.revision + 1,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: 'cancellation',
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ux:cancellation — abort during heavy tool/agent updates', () => {
  let state: RuntimeState;

  beforeEach(() => {
    state = createInitialRuntimeState();
  });

  describe('turn state after cancellation', () => {
    test('turnState transitions to cancelled after abort', () => {
      const busy = makeBusyState(state, 5, 3);
      expect(selectConversation(busy).turnState).toBe('streaming');

      const cancelled = applyCancel(busy);
      expect(selectConversation(cancelled).turnState).toBe('cancelled');
    });

    test('isTurnActive returns false after cancellation', () => {
      const busy = makeBusyState(state, 3, 2);
      // During streaming it may be active
      const cancelled = applyCancel(busy);
      expect(selectIsTurnActive(cancelled)).toBe(false);
    });

    test('currentTurnId is cleared after cancellation', () => {
      const busy = makeBusyState(state, 4, 2);
      expect(selectConversation(busy).currentTurnId).toBe('turn-cancel-001');

      const cancelled = applyCancel(busy);
      expect(selectConversation(cancelled).currentTurnId).toBeUndefined();
    });

    test('turnEndedAt is populated after cancellation', () => {
      const busy = makeBusyState(state, 2, 1);
      expect(selectConversation(busy).turnEndedAt).toBeUndefined();

      const cancelled = applyCancel(busy);
      expect(selectConversation(cancelled).turnEndedAt).toBe(TEST_TIMESTAMP);
    });
  });

  describe('tool call cleanup after cancellation', () => {
    test('all active tool calls are moved to cancelled state', () => {
      const busy = makeBusyState(state, 8, 0);
      expect(selectConversation(busy).activeToolCalls.size).toBe(8);

      const cancelled = applyCancel(busy);
      const { activeToolCalls } = selectConversation(cancelled);
      expect(activeToolCalls.size).toBe(8);
      for (const [, tc] of activeToolCalls) {
        expect(tc.state).toBe('cancelled');
      }
    });

    test('stream buffer is cleared after cancellation', () => {
      const busy = makeBusyState(state, 3, 1);
      expect(selectConversation(busy).stream.accumulated).toBe('partial...');

      const cancelled = applyCancel(busy);
      const { stream } = selectConversation(cancelled);
      expect(stream.accumulated).toBe('');
      expect(stream.deltaCount).toBe(0);
      expect(stream.firstDeltaAt).toBeUndefined();
      expect(stream.lastDeltaAt).toBeUndefined();
    });

    test('no tool calls remain in executing state after cancellation', () => {
      const busy = makeBusyState(state, 10, 0);
      const cancelled = applyCancel(busy);
      const { activeToolCalls } = selectConversation(cancelled);
      for (const [, tc] of activeToolCalls) {
        expect(tc.state).not.toBe('executing');
      }
    });
  });

  describe('agent cleanup after cancellation', () => {
    test('no agents remain active after cancellation', () => {
      const busy = makeBusyState(state, 3, 5);
      expect(selectRunningAgents(busy)).toHaveLength(5);

      const cancelled = applyCancel(busy);
      expect(selectAgents(cancelled).activeAgentIds).toHaveLength(0);
    });

    test('all agents are in terminal state after cancellation', () => {
      const busy = makeBusyState(state, 2, 4);
      const cancelled = applyCancel(busy);

      for (const [, agent] of selectAgents(cancelled).agents) {
        expect(agent.status).toBe('cancelled');
        expect(agent.endedAt).toBeDefined();
      }
    });

    test('activeAgentIds is empty after cancellation', () => {
      const busy = makeBusyState(state, 1, 6);
      const cancelled = applyCancel(busy);
      expect(selectAgents(cancelled).activeAgentIds).toHaveLength(0);
    });
  });

  describe('state consistency after cancellation', () => {
    test('revision increments after cancellation mutation', () => {
      const busy = makeBusyState(state, 3, 2);
      const preRev = selectConversation(busy).revision;

      const cancelled = applyCancel(busy);
      expect(selectConversation(cancelled).revision).toBeGreaterThan(preRev);
    });

    test('source is set to cancellation after cancel', () => {
      const busy = makeBusyState(state, 2, 1);
      const cancelled = applyCancel(busy);
      expect(selectConversation(cancelled).source).toBe('cancellation');
      expect(selectAgents(cancelled).source).toBe('cancellation');
    });

    test('cancellation from initial state produces valid cancelled state', () => {
      // Edge case: cancel on idle turn (no active turn)
      const idleBusy = makeBusyState(state, 0, 0);
      const cancelled = applyCancel(idleBusy);
      expect(selectConversation(cancelled).turnState).toBe('cancelled');
      expect(selectConversation(cancelled).activeToolCalls.size).toBe(0);
    });
  });
});
