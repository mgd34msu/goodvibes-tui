/**
 * AutomationEvent — discriminated union covering automation job and run lifecycle events.
 */

export const AUTOMATION_SCHEDULE_KINDS = ['at', 'every', 'cron'] as const;
export const AUTOMATION_RUN_OUTCOMES = ['success', 'partial', 'failed', 'cancelled'] as const;

export type AutomationScheduleKind = (typeof AUTOMATION_SCHEDULE_KINDS)[number];

export type AutomationExecutionMode = 'isolated' | 'current' | 'pinned' | 'background';

export type AutomationRunOutcome = (typeof AUTOMATION_RUN_OUTCOMES)[number];

export type AutomationEvent =
  | {
      type: 'AUTOMATION_JOB_CREATED';
      jobId: string;
      name: string;
      scheduleKind: AutomationScheduleKind;
      enabled: boolean;
    }
  | {
      type: 'AUTOMATION_JOB_UPDATED';
      jobId: string;
      changedFields: string[];
    }
  | {
      type: 'AUTOMATION_JOB_ENABLED';
      jobId: string;
    }
  | {
      type: 'AUTOMATION_JOB_DISABLED';
      jobId: string;
      reason: string;
    }
  | {
      type: 'AUTOMATION_RUN_QUEUED';
      jobId: string;
      runId: string;
      scheduledAt: number;
      forced: boolean;
    }
  | {
      type: 'AUTOMATION_RUN_STARTED';
      jobId: string;
      runId: string;
      startedAt: number;
      attempt: number;
    }
  | {
      type: 'AUTOMATION_RUN_COMPLETED';
      jobId: string;
      runId: string;
      startedAt: number;
      completedAt: number;
      durationMs: number;
      outcome: AutomationRunOutcome;
    }
  | {
      type: 'AUTOMATION_RUN_FAILED';
      jobId: string;
      runId: string;
      startedAt: number;
      failedAt: number;
      error: string;
      retryable: boolean;
    }
  | {
      type: 'AUTOMATION_RUN_CANCELLED';
      jobId: string;
      runId: string;
      cancelledAt: number;
      reason: string;
    }
  | {
      type: 'AUTOMATION_SCHEDULE_ERROR';
      jobId: string;
      scheduleText: string;
      error: string;
    }
  | {
      type: 'AUTOMATION_JOB_AUTO_DISABLED';
      jobId: string;
      reason: string;
      consecutiveFailures: number;
    };

export type AutomationEventType = AutomationEvent['type'];
