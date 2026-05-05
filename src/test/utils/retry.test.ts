import { describe, test, expect, mock } from 'bun:test';
import { withRetry, isRetryableError } from '@pellux/goodvibes-sdk/platform/utils';
import { AppError, ProviderError } from '@pellux/goodvibes-sdk/platform/types';

describe('isRetryableError', () => {
  test('returns false for plain Error', () => {
    expect(isRetryableError(new Error('boom'))).toBe(false);
  });

  test('returns true for AppError with recoverable=true', () => {
    const err = new AppError('oops', 'TEST', true);
    expect(isRetryableError(err)).toBe(true);
  });

  test('returns false for AppError with recoverable=false', () => {
    const err = new AppError('oops', 'TEST', false);
    expect(isRetryableError(err)).toBe(false);
  });

  test('returns true for ProviderError with retryable status 429', () => {
    expect(isRetryableError(new ProviderError('rate limited', 429))).toBe(true);
  });

  test('returns true for ProviderError with retryable status 500', () => {
    expect(isRetryableError(new ProviderError('server error', 500))).toBe(true);
  });

  test('returns true for ProviderError with retryable status 503', () => {
    expect(isRetryableError(new ProviderError('unavailable', 503))).toBe(true);
  });

  test('returns false for ProviderError with non-retryable status 400', () => {
    expect(isRetryableError(new ProviderError('bad request', 400))).toBe(false);
  });

  test('returns false for ProviderError with no status code', () => {
    expect(isRetryableError(new ProviderError('unknown'))).toBe(false);
  });

  test('returns true for plain object with retryable statusCode', () => {
    expect(isRetryableError({ statusCode: 429 })).toBe(true);
  });

  test('returns false for plain object with non-retryable statusCode', () => {
    expect(isRetryableError({ statusCode: 404 })).toBe(false);
  });

  test('returns true for plain object with retryable status', () => {
    expect(isRetryableError({ status: 503 })).toBe(true);
  });

  test('returns false for null', () => {
    expect(isRetryableError(null)).toBe(false);
  });

  test('returns false for string', () => {
    expect(isRetryableError('error string')).toBe(false);
  });
});

describe('withRetry', () => {
  test('returns result immediately when fn succeeds on first try', async () => {
    const fn = mock(async () => 'success');
    const result = await withRetry(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('throws immediately for non-retryable error', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error('non-retryable');
    };
    await expect(withRetry(fn, { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 10 })).rejects.toThrow('non-retryable');
    expect(calls).toBe(1);
  });

  test('retries on retryable error and succeeds on second attempt', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw new ProviderError('rate limited', 429);
      return 'eventually worked';
    };
    const result = await withRetry(fn, { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 10 });
    expect(result).toBe('eventually worked');
    expect(calls).toBe(2);
  });

  test('throws after maxRetries exhausted', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new ProviderError('always fails', 429);
    };
    await expect(withRetry(fn, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 })).rejects.toThrow('always fails');
    // maxRetries=2 means 3 total attempts (0, 1, 2)
    expect(calls).toBe(3);
  });

  test('calls onRetry callback with attempt number and error', async () => {
    const onRetryArgs: Array<{ attempt: number; error: Error }> = [];
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new ProviderError('temp failure', 429);
      return 'ok';
    };
    await withRetry(
      fn,
      { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5 },
      (attempt, error) => onRetryArgs.push({ attempt, error }),
    );
    expect(onRetryArgs).toHaveLength(2);
    expect(onRetryArgs[0].attempt).toBe(1);
    expect(onRetryArgs[1].attempt).toBe(2);
  });

  test('re-wraps non-Error throwables as Error', async () => {
    const fn = async () => { throw 'string error'; };
    await expect(withRetry(fn, { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 })).rejects.toBeInstanceOf(Error);
  });
});
