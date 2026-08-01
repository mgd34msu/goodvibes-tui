// Deliberately per-repo test, byte-identical to the sibling product's copy by design: the module it exercises is this repo's own and has diverged from the sibling's, so the two copies prove different code and neither can stand in for the other.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConversationManager } from '../../core/conversation.ts';
import { Orchestrator } from '@pellux/goodvibes-sdk/platform/core';
import { PermissionManager, createPermissionConfigReader } from '@pellux/goodvibes-sdk/platform/permissions';
import type { ChatRequest, ChatResponse, LLMProvider } from '@pellux/goodvibes-sdk/platform/providers';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createDomainDispatch, createRuntimeStore } from '../../runtime/store/index.ts';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { ForensicsCollector } from '@/runtime/index.ts';
import { ForensicsRegistry } from '@/runtime/index.ts';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { ProviderError } from '@pellux/goodvibes-sdk/platform/types';
import type { HookResult } from '@pellux/goodvibes-sdk/platform/hooks';
import { createTestManagers } from '../helpers/test-managers.ts';

const testManagers = createTestManagers();

const DEFAULT_MODEL = {
  id: 'mock-model',
  provider: 'mock',
  registryKey: 'mock:mock-model',
  displayName: 'Mock',
  description: '',
  capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
  contextWindow: 8192,
  selectable: true,
};

const SYNTHETIC_MODEL = {
  ...DEFAULT_MODEL,
  provider: 'synthetic',
  registryKey: 'synthetic:mock-model',
  tier: 'paid',
};

async function withMockProvider<T>(
  provider: LLMProvider,
  fn: () => Promise<T>,
  model = DEFAULT_MODEL,
): Promise<T> {
  const reg = testManagers.providerRegistry;
  const origGet = reg.get.bind(reg);
  const origGetForModel = reg.getForModel.bind(reg);
  const origGetCurrentModel = reg.getCurrentModel.bind(reg);
  reg.get = mock(() => provider);
  reg.getForModel = mock(() => provider);
  reg.getCurrentModel = mock(() => model);
  try {
    return await fn();
  } finally {
    reg.get = origGet;
    reg.getForModel = origGetForModel;
    reg.getCurrentModel = origGetCurrentModel;
  }
}

function buildHarness(options: { hookResult?: HookResult } = {}) {
  mkdirSync(join(homedir(), '.goodvibes', 'tui'), { recursive: true });
  const configManager = testManagers.configManager;
  const runtimeBus = new RuntimeEventBus();
  const store = createRuntimeStore();
  const dispatch = createDomainDispatch(store);
  const registry = new ForensicsRegistry();
  const collector = new ForensicsCollector(runtimeBus, registry);
  const toolRegistry = new ToolRegistry();
  const conversation = new ConversationManager(() => 80, configManager);
  const policyRuntimeState = new PolicyRuntimeState();
  const permissions = new PermissionManager(async () => ({ approved: true }), createPermissionConfigReader(configManager), policyRuntimeState);
  const hookDispatcher = options.hookResult
    ? { fire: mock(async () => options.hookResult!) }
    : null;

  runtimeBus.onDomain('turn', (env) => dispatch.dispatchTurnEvent(env.payload));
  runtimeBus.onDomain('tools', (env) => dispatch.dispatchToolEvent(env.payload));

  const orchestrator = new Orchestrator({
    conversation,
    getViewportHeight: () => 24,
    scrollToEnd: () => {},
    toolRegistry,
    permissionManager: permissions,
    getSystemPrompt: () => '',
    hookDispatcher,
    requestRender: () => {},
    runtimeBus,
    services: {
      agentManager: new AgentManager({ configManager }),
      wrfcController: { listChains: () => [] },
    },
  });
  orchestrator.setCoreServices({
    configManager,
    providerRegistry: testManagers.providerRegistry,
  });

  return { runtimeBus, store, registry, collector, orchestrator };
}

describe('runtime substrate gate', () => {
  const configManager = testManagers.configManager;
  const savedStream = configManager.get('display.stream') as boolean;
  const realDateNow = Date.now;
  let fakeNow = 1_800_000_000_000;

  beforeEach(() => {
    Date.now = () => ++fakeNow;
  });

  afterEach(() => {
    configManager.set('display.stream', savedStream);
    Date.now = realDateNow;
  });

  test('preflight overflow fails with explicit terminal stop reason and forensic evidence', async () => {
    configManager.set('display.stream', false);
    const { orchestrator, store, registry, collector } = buildHarness();
    const provider: LLMProvider = {
      name: 'mock',
      models: ['mock-model'],
      chat: mock(async (): Promise<ChatResponse> => ({
        content: 'should not run',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'completed',
      })),
    };

    (orchestrator as unknown as { checkContextWindowPreflight: () => Promise<'error'> }).checkContextWindowPreflight =
      (async () => 'error');

    await withMockProvider(provider, () => orchestrator.handleUserInput('overflow me'));

    expect(store.getState().conversation.turnState).toBe('failed');
    expect(store.getState().conversation.lastTurnStopReason).toBe('context_overflow');
    expect(registry.latest()?.classification).toBe('max_tokens');
    collector.dispose();
  });

  test('hook denial fails with permission-style classification', async () => {
    configManager.set('display.stream', false);
    const { orchestrator, store, registry, collector } = buildHarness({
      hookResult: { ok: true, decision: 'deny', reason: 'policy blocked' },
    });
    const provider: LLMProvider = {
      name: 'mock',
      models: ['mock-model'],
      chat: mock(async (): Promise<ChatResponse> => ({
        content: 'should not run',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'completed',
      })),
    };

    await withMockProvider(provider, () => orchestrator.handleUserInput('blocked by hook'));

    expect(store.getState().conversation.turnState).toBe('failed');
    expect(store.getState().conversation.lastTurnStopReason).toBe('hook_denied');
    expect(registry.latest()?.classification).toBe('permission_denied');
    collector.dispose();
  });

  test('synthetic provider exhaustion classifies as llm_error with explicit stop reason', async () => {
    configManager.set('display.stream', false);
    const { orchestrator, store, registry, collector } = buildHarness();
    const provider: LLMProvider = {
      name: 'synthetic',
      models: ['mock-model'],
      chat: mock(async (): Promise<ChatResponse> => {
        throw new ProviderError('rate limited', 429);
      }),
    };

    await withMockProvider(provider, () => orchestrator.handleUserInput('exhausted'), SYNTHETIC_MODEL);

    expect(store.getState().conversation.turnState).toBe('failed');
    expect(store.getState().conversation.lastTurnStopReason).toBe('provider_exhausted');
    expect(registry.latest()?.classification).toBe('llm_error');
    collector.dispose();
  });

  test('abort during provider wait yields cancelled terminal state and forensics', async () => {
    configManager.set('display.stream', false);
    const { orchestrator, store, registry, collector } = buildHarness();
    const provider: LLMProvider = {
      name: 'mock',
      models: ['mock-model'],
      chat: mock(async (params: ChatRequest): Promise<ChatResponse> => {
        await new Promise((_, reject) => {
          if (params.signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          params.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
        throw new Error('unreachable');
      }),
    };

    const run = withMockProvider(provider, () => orchestrator.handleUserInput('cancel me'));
    setTimeout(() => orchestrator.abort(), 0);
    await run;

    expect(store.getState().conversation.turnState).toBe('cancelled');
    expect(store.getState().conversation.lastTurnStopReason).toBe('cancelled');
    expect(registry.latest()?.classification).toBe('cancelled');
    collector.dispose();
  });

  test('repeated all-failed tool turns trip the circuit breaker with typed terminal evidence', async () => {
    configManager.set('display.stream', false);
    const { orchestrator, store, registry, collector } = buildHarness();
    const provider: LLMProvider = {
      name: 'mock',
      models: ['mock-model'],
      chat: mock(async (): Promise<ChatResponse> => ({
        content: '',
        toolCalls: [{ id: `call-${Date.now()}-${Math.random()}`, name: 'missing_tool', arguments: {} }],
        usage: { inputTokens: 5, outputTokens: 1 },
        stopReason: 'tool_call',
      })),
    };

    await withMockProvider(provider, () => orchestrator.handleUserInput('loop forever'));

    expect(store.getState().conversation.turnState).toBe('failed');
    expect(store.getState().conversation.lastTurnStopReason).toBe('tool_loop_circuit_breaker');
    expect(registry.latest()?.classification).toBe('tool_failure');
    collector.dispose();
  });
});
