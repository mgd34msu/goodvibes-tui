import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import {
  normalizeModelId,
  hasKeyForProvider,
  getCostFromCatalog,
  getCatalog,
  ensureCacheDir,
  _setCatalogForTesting,
  _resetForTest,
} from '../../providers/model-catalog.ts';
import type {
  CatalogProvider,
  PricingCatalog,
} from '../../providers/model-catalog.ts';

describe('normalizeModelId', () => {
  it('strips coding- prefix', () => {
    expect(normalizeModelId('coding-glm-4.7-free')).toBe('glm-4.7');
  });
  it('strips -free suffix', () => {
    expect(normalizeModelId('kimi-k2.5-free')).toBe('kimi-k2.5');
  });
  it('strips :free suffix', () => {
    expect(normalizeModelId('nvidia/nemotron-3-super:free')).toBe('nemotron-3-super');
  });
  it('strips provider namespace', () => {
    expect(normalizeModelId('z-ai/glm-4.7-flash')).toBe('glm-4.7-flash');
  });
  it('handles combined coding- prefix and -free suffix', () => {
    expect(normalizeModelId('coding-minimax-m2.1-free')).toBe('minimax-m2.1');
  });
  it('passes through clean IDs unchanged', () => {
    expect(normalizeModelId('gpt-5.2')).toBe('gpt-5.2');
  });
  it('strips openai/ namespace', () => {
    expect(normalizeModelId('openai/gpt-5.2')).toBe('gpt-5.2');
  });
  it('strips meta/ namespace', () => {
    expect(normalizeModelId('meta/llama-3.3-70b')).toBe('llama-3.3-70b');
  });
  it('strips :free from namespaced model', () => {
    expect(normalizeModelId('openai/gpt-4o:free')).toBe('gpt-4o');
  });
  it('does not strip -free- from middle of id', () => {
    const result = normalizeModelId('my-free-model');
    expect(result).not.toBe('my-model');
    expect(result).toBe('my-free-model');
  });
});

describe('hasKeyForProvider', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  it('returns true when primary env var is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';
    const provider: CatalogProvider = { id: 'openai', name: 'OpenAI', envVars: ['OPENAI_API_KEY'], baseUrl: 'https://api.openai.com/v1' };
    expect(hasKeyForProvider(provider)).toBe(true);
  });
  it('returns false when env var is not set', () => {
    delete process.env.OPENAI_API_KEY;
    const provider: CatalogProvider = { id: 'openai', name: 'OpenAI', envVars: ['OPENAI_API_KEY'], baseUrl: 'https://api.openai.com/v1' };
    expect(hasKeyForProvider(provider)).toBe(false);
  });
  it('returns false when env var is empty string', () => {
    process.env.GROQ_API_KEY = '';
    const provider: CatalogProvider = { id: 'groq', name: 'Groq', envVars: ['GROQ_API_KEY'], baseUrl: 'https://api.groq.com/openai/v1' };
    expect(hasKeyForProvider(provider)).toBe(false);
  });
  it('checks all fallback env var names', () => {
    delete process.env.NVIDIA_API_KEY;
    process.env.NIM_API_KEY = 'nvapi-test';
    const provider: CatalogProvider = { id: 'nvidia', name: 'NVIDIA', envVars: ['NVIDIA_API_KEY', 'NIM_API_KEY'], baseUrl: 'https://integrate.api.nvidia.com/v1' };
    expect(hasKeyForProvider(provider)).toBe(true);
  });
  it('returns true when any fallback env var is set', () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_HOST;
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const provider: CatalogProvider = { id: 'ollama', name: 'Ollama', envVars: ['OLLAMA_API_KEY', 'OLLAMA_HOST', 'OLLAMA_BASE_URL'], baseUrl: 'http://localhost:11434/v1' };
    expect(hasKeyForProvider(provider)).toBe(true);
  });
  it('returns false when all fallback env vars are absent', () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_BASE_URL;
    const provider: CatalogProvider = { id: 'ollama', name: 'Ollama', envVars: ['OLLAMA_API_KEY', 'OLLAMA_HOST', 'OLLAMA_BASE_URL'], baseUrl: 'http://localhost:11434/v1' };
    expect(hasKeyForProvider(provider)).toBe(false);
  });
  it('returns true for providers with no required env vars (self-hosted)', () => {
    const provider: CatalogProvider = { id: 'local-ollama', name: 'Local Ollama', envVars: [], baseUrl: 'http://localhost:11434/v1', requiresKey: false };
    expect(hasKeyForProvider(provider)).toBe(true);
  });
  it('returns true for providers with empty envVars regardless of requiresKey', () => {
    const provider: CatalogProvider = { id: 'subscription-plan', name: 'Subscription Plan', envVars: [], baseUrl: 'https://api.example.com/v1' };
    expect(hasKeyForProvider(provider)).toBe(true);
  });
});

/** Fixture catalog for getCostFromCatalog tests */
const COST_FIXTURE: PricingCatalog = {
  fetchedAt: Date.now(),
  models: [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic', pricing: { input: 3, output: 15 }, tier: 'paid' },
    { id: 'gpt-oss-120b', name: 'GPT OSS 120B', provider: 'OpenAI', pricing: { input: 0, output: 0 }, tier: 'free' },
  ],
};

describe('getCostFromCatalog', () => {
  beforeEach(() => { _resetForTest(); _setCatalogForTesting(COST_FIXTURE); });

  it('returns zero cost for :free suffix models', () => {
    expect(getCostFromCatalog('openai/gpt-4o:free')).toEqual({ input: 0, output: 0 });
  });
  it('returns correct pricing for exact-match paid model', () => {
    const cost = getCostFromCatalog('claude-sonnet-4-6');
    expect(cost.input).toBe(3);
    expect(cost.output).toBe(15);
  });
  it('returns zero cost for free-tier models in catalog', () => {
    expect(getCostFromCatalog('gpt-oss-120b')).toEqual({ input: 0, output: 0 });
  });
  it('returns zero cost for unknown models (fallback)', () => {
    expect(getCostFromCatalog('unknown-model-xyz-9999')).toEqual({ input: 0, output: 0 });
  });
  it('handles prefix/substring match for versioned model IDs', () => {
    const cost = getCostFromCatalog('claude-sonnet-4-6-20250101');
    expect(cost.input).toBe(3);
    expect(cost.output).toBe(15);
  });
  it('respects injected catalog via _setCatalogForTesting', () => {
    const customCatalog: PricingCatalog = {
      fetchedAt: Date.now(),
      models: [{ id: 'test-model', name: 'Test Model', provider: 'test', pricing: { input: 42, output: 84 }, tier: 'paid' }],
    };
    _setCatalogForTesting(customCatalog);
    const cost = getCostFromCatalog('test-model');
    expect(cost.input).toBe(42);
    expect(cost.output).toBe(84);
  });
  it('resets catalog state via _resetForTest', () => {
    const customCatalog: PricingCatalog = {
      fetchedAt: Date.now(),
      models: [{ id: 'test-model', name: 'Test Model', provider: 'test', pricing: { input: 99, output: 99 }, tier: 'paid' }],
    };
    _setCatalogForTesting(customCatalog);
    expect(getCostFromCatalog('test-model').input).toBe(99);
    _resetForTest();
    expect(getCostFromCatalog('test-model')).toEqual({ input: 0, output: 0 });
  });
});

describe('ensureCacheDir', () => {
  it('creates directory when it does not exist', () => {
    const spy = spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as never);
    ensureCacheDir('/tmp/test-cache-dir');
    expect(spy).toHaveBeenCalledWith('/tmp/test-cache-dir', { recursive: true });
    spy.mockRestore();
  });

  it('does not throw when directory already exists (EEXIST)', () => {
    const eexistError = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    const spy = spyOn(fs, 'mkdirSync').mockImplementation(() => { throw eexistError; });
    expect(() => ensureCacheDir('/tmp/existing-dir')).not.toThrow();
    spy.mockRestore();
  });

  it('logs to stderr on unexpected permission error', () => {
    const permError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation(() => { throw permError; });
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    ensureCacheDir('/root/forbidden');
    expect(stderrSpy).toHaveBeenCalled();
    const call = stderrSpy.mock.calls[0][0] as string;
    expect(call).toContain('[model-catalog]');
    expect(call).toContain('/root/forbidden');
    mkdirSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe('getCatalog', () => {
  it('returns a catalog object with getModel and findLargerContextModels', () => {
    const catalog = getCatalog();
    expect(typeof catalog.getModel).toBe('function');
    expect(typeof catalog.findLargerContextModels).toBe('function');
  });
  it('getModel returns null for unknown model IDs', () => {
    expect(getCatalog().getModel('nonexistent-model-xyz')).toBeNull();
  });
  it('findLargerContextModels returns array', () => {
    expect(Array.isArray(getCatalog().findLargerContextModels(0))).toBe(true);
  });
  it('findLargerContextModels respects limit parameter', () => {
    expect(getCatalog().findLargerContextModels(0, undefined, 2).length).toBeLessThanOrEqual(2);
  });
  it('findLargerContextModels returns results sorted by context descending', () => {
    const results = getCatalog().findLargerContextModels(0, undefined, 10);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].context).toBeGreaterThanOrEqual(results[i].context);
    }
  });
  it('findLargerContextModels filters by minContext', () => {
    const results = getCatalog().findLargerContextModels(100_000, undefined, 20);
    for (const r of results) {
      expect(r.context).toBeGreaterThan(100_000);
    }
  });
});
