import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { LLMProvider, ChatRequest, ChatResponse } from '../../providers/interface.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal stub LLMProvider. */
function makeProvider(name: string, response: string = 'ok'): LLMProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    name,
    models: ['test-model'],
    async chat(params: ChatRequest): Promise<ChatResponse> {
      calls.push(params);
      return {
        content: response,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end',
      };
    },
    calls,
  };
}

/** Build a provider that always throws. */
function makeErrorProvider(name: string): LLMProvider {
  return {
    name,
    models: ['bad-model'],
    async chat(_params: ChatRequest): Promise<ChatResponse> {
      throw new Error('API key missing or invalid');
    },
  };
}

// ---------------------------------------------------------------------------
// We test resolveToolLLM + ToolLLM by injecting mocks into providerRegistry
// and configManager before importing the module under test.
// ---------------------------------------------------------------------------

describe('resolveToolLLM', () => {
  // Import fresh each time by resetting module state via re-import.
  // Since Bun caches modules, we directly manipulate registry + config.

  beforeEach(async () => {
    // Reset singleton between tests
    const { ToolLLM } = await import('../../config/tool-llm.ts');
    ToolLLM._reset();
  });

  test('uses explicit tools.llmProvider + tools.llmModel when both set', async () => {
    const { providerRegistry } = await import('../../providers/registry.ts');
    const { configManager } = await import('../../config/index.ts');
    const { resolveToolLLM } = await import('../../config/tool-llm.ts');

    const fakeProvider = makeProvider('test-explicit-provider');
    providerRegistry.register(fakeProvider);

    const origProvider = configManager.get('tools.llmProvider');
    const origModel = configManager.get('tools.llmModel');
    configManager.set('tools.llmProvider', 'test-explicit-provider');
    configManager.set('tools.llmModel', 'some-model');

    try {
      const resolved = resolveToolLLM();
      expect(resolved).not.toBeNull();
      expect(resolved!.provider.name).toBe('test-explicit-provider');
      expect(resolved!.modelId).toBe('some-model');
    } finally {
      // Restore original config
      configManager.set('tools.llmProvider', origProvider);
      configManager.set('tools.llmModel', origModel);
    }
  });

  test('falls back to current model when tools.llmProvider is empty', async () => {
    // getProviderRegistry() returns the underlying instance (bypasses the Proxy),
    // allowing direct method patching for test isolation.
    const { getProviderRegistry } = await import('../../providers/registry.ts');
    const { configManager } = await import('../../config/index.ts');
    const { resolveToolLLM } = await import('../../config/tool-llm.ts');

    const instance = getProviderRegistry();

    const origProvider = configManager.get('tools.llmProvider');
    const origModel = configManager.get('tools.llmModel');
    configManager.set('tools.llmProvider', '');
    configManager.set('tools.llmModel', '');

    // Stub methods on the real instance so the fallback path works regardless
    // of what providers are registered in the test environment.
    const fakeFallbackProvider = makeProvider('test-fallback-current-provider');
    const fakeFallbackDef = {
      id: 'test-fallback-model',
      provider: 'test-fallback-current-provider',
      registryKey: 'test-fallback-current-provider:test-fallback-model',
      displayName: 'Test Fallback',
      description: 'Stub',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
      contextWindow: 4096,
      selectable: true,
      tier: 'standard' as const,
    };
    const proto = Object.getPrototypeOf(instance);
    const origGetCurrent = proto.getCurrentModel;
    const origGetForModel = proto.getForModel;
    proto.getCurrentModel = () => fakeFallbackDef;
    proto.getForModel = () => fakeFallbackProvider;

    try {
      const resolved = resolveToolLLM();
      expect(resolved).not.toBeNull();
      expect(resolved!.modelId).toBe('test-fallback-model');
    } finally {
      proto.getCurrentModel = origGetCurrent;
      proto.getForModel = origGetForModel;
      configManager.set('tools.llmProvider', origProvider);
      configManager.set('tools.llmModel', origModel);
    }
  });

  test('falls back when only one of llmProvider/llmModel is set', async () => {
    // getProviderRegistry() returns the underlying instance (bypasses the Proxy),
    // allowing direct method patching for test isolation.
    const { getProviderRegistry } = await import('../../providers/registry.ts');
    const { configManager } = await import('../../config/index.ts');
    const { resolveToolLLM } = await import('../../config/tool-llm.ts');

    const instance = getProviderRegistry();

    const origProvider = configManager.get('tools.llmProvider');
    const origModel = configManager.get('tools.llmModel');
    // Only provider is set, model is empty -> should fall back
    configManager.set('tools.llmProvider', 'anthropic');
    configManager.set('tools.llmModel', '');

    // Stub methods on the real instance so the fallback path works regardless
    // of what providers are registered in the test environment.
    const fakeFallbackProvider2 = makeProvider('test-fallback-only-provider');
    const fakeFallbackDef2 = {
      id: 'test-fallback-only-model',
      provider: 'test-fallback-only-provider',
      registryKey: 'test-fallback-only-provider:test-fallback-only-model',
      displayName: 'Test Fallback Only',
      description: 'Stub',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
      contextWindow: 4096,
      selectable: true,
      tier: 'standard' as const,
    };
    const proto2 = Object.getPrototypeOf(instance);
    const origGetCurrent2 = proto2.getCurrentModel;
    const origGetForModel2 = proto2.getForModel;
    proto2.getCurrentModel = () => fakeFallbackDef2;
    proto2.getForModel = () => fakeFallbackProvider2;

    try {
      const resolved = resolveToolLLM();
      expect(resolved).not.toBeNull();
      expect(resolved!.modelId).toBe('test-fallback-only-model');
    } finally {
      proto2.getCurrentModel = origGetCurrent2;
      proto2.getForModel = origGetForModel2;
      configManager.set('tools.llmProvider', origProvider);
      configManager.set('tools.llmModel', origModel);
    }
  });

  test('returns null when explicit provider name is not registered', async () => {
    const { configManager } = await import('../../config/index.ts');
    const { resolveToolLLM } = await import('../../config/tool-llm.ts');

    const origProvider = configManager.get('tools.llmProvider');
    const origModel = configManager.get('tools.llmModel');
    configManager.set('tools.llmProvider', 'nonexistent-provider-xyz');
    configManager.set('tools.llmModel', 'some-model');

    try {
      const resolved = resolveToolLLM();
      expect(resolved).toBeNull();
    } finally {
      configManager.set('tools.llmProvider', origProvider);
      configManager.set('tools.llmModel', origModel);
    }
  });
});

describe('ToolLLM.chat', () => {
  beforeEach(async () => {
    const { ToolLLM } = await import('../../config/tool-llm.ts');
    ToolLLM._reset();
  });

  test('returns response text on success', async () => {
    const { providerRegistry } = await import('../../providers/registry.ts');
    const { configManager } = await import('../../config/index.ts');
    const { ToolLLM } = await import('../../config/tool-llm.ts');

    const fakeProvider = makeProvider('test-chat-provider', 'generated commit message');
    providerRegistry.register(fakeProvider);

    const origProvider = configManager.get('tools.llmProvider');
    const origModel = configManager.get('tools.llmModel');
    configManager.set('tools.llmProvider', 'test-chat-provider');
    configManager.set('tools.llmModel', 'test-model');

    try {
      const instance = ToolLLM.getInstance();
      const result = await instance.chat('write a commit message');
      expect(result).toBe('generated commit message');
      expect(fakeProvider.calls.length).toBe(1);
      expect(fakeProvider.calls[0].model).toBe('test-model');
      expect(fakeProvider.calls[0].messages[0]).toEqual({ role: 'user', content: 'write a commit message' });
    } finally {
      configManager.set('tools.llmProvider', origProvider);
      configManager.set('tools.llmModel', origModel);
    }
  });

  test('passes maxTokens and systemPrompt to provider', async () => {
    const { providerRegistry } = await import('../../providers/registry.ts');
    const { configManager } = await import('../../config/index.ts');
    const { ToolLLM } = await import('../../config/tool-llm.ts');

    const fakeProvider = makeProvider('test-options-provider', 'result');
    providerRegistry.register(fakeProvider);

    const origProvider = configManager.get('tools.llmProvider');
    const origModel = configManager.get('tools.llmModel');
    configManager.set('tools.llmProvider', 'test-options-provider');
    configManager.set('tools.llmModel', 'test-model');

    try {
      const instance = ToolLLM.getInstance();
      await instance.chat('prompt', { maxTokens: 256, systemPrompt: 'You are a helper.' });
      expect(fakeProvider.calls[0].maxTokens).toBe(256);
      expect(fakeProvider.calls[0].systemPrompt).toBe('You are a helper.');
    } finally {
      configManager.set('tools.llmProvider', origProvider);
      configManager.set('tools.llmModel', origModel);
    }
  });

  test('returns empty string when provider throws (no API key)', async () => {
    const { providerRegistry } = await import('../../providers/registry.ts');
    const { configManager } = await import('../../config/index.ts');
    const { ToolLLM } = await import('../../config/tool-llm.ts');

    const badProvider = makeErrorProvider('test-error-provider');
    providerRegistry.register(badProvider);

    const origProvider = configManager.get('tools.llmProvider');
    const origModel = configManager.get('tools.llmModel');
    configManager.set('tools.llmProvider', 'test-error-provider');
    configManager.set('tools.llmModel', 'bad-model');

    try {
      const instance = ToolLLM.getInstance();
      const result = await instance.chat('some prompt');
      expect(result).toBe('');
    } finally {
      configManager.set('tools.llmProvider', origProvider);
      configManager.set('tools.llmModel', origModel);
    }
  });

  test('returns empty string when no provider can be resolved', async () => {
    const { configManager } = await import('../../config/index.ts');
    const { ToolLLM } = await import('../../config/tool-llm.ts');

    const origProvider = configManager.get('tools.llmProvider');
    const origModel = configManager.get('tools.llmModel');
    configManager.set('tools.llmProvider', 'completely-unknown-provider-abc');
    configManager.set('tools.llmModel', 'no-model');

    try {
      const instance = ToolLLM.getInstance();
      const result = await instance.chat('some prompt');
      expect(result).toBe('');
    } finally {
      configManager.set('tools.llmProvider', origProvider);
      configManager.set('tools.llmModel', origModel);
    }
  });

  test('getInstance returns the same singleton', async () => {
    const { ToolLLM } = await import('../../config/tool-llm.ts');
    const a = ToolLLM.getInstance();
    const b = ToolLLM.getInstance();
    expect(a).toBe(b);
  });

  test('toolLLM export is an instance of ToolLLM with the expected interface', async () => {
    // Note: _reset() in beforeEach clears the singleton, so the module-level
    // toolLLM export won't === a freshly-created getInstance() after reset.
    // We verify it has the right type and interface instead.
    const { ToolLLM, toolLLM } = await import('../../config/tool-llm.ts');
    expect(toolLLM).toBeInstanceOf(ToolLLM);
    expect(typeof toolLLM.chat).toBe('function');
  });
});
