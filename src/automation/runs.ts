/**
 * First-class automation run records.
 */

import type { AutomationDeliveryAttempt } from './delivery.ts';
import type { AutomationExecutionPolicy, AutomationSessionTarget } from './session-targets.ts';
import type { AutomationEntityBase, AutomationRunStatus } from './types.ts';
import type { AutomationRouteBinding } from './routes.ts';
import type { AutomationSourceRecord } from './sources.ts';

export type AutomationRunContinuationMode =
  | 'spawn'
  | 'shared-session'
  | 'continued-live'
  | 'background';

export interface AutomationRunUsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens?: number;
}

export interface AutomationRunTelemetry {
  readonly usage: AutomationRunUsageSummary;
  readonly llmCallCount?: number;
  readonly toolCallCount?: number;
  readonly turnCount?: number;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly reasoningSummaryPresent?: boolean;
  readonly source?: 'local-agent' | 'shared-session' | 'remote-node' | 'remote-device';
}

export interface AutomationRun extends AutomationEntityBase {
  readonly jobId: string;
  readonly status: AutomationRunStatus;
  readonly agentId?: string;
  readonly triggeredBy: AutomationSourceRecord;
  readonly target: AutomationSessionTarget;
  readonly execution: AutomationExecutionPolicy;
  readonly scheduleKind?: 'at' | 'every' | 'cron';
  readonly queuedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly forceRun: boolean;
  readonly dueRun: boolean;
  readonly attempt: number;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly route?: AutomationRouteBinding;
  readonly continuationMode?: AutomationRunContinuationMode;
  readonly deliveryIds: readonly string[];
  readonly deliveryAttempts?: readonly AutomationDeliveryAttempt[];
  readonly modelId?: string;
  readonly providerId?: string;
  readonly telemetry?: AutomationRunTelemetry;
  readonly result?: unknown;
  readonly error?: string;
  readonly cancelledReason?: string;
}

export interface AutomationRunSummary {
  readonly runId: string;
  readonly jobId: string;
  readonly status: AutomationRunStatus;
  readonly startedAt?: number;
  readonly endedAt?: number;
}
