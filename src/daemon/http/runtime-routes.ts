import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';
import { createDaemonRuntimeAutomationRouteHandlers } from './runtime-automation-routes.ts';
import { createDaemonRuntimeSessionRouteHandlers } from './runtime-session-routes.ts';
import type { DaemonRuntimeRouteContext } from './runtime-route-types.ts';

export type { DaemonRuntimeRouteContext } from './runtime-route-types.ts';

export function createDaemonRuntimeRouteHandlers(
  context: DaemonRuntimeRouteContext,
): Pick<
  DaemonApiRouteHandlers,
  | 'createSharedSession'
  | 'getAutomationJobs'
  | 'postAutomationJob'
  | 'getAutomationRuns'
  | 'getAutomationRun'
  | 'getAutomationHeartbeat'
  | 'postAutomationHeartbeat'
  | 'automationRunAction'
  | 'patchAutomationJob'
  | 'deleteAutomationJob'
  | 'setAutomationJobEnabled'
  | 'runAutomationJobNow'
  | 'postTask'
  | 'getSharedSession'
  | 'closeSharedSession'
  | 'reopenSharedSession'
  | 'getSharedSessionMessages'
  | 'getSharedSessionInputs'
  | 'postSharedSessionMessage'
  | 'postSharedSessionSteer'
  | 'postSharedSessionFollowUp'
  | 'cancelSharedSessionInput'
  | 'getRuntimeTask'
  | 'runtimeTaskAction'
  | 'getTaskStatus'
  | 'getSchedules'
  | 'postSchedule'
  | 'deleteSchedule'
  | 'setScheduleEnabled'
  | 'runScheduleNow'
> {
  return {
    ...createDaemonRuntimeSessionRouteHandlers(context),
    ...createDaemonRuntimeAutomationRouteHandlers(context),
  };
}
