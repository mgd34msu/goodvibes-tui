export type {
  AutomationJobStatus,
  AutomationRunStatus,
  AutomationRunTrigger,
  AutomationSurfaceKind,
  AutomationRouteKind,
  AutomationSourceKind,
  AutomationExecutionKind,
  AutomationDeliveryKind,
  AutomationEntityBase,
} from '@pellux/goodvibes-sdk/platform/automation/types';

export type {
  AutomationAtSchedule,
  AutomationEverySchedule,
  AutomationCronSchedule,
  AutomationScheduleDefinition,
  AutomationScheduleKind,
} from '@pellux/goodvibes-sdk/platform/automation/schedules';
export {
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
  parseEveryInterval,
  formatEveryInterval,
  validateSchedule,
  isRecurringTopOfHourCronExpression,
  normalizeCronStaggerMs,
  resolveDefaultCronStaggerMs,
  resolveAutomationCronStaggerMs,
  resolveStableAutomationCronOffsetMs,
  normalizeAtSchedule,
  normalizeEverySchedule,
  normalizeCronSchedule,
  getNextAutomationOccurrence,
  isAutomationDue,
} from '@pellux/goodvibes-sdk/platform/automation/schedules';

export type {
  AutomationExecutionPolicy,
  AutomationSessionTarget,
  AutomationSessionTargetKind,
  AutomationSandboxMode,
  AutomationWakeMode,
  AutomationExternalContentSource,
  AutomationExternalContentSourceKind,
} from '@pellux/goodvibes-sdk/platform/automation/session-targets';
export type { AutomationDeliveryMode, AutomationDeliveryTarget, AutomationDeliveryPolicy, AutomationDeliveryAttempt } from '@pellux/goodvibes-sdk/platform/automation/delivery';
export type { AutomationFailureAction, AutomationRetryStrategy, AutomationRetryPolicy, AutomationFailurePolicy, AutomationFailureRecord } from '@pellux/goodvibes-sdk/platform/automation/failures';
export type { AutomationSourceRecord, AutomationSourceSnapshot } from '@pellux/goodvibes-sdk/platform/automation/sources';
export type { AutomationRouteBinding, AutomationRouteResolution } from '@pellux/goodvibes-sdk/platform/automation/routes';
export type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation/jobs';
export type {
  AutomationRun,
  AutomationRunSummary,
  AutomationRunTelemetry,
  AutomationRunUsageSummary,
} from '@pellux/goodvibes-sdk/platform/automation/runs';

export type { LegacySchedulerSnapshot } from '@pellux/goodvibes-sdk/platform/automation/migration';
export { migrateLegacySchedules } from '@pellux/goodvibes-sdk/platform/automation/migration';
export { AutomationDeliveryManager } from '@pellux/goodvibes-sdk/platform/automation/delivery-manager';
export { AutomationService } from '@pellux/goodvibes-sdk/platform/automation/service';
export { AutomationJobStore } from '@pellux/goodvibes-sdk/platform/automation/store/jobs';
export { AutomationRunStore } from '@pellux/goodvibes-sdk/platform/automation/store/runs';
export { AutomationRouteStore } from '@pellux/goodvibes-sdk/platform/automation/store/routes';
export { AutomationSourceStore } from '@pellux/goodvibes-sdk/platform/automation/store/sources';
export type {
  AutomationHeartbeatResult,
  AutomationHeartbeatWake,
  CreateAutomationJobInput,
  UpdateAutomationJobInput,
} from '@pellux/goodvibes-sdk/platform/automation/manager';
export { AutomationManager } from '@pellux/goodvibes-sdk/platform/automation/manager';
