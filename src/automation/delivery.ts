/**
 * Delivery policy and delivery-attempt types.
 */

import type { AutomationSurfaceKind } from './types.ts';

export type AutomationDeliveryMode = 'none' | 'webhook' | 'surface' | 'integration' | 'link';

export interface AutomationDeliveryTarget {
  readonly kind: AutomationDeliveryMode;
  readonly surfaceKind?: AutomationSurfaceKind;
  readonly address?: string;
  readonly routeId?: string;
  readonly label?: string;
}

export interface AutomationDeliveryPolicy {
  readonly mode: AutomationDeliveryMode;
  readonly targets: readonly AutomationDeliveryTarget[];
  readonly fallbackTargets: readonly AutomationDeliveryTarget[];
  readonly includeSummary: boolean;
  readonly includeTranscript: boolean;
  readonly includeLinks: boolean;
  readonly replyToRouteId?: string;
}

export interface AutomationDeliveryAttempt {
  readonly id: string;
  readonly runId: string;
  readonly jobId: string;
  readonly target: AutomationDeliveryTarget;
  readonly status: 'pending' | 'sending' | 'sent' | 'failed' | 'dead_lettered';
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly responseId?: string;
}
