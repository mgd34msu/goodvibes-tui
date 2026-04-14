import { computeBackoffDelay, normalizeBackoffPolicy, type BackoffPolicy, type ResolvedBackoffPolicy } from './backoff.ts';

export interface StreamReconnectPolicy extends BackoffPolicy {
  readonly enabled?: boolean;
}

export interface ResolvedStreamReconnectPolicy extends ResolvedBackoffPolicy {
  readonly enabled: boolean;
}

export const DEFAULT_STREAM_RECONNECT_POLICY: ResolvedStreamReconnectPolicy = {
  enabled: false,
  maxAttempts: Number.POSITIVE_INFINITY,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  backoffFactor: 2,
};

export function normalizeStreamReconnectPolicy(
  policy?: StreamReconnectPolicy,
): ResolvedStreamReconnectPolicy {
  const normalized = normalizeBackoffPolicy(policy, DEFAULT_STREAM_RECONNECT_POLICY);
  return {
    ...normalized,
    enabled: policy?.enabled ?? DEFAULT_STREAM_RECONNECT_POLICY.enabled,
  };
}

export function getStreamReconnectDelay(
  attempt: number,
  policy: ResolvedStreamReconnectPolicy,
): number {
  return computeBackoffDelay(attempt, policy);
}
