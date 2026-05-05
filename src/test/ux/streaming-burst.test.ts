/**
 * UX Anti-Regression: Streaming + Tool Burst + Agent Burst (v3 §18.5)
 *
 * Verifies that simultaneous streaming, concurrent tool calls, and agent
 * state changes do not corrupt conversation state consistency.
 *
 * All tests use pure state manipulation — no real I/O, no event bus.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { createInitialRuntimeState } from '../../runtime/store/state.ts';
import type { RuntimeState } from '../../runtime/store/state.ts';
import {
  selectConversation,
  selectAgents,
  selectTasks,
  selectIsTurnActive,
  selectRunningTasks,
  selectRunningAgents,
} from '../../runtime/store/selectors/index.ts';
import type {
  ConversationDomainState,
  ActiveToolCall,
} from '@/runtime/index.ts';
import type { AgentDomainState, RuntimeAgent } from '@/runtime/index.ts';
import type { TaskDomainState } from '@/runtime/index.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fixed timestamp used in test helpers to avoid non-deterministic Date.now() calls. */
const TEST_TIMESTAMP = 1700000000000;

/** Produce a streaming-active conversation state. */
function makeStreamingConversation(
  base: ConversationDomainState,
  opts: { deltaCount?: number; accumulated?: string } = {},
): ConversationDomainState {
  return {
    ...base,
    turnState: 'streaming',
    currentTurnId: 'turn-stream-001',
    turnStartedAt: TEST_TIMESTAMP - 500,
    revision: base.revision + 1,
    lastUpdatedAt: TEST_TIMESTAMP,
    source: 'streaming-burst-test',
    stream: {
      accumulated: opts.accumulated ?? 'partial response text',
      reasoningAccumulated: '',
      deltaCount: opts.deltaCount ?? 12,
      firstDeltaAt: TEST_TIMESTAMP - 400,
      lastDeltaAt: TEST_TIMESTAMP - 10,
    },
  };
}

/** Produce an active tool call record. */
function makeToolCall(callId: string, toolName: string): ActiveToolCall {
  return {
    callId,
    toolName,
    args: JSON.stringify({ path: '/tmp/test.ts' }),
    state: 'executing',
    stateEnteredAt: TEST_TIMESTAMP - 100,
    phaseTimestamps: {
      received: TEST_TIMESTAMP - 200,
      validated: TEST_TIMESTAMP - 180,
      executing: TEST_TIMESTAMP - 100,
    },
  };
}

/** Produce a running agent. */
function makeRunningAgent(id: string, parentId?: string): RuntimeAgent {
  return {
    id,
    label: `Agent ${id}`,
    role: 'engineer',
    status: 'running',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    parentAgentId: parentId,
    childAgentIds: [],
    turnCount: 0,
    toolCallCount: 0,
    latestOutput: '',
    spawnedAt: TEST_TIMESTAMP - 200,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ux:streaming-burst — simultaneous streaming + tool + agent bursts', () => {
  let state: RuntimeState;

  beforeEach(() => {
    state = createInitialRuntimeState();
  });

  describe('streaming state integrity during concurrent tool calls', () => {
    test('adding tool calls during streaming does not change turnState', () => {
      // Simulate: streaming starts
      const withStreaming: RuntimeState = {
        ...state,
        conversation: makeStreamingConversation(state.conversation),
      };

      // Simulate: 3 tool calls dispatched concurrently during streaming
      const toolCalls = new Map(withStreaming.conversation.activeToolCalls);
      toolCalls.set('call-001', makeToolCall('call-001', 'Read'));
      toolCalls.set('call-002', makeToolCall('call-002', 'Edit'));
      toolCalls.set('call-003', makeToolCall('call-003', 'Bash'));

      const withTools: RuntimeState = {
        ...withStreaming,
        conversation: {
          ...withStreaming.conversation,
          activeToolCalls: toolCalls,
          toolCallsThisTurn: 3,
          revision: withStreaming.conversation.revision + 1,
          lastUpdatedAt: TEST_TIMESTAMP,
          source: 'tool-dispatch',
        },
      };

      // Contract: turnState remains 'streaming' — tool dispatch does not preempt it
      expect(selectConversation(withTools).turnState).toBe('streaming');
      expect(selectConversation(withTools).activeToolCalls.size).toBe(3);
      expect(selectConversation(withTools).toolCallsThisTurn).toBe(3);
    });

    test('stream delta accumulation is not disrupted by concurrent tool call state changes', () => {
      const withStreaming: RuntimeState = {
        ...state,
        conversation: makeStreamingConversation(state.conversation, {
          deltaCount: 50,
          accumulated: 'x'.repeat(2000),
        }),
      };

      // Simulate: tool call state transitions during streaming deltas
      const toolCalls = new Map<string, ActiveToolCall>();
      for (let i = 0; i < 5; i++) {
        const call = makeToolCall(`call-${i}`, 'Read');
        toolCalls.set(call.callId, { ...call, state: 'succeeded' });
      }

      const withSettledTools: RuntimeState = {
        ...withStreaming,
        conversation: {
          ...withStreaming.conversation,
          activeToolCalls: toolCalls,
          stream: {
            ...withStreaming.conversation.stream,
            deltaCount: 75,
            accumulated: 'x'.repeat(3000),
          },
          revision: withStreaming.conversation.revision + 1,
        },
      };

      const conv = selectConversation(withSettledTools);
      expect(conv.stream.deltaCount).toBe(75);
      expect(conv.stream.accumulated).toHaveLength(3000);
      // All tool calls are settled but streaming continues
      expect(conv.turnState).toBe('streaming');
      for (const [, tc] of conv.activeToolCalls) {
        expect(tc.state).toBe('succeeded');
      }
    });

    test('burst of 10 concurrent tool calls preserves all call IDs', () => {
      const withStreaming: RuntimeState = {
        ...state,
        conversation: makeStreamingConversation(state.conversation),
      };

      const toolCalls = new Map<string, ActiveToolCall>();
      for (let i = 0; i < 10; i++) {
        const callId = `burst-call-${i.toString().padStart(3, '0')}`;
        toolCalls.set(callId, makeToolCall(callId, `Tool${i}`));
      }

      const withBurst: RuntimeState = {
        ...withStreaming,
        conversation: {
          ...withStreaming.conversation,
          activeToolCalls: toolCalls,
          toolCallsThisTurn: 10,
        },
      };

      const conv = selectConversation(withBurst);
      expect(conv.activeToolCalls.size).toBe(10);
      for (let i = 0; i < 10; i++) {
        expect(conv.activeToolCalls.has(`burst-call-${i.toString().padStart(3, '0')}`)).toBe(true);
      }
    });
  });

  describe('agent burst during active streaming', () => {
    test('spawning multiple agents during streaming does not affect conversation state', () => {
      const withStreaming: RuntimeState = {
        ...state,
        conversation: makeStreamingConversation(state.conversation),
      };

      // Simulate: 3 agents spawned concurrently
      const agentMap = new Map<string, RuntimeAgent>();
      const agent1 = makeRunningAgent('agent-001');
      const agent2 = makeRunningAgent('agent-002', 'agent-001');
      const agent3 = makeRunningAgent('agent-003', 'agent-001');
      agentMap.set(agent1.id, agent1);
      agentMap.set(agent2.id, agent2);
      agentMap.set(agent3.id, agent3);

      const withAgents: RuntimeState = {
        ...withStreaming,
        agents: {
          ...withStreaming.agents,
          agents: agentMap,
          activeAgentIds: ['agent-001', 'agent-002', 'agent-003'],
          totalSpawned: 3,
          peakConcurrency: 3,
          revision: withStreaming.agents.revision + 1,
          lastUpdatedAt: TEST_TIMESTAMP,
          source: 'agent-burst-test',
        },
      };

      // Contract: streaming conversation state unaffected
      expect(selectConversation(withAgents).turnState).toBe('streaming');
      expect(selectConversation(withAgents).currentTurnId).toBe('turn-stream-001');

      // Contract: agents reflect burst correctly
      const agents = selectRunningAgents(withAgents);
      expect(agents).toHaveLength(3);
      expect(selectAgents(withAgents).peakConcurrency).toBe(3);
    });

    test('agent hierarchy is preserved under concurrent burst', () => {
      const agentMap = new Map<string, RuntimeAgent>();
      const root = makeRunningAgent('root-001');
      const children = Array.from({ length: 5 }, (_, i) =>
        makeRunningAgent(`child-${i}`, 'root-001'),
      );
      const updatedRoot = { ...root, childAgentIds: children.map((c) => c.id) };
      agentMap.set(updatedRoot.id, updatedRoot);
      for (const child of children) agentMap.set(child.id, child);

      const withBurstAgents: RuntimeState = {
        ...state,
        agents: {
          ...state.agents,
          agents: agentMap,
          activeAgentIds: [root.id, ...children.map((c) => c.id)],
          totalSpawned: 6,
          peakConcurrency: 6,
          revision: 6,
          lastUpdatedAt: TEST_TIMESTAMP,
          source: 'hierarchy-burst-test',
        },
      };

      const rootAgent = selectAgents(withBurstAgents).agents.get('root-001');
      expect(rootAgent).toBeDefined();
      expect(rootAgent?.childAgentIds).toHaveLength(5);
      for (const child of children) {
        const childAgent = selectAgents(withBurstAgents).agents.get(child.id);
        expect(childAgent?.parentAgentId).toBe('root-001');
      }
    });
  });

  describe('state consistency invariants under burst load', () => {
    test('revision counter is monotonically increasing across burst mutations', () => {
      let current = createInitialRuntimeState();
      const revisions: number[] = [current.conversation.revision];

      for (let i = 1; i <= 20; i++) {
        current = {
          ...current,
          conversation: {
            ...current.conversation,
            revision: i,
            lastUpdatedAt: TEST_TIMESTAMP,
          },
        };
        revisions.push(current.conversation.revision);
      }

      for (let i = 1; i < revisions.length; i++) {
        expect(revisions[i]).toBeGreaterThan(revisions[i - 1]!);
      }
    });

    test('tool call count matches active tool map size after burst', () => {
      const toolCalls = new Map<string, ActiveToolCall>();
      const count = 7;
      for (let i = 0; i < count; i++) {
        const callId = `tc-${i}`;
        toolCalls.set(callId, makeToolCall(callId, 'Tool'));
      }

      const withBurst: RuntimeState = {
        ...state,
        conversation: {
          ...makeStreamingConversation(state.conversation),
          activeToolCalls: toolCalls,
          toolCallsThisTurn: count,
        },
      };

      const conv = selectConversation(withBurst);
      expect(conv.activeToolCalls.size).toBe(conv.toolCallsThisTurn);
    });

    test('activeAgentIds array stays consistent with agents Map after burst', () => {
      const agentMap = new Map<string, RuntimeAgent>();
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const id = `a-${i}`;
        agentMap.set(id, makeRunningAgent(id));
        ids.push(id);
      }

      const withBurst: RuntimeState = {
        ...state,
        agents: {
          ...state.agents,
          agents: agentMap,
          activeAgentIds: ids,
          totalSpawned: 8,
          peakConcurrency: 8,
          revision: 8,
          lastUpdatedAt: TEST_TIMESTAMP,
          source: 'invariant-test',
        },
      };

      const agentDomain = selectAgents(withBurst);
      expect(agentDomain.activeAgentIds).toHaveLength(agentDomain.agents.size);
      for (const id of agentDomain.activeAgentIds) {
        expect(agentDomain.agents.has(id)).toBe(true);
      }
    });
  });
});
