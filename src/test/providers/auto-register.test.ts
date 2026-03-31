/**
 * auto-register.test.ts
 *
 * Tests for src/providers/auto-register.ts — Stage 2 of the dynamic model catalog.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  autoRegisterProviders,
  isProviderRegistered,
  resolveApiKey,
  createProviderFromEntry,
  AUTO_REGISTER_CATALOG,
} from '../../providers/auto-register.ts';
import type { AutoRegisterEntry } from '../../providers/auto-register.ts';
import { _resetProviderRegistryForTesting, getProviderRegistry } from '../../providers/registry.ts';
import { OpenAICompatProvider } from '../../providers/openai-compat.ts';
import { AnthropicCompatProvider } from '../../providers/anthropic-compat.ts';
import { logger } from '../../utils/logger.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const makeEntry = (overrides: Partial<AutoRegisterEntry> = {}): AutoRegisterEntry => ({
  id: 'test-provider',
  name: 'Test Provider',
  envVars: ['TEST_PROVIDER_API_KEY'],
  baseUrl: 'https://test.example.com/v1',
  apiFormat: 'openai',
  defaultModel: 'test-model',
  seedModels: ['test-model', 'test-model-2'],
  ...overrides,
});

// ---------------------------------------------------------------------------
// isProviderRegistered
// ---------------------------------------------------------------------------

describe('isProviderRegistered', () => {
  beforeEach(() => { _resetProviderRegistryForTesting(); });
  afterEach(() => { _resetProviderRegistryForTesting(); });

  it('returns true for a built-in provider like openrouter', () => {
    // openrouter is registered as a builtin in ProviderRegistry
    expect(isProviderRegistered('openrouter')).toBe(true);
  });

  it('returns false for an unregistered provider', () => {
    expect(isProviderRegistered('totally-unknown-provider-xyz')).toBe(false);
  });

  it('returns true after manually registering a provider', () => {
    const provider = new OpenAICompatProvider({
      name: 'manual-test',
      baseURL: 'https://manual.example.com/v1',
      apiKey: 'key',
      defaultModel: 'manual-model',
      models: ['manual-model'],
    });
    getProviderRegistry().register(provider);
    expect(isProviderRegistered('manual-test')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveApiKey
// ---------------------------------------------------------------------------

describe('resolveApiKey', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  it('returns the value of the first matching env var', () => {
    process.env.TEST_PROVIDER_API_KEY = 'sk-abc-123';
    const entry = makeEntry();
    expect(resolveApiKey(entry)).toBe('sk-abc-123');
  });

  it('returns empty string when no env vars are set', () => {
    delete process.env.TEST_PROVIDER_API_KEY;
    const entry = makeEntry();
    expect(resolveApiKey(entry)).toBe('');
  });

  it('returns empty string when env var is empty string', () => {
    process.env.TEST_PROVIDER_API_KEY = '';
    const entry = makeEntry();
    expect(resolveApiKey(entry)).toBe('');
  });

  it('checks fallback env vars in order, returns first non-empty', () => {
    delete process.env.NVIDIA_API_KEY;
    process.env.NIM_API_KEY = 'nvapi-test-key';
    const entry = makeEntry({ envVars: ['NVIDIA_API_KEY', 'NIM_API_KEY'] });
    expect(resolveApiKey(entry)).toBe('nvapi-test-key');
  });

  it('prefers the first env var when multiple are set', () => {
    process.env.NVIDIA_API_KEY = 'primary-key';
    process.env.NIM_API_KEY = 'fallback-key';
    const entry = makeEntry({ envVars: ['NVIDIA_API_KEY', 'NIM_API_KEY'] });
    expect(resolveApiKey(entry)).toBe('primary-key');
  });
});

// ---------------------------------------------------------------------------
// createProviderFromEntry
// ---------------------------------------------------------------------------

describe('createProviderFromEntry', () => {
  it('creates an OpenAICompatProvider for apiFormat openai', () => {
    const entry = makeEntry({ apiFormat: 'openai' });
    const provider = createProviderFromEntry(entry, 'test-key');
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    expect(provider.name).toBe('test-provider');
  });

  it('creates an OpenAICompatProvider when apiFormat is undefined (default)', () => {
    const entry = makeEntry({ apiFormat: undefined });
    const provider = createProviderFromEntry(entry, 'test-key');
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
  });

  it('creates an AnthropicCompatProvider for apiFormat anthropic', () => {
    const entry = makeEntry({ apiFormat: 'anthropic' });
    const provider = createProviderFromEntry(entry, 'test-key');
    expect(provider).toBeInstanceOf(AnthropicCompatProvider);
    expect(provider.name).toBe('test-provider');
  });

  it('uses seedModels as the models list', () => {
    const entry = makeEntry({ seedModels: ['model-a', 'model-b'] });
    const provider = createProviderFromEntry(entry, 'test-key');
    expect(provider.models).toEqual(['model-a', 'model-b']);
  });

  it('falls back to [defaultModel] when seedModels is undefined', () => {
    const entry = makeEntry({ seedModels: undefined });
    const provider = createProviderFromEntry(entry, 'test-key');
    expect(provider.models).toEqual(['test-model']);
  });

  // Multi-endpoint routing: ZenMux anthropic endpoint
  it('creates AnthropicCompatProvider for ZenMux anthropic endpoint', () => {
    const zenmuxAnthropicEntry: AutoRegisterEntry = {
      id: 'zenmux-anthropic',
      name: 'ZenMux (Anthropic)',
      envVars: ['ZENMUX_API_KEY'],
      baseUrl: 'https://zenmux.ai/api/anthropic/v1',
      apiFormat: 'anthropic',
      defaultModel: 'claude-opus-4-6',
      seedModels: ['claude-opus-4-6', 'claude-sonnet-4-6'],
    };
    const provider = createProviderFromEntry(zenmuxAnthropicEntry, 'zenmux-key');
    expect(provider).toBeInstanceOf(AnthropicCompatProvider);
    expect(provider.name).toBe('zenmux-anthropic');
    expect(provider.models).toContain('claude-opus-4-6');
  });

  // Multi-endpoint routing: ZenMux openai endpoint
  it('creates OpenAICompatProvider for ZenMux openai endpoint', () => {
    const zenmuxOpenAIEntry: AutoRegisterEntry = {
      id: 'zenmux',
      name: 'ZenMux',
      envVars: ['ZENMUX_API_KEY'],
      baseUrl: 'https://zenmux.ai/api/v1',
      apiFormat: 'openai',
      defaultModel: 'gpt-5.4',
      seedModels: ['gpt-5.4', 'gpt-5-mini'],
    };
    const provider = createProviderFromEntry(zenmuxOpenAIEntry, 'zenmux-key');
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    expect(provider.name).toBe('zenmux');
    expect(provider.models).toContain('gpt-5.4');
  });
});

// ---------------------------------------------------------------------------
// autoRegisterProviders
// ---------------------------------------------------------------------------

describe('autoRegisterProviders', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    _resetProviderRegistryForTesting();
    process.env = { ...originalEnv };
    // Clear any potentially interfering env vars
    for (const entry of AUTO_REGISTER_CATALOG) {
      for (const v of entry.envVars) {
        delete process.env[v];
      }
    }
    delete process.env.TEST_PROVIDER_API_KEY;
  });
  afterEach(() => {
    process.env = originalEnv;
    _resetProviderRegistryForTesting();
  });

  it('registers a provider when its env var is set', () => {
    process.env.TEST_PROVIDER_API_KEY = 'sk-test';
    const catalog = [makeEntry()];

    const result = autoRegisterProviders(catalog);

    expect(result).toContain('Test Provider');
    expect(isProviderRegistered('test-provider')).toBe(true);
  });

  it('skips a provider when its env var is not set', () => {
    delete process.env.TEST_PROVIDER_API_KEY;
    const catalog = [makeEntry()];

    const result = autoRegisterProviders(catalog);

    expect(result).toHaveLength(0);
    expect(isProviderRegistered('test-provider')).toBe(false);
  });

  it('skips a provider when its env var is empty string', () => {
    process.env.TEST_PROVIDER_API_KEY = '';
    const catalog = [makeEntry()];

    const result = autoRegisterProviders(catalog);

    expect(result).toHaveLength(0);
    expect(isProviderRegistered('test-provider')).toBe(false);
  });

  it('skips already-registered providers', () => {
    // openrouter is registered as a builtin
    const catalog = [
      makeEntry({ id: 'openrouter', name: 'OpenRouter' }),
    ];
    // Set the env var so the key check passes
    process.env.TEST_PROVIDER_API_KEY = 'sk-test';

    const result = autoRegisterProviders(catalog);

    // Should skip because openrouter is already registered
    expect(result).toHaveLength(0);
  });

  it('does not duplicate providers when called twice', () => {
    process.env.TEST_PROVIDER_API_KEY = 'sk-test';
    const catalog = [makeEntry()];

    const first = autoRegisterProviders(catalog);
    const second = autoRegisterProviders(catalog);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // already registered on first call
  });

  it('returns the display name of registered providers', () => {
    process.env.GROQ_API_KEY = 'gsk-test';
    process.env.CEREBRAS_API_KEY = 'csk-test';
    const catalog = [
      makeEntry({ id: 'groq-test', name: 'Groq', envVars: ['GROQ_API_KEY'] }),
      makeEntry({ id: 'cerebras-test', name: 'Cerebras', envVars: ['CEREBRAS_API_KEY'] }),
    ];

    const result = autoRegisterProviders(catalog);

    expect(result).toContain('Groq');
    expect(result).toContain('Cerebras');
    expect(result).toHaveLength(2);
  });

  it('returns empty array when no env vars are set', () => {
    const result = autoRegisterProviders([
      makeEntry({ id: 'p1', name: 'P1', envVars: ['P1_API_KEY'] }),
      makeEntry({ id: 'p2', name: 'P2', envVars: ['P2_API_KEY'] }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('handles multi-env-var provider with first var set', () => {
    process.env.NVIDIA_API_KEY = 'nvapi-primary';
    const catalog = [
      makeEntry({
        id: 'nvidia-test',
        name: 'NVIDIA',
        envVars: ['NVIDIA_API_KEY', 'NIM_API_KEY'],
        baseUrl: 'https://integrate.api.nvidia.com/v1',
      }),
    ];

    const result = autoRegisterProviders(catalog);
    expect(result).toContain('NVIDIA');
  });

  it('handles multi-env-var provider with only fallback var set', () => {
    delete process.env.NVIDIA_API_KEY;
    process.env.NIM_API_KEY = 'nvapi-fallback';
    const catalog = [
      makeEntry({
        id: 'nvidia-test',
        name: 'NVIDIA',
        envVars: ['NVIDIA_API_KEY', 'NIM_API_KEY'],
        baseUrl: 'https://integrate.api.nvidia.com/v1',
      }),
    ];

    const result = autoRegisterProviders(catalog);
    expect(result).toContain('NVIDIA');
  });

  // Multi-endpoint routing: ZenMux registers two providers from one key
  it('registers both ZenMux endpoints from a single ZENMUX_API_KEY', () => {
    process.env.ZENMUX_API_KEY = 'zmx-test-key';
    const catalog = [
      {
        id: 'zenmux-test',
        name: 'ZenMux',
        envVars: ['ZENMUX_API_KEY'],
        baseUrl: 'https://zenmux.ai/api/v1',
        apiFormat: 'openai' as const,
        defaultModel: 'gpt-5.4',
        seedModels: ['gpt-5.4'],
      },
      {
        id: 'zenmux-anthropic-test',
        name: 'ZenMux (Anthropic)',
        envVars: ['ZENMUX_API_KEY'],
        baseUrl: 'https://zenmux.ai/api/anthropic/v1',
        apiFormat: 'anthropic' as const,
        defaultModel: 'claude-opus-4-6',
        seedModels: ['claude-opus-4-6'],
      },
    ];

    const result = autoRegisterProviders(catalog);

    expect(result).toContain('ZenMux');
    expect(result).toContain('ZenMux (Anthropic)');
    expect(result).toHaveLength(2);
    expect(isProviderRegistered('zenmux-test')).toBe(true);
    expect(isProviderRegistered('zenmux-anthropic-test')).toBe(true);

    // Verify routing: openai endpoint → OpenAICompatProvider
    const openaiProvider = getProviderRegistry().get('zenmux-test');
    expect(openaiProvider).toBeInstanceOf(OpenAICompatProvider);

    // Verify routing: anthropic endpoint → AnthropicCompatProvider
    const anthropicProvider = getProviderRegistry().get('zenmux-anthropic-test');
    expect(anthropicProvider).toBeInstanceOf(AnthropicCompatProvider);
  });

  // Log format test
  it('writes correct log format to logger when providers are registered', () => {
    process.env.TEST_PROVIDER_API_KEY = 'sk-test';
    const logMessages: string[] = [];
    const spy = spyOn(logger, 'info').mockImplementation((msg: string) => {
      logMessages.push(msg);
    });

    try {
      autoRegisterProviders([makeEntry()]);
    } finally {
      spy.mockRestore();
    }

    const logLine = logMessages.find(m => m.includes('[auto-register]'));
    expect(logLine).toBeDefined();
    expect(logLine).toContain('Auto-registered 1 provider');
    expect(logLine).toContain('Test Provider');
  });

  it('uses singular "provider" when only one is registered', () => {
    process.env.TEST_PROVIDER_API_KEY = 'sk-test';
    const logMessages: string[] = [];
    const spy = spyOn(logger, 'info').mockImplementation((msg: string) => {
      logMessages.push(msg);
    });

    try {
      autoRegisterProviders([makeEntry()]);
    } finally {
      spy.mockRestore();
    }

    const logLine = logMessages.find(m => m.includes('[auto-register]'));
    expect(logLine).toContain('1 provider:');
    expect(logLine).not.toContain('1 providers:');
  });

  it('uses plural "providers" when multiple are registered', () => {
    process.env.P1_KEY = 'k1';
    process.env.P2_KEY = 'k2';
    const catalog = [
      makeEntry({ id: 'p1', name: 'P One', envVars: ['P1_KEY'] }),
      makeEntry({ id: 'p2', name: 'P Two', envVars: ['P2_KEY'] }),
    ];
    const logMessages: string[] = [];
    const spy = spyOn(logger, 'info').mockImplementation((msg: string) => {
      logMessages.push(msg);
    });

    try {
      autoRegisterProviders(catalog);
    } finally {
      spy.mockRestore();
    }

    const logLine = logMessages.find(m => m.includes('[auto-register]'));
    expect(logLine).toContain('2 providers:');
    expect(logLine).toContain('P One, P Two');
  });

  it('writes no log when nothing is registered', () => {
    const logMessages: string[] = [];
    const spy = spyOn(logger, 'info').mockImplementation((msg: string) => {
      logMessages.push(msg);
    });

    try {
      autoRegisterProviders([makeEntry()]); // no env var set
    } finally {
      spy.mockRestore();
    }

    const autoRegisterLogs = logMessages.filter(m => m.includes('[auto-register]'));
    expect(autoRegisterLogs).toHaveLength(0);
  });

  it('uses default catalog when no argument provided', () => {
    // Call with no arguments — should not throw
    const result = autoRegisterProviders();
    // Since no env vars are set (cleared in beforeEach), nothing registers
    expect(Array.isArray(result)).toBe(true);
  });

  it('logs to logger and excludes failing provider when register() throws', () => {
    process.env.P1_KEY = 'k1';
    process.env.P2_KEY = 'k2';
    const catalog = [
      makeEntry({ id: 'p-fail', name: 'P Fail', envVars: ['P1_KEY'] }),
      makeEntry({ id: 'p-ok', name: 'P OK', envVars: ['P2_KEY'] }),
    ];

    const warnMessages: string[] = [];
    const warnSpy = spyOn(logger, 'warn').mockImplementation((msg: string) => {
      warnMessages.push(msg);
    });

    const registry = getProviderRegistry();
    let callCount = 0;
    const registerSpy = spyOn(registry, 'register').mockImplementation((provider) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('simulated registration failure');
      }
      // Let the second provider register normally via the original
      registerSpy.mockRestore();
      registry.register(provider);
    });

    let result: string[];
    try {
      result = autoRegisterProviders(catalog);
    } finally {
      warnSpy.mockRestore();
      registerSpy.mockRestore();
    }

    // Failing provider excluded from returned names
    expect(result!).not.toContain('P Fail');

    // Succeeding provider is included
    expect(result!).toContain('P OK');
    expect(isProviderRegistered('p-ok')).toBe(true);

    // Error logged via logger.warn
    const errorLine = warnMessages.find(m => m.includes('[auto-register] Failed to register P Fail'));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain('simulated registration failure');
  });
});

// ---------------------------------------------------------------------------
// AUTO_REGISTER_CATALOG structure
// ---------------------------------------------------------------------------

describe('AUTO_REGISTER_CATALOG', () => {
  it('contains at least one entry', () => {
    expect(AUTO_REGISTER_CATALOG.length).toBeGreaterThan(0);
  });

  it('has a zenmux openai entry with correct URL', () => {
    const entry = AUTO_REGISTER_CATALOG.find(e => e.id === 'zenmux');
    expect(entry).toBeDefined();
    expect(entry!.baseUrl).toBe('https://zenmux.ai/api/v1');
    expect(entry!.apiFormat).toBe('openai');
  });

  it('has a zenmux-anthropic entry with correct URL', () => {
    const entry = AUTO_REGISTER_CATALOG.find(e => e.id === 'zenmux-anthropic');
    expect(entry).toBeDefined();
    expect(entry!.baseUrl).toBe('https://zenmux.ai/api/anthropic/v1');
    expect(entry!.apiFormat).toBe('anthropic');
  });

  it('both ZenMux entries share the same ZENMUX_API_KEY env var', () => {
    const openai = AUTO_REGISTER_CATALOG.find(e => e.id === 'zenmux');
    const anthropic = AUTO_REGISTER_CATALOG.find(e => e.id === 'zenmux-anthropic');
    expect(openai!.envVars).toContain('ZENMUX_API_KEY');
    expect(anthropic!.envVars).toContain('ZENMUX_API_KEY');
  });

  it('all entries have required fields', () => {
    for (const entry of AUTO_REGISTER_CATALOG) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(Array.isArray(entry.envVars)).toBe(true);
      expect(entry.baseUrl).toBeTruthy();
      expect(entry.defaultModel).toBeTruthy();
    }
  });

  it('all entries have unique ids', () => {
    const ids = AUTO_REGISTER_CATALOG.map(e => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
