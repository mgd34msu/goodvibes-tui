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
} from './types.ts';

export type {
  AutomationAtSchedule,
  AutomationEverySchedule,
  AutomationCronSchedule,
  AutomationScheduleDefinition,
  AutomationScheduleKind,
} from './schedules.ts';
export {
  parseEveryInterval,
  formatEveryInterval,
  validateSchedule,
  normalizeAtSchedule,
  normalizeEverySchedule,
  normalizeCronSchedule,
  getNextAutomationOccurrence,
  isAutomationDue,
} from './schedules.ts';

export type { AutomationExecutionPolicy, AutomationSessionTarget, AutomationSessionTargetKind, AutomationSandboxMode } from './session-targets.ts';
export type { AutomationDeliveryMode, AutomationDeliveryTarget, AutomationDeliveryPolicy, AutomationDeliveryAttempt } from './delivery.ts';
export type { AutomationFailureAction, AutomationRetryStrategy, AutomationRetryPolicy, AutomationFailurePolicy, AutomationFailureRecord } from './failures.ts';
export type { AutomationSourceRecord, AutomationSourceSnapshot } from './sources.ts';
export type { AutomationRouteBinding, AutomationRouteResolution } from './routes.ts';
export type { AutomationJob } from './jobs.ts';
export type {
  AutomationRun,
  AutomationRunSummary,
  AutomationRunTelemetry,
  AutomationRunUsageSummary,
} from './runs.ts';

export type { LegacySchedulerSnapshot } from './migration.ts';
export { migrateLegacySchedules } from './migration.ts';
export { AutomationDeliveryManager } from './delivery-manager.ts';
export { AutomationService } from './service.ts';
export { AutomationJobStore } from './store/jobs.ts';
export { AutomationRunStore } from './store/runs.ts';
export { AutomationRouteStore } from './store/routes.ts';
export { AutomationSourceStore } from './store/sources.ts';
export type { CreateAutomationJobInput, UpdateAutomationJobInput } from './manager.ts';
export { AutomationManager } from './manager.ts';
