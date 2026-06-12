/**
 * Tests for ProviderHealthTracker — verifies it uses SDK ProviderStatus values
 * (healthy / rate_limited / degraded / unknown) after the type convergence in E11-7.
 *
 * Covers:
 *   - onLlmResponse sets status to 'healthy' (not the old 'online')
 *   - onTurnError with rate-limit message sets status to 'rate_limited' (not 'rate-limited')
 *   - onTurnError with generic error sets status to 'degraded' (not 'error')
 *   - Initial status for a new record is 'unknown'
 *   - onProvidersChanged registers unknown providers without throwing
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
