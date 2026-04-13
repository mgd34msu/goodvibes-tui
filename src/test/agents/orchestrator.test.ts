import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOrchestrator, summarizeToolArgs } from '../../agents/orchestrator.ts';
import type { AgentRecord } from '../../tools/agent/index.ts';
import type { LLMProvider, ChatRequest, ChatResponse } from '../../providers/interface.ts';
import { FileStateCache } from '../../state/file-cache.ts';
import { MemoryRegistry, MemoryStore } from '../../state/index.ts';
import { ProjectIndex } from '../../state/project-index.ts';
import { randomUUID } from 'node:crypto';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';

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
    orchestrationDepth: 0,
    toolCallCount: 0,
    executionProtocol: 'gather-plan-apply',
    reviewMode: 'wrfc',
    communicationLane: 'direct',
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
  registryKey: 'mock:mock-model',
  displayName: 'Mock',
  description: '',
  capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
  contextWindow: 8192,
  selectable: true,
};

/**
 * Return the actual ProviderRegistry instance that the proxy delegates to.
 */
let testProviderRegistry: ReturnType<typeof getTestRuntimeServices>['providerRegistry'] | null = null;

function getActualRegistry() {
  if (!testProviderRegistry) {
    throw new Error('testProviderRegistry not initialized');
  }
  return testProviderRegistry;
}

/**
 * Run `fn` with the actual ProviderRegistry patched to use the given provider.
 * Restores originals in a finally block.
 */
async function withMockProvider<T>(provider: LLMProvider, fn: () => Promise<T>): Promise<T> {
  const reg = getActualRegistry();
  const origGetForModel = reg.getForModel.bind(reg);
  const origGetCurrentModel = reg.getCurrentModel.bind(reg);
  reg.getForModel = mock(() => provider);
  reg.getCurrentModel = mock(() => MOCK_MODEL);
  try {
    return await fn();
  } finally {
    reg.getForModel = origGetForModel;
    reg.getCurrentModel = origGetCurrentModel;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentOrchestrator', () => {
  let memoryDbPath: string;
  let projectIndexRoot: string;
  const repoRoot = join(import.meta.dir, '..', '..', '..');
  const originalCwd = process.cwd();
  let orchestratorRuntime: ReturnType<typeof getTestRuntimeServices>;
  let memoryStore: MemoryStore;
  let memoryRegistry: MemoryRegistry;
  let fileCache: FileStateCache;
  let projectIndex: ProjectIndex;

  async function getSystemPrompt(record: AgentRecord): Promise<string> {
    // eslint-disable-next-line prefer-const
    let capturedRef: { value: ChatRequest | null } = { value: null };
    const captureProvider: LLMProvider = {
      name: 'mock',
      models: ['mock-model'],
      chat: mock(async (params: ChatRequest): Promise<ChatResponse> => {
        capturedRef.value = params;
        return {
          content: 'Task done.',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: 'end',
        };
      }),
    };

    await withMockProvider(captureProvider, async () => {
      await orchestrator.runAgent(record);
    });

    return capturedRef.value?.systemPrompt ?? '';
  }

  let orchestrator: AgentOrchestrator;

  beforeEach(async () => {
    process.chdir(repoRoot);
    resetTestRuntimeServices();
    orchestratorRuntime = getTestRuntimeServices();
    memoryDbPath = join(tmpdir(), `agent-orchestrator-${randomUUID()}.db`);
    projectIndexRoot = join(tmpdir(), `agent-orchestrator-project-${randomUUID()}`);
    memoryStore = new MemoryStore(memoryDbPath, {
      embeddingRegistry: orchestratorRuntime.memoryEmbeddingRegistry,
    });
    memoryRegistry = new MemoryRegistry(memoryStore);
    fileCache = new FileStateCache();
    projectIndex = new ProjectIndex(projectIndexRoot);
    await Promise.all([
      memoryStore.init(),
      projectIndex.load(),
    ]);
    testProviderRegistry = orchestratorRuntime.providerRegistry;
    orchestrator = new AgentOrchestrator();
    orchestrator.setRuntimeBus(orchestratorRuntime.runtimeBus);
    orchestrator.setFeatureFlagManager(orchestratorRuntime.featureFlags);
    orchestrator.setDependencies({
      fileCache,
      projectIndex,
      fileUndoManager: orchestratorRuntime.fileUndoManager,
      modeManager: orchestratorRuntime.modeManager,
      processManager: orchestratorRuntime.processManager,
      webSearchService: orchestratorRuntime.webSearchService,
      channelRegistry: orchestratorRuntime.channelPlugins,
      remoteRunnerRegistry: orchestratorRuntime.remoteRunnerRegistry,
      knowledgeService: orchestratorRuntime.knowledgeService,
      memoryRegistry,
      archetypeLoader: orchestratorRuntime.archetypeLoader,
      configManager: orchestratorRuntime.configManager,
      providerRegistry: orchestratorRuntime.providerRegistry,
      providerOptimizer: orchestratorRuntime.providerOptimizer,
      toolLLM: orchestratorRuntime.toolLLM,
      serviceRegistry: orchestratorRuntime.serviceRegistry,
      sessionOrchestration: orchestratorRuntime.sessionOrchestration,
      featureFlags: orchestratorRuntime.featureFlags,
      overflowHandler: orchestratorRuntime.overflowHandler,
      sandboxSessionRegistry: orchestratorRuntime.sandboxSessionRegistry,
      workingDirectory: repoRoot,
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    memoryStore?.close();
    await projectIndex?.dispose();
    if (existsSync(memoryDbPath)) unlinkSync(memoryDbPath);
    if (existsSync(projectIndexRoot)) rmSync(projectIndexRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Status transitions
  // -------------------------------------------------------------------------

  describe('status transitions', () => {
    test('sets status to running then completed on success', async () => {
      const provider = makeMockProvider([{ content: 'Task done.' }]);
      const record = makeRecord();

      await withMockProvider(provider, () => orchestrator.runAgent(record));

      expect(record.status).toBe('completed');
      expect(record.completedAt).toBeDefined();
      expect(record.error).toBeUndefined();
    });

    test('sets status to failed when provider throws', async () => {
      const errorProvider: LLMProvider = {
        name: 'error-provider',
        models: ['mock-model'],
        chat: mock(async () => { throw new Error('API unavailable'); }),
      };

      const record = makeRecord();
      await withMockProvider(errorProvider, () => orchestrator.runAgent(record));

      expect(record.status).toBe('failed');
      expect(record.error).toContain('API unavailable');
      expect(record.completedAt).toBeDefined();
    });

    test('sets status to failed when model is not in registry', async () => {
      const origWarn = console.warn;
      console.warn = () => {};
      try {
        const record = makeRecord({ model: 'nonexistent-model-xyz' });
        await orchestrator.runAgent(record);
        expect(record.status).toBe('failed');
        expect(record.error).toContain('nonexistent-model-xyz');
      } finally {
        console.warn = origWarn;
      }
    });

    test('falls back to current model when requested model is not found', async () => {
      const provider = makeMockProvider([{ content: 'Task done via fallback.' }]);
      const reg = getActualRegistry();
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      let callCount = 0;
      reg.getForModel = mock((..._args: Parameters<typeof origGetForModel>) => {
        callCount++;
        if (callCount === 1) throw new Error('model not found');
        return provider;
      });
      reg.getCurrentModel = mock(() => MOCK_MODEL);
      try {
        const record = makeRecord({ model: 'some-other-model' });
        await orchestrator.runAgent(record);
        expect(record.status).toBe('completed');
        // getForModel called twice: once for requested model (throws), once for fallback
        expect(callCount).toBe(2);
      } finally {
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
      }
    });

    test('injects agent context and reasoning effort into provider requests', async () => {
      let captured: ChatRequest | null = null;
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (params: ChatRequest): Promise<ChatResponse> => {
          captured = params;
          return {
            content: 'Task done.',
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'end',
          };
        }),
      };
      const record = makeRecord({
        context: 'Automation execution context:\n- External content source: webhook',
        reasoningEffort: 'high',
      });

      await withMockProvider(provider, () => orchestrator.runAgent(record));

      expect(captured).not.toBeNull();
      const request = captured as unknown as ChatRequest;
      expect(request.systemPrompt).toContain('## Context');
      expect(request.systemPrompt).toContain('External content source: webhook');
      expect(request.reasoningEffort).toBe('high');
    });

    test('uses configured fallback models when the primary provider call fails', async () => {
      const primaryProvider: LLMProvider = {
        name: 'primary',
        models: ['primary-model'],
        chat: mock(async () => {
          throw new Error('primary unavailable');
        }),
      };
      const fallbackProvider: LLMProvider = {
        name: 'fallback',
        models: ['fallback-model'],
        chat: mock(async (params: ChatRequest): Promise<ChatResponse> => ({
          content: `Fallback used ${params.model}`,
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: 'end',
        })),
      };
      const reg = getActualRegistry();
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      reg.getForModel = mock((modelId: string) => modelId === 'fallback-model' ? fallbackProvider : primaryProvider);
      reg.getCurrentModel = mock(() => ({ ...MOCK_MODEL, id: 'primary-model', provider: 'primary' }));
      try {
        const record = makeRecord({ model: 'primary-model', fallbackModels: ['fallback-model'] });
        await orchestrator.runAgent(record);
        expect(record.status).toBe('completed');
        expect(fallbackProvider.chat).toHaveBeenCalled();
        expect(record.fullOutput).toContain('Fallback used fallback-model');
      } finally {
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
      }
    });

    test('never throws — all errors captured in record.error', async () => {
      const origWarn = console.warn;
      console.warn = () => {};
      try {
        const record = makeRecord({ model: 'completely-invalid-model' });

        // Must not throw
        await expect(orchestrator.runAgent(record)).resolves.toBeUndefined();
        expect(record.status).toBe('failed');
      } finally {
        console.warn = origWarn;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Turn loop
  // -------------------------------------------------------------------------

  describe('system prompt', () => {
    test('includes project context and tool guidance', async () => {
      const prompt = await getSystemPrompt(makeRecord({
        template: 'engineer',
        task: 'Inspect the repository',
        tools: ['read', 'find', 'edit', 'exec', 'agent'],
      }));

      expect(prompt).toContain('## Project');
      expect(prompt).toContain('- Directory:');
      expect(prompt).toContain('- Package manager: bun');
      expect(prompt).toContain('- TypeScript: yes');
      expect(prompt).toContain('- Entry points: src/main.ts');
      expect(prompt).not.toContain('Available tools: read, find, edit, exec, agent');
      expect(prompt).toContain('You have access to: read, find, edit, exec');
    });

    test('includes archetype-specific system prompt content when available', async () => {
      const prompt = await getSystemPrompt(makeRecord({
        template: 'engineer',
        task: 'Implement a feature',
        tools: ['read'],
      }));

      expect(prompt).toContain('## Role: Engineer');
    });

    test('injects relevant reviewed project knowledge and records the sources', async () => {
      await memoryRegistry.add({
        cls: 'runbook',
        summary: 'Use targeted runtime edits for orchestration store changes',
        detail: 'Prefer src/runtime/store paths when adjusting graph-node behavior.',
        tags: ['runtime', 'orchestration', 'store'],
        provenance: [{ kind: 'file', ref: 'src/runtime/store/index.ts' }],
        review: { state: 'reviewed', confidence: 92, reviewedBy: 'operator' },
      });

      const record = makeRecord({
        template: 'engineer',
        task: 'Update orchestration store behavior for graph nodes',
        tools: ['read', 'edit'],
        writeScope: ['src/runtime/store'],
      });
      const prompt = await getSystemPrompt(record);

      expect(prompt).toContain('Injected Project Knowledge');
      expect(prompt).toContain('Use targeted runtime edits for orchestration store changes');
      expect(record.knowledgeInjections?.length).toBeGreaterThan(0);
      expect(record.knowledgeInjections?.[0]?.reason).toContain('matched');
    });
  });

  describe('turn loop', () => {
    test('single turn with no tool calls completes immediately', async () => {
      const provider = makeMockProvider([{ content: 'Hello world!' }]);
      const record = makeRecord();

      await withMockProvider(provider, () => orchestrator.runAgent(record));

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

      const record = makeRecord();
      await withMockProvider(provider, () => orchestrator.runAgent(record));

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

      const record = makeRecord({ tools: [] });
      await withMockProvider(provider, () => orchestrator.runAgent(record));

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

      const record = makeRecord();
      await withMockProvider(provider, () => orchestrator.runAgent(record));

      expect(record.toolCallCount).toBe(2);
    });

    test('accumulates usage across turns and reasoning summaries', async () => {
      let callIndex = 0;
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (): Promise<ChatResponse> => {
          callIndex += 1;
          if (callIndex === 1) {
            return {
              content: '',
              toolCalls: [{ id: 'call-1', name: 'noop', arguments: {} }],
              usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 1 },
              stopReason: 'tool_use',
              reasoningSummary: 'plan',
            };
          }
          return {
            content: 'Done.',
            toolCalls: [],
            usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 1 },
            stopReason: 'end',
          };
        }),
      };

      const record = makeRecord();
      await withMockProvider(provider, () => orchestrator.runAgent(record));

      expect(record.status).toBe('completed');
      expect(record.usage).toEqual({
        inputTokens: 16,
        outputTokens: 10,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        llmCallCount: 2,
        turnCount: 2,
        reasoningSummaryCount: 1,
      });
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
    test('circuit breaker trips on consecutive all-error turns before MAX_TURNS', async () => {
      // Provider that always returns an unknown tool call — every turn all tools fail,
      // triggering the circuit breaker (CONSECUTIVE_ERROR_BREAK = 10) before MAX_TURNS (50)
      const provider = makeMockProvider([
        { content: '', toolCalls: [{ id: 'call-inf', name: 'noop', arguments: {} }] },
      ]);

      const record = makeRecord();
      await withMockProvider(provider, () => orchestrator.runAgent(record));

      expect(record.status).toBe('failed');
      expect(record.error).toContain('Circuit breaker tripped');
      expect(record.error).toContain('10');
    });
  });

  // -------------------------------------------------------------------------
  // Scoped tool registry
  // -------------------------------------------------------------------------

  describe('scoped tool registry', () => {
    test('agent tool (agent) is excluded from scoped registry to prevent recursion', async () => {
      let receivedTools: string[] = [];
      const captureToolsProvider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (params: ChatRequest): Promise<ChatResponse> => {
          receivedTools = (params.tools ?? []).map((t) => t.name);
          return { content: 'Done.', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 }, stopReason: 'end' };
        }),
      };

      // Ask for 'agent' to be included — it should be filtered out
      const record = makeRecord({ tools: ['agent', 'find'] });
      await withMockProvider(captureToolsProvider, () => orchestrator.runAgent(record));

      expect(receivedTools).not.toContain('agent');
    });
  });

  // -------------------------------------------------------------------------
  // Progress tracking
  // -------------------------------------------------------------------------

  describe('progress tracking', () => {
    test('progress is updated during execution', async () => {
      const provider = makeMockProvider([{ content: 'Completed task.' }]);
      const record = makeRecord();

      await withMockProvider(provider, () => orchestrator.runAgent(record));

      // After completion, progress should reflect the final response
      expect(record.progress).toBeDefined();
      expect(typeof record.progress).toBe('string');
      expect(record.progress!.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Frozen response objects (regression)
  // -------------------------------------------------------------------------

  describe('frozen response objects', () => {
    test('handles deeply frozen exec tool call without throwing readonly property error', async () => {
      // Regression: some providers (e.g. ollama-cloud/kimi) return frozen response objects.
      // The orchestrator must shallow-copy tool calls before mutating them.
      const frozenArgs = Object.freeze({ commands: Object.freeze([Object.freeze({ cmd: 'echo hello' })]) });
      const frozenToolCall = Object.freeze({ id: 'call-frozen', name: 'exec', arguments: frozenArgs });
      const frozenToolCalls = Object.freeze([frozenToolCall]);

      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => {
          // Alternate: first call returns frozen tool call, second call ends cleanly
          if ((_params.messages ?? []).some((m) => m.role === 'tool')) {
            return {
              content: 'Done.',
              toolCalls: [],
              usage: { inputTokens: 10, outputTokens: 5 },
              stopReason: 'end',
            };
          }
          return {
            content: '',
            // Cast needed: frozen array is readonly but interface expects mutable
            // Object.freeze() returns Readonly<T>, which is incompatible with the mutable Array<T> expected by ChatResponse.toolCalls.
            // The double cast bypasses TypeScript here to simulate the runtime scenario where frozen arrays reach this code path.
            toolCalls: frozenToolCalls as unknown as Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_use',
          };
        }),
      };

      const record = makeRecord({ tools: ['exec'] });

      // Must not throw "Attempted to assign to readonly property"
      await expect(
        withMockProvider(provider, () => orchestrator.runAgent(record))
      ).resolves.toBeUndefined();

      expect(record.status).toBe('completed');
      expect(record.toolCallCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  describe('summarizeToolArgs', () => {
    test('returns empty string for empty args', () => {
      expect(summarizeToolArgs({})).toBe('');
    });

    test('extracts path arg with em-dash prefix', () => {
      const result = summarizeToolArgs({ path: 'src/foo.ts' });
      expect(result).toBe(' — src/foo.ts');
    });

    test('extracts cmd arg', () => {
      const result = summarizeToolArgs({ cmd: 'npm run build' });
      expect(result).toBe(' — npm run build');
    });

    test('truncates values longer than 30 chars', () => {
      const longPath = 'src/' + 'a'.repeat(40) + '.ts';
      const result = summarizeToolArgs({ path: longPath });
      expect(result.length).toBeLessThanOrEqual(32); // ' — ' (3) + 27 + '…' (1)
      expect(result).toContain('\u2026');
    });

    test('falls back to first string value when no priority key matches', () => {
      const result = summarizeToolArgs({ unknownKey: 'some-value' });
      expect(result).toBe(' — some-value');
    });

    test('ignores non-string values', () => {
      const result = summarizeToolArgs({ count: 5, flag: true, name: 'ok' });
      expect(result).toBe(' — ok');
    });

    test('skips empty string values', () => {
      const result = summarizeToolArgs({ path: '', cmd: 'echo hi' });
      expect(result).toBe(' — echo hi');
    });
  });

});
