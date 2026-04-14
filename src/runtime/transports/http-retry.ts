import { computeBackoffDelay, normalizeBackoffPolicy, type BackoffPolicy, type ResolvedBackoffPolicy } from './backoff.ts';

export interface HttpRetryPolicy extends BackoffPolicy {
  readonly retryOnStatuses?: readonly number[];
  readonly retryOnMethods?: readonly string[];
  readonly retryOnNetworkError?: boolean;
}

export interface ResolvedHttpRetryPolicy extends ResolvedBackoffPolicy {
  readonly retryOnStatuses: readonly number[];
  readonly retryOnMethods: readonly string[];
  readonly retryOnNetworkError: boolean;
}

export const DEFAULT_HTTP_RETRY_POLICY: ResolvedHttpRetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  backoffFactor: 2,
  retryOnStatuses: [408, 429, 500, 502, 503, 504],
  retryOnMethods: ['GET', 'HEAD', 'OPTIONS'],
  retryOnNetworkError: true,
};

export function normalizeHttpRetryPolicy(
  policy?: HttpRetryPolicy,
): ResolvedHttpRetryPolicy {
  const normalized = normalizeBackoffPolicy(policy, DEFAULT_HTTP_RETRY_POLICY);
  return {
    ...normalized,
    retryOnStatuses: [...(policy?.retryOnStatuses ?? DEFAULT_HTTP_RETRY_POLICY.retryOnStatuses)],
    retryOnMethods: [...(policy?.retryOnMethods ?? DEFAULT_HTTP_RETRY_POLICY.retryOnMethods)].map((method) => method.toUpperCase()),
    retryOnNetworkError: policy?.retryOnNetworkError ?? DEFAULT_HTTP_RETRY_POLICY.retryOnNetworkError,
  };
}

export function resolveHttpRetryPolicy(
  defaultPolicy?: HttpRetryPolicy,
  override?: false | HttpRetryPolicy,
): ResolvedHttpRetryPolicy {
  if (override === false) {
    return normalizeHttpRetryPolicy({ maxAttempts: 1 });
  }
  const base = normalizeHttpRetryPolicy(defaultPolicy);
  if (!override) return base;
  return {
    ...base,
    ...normalizeBackoffPolicy(override, base),
    retryOnStatuses: override.retryOnStatuses ? [...override.retryOnStatuses] : base.retryOnStatuses,
    retryOnMethods: override.retryOnMethods ? override.retryOnMethods.map((method) => method.toUpperCase()) : base.retryOnMethods,
    retryOnNetworkError: override.retryOnNetworkError ?? base.retryOnNetworkError,
  };
}

export function getHttpRetryDelay(
  attempt: number,
  policy: ResolvedHttpRetryPolicy,
): number {
  return computeBackoffDelay(attempt, policy);
}

export function isRetryableHttpStatus(
  method: string,
  status: number,
  policy: ResolvedHttpRetryPolicy,
): boolean {
  return policy.retryOnMethods.includes(method.toUpperCase())
    && policy.retryOnStatuses.includes(status);
}

export function isRetryableNetworkError(
  method: string,
  policy: ResolvedHttpRetryPolicy,
): boolean {
  return policy.retryOnMethods.includes(method.toUpperCase()) && policy.retryOnNetworkError;
}
