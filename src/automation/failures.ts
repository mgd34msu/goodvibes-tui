/**
 * Failure policy and failure record types.
 */

export type AutomationFailureAction = 'retry' | 'cooldown' | 'disable' | 'dead_letter';
export type AutomationRetryStrategy = 'fixed' | 'linear' | 'exponential';

export interface AutomationRetryPolicy {
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly strategy: AutomationRetryStrategy;
  readonly maxDelayMs?: number;
  readonly jitterMs?: number;
}

export interface AutomationFailurePolicy {
  readonly action: AutomationFailureAction;
  readonly maxConsecutiveFailures: number;
  readonly cooldownMs: number;
  readonly retryPolicy: AutomationRetryPolicy;
  readonly deadLetterRouteId?: string;
  readonly disableAfterFailures?: boolean;
  readonly notifyRouteId?: string;
}

export interface AutomationFailureRecord {
  readonly id: string;
  readonly jobId: string;
  readonly runId?: string;
  readonly occurredAt: number;
  readonly reason: string;
  readonly action: AutomationFailureAction;
  readonly consecutiveFailures: number;
  readonly autoDisabled: boolean;
  readonly deadLetterRouteId?: string;
  readonly metadata: Record<string, unknown>;
}
