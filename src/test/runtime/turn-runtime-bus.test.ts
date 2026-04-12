import { afterEach, describe, expect, mock, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationManager } from '../../core/conversation.ts';
import { Orchestrator } from '../../core/orchestrator.ts';
import { PermissionManager } from '../../permissions/manager.ts';
import { ConfigManager } from '../../config/manager.ts';
import { PolicyRuntimeState } from '../../runtime/permissions/policy-runtime.ts';
import type { ProviderRegistry } from '../../providers/registry.ts';
import type { ChatRequest, ChatResponse, LLMProvider } from '../../providers/interface.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { createDomainDispatch, createRuntimeStore } from '../../runtime/store/index.ts';
import { ToolRegistry } from '../../tools/registry.ts';
import { createPermissionConfigReader } from '../../permissions/manager.ts';
import { getTestProviderRegistry } from '../helpers/runtime-services.ts';

const configManager = new ConfigManager({
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
    const providerRegistry = getTestProviderRegistry();
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
        stopReason: 'end',
      })),
    };

    const orchestrator = new Orchestrator(conversation,
      () => 24,
      () => {},
      toolRegistry,
      permissions,
      () => '',
      null,
      null,
      () => {},
      runtimeBus,
    );
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
