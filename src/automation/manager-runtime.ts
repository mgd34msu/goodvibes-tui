import { PersistentStore } from '../state/persistent-store.ts';
import { ConfigManager } from '../config/manager.ts';
import { createDomainDispatch } from '../runtime/store/index.ts';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { AgentManager } from '../tools/agent/index.ts';
import { AgentMessageBus } from '../agents/message-bus.ts';
import { migrateLegacySchedules, type LegacySchedulerSnapshot } from './migration.ts';
import { AutomationJobStore } from './store/jobs.ts';
import { AutomationRunStore } from './store/runs.ts';
import { resolveAutomationStorePath } from './store/paths.ts';
import { AutomationDeliveryManager } from './delivery-manager.ts';
import { RouteBindingManager } from '../channels/index.ts';
import type { AutomationJob } from './jobs.ts';
import type { AutomationRun, AutomationRunContinuationMode, AutomationRunTelemetry } from './runs.ts';
import type { AutomationRunTrigger } from './types.ts';
import { SharedSessionBroker } from '../control-plane/index.ts';
import type {
  CreateAutomationJobInput,
  SpawnAutomationTaskInput,
  UpdateAutomationJobInput,
} from './manager-runtime-helpers.ts';
import {
  applyFailureToJob as applyAutomationFailureToJob,
  executeAutomationJob,
  resolveAutomationExecution,
  resolveRouteForTarget as resolveAutomationRouteForTarget,
  resolveSharedSessionExecution as resolveAutomationSharedSessionExecution,
  syncExecutionRoute as syncAutomationExecutionRoute,
  toResolvedExecution as toAutomationResolvedExecution,
} from './manager-runtime-execution.ts';
import {
  formatExternalContentSource,
  normalizeExternalTelemetry,
  normalizeJobRecord,
  normalizeRunRecord,
  normalizeRunTelemetry,
  normalizeSourceRecord,
  sortJobs,
  sortRuns,
} from './manager-runtime-helpers.ts';
import {
  advanceScheduledHeartbeatAutomationJob,
  cancelAutomationTimer,
  queueDueHeartbeatAutomationJobs,
  queueHeartbeatWake,
  scheduleAutomationJob,
  type AutomationHeartbeatWake,
} from './manager-runtime-scheduling.ts';
import {
  maybeDeliverAutomationFailureNotice,
  maybeDeliverAutomationRun,
  scheduleAutomationFailureFollowUp,
} from './manager-runtime-delivery.ts';
import {
  emitAutomationManagerJobAutoDisabled,
  emitAutomationManagerJobCreated,
  emitAutomationManagerJobUpdated,
  emitAutomationManagerRunCompleted,
  emitAutomationManagerRunFailed,
  emitAutomationManagerRunQueued,
  emitAutomationManagerRunStarted,
} from './manager-runtime-events.ts';
import {
  collectAutomationSources,
  syncAutomationJobToRuntime,
  syncAutomationRunToRuntime,
  syncAutomationRuntimeSnapshot,
} from './manager-runtime-sync.ts';
import { reconcileAutomationActiveRuns } from './manager-runtime-reconcile.ts';
import { summarizeError } from '../utils/error-display.ts';
import {
  createAutomationJobRecord,
  toggleAutomationJobEnabled,
  updateAutomationJobRecord,
} from './manager-runtime-job-mutations.ts';

export type {
  CreateAutomationJobInput,
  UpdateAutomationJobInput,
  SpawnAutomationTaskInput,
} from './manager-runtime-helpers.ts';
export type { AutomationHeartbeatWake } from './manager-runtime-scheduling.ts';

interface AutomationManagerConfig {
  readonly jobStore?: AutomationJobStore;
  readonly runStore?: AutomationRunStore;
  readonly legacyStore?: PersistentStore<LegacySchedulerSnapshot>;
  readonly spawnTask?: (input: SpawnAutomationTaskInput) => string;
  readonly cancelTask?: (agentId: string) => void;
  readonly agentStatusProvider?: Pick<AgentManager, 'getStatus'>;
  readonly runtimeStore?: RuntimeStore;
  readonly runtimeBus?: RuntimeEventBus;
  readonly deliveryManager?: AutomationDeliveryManager;
  readonly configManager: ConfigManager;
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
}

export interface AutomationHeartbeatResult {
  readonly processed: readonly AutomationRun[];
  readonly failed: readonly {
    readonly jobId: string;
    readonly error: string;
  }[];
  readonly pending: readonly AutomationHeartbeatWake[];
  readonly checkedAt: number;
}

export class AutomationManager {
  private readonly jobStore: AutomationJobStore;
  private readonly runStore: AutomationRunStore;
  private readonly legacyStore: PersistentStore<LegacySchedulerSnapshot>;
  private readonly spawnTask?: (input: SpawnAutomationTaskInput) => string;
  private readonly cancelTask?: (agentId: string) => void;
  private readonly agentStatusProvider?: Pick<AgentManager, 'getStatus'>;
  private readonly configManager: ConfigManager;
  private readonly routeBindings: RouteBindingManager;
  private readonly sessionBroker: SharedSessionBroker;
  private readonly jobs = new Map<string, AutomationJob>();
  private readonly runs = new Map<string, AutomationRun>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly heartbeatWakes = new Map<string, AutomationHeartbeatWake>();
  private deliveryManager: AutomationDeliveryManager | null;
  private readonly deliveryInFlight = new Set<string>();
  private runtimeDispatch: DomainDispatch | null = null;
  private runtimeBus: RuntimeEventBus | null = null;
  private loaded = false;
  private running = false;
  private startPromise: Promise<void> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AutomationManagerConfig) {
    this.configManager = config.configManager;
    this.jobStore = config.jobStore ?? new AutomationJobStore({ configManager: this.configManager });
    this.runStore = config.runStore ?? new AutomationRunStore({ configManager: this.configManager });
    this.legacyStore = config.legacyStore ?? new PersistentStore<LegacySchedulerSnapshot>(
      resolveAutomationStorePath('schedules.json', this.configManager),
    );
    this.routeBindings = config.routeBindings;
    this.sessionBroker = config.sessionBroker;
    this.agentStatusProvider = config.agentStatusProvider;
    this.spawnTask = config.spawnTask;
    this.cancelTask = config.cancelTask;
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
    }
    this.runtimeBus = config.runtimeBus ?? null;
    this.deliveryManager = config.deliveryManager ?? null;
  }

  private requireSpawnTask(): (input: SpawnAutomationTaskInput) => string {
    if (!this.spawnTask) {
      throw new Error('AutomationManager requires an explicit spawnTask callback.');
    }
    return this.spawnTask;
  }

  private requireCancelTask(): (agentId: string) => void {
    if (!this.cancelTask) {
      throw new Error('AutomationManager requires an explicit cancelTask callback.');
    }
    return this.cancelTask;
  }

  private runtimeExecutionContext() {
    return {
      configManager: this.configManager,
      routeBindings: this.routeBindings,
      sessionBroker: this.sessionBroker,
      spawnTask: (input: SpawnAutomationTaskInput) => this.requireSpawnTask()(input),
      saveJobs: () => this.saveJobs(),
      saveRuns: () => this.saveRuns(),
      pruneRunHistory: (jobId?: string) => this.pruneRunHistory(jobId),
      activeRunCount: () => this.activeRunCount(),
      maxConcurrentRuns: () => this.maxConcurrentRuns(),
      syncExecutionRoute: (job: AutomationJob, run: AutomationRun) => this.syncExecutionRoute(job, run),
      syncRunToRuntime: (run: AutomationRun, source: string) => this.syncRunToRuntime(run, source),
      syncJobToRuntime: (job: AutomationJob, source: string) => this.syncJobToRuntime(job, source),
      emitRunQueued: (job: AutomationJob, run: AutomationRun) => this.emitRunQueued(job, run),
      emitRunStarted: (job: AutomationJob, run: AutomationRun) => this.emitRunStarted(job, run),
      emitRunCompleted: (job: AutomationJob, run: AutomationRun, outcome: 'success' | 'partial' | 'failed' | 'cancelled') => this.emitRunCompleted(job, run, outcome),
      emitRunFailed: (job: AutomationJob, run: AutomationRun, error: string, retryable: boolean) => this.emitRunFailed(job, run, error, retryable),
      maybeDeliverRun: (job: AutomationJob, run: AutomationRun) => this.maybeDeliverRun(job, run),
      scheduleFailureFollowUp: (job: AutomationJob, run: AutomationRun) => this.scheduleFailureFollowUp(job, run),
      applyFailureToJob: (job: AutomationJob, timestamp: number, countRun = true) => this.applyFailureToJob(job, timestamp, countRun),
      jobs: this.jobs,
      runs: this.runs,
    };
  }

  private jobMutationContext() {
    return {
      configManager: this.configManager,
      jobs: this.jobs,
      saveJobs: () => this.saveJobs(),
      scheduleJob: (job: AutomationJob) => this.scheduleJob(job),
      syncJobToRuntime: (job: AutomationJob, source: string) => this.syncJobToRuntime(job, source),
      emitJobCreated: (job: AutomationJob) => this.emitJobCreated(job),
      emitJobUpdated: (job: AutomationJob, changedFields: string[]) => this.emitJobUpdated(job, changedFields),
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.load()
      .then(() => {
        this.running = true;
        this.reconcileActiveRuns();
        this.reconcileTimer = setInterval(() => {
          this.reconcileActiveRuns();
        }, 2_000);
        for (const job of this.jobs.values()) {
          this.scheduleJob(job);
        }
      })
      .finally(() => {
        this.startPromise = null;
      });
    return await this.startPromise;
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.running = false;
  }

  attachRuntime(config: {
    readonly runtimeStore?: RuntimeStore | null;
    readonly runtimeBus?: RuntimeEventBus | null;
    readonly deliveryManager?: AutomationDeliveryManager | null;
  }): void {
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
      this.syncRuntimeSnapshot();
    }
    if (config.runtimeBus) {
      this.runtimeBus = config.runtimeBus;
    }
    if (config.deliveryManager) {
      this.deliveryManager = config.deliveryManager;
      this.deliveryManager.attachRuntime({
        runtimeStore: config.runtimeStore,
        runtimeBus: config.runtimeBus,
      });
    }
  }

  listJobs(): AutomationJob[] {
    this.reconcileActiveRuns();
    return sortJobs(this.jobs.values());
  }

  listRuns(jobId?: string): AutomationRun[] {
    this.reconcileActiveRuns();
    const runs = jobId
      ? [...this.runs.values()].filter((run) => run.jobId === jobId)
      : this.runs.values();
    return sortRuns(runs);
  }

  listHeartbeatWakes(): AutomationHeartbeatWake[] {
    this.queueDueHeartbeatJobs('inspect');
    return [...this.heartbeatWakes.values()].sort((a, b) => a.queuedAt - b.queuedAt || a.jobId.localeCompare(b.jobId));
  }

  getRun(runId: string): AutomationRun | undefined {
    this.reconcileActiveRuns();
    return this.runs.get(runId);
  }

  getJob(jobId: string): AutomationJob | undefined {
    this.reconcileActiveRuns();
    return this.jobs.get(jobId);
  }

  async createJob(input: CreateAutomationJobInput): Promise<AutomationJob> {
    await this.start();
    return await createAutomationJobRecord(this.jobMutationContext(), input);
  }

  async removeJob(jobId: string): Promise<boolean> {
    await this.start();
    this.cancelTimer(jobId);
    const removed = this.jobs.delete(jobId);
    if (!removed) return false;
    await this.saveJobs();
    return true;
  }

  async setEnabled(jobId: string, enabled: boolean): Promise<AutomationJob | null> {
    await this.start();
    const updated = await toggleAutomationJobEnabled(this.jobMutationContext(), jobId, enabled);
    if (!enabled) this.cancelTimer(jobId);
    return updated;
  }

  async updateJob(jobId: string, patch: UpdateAutomationJobInput): Promise<AutomationJob | null> {
    await this.start();
    return await updateAutomationJobRecord(this.jobMutationContext(), jobId, patch);
  }

  async runNow(jobId: string): Promise<AutomationRun> {
    await this.start();
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Automation job not found: ${jobId}`);
    if (this.activeRunCount() >= this.maxConcurrentRuns()) {
      throw new Error(`Automation concurrency limit reached (${this.maxConcurrentRuns()})`);
    }
    return await this.executeJob(job, 'manual', false);
  }

  async triggerHeartbeat(_input: { readonly source?: string } = {}): Promise<AutomationHeartbeatResult> {
    await this.start();
    this.queueDueHeartbeatJobs('heartbeat');
    const queued = this.listHeartbeatWakes();
    const processed: AutomationRun[] = [];
    const failed: Array<{ jobId: string; error: string }> = [];
    for (const wake of queued) {
      if (this.activeRunCount() >= this.maxConcurrentRuns()) break;
      const job = this.jobs.get(wake.jobId);
      this.heartbeatWakes.delete(wake.jobId);
      if (!job?.enabled) continue;
      try {
        const run = await this.executeJob(job, wake.trigger, wake.dueRun, wake.attempt);
        processed.push(run);
        this.advanceScheduledHeartbeatJob(job.id);
      } catch (error) {
        failed.push({
          jobId: wake.jobId,
          error: summarizeError(error),
        });
      }
    }
    return {
      processed,
      failed,
      pending: this.listHeartbeatWakes(),
      checkedAt: Date.now(),
    };
  }

  async retryRun(runId: string): Promise<AutomationRun> {
    await this.start();
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Automation run not found: ${runId}`);
    const job = this.jobs.get(run.jobId);
    if (!job) throw new Error(`Automation job not found: ${run.jobId}`);
    if (this.activeRunCount() >= this.maxConcurrentRuns()) {
      throw new Error(`Automation concurrency limit reached (${this.maxConcurrentRuns()})`);
    }
    return await this.executeJob(job, 'manual', false, run.attempt + 1);
  }

  async cancelRun(runId: string, reason = 'operator-cancelled'): Promise<AutomationRun | null> {
    await this.start();
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status !== 'running') return run;

    if (run.agentId) {
      this.requireCancelTask()(run.agentId);
    }

    const endedAt = Date.now();
    const updatedRun: AutomationRun = {
      ...run,
      status: 'cancelled',
      endedAt,
      durationMs: Math.max(0, endedAt - (run.startedAt ?? run.queuedAt)),
      cancelledReason: reason,
      updatedAt: endedAt,
    };
    this.runs.set(run.id, updatedRun);
    this.syncRunToRuntime(updatedRun, 'automation.cancel');

    const job = this.jobs.get(run.jobId);
    if (job) {
      const updatedJob: AutomationJob = {
        ...job,
        lastRunAt: endedAt,
        updatedAt: endedAt,
      };
      this.jobs.set(job.id, updatedJob);
      await this.syncExecutionRoute(updatedJob, updatedRun);
      if (updatedRun.sessionId && updatedRun.continuationMode !== 'continued-live') {
        await this.sessionBroker.completeAgent(updatedRun.sessionId, updatedRun.agentId ?? run.id, reason, {
          status: 'cancelled',
          automationJobId: updatedJob.id,
          automationRunId: updatedRun.id,
        });
      }
      this.syncJobToRuntime(updatedJob, 'automation.cancel');
      this.emitRunCompleted(updatedJob, updatedRun, 'cancelled');
      this.maybeDeliverRun(updatedJob, updatedRun);
    }

    await this.saveRuns();
    await this.saveJobs();
    return updatedRun;
  }

  async recordExternalRunResult(
    runId: string,
    input: {
      readonly status: 'completed' | 'failed' | 'cancelled';
      readonly result?: unknown;
      readonly error?: string;
      readonly telemetry?: AutomationRunTelemetry;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<AutomationRun | null> {
    await this.start();
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status !== 'running') return run;

    const endedAt = Date.now();
    const updatedRun: AutomationRun = {
      ...run,
      status: input.status,
      endedAt,
      durationMs: Math.max(0, endedAt - (run.startedAt ?? run.queuedAt)),
      updatedAt: endedAt,
      ...(input.status === 'completed'
        ? { result: input.result }
        : input.status === 'failed'
          ? { error: input.error ?? 'Remote work failed' }
          : { cancelledReason: input.error ?? 'Remote work cancelled' }),
      ...(input.telemetry ? { telemetry: normalizeExternalTelemetry(input.telemetry, run, input.metadata) } : {}),
    };
    this.runs.set(run.id, updatedRun);
    this.syncRunToRuntime(updatedRun, 'automation.external');

    const job = this.jobs.get(run.jobId);
    if (!job) {
      await this.saveRuns();
      return updatedRun;
    }

    const wasEnabled = job.enabled;
    const updatedJob: AutomationJob = input.status === 'completed'
      ? {
          ...job,
          successCount: job.successCount + 1,
          failureCount: 0,
          updatedAt: endedAt,
        }
      : input.status === 'failed'
        ? this.applyFailureToJob(job, endedAt, false)
        : {
            ...job,
            updatedAt: endedAt,
          };
    this.jobs.set(job.id, updatedJob);
    await this.syncExecutionRoute(updatedJob, updatedRun);
    this.syncJobToRuntime(updatedJob, 'automation.external');

    if (input.status === 'completed') {
      this.emitRunCompleted(updatedJob, updatedRun, 'success');
    } else if (input.status === 'failed') {
      this.emitRunFailed(updatedJob, updatedRun, updatedRun.error ?? 'Remote work failed', false);
    } else {
      this.emitRunCompleted(updatedJob, updatedRun, 'cancelled');
    }
    this.maybeDeliverRun(updatedJob, updatedRun);
    if (input.status === 'completed' && updatedJob.deleteAfterRun) {
      this.cancelTimer(updatedJob.id);
      this.jobs.delete(updatedJob.id);
    } else if (input.status === 'failed') {
      this.scheduleFailureFollowUp(updatedJob, updatedRun);
    }
    if (!updatedJob.enabled && wasEnabled && input.status === 'failed') {
      this.emitJobAutoDisabled(updatedJob, updatedJob.pausedReason ?? 'failure-threshold-reached');
    }

    await this.saveRuns();
    await this.saveJobs();
    return updatedRun;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const [jobSnapshot, runSnapshot] = await Promise.all([
      this.jobStore.load(),
      this.runStore.load(),
    ]);
    for (const job of jobSnapshot.jobs) {
      const normalizedJob = normalizeJobRecord(job, this.configManager);
      this.jobs.set(normalizedJob.id, normalizedJob);
    }
    for (const run of runSnapshot.runs) {
      const normalizedRun = normalizeRunRecord(run, this.jobs.get(run.jobId));
      this.runs.set(normalizedRun.id, normalizedRun);
    }
    if (this.jobs.size === 0) {
      await this.importLegacySchedules();
    }
    this.loaded = true;
    this.pruneRunHistory();
    this.syncRuntimeSnapshot();
  }

  private async importLegacySchedules(): Promise<void> {
    const snapshot = await this.legacyStore.load();
    if (!snapshot) return;
    const migrated = migrateLegacySchedules(snapshot);
    if (migrated.jobs.length === 0 && migrated.runs.length === 0) return;
    for (const job of migrated.jobs) {
      this.jobs.set(job.id, job);
    }
    for (const run of migrated.runs) {
      this.runs.set(run.id, run);
    }
    await Promise.all([this.saveJobs(), this.saveRuns()]);
    this.syncRuntimeSnapshot();
  }

  private scheduleJob(job: AutomationJob): void {
    scheduleAutomationJob({
      configManager: this.configManager,
      jobs: this.jobs,
      timers: this.timers,
      heartbeatWakes: this.heartbeatWakes,
      running: () => this.running,
      saveJobs: () => this.saveJobs(),
      activeRunCount: () => this.activeRunCount(),
      maxConcurrentRuns: () => this.maxConcurrentRuns(),
      executeJob: (scheduledJob, trigger, dueRun, attempt) => this.executeJob(scheduledJob, trigger, dueRun, attempt),
    }, job);
  }

  private cancelTimer(jobId: string): void {
    cancelAutomationTimer(this.timers, jobId);
  }

  private queueDueHeartbeatJobs(reason: string): void {
    queueDueHeartbeatAutomationJobs(this.jobs.values(), this.heartbeatWakes, reason);
  }

  private advanceScheduledHeartbeatJob(jobId: string): void {
    advanceScheduledHeartbeatAutomationJob(
      {
        jobs: this.jobs,
        saveJobs: () => this.saveJobs(),
      },
      this.timers,
      jobId,
      (job) => this.scheduleJob(job),
    );
  }

  private async executeJob(
    job: AutomationJob,
    trigger: AutomationRunTrigger,
    dueRun: boolean,
    attempt = 1,
  ): Promise<AutomationRun> {
    return await executeAutomationJob(this.runtimeExecutionContext(), job, trigger, dueRun, attempt);
  }

  private async syncExecutionRoute(job: AutomationJob, run: AutomationRun): Promise<void> {
    await syncAutomationExecutionRoute(this.runtimeExecutionContext(), job, run);
  }

  private applyFailureToJob(job: AutomationJob, timestamp: number, countRun = true): AutomationJob {
    return applyAutomationFailureToJob(job, timestamp, countRun);
  }

  private reconcileActiveRuns(): void {
    if (!this.agentStatusProvider) {
      return;
    }
    reconcileAutomationActiveRuns({
      configManager: this.configManager,
      sessionBroker: this.sessionBroker,
      agentStatusProvider: this.agentStatusProvider,
      jobs: this.jobs,
      runs: this.runs,
      saveJobs: () => this.saveJobs(),
      saveRuns: () => this.saveRuns(),
      syncExecutionRoute: (job, run) => this.syncExecutionRoute(job, run),
      syncRunToRuntime: (run, source) => this.syncRunToRuntime(run, source),
      syncJobToRuntime: (job, source) => this.syncJobToRuntime(job, source),
      emitRunCompleted: (job, run, outcome) => this.emitRunCompleted(job, run, outcome),
      emitRunFailed: (job, run, error, retryable) => this.emitRunFailed(job, run, error, retryable),
      emitJobAutoDisabled: (job, reason) => this.emitJobAutoDisabled(job, reason),
      maybeDeliverRun: (job, run) => this.maybeDeliverRun(job, run),
      scheduleFailureFollowUp: (job, run) => this.scheduleFailureFollowUp(job, run),
      applyFailureToJob: (job, timestamp, countRun) => this.applyFailureToJob(job, timestamp, countRun),
      pruneRunHistory: () => this.pruneRunHistory(),
      cancelTimer: (jobId) => this.cancelTimer(jobId),
    });
  }

  private async saveJobs(): Promise<void> {
    await this.jobStore.save(sortJobs(this.jobs.values()));
  }

  private async saveRuns(): Promise<void> {
    this.pruneRunHistory();
    await this.runStore.save(sortRuns(this.runs.values()));
  }

  private maxConcurrentRuns(): number {
    return Math.max(1, Number(this.configManager.get('automation.maxConcurrentRuns') ?? 4));
  }

  private activeRunCount(): number {
    let total = 0;
    for (const run of this.runs.values()) {
      if (run.status === 'running') total += 1;
    }
    return total;
  }

  private pruneRunHistory(jobId?: string): void {
    const limit = Math.max(1, Number(this.configManager.get('automation.runHistoryLimit') ?? 100));
    const runs = sortRuns(this.runs.values());
    const keep = new Set<string>();
    if (jobId) {
      const scoped = runs.filter((run) => run.jobId === jobId).slice(0, limit);
      for (const run of scoped) keep.add(run.id);
      for (const run of runs) {
        if (run.jobId !== jobId) keep.add(run.id);
      }
    } else {
      const grouped = new Map<string, number>();
      for (const run of runs) {
        const count = grouped.get(run.jobId) ?? 0;
        if (count < limit) {
          grouped.set(run.jobId, count + 1);
          keep.add(run.id);
        }
      }
    }
    for (const runId of [...this.runs.keys()]) {
      if (!keep.has(runId)) this.runs.delete(runId);
    }
  }

  private scheduleFailureFollowUp(job: AutomationJob, run: AutomationRun): void {
    scheduleAutomationFailureFollowUp({
      jobs: this.jobs,
      retryTimers: this.retryTimers,
      deliveryManager: this.deliveryManager,
      activeRunCount: () => this.activeRunCount(),
      maxConcurrentRuns: () => this.maxConcurrentRuns(),
      executeJob: (scheduledJob, trigger, dueRun, attempt) => this.executeJob(scheduledJob, trigger, dueRun, attempt),
      saveJobs: () => this.saveJobs(),
      scheduleJob: (scheduledJob) => this.scheduleJob(scheduledJob),
    }, (failureJob, failureRun) => this.maybeDeliverFailureNotice(failureJob, failureRun), job, run);
  }

  private maybeDeliverFailureNotice(job: AutomationJob, run: AutomationRun): void {
    maybeDeliverAutomationFailureNotice(this.deliveryManager, job, run);
  }

  private syncRuntimeSnapshot(): void {
    syncAutomationRuntimeSnapshot(this.runtimeDispatch, this.jobs.values(), this.runs.values());
  }

  private syncJobToRuntime(job: AutomationJob, source: string): void {
    syncAutomationJobToRuntime(this.runtimeDispatch, job, source);
  }

  private syncRunToRuntime(run: AutomationRun, source: string): void {
    syncAutomationRunToRuntime(this.runtimeDispatch, run, source);
  }

  private emitJobCreated(job: AutomationJob): void {
    emitAutomationManagerJobCreated(this.runtimeBus, job);
  }

  private emitJobUpdated(job: AutomationJob, changedFields: string[]): void {
    emitAutomationManagerJobUpdated(this.runtimeBus, job, changedFields);
  }

  private emitJobAutoDisabled(job: AutomationJob, reason: string): void {
    emitAutomationManagerJobAutoDisabled(this.runtimeBus, job, reason);
  }

  private emitRunQueued(job: AutomationJob, run: AutomationRun): void {
    emitAutomationManagerRunQueued(this.runtimeBus, job, run);
  }

  private emitRunStarted(job: AutomationJob, run: AutomationRun): void {
    emitAutomationManagerRunStarted(this.runtimeBus, job, run);
  }

  private emitRunCompleted(job: AutomationJob, run: AutomationRun, outcome: 'success' | 'partial' | 'failed' | 'cancelled'): void {
    emitAutomationManagerRunCompleted(this.runtimeBus, job, run, outcome);
  }

  private emitRunFailed(job: AutomationJob, run: AutomationRun, error: string, retryable: boolean): void {
    emitAutomationManagerRunFailed(this.runtimeBus, job, run, error, retryable);
  }

  private maybeDeliverRun(job: AutomationJob, run: AutomationRun): void {
    maybeDeliverAutomationRun({
      runs: this.runs,
      deliveryInFlight: this.deliveryInFlight,
      deliveryManager: this.deliveryManager,
      syncRunToRuntime: (nextRun, source) => this.syncRunToRuntime(nextRun, source),
      saveRuns: () => this.saveRuns(),
    }, job, run);
  }
}
