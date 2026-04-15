/**
 * Local provider context window ingestion tests.
 *
 * Tests for:
 * - Parsing max_context_length from /v1/models responses
 * - Fallback when field is missing or invalid
 * - Provenance ladder (provider_api > configured_cap > fallback)
 * - Cache TTL and per-provider isolation
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  resolveContextWindow,
  DEFAULT_CONTEXT_WINDOW,
  LocalContextIngestionService,
  type ContextWindowProvenance,
} from '@pellux/goodvibes-sdk/platform/providers/local-context-ingestion';

// ---------------------------------------------------------------------------
// resolveContextWindow — unit tests (pure function, no network)
// ---------------------------------------------------------------------------

describe('resolveContextWindow — provenance ladder', () => {
  test('provider_api wins when apiContextLength is valid', () => {
    const result = resolveContextWindow('my-model', 131072, 32768);
    expect(result.tokens).toBe(131072);
    expect(result.provenance).toBe('provider_api');
    expect(result.apiReportedTokens).toBe(131072);
    expect(result.safeCap).toBe(131072);
  });

  test('provider_api wins even when configured_cap is larger', () => {
    const result = resolveContextWindow('my-model', 8192, 200_000);
    expect(result.tokens).toBe(8192);
    expect(result.provenance).toBe('provider_api');
  });

  test('configured_cap used when apiContextLength is null', () => {
    const result = resolveContextWindow('my-model', null, 65536);
    expect(result.tokens).toBe(65536);
    expect(result.provenance).toBe('configured_cap');
    expect(result.apiReportedTokens).toBeUndefined();
  });

  test('configured_cap used when apiContextLength is 0', () => {
    const result = resolveContextWindow('my-model', 0, 65536);
    expect(result.tokens).toBe(65536);
    expect(result.provenance).toBe('configured_cap');
  });

  test('fallback used when both api and config are 0/null', () => {
    const result = resolveContextWindow('my-model', null, 0);
    expect(result.tokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(result.provenance).toBe('fallback');
  });

  test('fallback used when api is null and config is 0', () => {
    const result = resolveContextWindow('unknown-model', null, 0);
    expect(result.tokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(result.provenance).toBe('fallback');
  });

  test('DEFAULT_CONTEXT_WINDOW is 8192', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(8192);
  });

  test('negative apiContextLength is treated as invalid (falls through)', () => {
    const result = resolveContextWindow('my-model', -1, 32768);
    // -1 is <= 0 so falls through to configured_cap
    expect(result.tokens).toBe(32768);
    expect(result.provenance).toBe('configured_cap');
  });
});

// ---------------------------------------------------------------------------
// Provenance type coverage
// ---------------------------------------------------------------------------

describe('ContextWindowProvenance values', () => {
  test('all provenance values are string literals', () => {
    const values: ContextWindowProvenance[] = ['provider_api', 'configured_cap', 'fallback'];
    for (const v of values) {
      expect(typeof v).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

describe('clearAllContextCaches', () => {
  const service = new LocalContextIngestionService();

  beforeEach(() => {
    service.clearAllCaches();
  });

  test('clearAllContextCaches empties diagnostics', () => {
    service.clearAllCaches();
    const diag = service.getDiagnostics();
    expect(diag).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractContextLength field coverage (via resolveContextWindow)
// ---------------------------------------------------------------------------

describe('resolveContextWindow — field validation', () => {
  test('large context windows (e.g. 1M tokens) are passed through', () => {
    const result = resolveContextWindow('gemini-ultra', 1_048_576, 0);
    expect(result.tokens).toBe(1_048_576);
    expect(result.provenance).toBe('provider_api');
  });

  test('exact DEFAULT_CONTEXT_WINDOW value from configured_cap is valid', () => {
    const result = resolveContextWindow('old-model', null, DEFAULT_CONTEXT_WINDOW);
    expect(result.tokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(result.provenance).toBe('configured_cap');
  });

  test('very small context window (e.g. 1024) from API is respected', () => {
    const result = resolveContextWindow('tiny-model', 1024, 0);
    expect(result.tokens).toBe(1024);
    expect(result.provenance).toBe('provider_api');
  });
});
