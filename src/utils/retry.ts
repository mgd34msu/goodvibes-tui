import { AppError, RETRYABLE_STATUS_CODES } from '../types/errors.ts';

/** Configuration for retry behaviour with exponential backoff. */
export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
};

/** Type guard: checks if an unknown value has a numeric `statusCode` property. */
function hasStatusCode(err: unknown): err is { statusCode: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as Record<string, unknown>).statusCode === 'number'
  );
}

/** Type guard: checks if an unknown value has a numeric `status` property. */
function hasStatus(err: unknown): err is { status: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as Record<string, unknown>).status === 'number'
  );
}

/**
 * Determines whether an error should trigger a retry.
 * Checks AppError.recoverable first, then falls back to HTTP status code inspection.
 * Handles both Error subclasses and plain objects with statusCode/status properties.
 */
export function isRetryableError(error: unknown): boolean {
  // AppError with explicit recoverability flag takes priority
  if (error instanceof AppError) {
    return error.recoverable;
  }
  // Inspect statusCode / status on any object (including non-Error throwables)
  if (hasStatusCode(error)) {
    return RETRYABLE_STATUS_CODES.includes(error.statusCode);
  }
  if (hasStatus(error)) {
    return RETRYABLE_STATUS_CODES.includes(error.status);
  }
  return false;
}

function computeDelay(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  // Exponential backoff: initialDelay * 2^attempt, with jitter
  const exponential = initialDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * initialDelayMs;
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Wraps an async function with retry logic using exponential backoff.
 * Retries when `isRetryableError` returns true for the thrown error.
 *
 * @param fn - Async function to execute.
 * @param config - Optional overrides for retry behaviour.
 * @param onRetry - Optional callback invoked before each retry.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
): Promise<T> {
  const cfg: RetryConfig = { ...DEFAULT_CONFIG, ...config };
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === cfg.maxRetries) {
        break;
      }

      if (!isRetryableError(err)) {
        throw lastError;
      }

      const delayMs = computeDelay(attempt, cfg.initialDelayMs, cfg.maxDelayMs);
      onRetry?.(attempt + 1, lastError, delayMs);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
