/**
 * auto-register.test.ts
 *
 * Tests for src/providers/auto-register.ts — Stage 2 of the dynamic model catalog.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  autoRegisterProviders,
  AUTO_REGISTER_CATALOG,
} from '@pellux/goodvibes-sdk/platform/providers';
import type { AutoRegisterEntry } from '@pellux/goodvibes-sdk/platform/providers';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { OpenAICompatProvider } from '@pellux/goodvibes-sdk/platform/providers';
import { AnthropicCompatProvider } from '@pellux/goodvibes-sdk/platform/providers';
import { createTestManagers } from '../helpers/test-managers.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

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

let providerRegistry: ProviderRegistry;

beforeEach(() => {
  providerRegistry = createTestManagers().providerRegistry;
});

function isProviderRegistered(registry: ProviderRegistry, providerId: string): boolean {
  return Boolean(registry.get(providerId));
}

// ---------------------------------------------------------------------------
// isProviderRegistered
// ---------------------------------------------------------------------------

describe('isProviderRegistered', () => {
  it('returns true for a built-in provider like openrouter', () => {
    // openrouter is registered as a builtin in ProviderRegistry
    expect(isProviderRegistered(providerRegistry, 'openrouter')).toBe(true);
  });

  it('returns false for an unregistered provider', () => {
    expect(isProviderRegistered(providerRegistry, 'totally-unknown-provider-xyz')).toBe(false);
  });

  it('returns true after manually registering a provider', () => {
    const provider = new OpenAICompatProvider({
      name: 'manual-test',
      baseURL: 'https://manual.example.com/v1',
      apiKey: 'key',
      defaultModel: 'manual-model',
      models: ['manual-model'],
    });
    providerRegistry.register(provider);
    expect(isProviderRegistered(providerRegistry, 'manual-test')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// autoRegisterProviders
// ---------------------------------------------------------------------------

describe('autoRegisterProviders', () => {
  const originalEnv = process.env;
  beforeEach(() => {
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
  });

  it('registers a provider when its env var is set', () => {
    process.env.TEST_PROVIDER_API_KEY = 'sk-test';
    const catalog = [makeEntry()];

    const result = autoRegisterProviders(providerRegistry, catalog);

    expect(result).toContain('Test Provider');
    expect(isProviderRegistered(providerRegistry, 'test-provider')).toBe(true);
  });

  it('skips a provider when its env var is not set', () => {
    delete process.env.TEST_PROVIDER_API_KEY;
    const catalog = [makeEntry()];

    const result = autoRegisterProviders(providerRegistry, catalog);

    expect(result).toHaveLength(0);
    expect(isProviderRegistered(providerRegistry, 'test-provider')).toBe(false);
  });

  it('skips a provider when its env var is empty string', () => {
    process.env.TEST_PROVIDER_API_KEY = '';
    const catalog = [makeEntry()];

    const result = autoRegisterProviders(providerRegistry, catalog);

    expect(result).toHaveLength(0);
    expect(isProviderRegistered(providerRegistry, 'test-provider')).toBe(false);
  });

  it('skips already-registered providers', () => {
    // openrouter is registered as a builtin
    const catalog = [
      makeEntry({ id: 'openrouter', name: 'OpenRouter' }),
    ];
    // Set the env var so the key check passes
    process.env.TEST_PROVIDER_API_KEY = 'sk-test';

    const result = autoRegisterProviders(providerRegistry, catalog);

    // Should skip because openrouter is already registered
    expect(result).toHaveLength(0);
  });

  it('does not duplicate providers when called twice', () => {
    process.env.TEST_PROVIDER_API_KEY = 'sk-test';
    const catalog = [makeEntry()];

    const first = autoRegisterProviders(providerRegistry, catalog);
    const second = autoRegisterProviders(providerRegistry, catalog);

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

    const result = autoRegisterProviders(providerRegistry, catalog);

    expect(result).toContain('Groq');
    expect(result).toContain('Cerebras');
    expect(result).toHaveLength(2);
  });

  it('returns empty array when no env vars are set', () => {
    const result = autoRegisterProviders(providerRegistry, [
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

    const result = autoRegisterProviders(providerRegistry, catalog);
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

    const result = autoRegisterProviders(providerRegistry, catalog);
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

    const result = autoRegisterProviders(providerRegistry, catalog);

    expect(result).toContain('ZenMux');
    expect(result).toContain('ZenMux (Anthropic)');
    expect(result).toHaveLength(2);
    expect(isProviderRegistered(providerRegistry, 'zenmux-test')).toBe(true);
    expect(isProviderRegistered(providerRegistry, 'zenmux-anthropic-test')).toBe(true);

    // Verify routing: openai endpoint → OpenAICompatProvider
    const openaiProvider = providerRegistry.get('zenmux-test');
    expect(openaiProvider).toBeInstanceOf(OpenAICompatProvider);

    // Verify routing: anthropic endpoint → AnthropicCompatProvider
    const anthropicProvider = providerRegistry.get('zenmux-anthropic-test');
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
      autoRegisterProviders(providerRegistry, [makeEntry()]);
    } finally {
      spy.mockRestore();
    }

    const logLine = logMessages.find((m: string) => m.includes('[auto-register]'));
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
      autoRegisterProviders(providerRegistry, [makeEntry()]);
    } finally {
      spy.mockRestore();
    }

    const logLine = logMessages.find((m: string) => m.includes('[auto-register]'));
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
      autoRegisterProviders(providerRegistry, catalog);
    } finally {
      spy.mockRestore();
    }

    const logLine = logMessages.find((m: string) => m.includes('[auto-register]'));
    expect(logLine).toContain('2 providers:');
    expect(logLine).toContain('P One, P Two');
  });

  it('writes no log when nothing is registered', () => {
    const logMessages: string[] = [];
    const spy = spyOn(logger, 'info').mockImplementation((msg: string) => {
      logMessages.push(msg);
    });

    try {
      autoRegisterProviders(providerRegistry, [makeEntry()]); // no env var set
    } finally {
      spy.mockRestore();
    }

    const autoRegisterLogs = logMessages.filter((m: string) => m.includes('[auto-register]'));
    expect(autoRegisterLogs).toHaveLength(0);
  });

  it('uses default catalog when no argument provided', () => {
    // Call with no arguments — should not throw
    const result = autoRegisterProviders(providerRegistry);
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

    const registry = providerRegistry;
    let callCount = 0;
    const registerSpy = spyOn(registry, 'register').mockImplementation((provider: Parameters<typeof registry.register>[0]) => {
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
      result = autoRegisterProviders(providerRegistry, catalog);
    } finally {
      warnSpy.mockRestore();
      registerSpy.mockRestore();
    }

    // Failing provider excluded from returned names
    expect(result!).not.toContain('P Fail');

    // Succeeding provider is included
    expect(result!).toContain('P OK');
    expect(isProviderRegistered(providerRegistry, 'p-ok')).toBe(true);

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
