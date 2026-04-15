import { getNextAutomationOccurrence, normalizeCronSchedule, normalizeEverySchedule, type AutomationScheduleDefinition } from '@pellux/goodvibes-sdk/platform/automation/schedules';
import type { KnowledgeStore } from '@pellux/goodvibes-sdk/platform/knowledge/store';
import type { KnowledgeJobMode, KnowledgeJobRecord, KnowledgeJobRunRecord, KnowledgeScheduleRecord } from '@pellux/goodvibes-sdk/platform/knowledge/types';
import { emitKnowledgeJobCompleted, emitKnowledgeJobFailed, emitKnowledgeJobQueued, emitKnowledgeJobStarted } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

export interface KnowledgeSchedulingContext {
  readonly store: KnowledgeStore;
  readonly emitIfReady: (
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ) => void;
  readonly runJobByKind: (
    kind: KnowledgeJobRecord['kind'],
    input: { readonly sourceIds?: readonly string[]; readonly limit?: number },
  ) => Promise<Record<string, unknown>>;
}

export class KnowledgeScheduleService {
  private readonly jobs: readonly KnowledgeJobRecord[];
  private readonly scheduleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private schedulesInitialized = false;

  constructor(private readonly context: KnowledgeSchedulingContext) {
    this.jobs = [
      { id: 'knowledge-lint', kind: 'lint', title: 'Lint Knowledge Store', description: 'Run knowledge health checks and refresh the issue queue.', defaultMode: 'inline', metadata: { category: 'quality' } },
      { id: 'knowledge-reindex', kind: 'reindex', title: 'Reindex Knowledge', description: 'Re-run compile and memory mirroring across the current store.', defaultMode: 'background', metadata: { category: 'maintenance' } },
      { id: 'knowledge-refresh-stale', kind: 'refresh-stale', title: 'Refresh Stale Sources', description: 'Recrawl stale, failed, or aging remote sources.', defaultMode: 'background', metadata: { category: 'maintenance' } },
      { id: 'knowledge-refresh-bookmarks', kind: 'refresh-bookmarks', title: 'Refresh Bookmarks', description: 'Recrawl bookmark and URL-list sources to refresh summaries and links.', defaultMode: 'background', metadata: { category: 'maintenance' } },
      { id: 'knowledge-rebuild-projections', kind: 'rebuild-projections', title: 'Rebuild Projections', description: 'Render and materialize the major derived markdown/wiki projections.', defaultMode: 'background', metadata: { category: 'projection' } },
      { id: 'knowledge-light-consolidation', kind: 'light-consolidation', title: 'Light Consolidation', description: 'Score recent usage, refresh candidate promotions, and write a deterministic consolidation report.', defaultMode: 'background', metadata: { category: 'consolidation' } },
      { id: 'knowledge-deep-consolidation', kind: 'deep-consolidation', title: 'Deep Consolidation', description: 'Run the full consolidation loop, including high-confidence memory promotion and deterministic reporting.', defaultMode: 'background', metadata: { category: 'consolidation' } },
    ];
    void this.initializeSchedules();
  }

  listJobs(): readonly KnowledgeJobRecord[] {
    return this.jobs;
  }

  getJob(id: string): KnowledgeJobRecord | null {
    return this.jobs.find((job) => job.id === id) ?? null;
  }

  async saveSchedule(input: {
    readonly id?: string;
    readonly jobId: string;
    readonly label?: string;
    readonly enabled?: boolean;
    readonly schedule: AutomationScheduleDefinition;
    readonly metadata?: Record<string, unknown>;
  }): Promise<KnowledgeScheduleRecord> {
    const job = this.getJob(input.jobId);
    if (!job) throw new Error(`Unknown knowledge job: ${input.jobId}`);
    const nextRunAt = (input.enabled ?? true)
      ? getNextAutomationOccurrence(input.schedule, Date.now(), input.id ?? input.jobId)
      : undefined;
    const record = await this.context.store.upsertSchedule({
      id: input.id,
      jobId: input.jobId,
      label: input.label?.trim() || job.title,
      enabled: input.enabled ?? true,
      schedule: input.schedule,
      nextRunAt,
      metadata: {
        ...(input.metadata ?? {}),
      },
    });
    await this.reconcileSchedules();
    return record;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const deleted = await this.context.store.deleteSchedule(id);
    this.clearScheduleTimer(id);
    return deleted;
  }

  async setScheduleEnabled(id: string, enabled: boolean): Promise<KnowledgeScheduleRecord | null> {
    const schedule = this.context.store.getSchedule(id);
    if (!schedule) return null;
    const updated = await this.context.store.upsertSchedule({
      id: schedule.id,
      jobId: schedule.jobId,
      label: schedule.label,
      enabled,
      schedule: schedule.schedule,
      lastRunAt: schedule.lastRunAt,
      nextRunAt: enabled ? getNextAutomationOccurrence(schedule.schedule, Date.now(), schedule.id) : undefined,
      metadata: schedule.metadata,
    });
    await this.reconcileSchedules();
    return updated;
  }

  listJobRuns(limit = 100, jobId?: string): readonly KnowledgeJobRunRecord[] {
    return this.context.store.listJobRuns(limit, jobId);
  }

  async runJob(
    id: string,
    input: {
      readonly mode?: KnowledgeJobMode;
      readonly sourceIds?: readonly string[];
      readonly limit?: number;
    } = {},
  ): Promise<KnowledgeJobRunRecord> {
    const job = this.getJob(id);
    if (!job) throw new Error(`Unknown knowledge job: ${id}`);
    const mode = input.mode ?? job.defaultMode;
    const run = await this.context.store.upsertJobRun({
      jobId: job.id,
      status: 'queued',
      mode,
      requestedAt: Date.now(),
      result: {},
      metadata: {
        ...(input.sourceIds?.length ? { sourceIds: [...input.sourceIds] } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      },
    });
    this.context.emitIfReady((bus, ctx) => emitKnowledgeJobQueued(bus, ctx, {
      jobId: job.id,
      runId: run.id,
      mode,
    }));
    if (mode === 'inline') {
      return this.executeJobRun(job, run.id, input);
    }
    queueMicrotask(() => {
      void this.executeJobRun(job, run.id, input);
    });
    return run;
  }

  dispose(): void {
    for (const timer of this.scheduleTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduleTimers.clear();
  }

  private async initializeSchedules(): Promise<void> {
    if (this.schedulesInitialized) return;
    this.schedulesInitialized = true;
    await this.context.store.init();
    if (this.context.store.listSchedules(10_000).length === 0) {
      await this.context.store.upsertSchedule({
        jobId: 'knowledge-light-consolidation',
        label: 'Daily Light Consolidation',
        enabled: true,
        schedule: normalizeEverySchedule('24h'),
        nextRunAt: getNextAutomationOccurrence(normalizeEverySchedule('24h'), Date.now(), 'knowledge-light-consolidation'),
        metadata: { bootstrap: true },
      });
      await this.context.store.upsertSchedule({
        jobId: 'knowledge-deep-consolidation',
        label: 'Weekly Deep Consolidation',
        enabled: true,
        schedule: normalizeCronSchedule('15 4 * * 0'),
        nextRunAt: getNextAutomationOccurrence(normalizeCronSchedule('15 4 * * 0'), Date.now(), 'knowledge-deep-consolidation'),
        metadata: { bootstrap: true },
      });
    }
    await this.reconcileSchedules();
  }

  private clearScheduleTimer(id: string): void {
    const timer = this.scheduleTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.scheduleTimers.delete(id);
    }
  }

  private async reconcileSchedules(): Promise<void> {
    await this.context.store.init();
    const schedules = this.context.store.listSchedules(10_000);
    const activeIds = new Set(schedules.map((schedule) => schedule.id));
    for (const existing of [...this.scheduleTimers.keys()]) {
      if (!activeIds.has(existing)) this.clearScheduleTimer(existing);
    }
    for (const schedule of schedules) {
      this.clearScheduleTimer(schedule.id);
      if (!schedule.enabled) continue;
      const dueAt = schedule.nextRunAt ?? getNextAutomationOccurrence(schedule.schedule, Date.now(), schedule.id);
      const normalized = await this.context.store.upsertSchedule({
        id: schedule.id,
        jobId: schedule.jobId,
        label: schedule.label,
        enabled: schedule.enabled,
        schedule: schedule.schedule,
        lastRunAt: schedule.lastRunAt,
        nextRunAt: dueAt,
        metadata: schedule.metadata,
      });
      if (!normalized.nextRunAt) continue;
      const delay = Math.max(250, Math.min(2_147_483_647, normalized.nextRunAt - Date.now()));
      this.scheduleTimers.set(normalized.id, setTimeout(() => {
        void this.runScheduledJob(normalized.id);
      }, delay));
    }
  }

  private async runScheduledJob(scheduleId: string): Promise<void> {
    this.clearScheduleTimer(scheduleId);
    const schedule = this.context.store.getSchedule(scheduleId);
    if (!schedule?.enabled) return;
    const now = Date.now();
    await this.runJob(schedule.jobId, { mode: 'background' });
    await this.context.store.upsertSchedule({
      id: schedule.id,
      jobId: schedule.jobId,
      label: schedule.label,
      enabled: schedule.enabled,
      schedule: schedule.schedule,
      lastRunAt: now,
      nextRunAt: getNextAutomationOccurrence(schedule.schedule, now, schedule.id),
      metadata: schedule.metadata,
    });
    await this.reconcileSchedules();
  }

  private async executeJobRun(
    job: KnowledgeJobRecord,
    runId: string,
    input: { readonly sourceIds?: readonly string[]; readonly limit?: number; readonly mode?: KnowledgeJobMode },
  ): Promise<KnowledgeJobRunRecord> {
    const startedAt = Date.now();
    let run = await this.context.store.upsertJobRun({
      id: runId,
      jobId: job.id,
      status: 'running',
      mode: input.mode ?? job.defaultMode,
      startedAt,
    });
    this.context.emitIfReady((bus, ctx) => emitKnowledgeJobStarted(bus, ctx, {
      jobId: job.id,
      runId: run.id,
      mode: run.mode,
    }));
    try {
      const result = await this.context.runJobByKind(job.kind, input);
      const completedAt = Date.now();
      run = await this.context.store.upsertJobRun({
        id: run.id,
        jobId: run.jobId,
        status: 'completed',
        mode: run.mode,
        requestedAt: run.requestedAt,
        startedAt,
        completedAt,
        result,
      });
      this.context.emitIfReady((bus, ctx) => emitKnowledgeJobCompleted(bus, ctx, {
        jobId: job.id,
        runId: run.id,
        durationMs: completedAt - startedAt,
      }));
      return run;
    } catch (error) {
      const completedAt = Date.now();
      run = await this.context.store.upsertJobRun({
        id: run.id,
        jobId: run.jobId,
        status: 'failed',
        mode: run.mode,
        requestedAt: run.requestedAt,
        startedAt,
        completedAt,
        error: summarizeError(error),
      });
      this.context.emitIfReady((bus, ctx) => emitKnowledgeJobFailed(bus, ctx, {
        jobId: job.id,
        runId: run.id,
        error: run.error ?? 'Knowledge job failed.',
        durationMs: completedAt - startedAt,
      }));
      return run;
    }
  }
}
