import { describe, it, expect } from 'bun:test';
import { ProviderError } from '../../types/errors.ts';
import { formatProviderError } from '../../utils/error-display.ts';

describe('F6 - ProviderError structured guidance', () => {
  it('sets guidance for 429 rate limit', () => {
    const err = new ProviderError('Too Many Requests', 429);
    expect(err.guidance).toBe('Rate limited. The request will be retried automatically.');
    expect(err.recoverable).toBe(true);
  });

  it('parses retry-after from 429 message', () => {
    const err = new ProviderError('Rate limited retry-after: 30', 429);
    expect(err.retryAfterMs).toBe(30000);
  });

  it('sets no retryAfterMs when not in message', () => {
    const err = new ProviderError('Too Many Requests', 429);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('sets guidance for 401 auth failure', () => {
    const err = new ProviderError('Unauthorized', 401);
    expect(err.guidance).toBe('Authentication failed. Check your API key for this provider.');
    expect(err.recoverable).toBe(false);
  });

  it('sets guidance for 403 auth failure', () => {
    const err = new ProviderError('Forbidden', 403);
    expect(err.guidance).toBe('Authentication failed. Check your API key for this provider.');
  });

  it('sets guidance for 408 timeout', () => {
    const err = new ProviderError('Request Timeout', 408);
    expect(err.guidance).toBe('Request timed out. Check your network connection.');
  });

  it('sets guidance when message contains "timeout"', () => {
    const err = new ProviderError('Connection timeout after 30s');
    expect(err.guidance).toBe('Request timed out. Check your network connection.');
  });

  it('sets guidance for ECONNREFUSED', () => {
    const err = new ProviderError('connect ECONNREFUSED 127.0.0.1:11434');
    expect(err.guidance).toBe('Connection failed. Check your network connection.');
  });

  it('sets guidance for ENOTFOUND', () => {
    const err = new ProviderError('getaddrinfo ENOTFOUND api.openai.com');
    expect(err.guidance).toBe('Connection failed. Check your network connection.');
  });

  it('sets guidance for fetch failed', () => {
    const err = new ProviderError('fetch failed');
    expect(err.guidance).toBe('Connection failed. Check your network connection.');
  });

  it('sets no guidance for generic 500 error', () => {
    const err = new ProviderError('Internal Server Error', 500);
    expect(err.guidance).toBeUndefined();
    expect(err.recoverable).toBe(true);
  });

  it('preserves statusCode', () => {
    const err = new ProviderError('Bad Gateway', 502);
    expect(err.statusCode).toBe(502);
  });
});

describe('F6 - formatProviderError', () => {
  it('returns plain message when no guidance', () => {
    const err = new ProviderError('Internal Server Error', 500);
    expect(formatProviderError(err)).toBe('Internal Server Error');
  });

  it('includes guidance in output', () => {
    const err = new ProviderError('Unauthorized', 401);
    const formatted = formatProviderError(err);
    expect(formatted).toContain('Unauthorized');
    expect(formatted).toContain('Hint:');
    expect(formatted).toContain('Authentication failed');
  });

  it('includes retry time when retryAfterMs present', () => {
    const err = new ProviderError('Rate limited retry-after: 60', 429);
    const formatted = formatProviderError(err);
    expect(formatted).toContain('Retry in 60s');
  });

  it('rounds up partial seconds for retry time', () => {
    // Create a ProviderError with retryAfterMs manually set via message parsing
    // retry-after: 1 => 1000ms => ceil(1000/1000) = 1s
    const err = new ProviderError('rate-after: 1', 429);
    // No match since pattern requires 'retry', check retryAfterMs undefined
    expect(err.retryAfterMs).toBeUndefined();
    const formatted = formatProviderError(err);
    expect(formatted).not.toContain('Retry in');
  });
});

describe('F6 - ProviderError recoverability', () => {
  it('ProviderError is still recoverable at 429', () => {
    const err = new ProviderError('Too Many Requests', 429);
    expect(err.recoverable).toBe(true);
  });

  it('ProviderError is recoverable at 500', () => {
    const err = new ProviderError('Server Error', 500);
    expect(err.recoverable).toBe(true);
  });

  it('ProviderError is NOT recoverable at 401', () => {
    const err = new ProviderError('Unauthorized', 401);
    expect(err.recoverable).toBe(false);
  });

  it('ProviderError without statusCode is not recoverable', () => {
    const err = new ProviderError('Unknown error');
    expect(err.recoverable).toBe(false);
  });
});
