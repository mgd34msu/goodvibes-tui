import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { AgentOrchestrator } from '../../agents/orchestrator.ts';
import type { AgentRecord } from '../../tools/agent/index.ts';
import type { LLMProvider, ChatRequest, ChatResponse } from '../../providers/interface.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AgentRecord for testing. */
function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-test-01',
    task: 'Write a hello world program',
    template: 'general',
    tools: [],
    status: 'pending',
    startedAt: Date.now(),
    toolCallCount: 0,
    ...overrides,
  };
}

/** Build a mock LLMProvider that returns pre-programmed responses in order. */
function makeMockProvider(
  responses: Array<{ content: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>
): LLMProvider {
  let idx = 0;
  return {
    name: 'mock',
    models: ['mock-model'],
    chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => {
      const resp = responses[idx] ?? responses[responses.length - 1];
      idx++;
      const toolCalls = resp.toolCalls ?? [];
      return {
        content: resp.content,
        toolCalls,
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: toolCalls.length > 0 ? 'tool_use' : 'end',
      };
    }),
  };
}

/** Mock model descriptor reused across tests. */
const MOCK_MODEL = {
  id: 'mock-model',
  provider: 'mock',
  displayName: 'Mock',
  description: '',
  capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
  contextWindow: 8192,
  selectable: true,
};

/**
 * Run `fn` with providerRegistry patched to use the given provider.
 * Restores originals in a finally block.
 */
async function withMockProvider<T>(provider: LLMProvider, fn: () => Promise<T>): Promise<T> {
  const { providerRegistry } = await import('../../providers/registry.ts');
  const origGetForModel = providerRegistry.getForModel.bind(providerRegistry);
  const origGetCurrentModel = providerRegistry.getCurrentModel.bind(providerRegistry);
  providerRegistry.getForModel = mock(() => provider);
  providerRegistry.getCurrentModel = mock(() => MOCK_MODEL);
  try {
    return await fn();
  } finally {
    providerRegistry.getForModel = origGetForModel;
    providerRegistry.getCurrentModel = origGetCurrentModel;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentOrchestrator', () => {
  let orchestrator: AgentOrchestrator;

  beforeEach(() => {
    AgentOrchestrator.resetInstance();
    orchestrator = new AgentOrchestrator();
  });

  // -------------------------------------------------------------------------
  // Status transitions
  // -------------------------------------------------------------------------

  describe('status transitions', () => {
    test('sets status to running then completed on success', async () => {
      const provider = makeMockProvider([{ content: 'Task done.' }]);
      const record = makeRecord();

      // Inject mock provider via providerRegistry mock
      const { providerRegistry } = await import('../../providers/registry.ts');
      const originalGetForModel = providerRegistry.getForModel.bind(providerRegistry);
      const originalGetCurrentModel = providerRegistry.getCurrentModel.bind(providerRegistry);
      providerRegistry.getForModel = mock(() => provider);
      providerRegistry.getCurrentModel = mock(() => ({
        id: 'mock-model',
        provider: 'mock',
        displayName: 'Mock',
        description: '',
        capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192,
        selectable: true,
      }));

      try {
        await orchestrator.runAgent(record);
      } finally {
        providerRegistry.getForModel = originalGetForModel;
        providerRegistry.getCurrentModel = originalGetCurrentModel;
      }

      expect(record.status).toBe('completed');
      expect(record.completedAt).toBeDefined();
      expect(record.error).toBeUndefined();
    });

    test('sets status to failed when provider throws', async () => {
      const { providerRegistry } = await import('../../providers/registry.ts');
      const originalGetForModel = providerRegistry.getForModel.bind(providerRegistry);
      const originalGetCurrentModel = providerRegistry.getCurrentModel.bind(providerRegistry);

      const errorProvider: LLMProvider = {
        name: 'error-provider',
        models: ['mock-model'],
        chat: mock(async () => { throw new Error('API unavailable'); }),
      };
      providerRegistry.getForModel = mock(() => errorProvider);
      providerRegistry.getCurrentModel = mock(() => ({
        id: 'mock-model',
        provider: 'mock',
        displayName: 'Mock',
        description: '',
        capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192,
        selectable: true,
      }));

      const record = makeRecord();
      try {
        await orchestrator.runAgent(record);
      } finally {
        providerRegistry.getForModel = originalGetForModel;
        providerRegistry.getCurrentModel = originalGetCurrentModel;
      }

      expect(record.status).toBe('failed');
      expect(record.error).toContain('API unavailable');
      expect(record.completedAt).toBeDefined();
    });

    test('sets status to failed when model is not in registry', async () => {
      const record = makeRecord({ model: 'nonexistent-model-xyz' });
      await orchestrator.runAgent(record);

      expect(record.status).toBe('failed');
      expect(record.error).toContain('nonexistent-model-xyz');
    });

    test('never throws — all errors captured in record.error', async () => {
      const record = makeRecord({ model: 'completely-invalid-model' });

      // Must not throw
      await expect(orchestrator.runAgent(record)).resolves.toBeUndefined();
      expect(record.status).toBe('failed');
    });
  });

  // -------------------------------------------------------------------------
  // Turn loop
  // -------------------------------------------------------------------------

  describe('turn loop', () => {
    test('single turn with no tool calls completes immediately', async () => {
      const provider = makeMockProvider([{ content: 'Hello world!' }]);
      const { providerRegistry } = await import('../../providers/registry.ts');
      const originalGetForModel = providerRegistry.getForModel.bind(providerRegistry);
      const originalGetCurrentModel = providerRegistry.getCurrentModel.bind(providerRegistry);
      providerRegistry.getForModel = mock(() => provider);
      providerRegistry.getCurrentModel = mock(() => ({
        id: 'mock-model', provider: 'mock', displayName: 'Mock', description: '',
        capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192, selectable: true,
      }));

      const record = makeRecord();
      try {
        await orchestrator.runAgent(record);
      } finally {
        providerRegistry.getForModel = originalGetForModel;
        providerRegistry.getCurrentModel = originalGetCurrentModel;
      }

      expect(record.status).toBe('completed');
      expect(record.toolCallCount).toBe(0);
      // provider.chat should have been called exactly once
      expect((provider.chat as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    });

    test('tool call loop: calls LLM again after executing tools', async () => {
      // First response: one tool call
      // Second response: final text (no more tool calls)
      const provider = makeMockProvider([
        {
          content: '',
          toolCalls: [{ id: 'call-1', name: 'noop', arguments: {} }],
        },
        { content: 'All done.' },
      ]);

      const { providerRegistry } = await import('../../providers/registry.ts');
      const originalGetForModel = providerRegistry.getForModel.bind(providerRegistry);
      const originalGetCurrentModel = providerRegistry.getCurrentModel.bind(providerRegistry);
      providerRegistry.getForModel = mock(() => provider);
      providerRegistry.getCurrentModel = mock(() => ({
        id: 'mock-model', provider: 'mock', displayName: 'Mock', description: '',
        capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192, selectable: true,
      }));

      const record = makeRecord();
      try {
        await orchestrator.runAgent(record);
      } finally {
        providerRegistry.getForModel = originalGetForModel;
        providerRegistry.getCurrentModel = originalGetCurrentModel;
      }

      expect(record.status).toBe('completed');
      // toolCallCount incremented for each tool call attempted
      expect(record.toolCallCount).toBe(1);
      // LLM called twice: once for tool call response, once for final response
      expect((provider.chat as ReturnType<typeof mock>).mock.calls.length).toBe(2);
    });

    test('tool call for unknown tool does not crash — records error in result', async () => {
      const provider = makeMockProvider([
        {
          content: '',
          toolCalls: [{ id: 'call-bad', name: 'nonexistent-tool', arguments: {} }],
        },
        { content: 'Handled.' },
      ]);

      const { providerRegistry } = await import('../../providers/registry.ts');
      const originalGetForModel = providerRegistry.getForModel.bind(providerRegistry);
      const originalGetCurrentModel = providerRegistry.getCurrentModel.bind(providerRegistry);
      providerRegistry.getForModel = mock(() => provider);
      providerRegistry.getCurrentModel = mock(() => ({
        id: 'mock-model', provider: 'mock', displayName: 'Mock', description: '',
        capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192, selectable: true,
      }));

      const record = makeRecord({ tools: [] });
      try {
        await orchestrator.runAgent(record);
      } finally {
        providerRegistry.getForModel = originalGetForModel;
        providerRegistry.getCurrentModel = originalGetCurrentModel;
      }

      // Agent completes (doesn't fail just because a tool was not found)
      expect(record.status).toBe('completed');
      expect(record.toolCallCount).toBe(1);
    });

    test('multi-tool call in single turn increments toolCallCount per call', async () => {
      const provider = makeMockProvider([
        {
          content: '',
          toolCalls: [
            { id: 'call-a', name: 'tool-a', arguments: {} },
            { id: 'call-b', name: 'tool-b', arguments: {} },
          ],
        },
        { content: 'Done.' },
      ]);

      const { providerRegistry } = await import('../../providers/registry.ts');
      const originalGetForModel = providerRegistry.getForModel.bind(providerRegistry);
      const originalGetCurrentModel = providerRegistry.getCurrentModel.bind(providerRegistry);
      providerRegistry.getForModel = mock(() => provider);
      providerRegistry.getCurrentModel = mock(() => ({
        id: 'mock-model', provider: 'mock', displayName: 'Mock', description: '',
        capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192, selectable: true,
      }));

      const record = makeRecord();
      try {
        await orchestrator.runAgent(record);
      } finally {
        providerRegistry.getForModel = originalGetForModel;
        providerRegistry.getCurrentModel = originalGetCurrentModel;
      }

      expect(record.toolCallCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  describe('cancellation', () => {
    test('cancellation mid-loop stops execution and does not set failed/completed', async () => {
      let callCount = 0;
      // Provider that cancels the record on the second call, simulating an external cancel
      const record = makeRecord();
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => {
          callCount++;
          if (callCount === 2) {
            // Simulate external cancellation between turns
            record.status = 'cancelled';
          }
          return {
            content: '',
            toolCalls: [{ id: `call-${callCount}`, name: 'noop', arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_use',
          };
        }),
      };

      await withMockProvider(provider, () => orchestrator.runAgent(record));

      // Status was externally set to cancelled; runAgent must respect it and return early
      expect(record.status).toBe('cancelled');
      expect(record.error).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Max turn limit
  // -------------------------------------------------------------------------

  describe('max turn limit', () => {
    test('fails with error message after exceeding MAX_TURNS', async () => {
      // Provider that always returns a tool call — would loop forever without the limit
      const provider = makeMockProvider([
        { content: '', toolCalls: [{ id: 'call-inf', name: 'noop', arguments: {} }] },
      ]);

      const record = makeRecord();
      await withMockProvider(provider, () => orchestrator.runAgent(record));

      expect(record.status).toBe('failed');
      expect(record.error).toContain('Exceeded maximum turn limit');
      expect(record.error).toContain('50');
    });
  });

  // -------------------------------------------------------------------------
  // Scoped tool registry
  // -------------------------------------------------------------------------

  describe('scoped tool registry', () => {
    test('agent tool (agent) is excluded from scoped registry to prevent recursion', async () => {
      const provider = makeMockProvider([{ content: 'Done.' }]);
      const { providerRegistry } = await import('../../providers/registry.ts');
      const originalGetForModel = providerRegistry.getForModel.bind(providerRegistry);
      const originalGetCurrentModel = providerRegistry.getCurrentModel.bind(providerRegistry);

      let receivedTools: string[] = [];
      providerRegistry.getForModel = mock(() => ({
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (params: ChatRequest): Promise<ChatResponse> => {
          receivedTools = (params.tools ?? []).map((t) => t.name);
          return { content: 'Done.', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 }, stopReason: 'end' };
        }),
      }));
      providerRegistry.getCurrentModel = mock(() => ({
        id: 'mock-model', provider: 'mock', displayName: 'Mock', description: '',
        capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192, selectable: true,
      }));

      // Ask for 'agent' to be included — it should be filtered out
      const record = makeRecord({ tools: ['agent', 'find'] });
      try {
        await orchestrator.runAgent(record);
      } finally {
        providerRegistry.getForModel = originalGetForModel;
        providerRegistry.getCurrentModel = originalGetCurrentModel;
      }

      expect(receivedTools).not.toContain('agent');
    });
  });

  // -------------------------------------------------------------------------
  // Progress tracking
  // -------------------------------------------------------------------------

  describe('progress tracking', () => {
    test('progress is updated during execution', async () => {
      const provider = makeMockProvider([{ content: 'Completed task.' }]);
      const { providerRegistry } = await import('../../providers/registry.ts');
      const originalGetForModel = providerRegistry.getForModel.bind(providerRegistry);
      const originalGetCurrentModel = providerRegistry.getCurrentModel.bind(providerRegistry);
      providerRegistry.getForModel = mock(() => provider);
      providerRegistry.getCurrentModel = mock(() => ({
        id: 'mock-model', provider: 'mock', displayName: 'Mock', description: '',
        capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192, selectable: true,
      }));

      const record = makeRecord();
      try {
        await orchestrator.runAgent(record);
      } finally {
        providerRegistry.getForModel = originalGetForModel;
        providerRegistry.getCurrentModel = originalGetCurrentModel;
      }

      // After completion, progress should reflect the final response
      expect(record.progress).toBeDefined();
      expect(typeof record.progress).toBe('string');
      expect(record.progress!.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  describe('singleton', () => {
    test('getInstance returns the same instance each time', () => {
      AgentOrchestrator.resetInstance();
      const a = AgentOrchestrator.getInstance();
      const b = AgentOrchestrator.getInstance();
      expect(a).toBe(b);
    });

    test('resetInstance clears the singleton', () => {
      AgentOrchestrator.resetInstance();
      const a = AgentOrchestrator.getInstance();
      AgentOrchestrator.resetInstance();
      const b = AgentOrchestrator.getInstance();
      expect(a).not.toBe(b);
    });
  });
});
