import { describe, expect, test } from 'bun:test';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ModelDefinition, ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import {
  attachSpokenTurnModelRouting,
  createSpokenTurnInputOptions,
  resolveSpokenTurnModelOverride,
} from '../../audio/spoken-turn-model-routing.ts';

const chatModel: ModelDefinition = {
  id: 'chat-model',
  provider: 'openai',
  registryKey: 'openai:chat-model',
  displayName: 'Chat Model',
  description: '',
  contextWindow: 128000,
  capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
  selectable: true,
  tier: 'standard',
};

const ttsModel: ModelDefinition = {
  id: 'spoken-model',
  provider: 'anthropic',
  registryKey: 'anthropic:spoken-model',
  displayName: 'Spoken Model',
  description: '',
  contextWindow: 200000,
  capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
  selectable: true,
  tier: 'standard',
};

function makeConfig(values: Record<string, string>): Pick<ConfigManager, 'get'> {
  return {
    get(key: string) {
      return values[key] ?? '';
    },
  } as Pick<ConfigManager, 'get'>;
}

function makeRegistry(current = chatModel): ProviderRegistry {
  return {
    getCurrentModel: () => current,
    listModels: () => [chatModel, ttsModel],
  } as unknown as ProviderRegistry;
}

describe('spoken turn model routing', () => {
  test('uses the current chat model when no TTS LLM override is configured', () => {
    const override = resolveSpokenTurnModelOverride({
      providerRegistry: makeRegistry(),
      configManager: makeConfig({}),
    });

    expect(override).toBeNull();
  });

  test('resolves the configured TTS LLM override without changing current chat model', () => {
    const registry = makeRegistry();
    const override = resolveSpokenTurnModelOverride({
      providerRegistry: registry,
      configManager: makeConfig({
        'tts.llmProvider': 'anthropic',
        'tts.llmModel': 'anthropic:spoken-model',
      }),
    });

    expect(override?.registryKey).toBe('anthropic:spoken-model');
    expect(registry.getCurrentModel().registryKey).toBe('openai:chat-model');
  });

  test('applies the routed provider registry only to spoken turns', async () => {
    let activeRegistry = makeRegistry();
    const observedModels: string[] = [];
    const fakeOrchestrator = {
      setCoreServices(services: { providerRegistry?: ProviderRegistry }) {
        if (services.providerRegistry) activeRegistry = services.providerRegistry;
      },
      async runTurn(_text?: string, _content?: unknown, _options?: unknown) {
        observedModels.push(activeRegistry.getCurrentModel().registryKey ?? activeRegistry.getCurrentModel().id);
      },
    };

    const detach = attachSpokenTurnModelRouting({
      orchestrator: fakeOrchestrator as never,
      providerRegistry: activeRegistry,
      configManager: makeConfig({
        'tts.llmProvider': 'anthropic',
        'tts.llmModel': 'anthropic:spoken-model',
      }),
    });

    await fakeOrchestrator.runTurn();
    await fakeOrchestrator.runTurn('speak', undefined, createSpokenTurnInputOptions());
    detach();

    expect(observedModels).toEqual(['openai:chat-model', 'anthropic:spoken-model']);
    expect(activeRegistry.getCurrentModel().registryKey).toBe('openai:chat-model');
  });

  test('falls back to current chat model when the configured override is invalid', async () => {
    let activeRegistry = makeRegistry();
    const messages: string[] = [];
    const observedModels: string[] = [];
    const fakeOrchestrator = {
      setCoreServices(services: { providerRegistry?: ProviderRegistry }) {
        if (services.providerRegistry) activeRegistry = services.providerRegistry;
      },
      async runTurn(_text?: string, _content?: unknown, _options?: unknown) {
        observedModels.push(activeRegistry.getCurrentModel().registryKey ?? activeRegistry.getCurrentModel().id);
      },
    };

    attachSpokenTurnModelRouting({
      orchestrator: fakeOrchestrator as never,
      providerRegistry: activeRegistry,
      configManager: makeConfig({
        'tts.llmProvider': 'anthropic',
        'tts.llmModel': 'missing-model',
      }),
      notify: (message) => messages.push(message),
    });

    await fakeOrchestrator.runTurn('speak', undefined, createSpokenTurnInputOptions());

    expect(observedModels).toEqual(['openai:chat-model']);
    expect(messages.join('\n')).toContain("Configured TTS LLM 'missing-model' was not found");
  });
});
