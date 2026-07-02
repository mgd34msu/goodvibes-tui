/**
 * Tests for ProviderHealthTracker — verifies it uses SDK ProviderStatus values
 * (healthy / rate_limited / degraded / unknown) after the type convergence in E11-7,
 * and the WO-112 console-merge extensions:
 *   - onTurnError requires a concrete provider (no phantom 'unknown' rows)
 *   - per-provider session stats (requests, errors, tokens, cost)
 *   - buildHealthDomainState() projection into the SDK domain-state shape
 */

import { describe, expect, test } from 'bun:test';
import { ProviderHealthTracker } from '../../panels/provider-health-tracker.ts';

describe('ProviderHealthTracker — SDK ProviderStatus values', () => {
  test('initial status for a newly seen provider is unknown', () => {
    const tracker = new ProviderHealthTracker();
    tracker.onProvidersChanged(['anthropic']);

    const health = tracker.get('anthropic');
    expect(health).toBeDefined();
    expect(health!.status).toBe('unknown');
  });

  test('onLlmResponse records status as healthy (SDK value, not old online)', () => {
    const tracker = new ProviderHealthTracker();
    tracker.onLlmResponse('anthropic');

    const health = tracker.get('anthropic');
    expect(health).toBeDefined();
    expect(health!.status).toBe('healthy');
    // Must NOT be the old local-only value that diverged from SDK.
    expect(health!.status).not.toBe('online');
  });

  test('onTurnError with rate-limit keyword sets status to rate_limited (SDK value)', () => {
    const tracker = new ProviderHealthTracker();
    tracker.onTurnError('Error 429: rate limit exceeded', 'openai');

    const health = tracker.get('openai');
    expect(health).toBeDefined();
    expect(health!.status).toBe('rate_limited');
    // Must NOT be the old diverged value.
    expect(health!.status).not.toBe('rate-limited');
  });

  test('onTurnError with generic error sets status to degraded (SDK value, not error)', () => {
    const tracker = new ProviderHealthTracker();
    tracker.onTurnError('connection reset', 'anthropic');

    const health = tracker.get('anthropic');
    expect(health).toBeDefined();
    expect(health!.status).toBe('degraded');
    // Must NOT be the old diverged value.
    expect(health!.status).not.toBe('error');
  });

  test('rate_limited is set on quota-exceeded errors', () => {
    const tracker = new ProviderHealthTracker();
    tracker.onTurnError('quota exceeded for this billing period', 'gemini');

    const health = tracker.get('gemini');
    expect(health!.status).toBe('rate_limited');
  });

  test('degraded is set on auth or network errors', () => {
    const tracker = new ProviderHealthTracker();
    tracker.onTurnError('unauthorized: invalid API key', 'openai');

    // Note: auth errors that do not match rate-limit patterns fall to degraded,
    // not auth_error (auth_error is an SDK status set by the registry, not the tracker).
    const health = tracker.get('openai');
    expect(health!.status).toBe('degraded');
  });

  test('after success, status transitions from degraded to healthy', () => {
    const tracker = new ProviderHealthTracker();
    tracker.onTurnError('connection reset', 'anthropic');
    expect(tracker.get('anthropic')!.status).toBe('degraded');

    tracker.onLlmResponse('anthropic');
    expect(tracker.get('anthropic')!.status).toBe('healthy');
  });

  test('onProvidersChanged registers multiple providers without throwing', () => {
    const tracker = new ProviderHealthTracker();

    expect(() => {
      tracker.onProvidersChanged(['anthropic', 'openai', 'gemini', 'synthetic']);
    }).not.toThrow();

    expect(tracker.getAll()).toHaveLength(4);
    for (const health of tracker.getAll()) {
      expect(health.status).toBe('unknown');
    }
  });
});

describe('ProviderHealthTracker — WO-112 console merge extensions', () => {
  test('errors are attributed only to the named provider (no phantom unknown row)', () => {
    const tracker = new ProviderHealthTracker();
    tracker.onTurnError('connection reset', 'openai');

    expect(tracker.get('unknown')).toBeUndefined();
    expect(tracker.getAll().map((health) => health.name)).toEqual(['openai']);
  });

  test('accumulates per-provider session stats (requests, errors, tokens, cost)', () => {
    const tracker = new ProviderHealthTracker();
    tracker.onLlmResponse('openai', { model: 'gpt-5.4', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
    tracker.onLlmResponse('openai', { model: 'gpt-5.4', inputTokens: 200, outputTokens: 100 });
    tracker.onTurnError('boom', 'openai');

    const health = tracker.get('openai')!;
    expect(health.requests).toBe(3);
    expect(health.errors).toBe(1);
    expect(health.inputTokens).toBe(300);
    expect(health.outputTokens).toBe(150);
    expect(health.cacheReadTokens).toBe(10);
    expect(health.totalTokens).toBe(460);
    expect(health.lastModelId).toBe('gpt-5.4');
    expect(health.totalCostUsd).toBeGreaterThan(0);
  });

  test('buildHealthDomainState projects records into the SDK domain shape', () => {
    const tracker = new ProviderHealthTracker();
    tracker.onLlmResponse('openai', { model: 'gpt-5.4', inputTokens: 10, outputTokens: 5 });
    tracker.onTurnError('connection reset', 'anthropic');

    const state = tracker.buildHealthDomainState([
      { providerId: 'openai', isActive: true, isConfigured: true },
      { providerId: 'anthropic', isActive: false, isConfigured: true },
      { providerId: 'gemini', isActive: false, isConfigured: false },
    ]);

    expect(state.providers.size).toBe(3);
    expect(state.providers.get('openai')!.status).toBe('healthy');
    expect(state.providers.get('openai')!.isActive).toBe(true);
    expect(state.providers.get('openai')!.stats.successCalls).toBe(1);
    expect(state.providers.get('anthropic')!.status).toBe('degraded');
    expect(state.providers.get('anthropic')!.stats.errorCalls).toBe(1);
    expect(state.providers.get('gemini')!.status).toBe('unknown');
    expect(state.providers.get('gemini')!.isConfigured).toBe(false);
    expect(state.degradedCount).toBe(1);
    expect(state.unavailableCount).toBe(0);
    expect(state.compositeStatus).toBe('degraded');
  });

  test('tracked providers missing from meta are still projected (attribution survivability)', () => {
    const tracker = new ProviderHealthTracker();
    tracker.onTurnError('boom', 'openai');

    const state = tracker.buildHealthDomainState([]);
    expect(state.providers.get('openai')).toBeDefined();
    expect(state.providers.get('openai')!.status).toBe('degraded');
  });
});
