import { afterEach, describe, expect, mock, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationManager } from '../../core/conversation.ts';
import { Orchestrator } from '@pellux/goodvibes-sdk/platform/core';
import { PermissionManager } from '@pellux/goodvibes-sdk/platform/permissions';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { ChatRequest, ChatResponse, LLMProvider } from '@pellux/goodvibes-sdk/platform/providers';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createDomainDispatch, createRuntimeStore } from '../../runtime/store/index.ts';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { createPermissionConfigReader } from '@pellux/goodvibes-sdk/platform/permissions';
import { createTestManagers } from '../helpers/test-managers.ts';

const configManager = new ConfigManager({ surfaceRoot: 'tui',
  configDir: join(tmpdir(), `gv-turn-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`),
});

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

async function withMockProvider<T>(
  reg: Pick<ProviderRegistry, 'get' | 'getForModel' | 'getCurrentModel'>,
  provider: LLMProvider,
  fn: () => Promise<T>,
): Promise<T> {
  const origGet = reg.get.bind(reg);
  const origGetForModel = reg.getForModel.bind(reg);
  const origGetCurrentModel = reg.getCurrentModel.bind(reg);
  reg.get = mock(() => provider);
  reg.getForModel = mock(() => provider);
  reg.getCurrentModel = mock(() => MOCK_MODEL);
  try {
    return await fn();
  } finally {
    reg.get = origGet;
    reg.getForModel = origGetForModel;
    reg.getCurrentModel = origGetCurrentModel;
  }
}

describe('runtime turn substrate', () => {
  const savedStream = configManager.get('display.stream') as boolean;

  afterEach(() => {
    configManager.set('display.stream', savedStream);
  });

  test('orchestrator emits typed turn events and drives the runtime store', async () => {
    const { providerRegistry } = createTestManagers();
    configManager.set('display.stream', true);

    const runtimeBus = new RuntimeEventBus();
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    const toolRegistry = new ToolRegistry();
    const conversation = new ConversationManager(() => 80);
    const policyRuntimeState = new PolicyRuntimeState();
    const permissions = new PermissionManager(async () => ({ approved: true }), createPermissionConfigReader(configManager), policyRuntimeState);
    const seen: string[] = [];

    runtimeBus.onDomain('turn', (env) => {
      seen.push(env.type);
      dispatch.dispatchTurnEvent(env.payload);
    });

    const provider: LLMProvider = {
      name: 'mock',
      models: ['mock-model'],
      chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => ({
        content: 'hello back',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'completed',
      })),
    };

    const orchestrator = new Orchestrator({
      conversation,
      getViewportHeight: () => 24,
      scrollToEnd: () => {},
      toolRegistry,
      permissionManager: permissions,
      getSystemPrompt: () => '',
      requestRender: () => {},
      runtimeBus,
      services: {
        agentManager: new AgentManager({ configManager }),
        wrfcController: { listChains: () => [] },
      },
    });
    orchestrator.setCoreServices({
      providerRegistry,
      configManager,
    });

    await withMockProvider(providerRegistry, provider, () => orchestrator.handleUserInput('hello'));

    expect(seen).toContain('TURN_SUBMITTED');
    expect(seen).toContain('LLM_RESPONSE_RECEIVED');
    expect(seen).toContain('TURN_COMPLETED');
    expect(store.getState().conversation.currentTurnId).toBeDefined();
    expect(store.getState().conversation.turnState).toBe('completed');
    expect(store.getState().conversation.totalTurns).toBe(1);
    expect(store.getState().conversation.lastTurnStopReason).toBe('completed');
  });
});
