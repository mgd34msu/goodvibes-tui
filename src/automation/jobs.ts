/**
 * First-class automation job records.
 */

import type { AutomationDeliveryPolicy } from './delivery.ts';
import type { AutomationFailurePolicy } from './failures.ts';
import type { AutomationScheduleDefinition } from './schedules.ts';
import type { AutomationExecutionPolicy } from './session-targets.ts';
import type { AutomationEntityBase, AutomationJobStatus } from './types.ts';
import type { AutomationSourceRecord } from './sources.ts';

export interface AutomationJob extends AutomationEntityBase {
  readonly name: string;
  readonly description?: string;
  readonly status: AutomationJobStatus;
  readonly enabled: boolean;
  readonly schedule: AutomationScheduleDefinition;
  readonly execution: AutomationExecutionPolicy;
  readonly delivery: AutomationDeliveryPolicy;
  readonly failure: AutomationFailurePolicy;
  readonly source: AutomationSourceRecord;
  readonly nextRunAt?: number;
  readonly lastRunAt?: number;
  readonly lastRunId?: string;
  readonly runCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly pausedReason?: string;
  readonly deleteAfterRun: boolean;
  readonly archivedAt?: number;
}
