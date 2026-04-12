import { AgentManager } from '../tools/agent/index.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { SharedSessionBroker } from '../control-plane/index.ts';
import type { AutomationJob } from './jobs.ts';
import type { AutomationRun } from './runs.ts';
import { buildRunTelemetryFromAgent, getTerminalAgentState } from './manager-runtime-helpers.ts';

interface AutomationReconcileContext {
  readonly configManager: ConfigManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly agentStatusProvider: Pick<AgentManager, 'getStatus'>;
  readonly jobs: Map<string, AutomationJob>;
  readonly runs: Map<string, AutomationRun>;
  readonly saveJobs: () => Promise<void>;
  readonly saveRuns: () => Promise<void>;
  readonly syncExecutionRoute: (job: AutomationJob, run: AutomationRun) => Promise<void>;
  readonly syncRunToRuntime: (run: AutomationRun, source: string) => void;
  readonly syncJobToRuntime: (job: AutomationJob, source: string) => void;
  readonly emitRunCompleted: (job: AutomationJob, run: AutomationRun, outcome: 'success' | 'partial' | 'failed' | 'cancelled') => void;
  readonly emitRunFailed: (job: AutomationJob, run: AutomationRun, error: string, retryable: boolean) => void;
  readonly emitJobAutoDisabled: (job: AutomationJob, reason: string) => void;
  readonly maybeDeliverRun: (job: AutomationJob, run: AutomationRun) => void;
  readonly scheduleFailureFollowUp: (job: AutomationJob, run: AutomationRun) => void;
  readonly applyFailureToJob: (job: AutomationJob, timestamp: number, countRun?: boolean) => AutomationJob;
  readonly pruneRunHistory: () => void;
  readonly cancelTimer: (jobId: string) => void;
}

export function reconcileAutomationActiveRuns(context: AutomationReconcileContext): void {
  let jobsChanged = false;
  let runsChanged = false;
  for (const run of context.runs.values()) {
    if (run.status !== 'running' || !run.agentId) continue;
    const agent = context.agentStatusProvider.getStatus(run.agentId);
    if (!agent) {
      const missingAgeMs = Date.now() - (run.startedAt ?? run.queuedAt);
      if (missingAgeMs < Math.max(300_000, Number(context.configManager.get('automation.catchUpWindowMinutes') ?? 30) * 60_000)) {
        continue;
      }
    }
    if (!agent) {
      const endedAt = Date.now();
      const updatedRun: AutomationRun = {
        ...run,
        status: 'failed',
        endedAt,
        durationMs: Math.max(0, endedAt - (run.startedAt ?? run.queuedAt)),
        updatedAt: endedAt,
        error: 'Agent state lost before completion',
      };
      context.runs.set(run.id, updatedRun);
      context.syncRunToRuntime(updatedRun, 'automation.reconcile');
      const job = context.jobs.get(run.jobId);
      if (job) {
        const updatedJob = context.applyFailureToJob(job, endedAt, false);
        context.jobs.set(job.id, updatedJob);
        void context.syncExecutionRoute(updatedJob, updatedRun);
        if (updatedRun.sessionId && updatedRun.continuationMode !== 'continued-live') {
          void context.sessionBroker.appendSystemMessage(updatedRun.sessionId, updatedRun.error ?? 'Agent state lost before completion', {
            status: 'failed',
            automationJobId: updatedJob.id,
            automationRunId: updatedRun.id,
          });
        }
        context.syncJobToRuntime(updatedJob, 'automation.reconcile');
        context.emitRunFailed(updatedJob, updatedRun, updatedRun.error ?? 'Agent state lost', false);
        context.scheduleFailureFollowUp(updatedJob, updatedRun);
        jobsChanged = true;
      }
      runsChanged = true;
      continue;
    }
    const terminalStatus = getTerminalAgentState(agent);
    if (!terminalStatus) continue;

    const endedAt = agent.completedAt ?? Date.now();
    const durationMs = run.startedAt !== undefined ? Math.max(0, endedAt - run.startedAt) : 0;
    const updatedRun: AutomationRun = {
      ...run,
      status: terminalStatus,
      endedAt,
      durationMs,
      updatedAt: endedAt,
      telemetry: buildRunTelemetryFromAgent(agent, run),
      ...(terminalStatus === 'completed'
        ? { result: agent.fullOutput ?? agent.streamingContent ?? agent.progress ?? null }
        : terminalStatus === 'failed'
          ? { error: agent.error ?? 'Agent failed' }
          : { cancelledReason: agent.error ?? 'Agent cancelled' }),
    };
    context.runs.set(run.id, updatedRun);
    context.syncRunToRuntime(updatedRun, 'automation.reconcile');
    runsChanged = true;

    const job = context.jobs.get(run.jobId);
    if (!job) continue;
    const wasEnabled = job.enabled;
    const updatedJob: AutomationJob = terminalStatus === 'completed'
      ? {
          ...job,
          successCount: job.successCount + 1,
          failureCount: 0,
          updatedAt: endedAt,
        }
      : context.applyFailureToJob(job, endedAt, false);
    context.jobs.set(job.id, updatedJob);
    void context.syncExecutionRoute(updatedJob, updatedRun);
    if (updatedRun.sessionId && updatedRun.continuationMode !== 'continued-live') {
      const sessionBody = terminalStatus === 'completed'
        ? String(updatedRun.result ?? '')
        : terminalStatus === 'failed'
          ? updatedRun.error ?? 'Agent failed'
          : updatedRun.cancelledReason ?? 'Agent cancelled';
      if (sessionBody.trim().length > 0) {
        void context.sessionBroker.completeAgent(updatedRun.sessionId, updatedRun.agentId ?? updatedRun.id, sessionBody, {
          status: terminalStatus,
          automationJobId: updatedJob.id,
          automationRunId: updatedRun.id,
          routeId: updatedRun.routeId,
        });
      }
    }
    context.syncJobToRuntime(updatedJob, 'automation.reconcile');
    if (terminalStatus === 'completed') {
      context.emitRunCompleted(updatedJob, updatedRun, 'success');
    } else if (terminalStatus === 'failed') {
      context.emitRunFailed(updatedJob, updatedRun, updatedRun.error ?? 'Agent failed', false);
    } else {
      context.emitRunCompleted(updatedJob, updatedRun, 'cancelled');
    }
    context.maybeDeliverRun(updatedJob, updatedRun);
    if (terminalStatus === 'completed' && updatedJob.deleteAfterRun) {
      context.cancelTimer(updatedJob.id);
      context.jobs.delete(updatedJob.id);
    } else if (terminalStatus !== 'completed') {
      context.scheduleFailureFollowUp(updatedJob, updatedRun);
    }
    if (!updatedJob.enabled && wasEnabled && terminalStatus !== 'completed') {
      context.emitJobAutoDisabled(updatedJob, updatedJob.pausedReason ?? 'failure-threshold-reached');
    }
    jobsChanged = true;
  }
  if (jobsChanged) void context.saveJobs();
  if (runsChanged) {
    context.pruneRunHistory();
    void context.saveRuns();
  }
}
