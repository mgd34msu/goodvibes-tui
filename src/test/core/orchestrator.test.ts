import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools/registry';
import { MockLLMProvider } from '../setup.ts';
import { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks/dispatcher';
import type { HookEvent, HookResult } from '@pellux/goodvibes-sdk/platform/hooks/types';
import { PermissionManager } from '@pellux/goodvibes-sdk/platform/permissions/manager';
import type { LLMProvider, ChatRequest, ChatResponse } from '@pellux/goodvibes-sdk/platform/providers/interface';
import { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { createPermissionConfigReader } from '@pellux/goodvibes-sdk/platform/permissions/manager';
import { PolicyRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-runtime';
import { createTestManagers } from '../helpers/test-managers.ts';
import { resetSettingsControlPlaneStore } from '../helpers/settings-control-plane.ts';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools/agent/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockChatResponse {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: 'end' | 'tool_use';
}

// MockLLMProvider is imported from setup.ts for shared usage.
// _makeMockProvider retained below for tests that use bun:test mock() directly.
function _makeMockProvider(responses: MockChatResponse[]) {
  let idx = 0;
  return {
    name: 'mock',
    models: ['mock-model'],
    chat: mock(async (_params: unknown) => {
      const resp = responses[idx] ?? responses[responses.length - 1];
      idx++;
      return resp;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orchestrator', () => {
  let runtimeBus: RuntimeEventBus;
  let toolRegistry: ToolRegistry;
  let testManagers: ReturnType<typeof createTestManagers>;
  let configManager: ReturnType<typeof createTestManagers>['configManager'];
  let testExecutionLock: Promise<void> = Promise.resolve();
  let releaseTestExecutionLock: (() => void) | null = null;

  beforeEach(async () => {
    await testExecutionLock;
    testExecutionLock = new Promise<void>((resolve) => {
      releaseTestExecutionLock = resolve;
    });
    testManagers = createTestManagers();
    configManager = testManagers.configManager;
    resetSettingsControlPlaneStore(configManager);
    runtimeBus = new RuntimeEventBus();
    toolRegistry = new ToolRegistry();
  });

  afterEach(() => {
    resetSettingsControlPlaneStore(configManager);
    releaseTestExecutionLock?.();
    releaseTestExecutionLock = null;
  });

  async function buildOrchestrator(renderRequest: (() => void) | null = null) {
    const { Orchestrator } = await import('../../core/orchestrator.ts');
    const { ConversationManager } = await import('../../core/conversation.ts');
    const cm = new ConversationManager(() => 80, configManager);
    const policyRuntimeState = new PolicyRuntimeState();
    const pm = new PermissionManager(async () => ({ approved: true }), createPermissionConfigReader(configManager), policyRuntimeState);
    const agentManager = new AgentManager({ configManager });
    // hookDispatcher is still optional; services are injected explicitly.
    const orch = new Orchestrator(cm, () => 24, () => {}, toolRegistry, pm, () => '', null, null, renderRequest, runtimeBus, {
      agentManager,
      wrfcController: { listChains: () => [] },
    });
    orch.setCoreServices({
      providerRegistry: testManagers.providerRegistry,
      configManager,
    });
    return { orch, cm, pm };
  }

  async function buildOrchestratorWithHooks(hookDispatcher: HookDispatcher) {
    const { Orchestrator } = await import('../../core/orchestrator.ts');
    const { ConversationManager } = await import('../../core/conversation.ts');
    const cm = new ConversationManager(() => 80, configManager);
    const policyRuntimeState = new PolicyRuntimeState();
    const pm = new PermissionManager(async () => ({ approved: true }), createPermissionConfigReader(configManager), policyRuntimeState);
    const agentManager = new AgentManager({ configManager });
    const orch = new Orchestrator(cm, () => 24, () => {}, toolRegistry, pm, () => '', hookDispatcher, null, null, runtimeBus, {
      agentManager,
      wrfcController: { listChains: () => [] },
    });
    orch.setCoreServices({
      providerRegistry: testManagers.providerRegistry,
      configManager,
    });
    return { orch, cm, pm };
  }

  /** Helper: register a tool that resolves successfully */
  function registerSuccessTool(name: string, output = 'ok'): void {
    toolRegistry.register({
      definition: { name, description: name, parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true, output }),
    });
  }

  /** Helper: register a tool that throws */
  function registerThrowingTool(name: string, message = 'boom'): void {
    toolRegistry.register({
      definition: { name, description: name, parameters: { type: 'object', properties: {} } },
      execute: async () => { throw new Error(message); },
    });
  }

  describe('Orchestrator state', () => {
    test('isThinking starts false', async () => {
      const { orch } = await buildOrchestrator();
      expect(orch.isThinking).toBe(false);
    });

    test('messageQueue starts empty', async () => {
      const { orch } = await buildOrchestrator();
      expect(orch.messageQueue).toHaveLength(0);
    });

    test('usage starts at zero', async () => {
      const { orch } = await buildOrchestrator();
      expect(orch.usage.input).toBe(0);
      expect(orch.usage.output).toBe(0);
      expect(orch.lastRequestInputTokens).toBe(0);
    });

    test('abort() does not throw when not thinking', async () => {
      const { orch } = await buildOrchestrator();
      expect(() => orch.abort()).not.toThrow();
    });

    test('getSpinner() returns a non-empty string', async () => {
      const { orch } = await buildOrchestrator();
      const spinner = orch.getSpinner();
      expect(typeof spinner).toBe('string');
      expect(spinner.length).toBeGreaterThan(0);
    });

    test('getSpinner() produces valid spinner frames at different positions', async () => {
      const { orch } = await buildOrchestrator();
      const frames = new Set<string>();
      for (let i = 0; i < 10; i++) {
        (orch as unknown as { thinkingFrame: number }).thinkingFrame = i;
        frames.add(orch.getSpinner());
      }
      // Should have multiple distinct spinner chars over 10 positions
      expect(frames.size).toBeGreaterThan(1);
    });

    test('dispose detaches replay listeners from the runtime bus', async () => {
      const { orch } = await buildOrchestrator();
      const busState = runtimeBus as unknown as {
        _listeners: Map<string, Set<unknown>>;
      };
      const before = busState._listeners.get('AGENT_COMPLETED')?.size ?? 0;
      expect(before).toBeGreaterThan(0);

      orch.dispose();

      const after = busState._listeners.get('AGENT_COMPLETED')?.size ?? 0;
      expect(after).toBe(0);
    });
  });

  describe('handleUserInput - queue behavior', () => {
    test('queues input when already thinking and emits render:request', async () => {
      let renderCount = 0;
      const { orch } = await buildOrchestrator(() => { renderCount++; });

      // Manually set thinking state to simulate in-flight request
      (orch as unknown as { isThinking: boolean }).isThinking = true;

      // This should queue, not call LLM (which would fail without a valid provider)
      orch.handleUserInput('queued message');

      expect(orch.messageQueue.map(m => m.text)).toContain('queued message');
      expect(renderCount).toBeGreaterThan(0);
    });

    test('empty input string is ignored (does not queue)', async () => {
      const { orch } = await buildOrchestrator();
      (orch as unknown as { isThinking: boolean }).isThinking = true;

      orch.handleUserInput('   '); // whitespace only
      expect(orch.messageQueue).toHaveLength(0);
    });

    test('multiple queued messages accumulate in order', async () => {
      const { orch } = await buildOrchestrator();
      (orch as unknown as { isThinking: boolean }).isThinking = true;

      orch.handleUserInput('first');
      orch.handleUserInput('second');
      orch.handleUserInput('third');

      expect(orch.messageQueue.map(m => m.text)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('token accounting', () => {
    let savedAutoApprove: boolean;
    let savedStream: boolean;
    const mockModel = {
      id: 'mock-model',
      provider: 'mock',
      registryKey: 'mock:mock-model',
      displayName: 'Mock',
      description: '',
      capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
      contextWindow: 8192,
      selectable: true,
    };

    beforeEach(() => {
      savedAutoApprove = (configManager.get('behavior.autoApprove') as boolean | undefined) ?? false;
      savedStream = (configManager.get('display.stream') as boolean | undefined) ?? true;
      configManager.set('behavior.autoApprove', true);
    });

    afterEach(() => {
      configManager.set('behavior.autoApprove', savedAutoApprove);
      configManager.set('display.stream', savedStream);
    });

    test('non-streaming turns still advance live output counters via hidden deltas', async () => {
      configManager.set('display.stream', false);
      let maxSeenInput = 0;
      let maxSeenOutput = 0;

      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (params: ChatRequest): Promise<ChatResponse> => {
          params.onDelta?.({ content: 'hello' });
          params.onDelta?.({ content: ' world' });
          return {
            content: 'hello world',
            toolCalls: [],
            usage: { inputTokens: 42, outputTokens: 11 },
            stopReason: 'end',
          };
        }),
      };

      let orchRef: Awaited<ReturnType<typeof buildOrchestrator>>['orch'] | null = null;
      const { orch } = await buildOrchestrator(() => {
        if (orchRef) {
          maxSeenInput = Math.max(maxSeenInput, orchRef.streamingInputTokens);
          maxSeenOutput = Math.max(maxSeenOutput, orchRef.streamingOutputTokens);
        }
      });
      orchRef = orch;

      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => mockModel);
      try {
        await orch.handleUserInput('say hello');
      } finally {
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
      }

      expect(maxSeenInput).toBeGreaterThan(0);
      expect(maxSeenOutput).toBeGreaterThanOrEqual(2);
      expect(orch.usage.output).toBe(11);
    });

    test('reasoning-only deltas still advance live output counters', async () => {
      configManager.set('display.stream', false);
      let maxSeenOutput = 0;

      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (params: ChatRequest): Promise<ChatResponse> => {
          params.onDelta?.({ reasoning: 'thinking' });
          params.onDelta?.({ reasoning: ' harder' });
          return {
            content: 'done',
            toolCalls: [],
            usage: { inputTokens: 12, outputTokens: 6 },
            stopReason: 'end',
          };
        }),
      };

      let orchRef: Awaited<ReturnType<typeof buildOrchestrator>>['orch'] | null = null;
      const { orch } = await buildOrchestrator(() => {
        if (orchRef) {
          maxSeenOutput = Math.max(maxSeenOutput, orchRef.streamingOutputTokens);
        }
      });
      orchRef = orch;

      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => mockModel);
      try {
        await orch.handleUserInput('reason');
      } finally {
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
      }

      expect(maxSeenOutput).toBeGreaterThan(0);
      expect(orch.usage.output).toBe(6);
    });

    test('usage normalizes cached prompt tokens into fresh input plus cache read', async () => {
      configManager.set('display.stream', false);

      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => ({
          content: 'done',
          toolCalls: [],
          usage: { inputTokens: 15000, outputTokens: 80, cacheReadTokens: 14900 },
          stopReason: 'end',
        })),
      };

      const { orch } = await buildOrchestrator();

      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => mockModel);
      try {
        await orch.handleUserInput('cached request');
      } finally {
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
      }

      expect(orch.usage.input).toBe(100);
      expect(orch.usage.cacheRead).toBe(14900);
      expect(orch.lastRequestInputTokens).toBe(100);
      expect(orch.lastInputTokens).toBe(15000);
    });
  });

  describe('event replay routing', () => {
    test('replay notices route through the system-message router instead of the main conversation when available', async () => {
      const replayMockModel = {
        id: 'mock-model',
        provider: 'mock',
        registryKey: 'mock:mock-model',
        displayName: 'Mock',
        description: '',
        capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192,
        selectable: true,
      };
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => ({
          content: 'done',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: 'end',
        })),
      };

      const { orch, cm } = await buildOrchestrator();
      const low = mock((_message: string) => {});
      orch.setSystemMessageRouter({ low });

      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => replayMockModel);
      try {
        runtimeBus.emit('workflows', createEventEnvelope('WORKFLOW_CHAIN_FAILED', {
          type: 'WORKFLOW_CHAIN_FAILED',
          chainId: 'wrfc-1',
          reason: 'review score below threshold',
        }, {
          sessionId: 'test',
          traceId: 'test:wrfc',
          source: 'test',
        }));

        await orch.handleUserInput('turn one');
        await orch.handleUserInput('turn two');
      } finally {
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
      }

      expect(low).toHaveBeenCalledTimes(1);
      const replayMessages = cm.getMessageSnapshot().filter((message) => (
        message.role === 'system' && message.content.includes('[Replay]')
      ));
      expect(replayMessages).toHaveLength(0);
    });
  });

  describe('conversation follow-ups', () => {
    test('queued follow-ups emit a short assistant acknowledgement into the main conversation', async () => {
      const mockModel = {
        id: 'mock-model',
        provider: 'mock',
        registryKey: 'mock:mock-model',
        displayName: 'Mock',
        description: '',
        capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
        contextWindow: 8192,
        selectable: true,
      };
      const provider = new MockLLMProvider([{ content: 'WRFC passed and the engineer run is complete.' }]);
      const { orch, cm } = await buildOrchestrator();

      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      const origGetTokenLimitsForModel = reg.getTokenLimitsForModel.bind(reg);
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => mockModel);
      reg.getTokenLimitsForModel = mock(() => ({
        maxOutputTokens: 512,
        contextWindow: 8192,
        maxToolResultTokens: 16384,
        maxToolCalls: 32,
        maxReasoningTokens: 0,
      }));
      try {
        orch.enqueueConversationFollowUp({
          key: 'wrfc:chain-1:passed',
          summary: 'WRFC chain chain-1 passed all gates.',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
        reg.getTokenLimitsForModel = origGetTokenLimitsForModel;
      }

      const snapshot = cm.getMessageSnapshot();
      expect(snapshot.some((message) => (
        message.role === 'assistant'
        && message.content.includes('WRFC passed and the engineer run is complete.')
      ))).toBe(true);
      expect(provider.callLog).toHaveLength(1);
      const lastMessage = provider.callLog[0]?.messages.at(-1);
      expect(lastMessage?.role).toBe('user');
      expect(String(lastMessage?.content ?? '')).toContain('WRFC chain chain-1 passed all gates.');
    });
  });

  describe('registerDelegateTool', () => {
    test('registers delegate tool into the ToolRegistry', async () => {
      const { orch } = await buildOrchestrator();

      const mockAcp = {
        spawn: mock(async (_task: unknown) => 'agent-id-123'),
      } as unknown as import('@pellux/goodvibes-sdk/platform/acp/manager').AcpManager;

      orch.registerDelegateTool(mockAcp);

      expect(toolRegistry.has('delegate')).toBe(true);
    });

    test('delegate tool definition has required parameters', async () => {
      const { orch } = await buildOrchestrator();

      const mockAcp = {
        spawn: mock(async (_task: unknown) => 'agent-id'),
      } as unknown as import('@pellux/goodvibes-sdk/platform/acp/manager').AcpManager;

      orch.registerDelegateTool(mockAcp);

      const defs = toolRegistry.getToolDefinitions();
      const delegateDef = defs.find((d) => d.name === 'delegate');
      expect(delegateDef).toBeDefined();
      const params = delegateDef!.parameters as { required: string[] };
      expect(params.required).toContain('description');
      expect(params.required).toContain('context');
      expect(params.required).toContain('tools');
    });

    test('delegate tool execution calls acpManager.spawn', async () => {
      const { orch } = await buildOrchestrator();

      const spawnMock = mock(async (_task: unknown) => 'spawned-agent-id');
      const mockAcp = { spawn: spawnMock } as unknown as import('@pellux/goodvibes-sdk/platform/acp/manager').AcpManager;

      orch.registerDelegateTool(mockAcp);

      const result = await toolRegistry.execute('call-x', 'delegate', {
        description: 'Run tests',
        context: 'Run all unit tests',
        tools: ['read'],
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('spawned-agent-id');
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    test('delegate tool returns failure when acpManager is null', async () => {
      const { orch } = await buildOrchestrator();

      // Register WITHOUT calling registerDelegateTool - then directly inject
      // We test the internal null-check by accessing the tool function after registration
      // First register with a real mock to get the tool registered
      const mockAcp = { spawn: mock(async () => 'id') } as unknown as import('@pellux/goodvibes-sdk/platform/acp/manager').AcpManager;
      orch.registerDelegateTool(mockAcp);

      // Now manually clear the internal acpManager via type cast to simulate null scenario
      (orch as unknown as { acpManager: null }).acpManager = null;

      const result = await toolRegistry.execute('call-null', 'delegate', {
        description: 'task',
        context: 'ctx',
        tools: [],
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('not initialized');
    });
  });

  describe('Hook firing', () => {
    // executeToolCalls calls permissionManager.check() which blocks in 'prompt' mode.
    // Set autoApprove=true so all tools are auto-approved during hook tests.
    let savedAutoApprove: boolean;

    beforeEach(() => {
      savedAutoApprove = (configManager.get('behavior.autoApprove') as boolean | undefined) ?? false;
      configManager.set('behavior.autoApprove', true);
    });

    afterEach(() => {
      configManager.set('behavior.autoApprove', savedAutoApprove);
    });

    /** Directly call the private executeToolCalls method via type cast */
    type OrchestratorInternal = {
      executeToolCalls: (
        turnId: string,
        calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
      ) => Promise<Array<{ callId: string; success: boolean; output?: string; error?: string }>>;
    };

    test('Pre hook fires before tool execution with correct event shape', async () => {
      const dispatcher = new HookDispatcher();
      const firedEvents: HookEvent[] = [];
      dispatcher.register('Pre:tool:mytool', {
        type: 'ts',
        match: 'Pre:tool:mytool',
        path: '',
      });
      // Spy on fire instead of registering a real runner
      const origFire = dispatcher.fire.bind(dispatcher);
      const firedPaths: string[] = [];
      dispatcher.fire = async (event: HookEvent): Promise<HookResult> => {
        firedEvents.push(event);
        firedPaths.push(event.path);
        return origFire(event);
      };

      registerSuccessTool('mytool');
      const { orch } = await buildOrchestratorWithHooks(dispatcher);
      const internal = orch as unknown as OrchestratorInternal;
      await internal.executeToolCalls('turn-1', [{ id: 'c1', name: 'mytool', arguments: {} }]);

      const preEvent = firedEvents.find(e => e.phase === 'Pre');
      expect(preEvent).toBeDefined();
      expect(preEvent!.path).toBe('Pre:tool:mytool');
      expect(preEvent!.category).toBe('tool');
      expect(preEvent!.specific).toBe('mytool');
      expect(preEvent!.payload).toMatchObject({ callId: 'c1', tool: 'mytool' });
      expect(typeof preEvent!.sessionId).toBe('string');
      expect(preEvent!.sessionId.length).toBeGreaterThan(0);
    });

    test('Post hook fires after successful execution', async () => {
      const dispatcher = new HookDispatcher();
      const firedEvents: HookEvent[] = [];
      dispatcher.fire = async (event: HookEvent): Promise<HookResult> => {
        firedEvents.push(event);
        return { ok: true };
      };

      registerSuccessTool('goodtool', 'done');
      const { orch } = await buildOrchestratorWithHooks(dispatcher);
      const internal = orch as unknown as OrchestratorInternal;
      const results = await internal.executeToolCalls('turn-2', [{ id: 'c2', name: 'goodtool', arguments: {} }]);

      expect(results[0].success).toBe(true);
      const postEvent = firedEvents.find(e => e.phase === 'Post');
      expect(postEvent).toBeDefined();
      expect(postEvent!.path).toBe('Post:tool:goodtool');
      expect(postEvent!.payload).toMatchObject({ callId: 'c2', tool: 'goodtool' });
    });

    test('Fail hook fires when tool throws', async () => {
      const dispatcher = new HookDispatcher();
      const firedEvents: HookEvent[] = [];
      dispatcher.fire = async (event: HookEvent): Promise<HookResult> => {
        firedEvents.push(event);
        return { ok: true };
      };

      registerThrowingTool('badtool', 'something went wrong');
      const { orch } = await buildOrchestratorWithHooks(dispatcher);
      const internal = orch as unknown as OrchestratorInternal;
      const results = await internal.executeToolCalls('turn-3', [{ id: 'c3', name: 'badtool', arguments: {} }]);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('something went wrong');

      const failEvent = firedEvents.find(e => e.phase === 'Fail');
      expect(failEvent).toBeDefined();
      expect(failEvent!.path).toBe('Fail:tool:badtool');
      expect(failEvent!.payload).toMatchObject({ callId: 'c3', tool: 'badtool', error: 'something went wrong' });

      // Post hook must NOT fire on failure
      const postEvent = firedEvents.find(e => e.phase === 'Post');
      expect(postEvent).toBeUndefined();
    });

    test('Pre hook deny skips execution and returns denied ToolResult', async () => {
      const dispatcher = new HookDispatcher();
      const executeMock = mock(async () => ({ success: true, output: 'should not run' }));
      dispatcher.fire = async (event: HookEvent): Promise<HookResult> => {
        if (event.phase === 'Pre') {
          return { ok: true, decision: 'deny', reason: 'blocked by policy' };
        }
        return { ok: true };
      };

      // Register the tool but track whether it ran
      toolRegistry.register({
        definition: { name: 'restricted', description: 'restricted', parameters: { type: 'object', properties: {} } },
        execute: executeMock,
      });

      const { orch } = await buildOrchestratorWithHooks(dispatcher);
      const internal = orch as unknown as OrchestratorInternal;
      const results = await internal.executeToolCalls('turn-4', [{ id: 'c4', name: 'restricted', arguments: {} }]);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('blocked by policy');
      // Tool execute should never have been called
      expect(executeMock).not.toHaveBeenCalled();
    });

    test('no hooks: tool executes normally when hookDispatcher is null', async () => {
      registerSuccessTool('plaintool', 'plain result');
      const { orch } = await buildOrchestrator();
      const internal = orch as unknown as OrchestratorInternal;
      const results = await internal.executeToolCalls('turn-5', [{ id: 'c5', name: 'plaintool', arguments: {} }]);

      expect(results[0].success).toBe(true);
      expect(results[0].output).toBe('plain result');
    });

    test('hook fire() failure does not block tool execution', async () => {
      const dispatcher = new HookDispatcher();
      dispatcher.fire = async (_event: HookEvent): Promise<HookResult> => {
        throw new Error('hook system exploded');
      };

      registerSuccessTool('robusttool', 'still works');
      const { orch } = await buildOrchestratorWithHooks(dispatcher);
      const internal = orch as unknown as OrchestratorInternal;
      const results = await internal.executeToolCalls('turn-6', [{ id: 'c6', name: 'robusttool', arguments: {} }]);

      // Tool should still execute and succeed despite hook failure
      expect(results[0].success).toBe(true);
      expect(results[0].output).toBe('still works');
    });
  });

  describe('turn loop - spawn behavior', () => {
    let providerPatchLock: Promise<void> = Promise.resolve();

    /**
     * Mock model descriptor shared across spawn-behavior tests.
     * Capabilities.toolCalling must be true so the orchestrator includes tools
     * in the chat request and processes tool-use responses.
     */
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
     * Patch the actual ProviderRegistry instance (the Proxy delegates to it)
     * so getCurrentModel and getForModel return our mocks.  Restores originals
     * in a finally block.
     */
    async function withMockProvider<T>(
      provider: LLMProvider,
      fn: () => Promise<T>,
    ): Promise<T> {
      const waitForTurn = providerPatchLock;
      let releaseLock!: () => void;
      providerPatchLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      await waitForTurn;
      const reg = testManagers.providerRegistry;
      const origGet = reg.get.bind(reg);
      const origGetForModel = reg.getForModel.bind(reg);
      const origGetCurrentModel = reg.getCurrentModel.bind(reg);
      // Patch all three provider-lookup paths used by core/orchestrator.ts
      reg.get = mock(() => provider);
      reg.getForModel = mock(() => provider);
      reg.getCurrentModel = mock(() => MOCK_MODEL);
      try {
        return await fn();
      } finally {
        reg.get = origGet;
        reg.getForModel = origGetForModel;
        reg.getCurrentModel = origGetCurrentModel;
        releaseLock();
      }
    }

    /** autoApprove must be on so permission checks don't block the turn loop. */
    let savedAutoApprove: boolean;

    beforeEach(() => {
      savedAutoApprove = (configManager.get('behavior.autoApprove') as boolean | undefined) ?? false;
      configManager.set('behavior.autoApprove', true);
    });

    afterEach(() => {
      configManager.set('behavior.autoApprove', savedAutoApprove);
    });

    test('batch-spawn tool call ends the turn loop (LLM called exactly once)', async () => {
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => {
          // First (and only expected) call: return a batch-spawn agent tool call
          return {
            content: '',
            toolCalls: [{
              id: 'call-batch-1',
              name: 'agent',
              arguments: {
                mode: 'batch-spawn',
                tasks: [
                  { task: 'Write unit tests' },
                  { task: 'Write integration tests' },
                ],
              },
            }],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_use',
          };
        }),
      };

      // Register a no-op agent tool so executeToolCalls doesn't error
      toolRegistry.register({
        definition: { name: 'agent', description: 'agent', parameters: { type: 'object', properties: {}, required: ['mode'] } },
        execute: async () => ({ success: true, output: 'batch spawned' }),
      });

      const turnCompleteEvents: unknown[] = [];
      runtimeBus.on('TURN_COMPLETED', (data) => turnCompleteEvents.push(data));

      const { orch, cm } = await buildOrchestrator();

      await withMockProvider(provider, () => orch.handleUserInput('spawn two agents'));

      const messages = (
        cm as unknown as {
          messages: Array<{ role: string; callId?: string; content: unknown }>;
        }
      ).messages;
      const assistantMessages = messages.filter((message) => message.role === 'assistant');
      const toolMessages = messages.filter((message) => message.role === 'tool');
      expect(assistantMessages).toHaveLength(1);
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.callId).toBe('call-batch-1');
      expect(toolMessages[0]?.content).toBe('batch spawned');
      expect(turnCompleteEvents.length).toBeGreaterThan(0);
    });

    test('spawn tool call ends the turn loop (same behavior as batch-spawn)', async () => {
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => {
          return {
            content: '',
            toolCalls: [{
              id: 'call-spawn-1',
              name: 'agent',
              arguments: { mode: 'spawn', task: 'Write tests' },
            }],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'tool_use',
          };
        }),
      };

      toolRegistry.register({
        definition: { name: 'agent', description: 'agent', parameters: { type: 'object', properties: {}, required: ['mode'] } },
        execute: async () => ({ success: true, output: 'spawned' }),
      });

      const turnCompleteEvents: unknown[] = [];
      runtimeBus.on('TURN_COMPLETED', (data) => turnCompleteEvents.push(data));

      const { orch, cm } = await buildOrchestrator();

      await withMockProvider(provider, () => orch.handleUserInput('spawn an agent'));

      const messages = (
        cm as unknown as {
          messages: Array<{ role: string; callId?: string; content: unknown }>;
        }
      ).messages;
      const assistantMessages = messages.filter((message) => message.role === 'assistant');
      const toolMessages = messages.filter((message) => message.role === 'tool');
      expect(assistantMessages).toHaveLength(1);
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.callId).toBe('call-spawn-1');
      expect(toolMessages[0]?.content).toBe('spawned');
      expect(turnCompleteEvents.length).toBeGreaterThan(0);
    });

    test('non-spawn agent mode (status) does NOT end the turn loop early', async () => {
      let chatCallCount = 0;
      const provider: LLMProvider = {
        name: 'mock',
        models: ['mock-model'],
        chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => {
          chatCallCount++;
          if (chatCallCount === 1) {
            // First call: return an agent status tool call (not spawn)
            return {
              content: '',
              toolCalls: [{
                id: 'call-status-1',
                name: 'agent',
                arguments: { mode: 'status', agentId: 'agent-123' },
              }],
              usage: { inputTokens: 10, outputTokens: 5 },
              stopReason: 'tool_use',
            };
          }
          // Second call: finish cleanly
          return {
            content: 'Status checked.',
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'end',
          };
        }),
      };

      toolRegistry.register({
        definition: { name: 'agent', description: 'agent', parameters: { type: 'object', properties: {}, required: ['mode'] } },
        execute: async () => ({ success: true, output: 'status: running' }),
      });

      const { orch } = await buildOrchestrator();

      await withMockProvider(provider, () => orch.handleUserInput('check agent status'));

      // Status mode should NOT end the loop — LLM is called twice (tool result sent back)
      expect(chatCallCount).toBe(2);
    });
  });
});
