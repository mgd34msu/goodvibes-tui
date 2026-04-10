import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PersistentStore } from '../state/persistent-store.ts';
import { ConfigManager } from '../config/manager.ts';
import { createDomainDispatch } from '../runtime/store/index.ts';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import {
  emitAutomationJobAutoDisabled,
  emitAutomationJobCreated,
  emitAutomationJobDisabled,
  emitAutomationJobEnabled,
  emitAutomationJobUpdated,
  emitAutomationRunCompleted,
  emitAutomationRunFailed,
  emitAutomationRunQueued,
  emitAutomationRunStarted,
} from '../runtime/emitters/index.ts';
import { AgentManager } from '../tools/agent/index.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import { logger } from '../utils/logger.ts';
import { migrateLegacySchedules, type LegacySchedulerSnapshot } from './migration.ts';
import { getNextAutomationOccurrence } from './schedules.ts';
import type { AutomationScheduleDefinition } from './schedules.ts';
import { AutomationJobStore } from './store/jobs.ts';
import { AutomationRunStore } from './store/runs.ts';
import { AutomationDeliveryManager } from './delivery-manager.ts';
import { RouteBindingManager } from '../channels/index.ts';
import type { AutomationDeliveryPolicy } from './delivery.ts';
import type { AutomationFailurePolicy } from './failures.ts';
import type { AutomationJob } from './jobs.ts';
import type { AutomationRouteBinding } from './routes.ts';
import type { AutomationRun, AutomationRunContinuationMode, AutomationRunTelemetry } from './runs.ts';
import type { AutomationExecutionPolicy, AutomationSessionTarget } from './session-targets.ts';
import type { AutomationSourceRecord } from './sources.ts';
import type { AutomationRunTrigger } from './types.ts';
import { SharedSessionBroker } from '../control-plane/index.ts';
import type { SharedSessionRecord, SharedSessionSubmission } from '../control-plane/index.ts';

const LEGACY_SCHEDULES_PATH = join(process.cwd(), '.goodvibes', 'tui', 'schedules.json');
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface CreateAutomationJobInput {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: AutomationScheduleDefinition;
  readonly description?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly template?: string;
  readonly target?: AutomationSessionTarget;
  readonly reasoningEffort?: AutomationExecutionPolicy['reasoningEffort'];
  readonly timeoutMs?: number;
  readonly toolAllowlist?: readonly string[];
  readonly autoApprove?: boolean;
  readonly delivery?: Partial<AutomationDeliveryPolicy>;
  readonly failure?: Partial<AutomationFailurePolicy>;
  readonly enabled?: boolean;
  readonly deleteAfterRun?: boolean;
}

export interface UpdateAutomationJobInput {
  readonly name?: string;
  readonly prompt?: string;
  readonly schedule?: AutomationScheduleDefinition;
  readonly description?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly template?: string;
  readonly target?: AutomationSessionTarget;
  readonly reasoningEffort?: AutomationExecutionPolicy['reasoningEffort'];
  readonly timeoutMs?: number;
  readonly toolAllowlist?: readonly string[];
  readonly autoApprove?: boolean;
  readonly delivery?: Partial<AutomationDeliveryPolicy>;
  readonly failure?: Partial<AutomationFailurePolicy>;
  readonly enabled?: boolean;
  readonly deleteAfterRun?: boolean;
}

interface SpawnAutomationTaskInput {
  readonly prompt: string;
  readonly modelId?: string;
  readonly modelProvider?: string;
  readonly template?: string;
  readonly toolAllowlist?: readonly string[];
  readonly context?: string;
}

interface AutomationManagerConfig {
  readonly jobStore?: AutomationJobStore;
  readonly runStore?: AutomationRunStore;
  readonly legacyStore?: PersistentStore<LegacySchedulerSnapshot>;
  readonly spawnTask?: (input: SpawnAutomationTaskInput) => string;
  readonly runtimeStore?: RuntimeStore;
  readonly runtimeBus?: RuntimeEventBus;
  readonly deliveryManager?: AutomationDeliveryManager;
  readonly configManager?: ConfigManager;
  readonly routeBindings?: RouteBindingManager;
  readonly sessionBroker?: SharedSessionBroker;
}

interface ResolvedAutomationExecution {
  readonly task: string;
  readonly continuationMode: AutomationRunContinuationMode;
  readonly session?: SharedSessionRecord;
  readonly route?: AutomationRouteBinding;
  readonly agentId?: string;
  readonly target: AutomationSessionTarget;
  readonly updatedJob?: AutomationJob;
}

function sortJobs(jobs: Iterable<AutomationJob>): AutomationJob[] {
  return [...jobs].sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt);
}

function sortRuns(runs: Iterable<AutomationRun>): AutomationRun[] {
  return [...runs].sort((a, b) => b.queuedAt - a.queuedAt);
}

function computeNextRun(schedule: AutomationScheduleDefinition, from = Date.now()): number | undefined {
  return getNextAutomationOccurrence(schedule, from);
}

function buildDefaultSource(enabled: boolean, timestamp: number): AutomationSourceRecord {
  return {
    id: 'automation-manager',
    kind: 'schedule',
    label: 'Automation manager',
    enabled,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
}

function normalizeSourceRecord(
  source: AutomationSourceRecord | undefined,
  enabled: boolean,
  timestamp: number,
): AutomationSourceRecord {
  if (!source) {
    return buildDefaultSource(enabled, timestamp);
  }
  return {
    ...buildDefaultSource(enabled, timestamp),
    ...source,
    enabled: source.enabled ?? enabled,
    createdAt: source.createdAt ?? timestamp,
    updatedAt: source.updatedAt ?? source.createdAt ?? timestamp,
    label: source.label ?? source.id ?? 'Automation source',
    metadata: source.metadata ?? {},
  };
}

function buildDefaultExecution(input: CreateAutomationJobInput, configManager: ConfigManager): AutomationExecutionPolicy {
  return {
    prompt: input.prompt,
    ...(input.template ? { template: input.template } : {}),
    target: input.target ?? {
      kind: 'isolated',
      createIfMissing: true,
    },
    ...(input.model ? { modelId: input.model } : {}),
    ...(input.provider ? { modelProvider: input.provider } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...((input.timeoutMs ?? Number(configManager.get('automation.defaultTimeoutMs') ?? 0)) ? { timeoutMs: input.timeoutMs ?? Number(configManager.get('automation.defaultTimeoutMs') ?? 0) } : {}),
    ...(input.toolAllowlist?.length ? { toolAllowlist: input.toolAllowlist } : {}),
    ...(input.autoApprove !== undefined ? { autoApprove: input.autoApprove } : {}),
    sandboxMode: 'inherit',
  };
}

function buildDefaultDelivery(overrides?: Partial<AutomationDeliveryPolicy>): AutomationDeliveryPolicy {
  const base: AutomationDeliveryPolicy = {
    mode: 'none',
    targets: [],
    fallbackTargets: [],
    includeSummary: true,
    includeTranscript: false,
    includeLinks: true,
  };
  return {
    ...base,
    ...overrides,
    targets: overrides?.targets ?? [],
    fallbackTargets: overrides?.fallbackTargets ?? [],
  };
}

function buildDefaultFailurePolicy(configManager: ConfigManager, overrides?: Partial<AutomationFailurePolicy>): AutomationFailurePolicy {
  const baseRetryPolicy = {
    maxAttempts: 3,
    delayMs: 5_000,
    strategy: 'exponential' as const,
    maxDelayMs: 60_000,
    jitterMs: 500,
  };
  const base: AutomationFailurePolicy = {
    action: 'retry',
    maxConsecutiveFailures: 3,
    cooldownMs: Number(configManager.get('automation.failureCooldownMs') ?? 30_000),
    retryPolicy: baseRetryPolicy,
    disableAfterFailures: false,
  };
  return {
    ...base,
    ...overrides,
    retryPolicy: {
      ...baseRetryPolicy,
      ...(overrides?.retryPolicy ?? {}),
    },
  };
}

function getTerminalAgentState(agent: AgentRecord): Extract<AutomationRun['status'], 'completed' | 'failed' | 'cancelled'> | null {
  switch (agent.status) {
    case 'completed':
    case 'failed':
    case 'cancelled':
      return agent.status;
    default:
      return null;
  }
}

function normalizeJobRecord(job: AutomationJob, configManager: ConfigManager): AutomationJob {
  const timestamp = job.createdAt ?? Date.now();
  const enabled = job.enabled ?? job.status === 'enabled';
  const target = job.execution?.target ?? { kind: 'isolated', createIfMissing: true } as AutomationSessionTarget;
  return {
    ...job,
    labels: job.labels ?? [],
    createdAt: timestamp,
    updatedAt: job.updatedAt ?? timestamp,
    enabled,
    status: job.status ?? (enabled ? 'enabled' : 'paused'),
    execution: {
      prompt: job.execution?.prompt ?? job.description ?? job.name,
      ...job.execution,
      target,
    },
    delivery: buildDefaultDelivery(job.delivery),
    failure: buildDefaultFailurePolicy(configManager, job.failure),
    source: normalizeSourceRecord(job.source, enabled, timestamp),
    runCount: job.runCount ?? 0,
    successCount: job.successCount ?? 0,
    failureCount: job.failureCount ?? 0,
  };
}

function normalizeRunRecord(run: AutomationRun, job?: AutomationJob): AutomationRun {
  const queuedAt = run.queuedAt ?? run.createdAt ?? Date.now();
  const target = run.target ?? job?.execution.target ?? { kind: 'isolated', createIfMissing: true } as AutomationSessionTarget;
  return {
    ...run,
    labels: run.labels ?? [],
    createdAt: run.createdAt ?? queuedAt,
    updatedAt: run.updatedAt ?? run.endedAt ?? run.startedAt ?? queuedAt,
    triggeredBy: normalizeSourceRecord(run.triggeredBy ?? job?.source, true, queuedAt),
    target,
    execution: {
      prompt: run.execution?.prompt ?? job?.execution.prompt ?? job?.description ?? job?.name ?? '',
      ...run.execution,
      target: run.execution?.target ?? target,
    },
    attempt: run.attempt ?? 1,
    deliveryIds: run.deliveryIds ?? [],
    telemetry: normalizeRunTelemetry(run.telemetry, run),
  };
}

function normalizeRunTelemetry(
  telemetry: AutomationRun['telemetry'],
  run: Pick<AutomationRun, 'modelId' | 'providerId' | 'continuationMode'>,
): AutomationRun['telemetry'] {
  if (!telemetry || typeof telemetry !== 'object') return undefined;
  const usage = telemetry.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const normalized: AutomationRunTelemetry = {
    usage: {
      inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
      outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
      cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0,
      cacheWriteTokens: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0,
      ...(typeof usage.reasoningTokens === 'number' ? { reasoningTokens: usage.reasoningTokens } : {}),
    },
    ...(typeof telemetry.llmCallCount === 'number' ? { llmCallCount: telemetry.llmCallCount } : {}),
    ...(typeof telemetry.toolCallCount === 'number' ? { toolCallCount: telemetry.toolCallCount } : {}),
    ...(typeof telemetry.turnCount === 'number' ? { turnCount: telemetry.turnCount } : {}),
    ...(telemetry.modelId ?? run.modelId ? { modelId: telemetry.modelId ?? run.modelId } : {}),
    ...(telemetry.providerId ?? run.providerId ? { providerId: telemetry.providerId ?? run.providerId } : {}),
    ...(typeof telemetry.reasoningSummaryPresent === 'boolean' ? { reasoningSummaryPresent: telemetry.reasoningSummaryPresent } : {}),
    ...(telemetry.source ? { source: telemetry.source } : {}),
  };
  return normalized;
}

function buildRunTelemetryFromAgent(agent: AgentRecord, run: AutomationRun): AutomationRunTelemetry | undefined {
  if (!agent.usage) return undefined;
  return {
    usage: {
      inputTokens: agent.usage.inputTokens,
      outputTokens: agent.usage.outputTokens,
      cacheReadTokens: agent.usage.cacheReadTokens,
      cacheWriteTokens: agent.usage.cacheWriteTokens,
      ...(typeof agent.usage.reasoningTokens === 'number' ? { reasoningTokens: agent.usage.reasoningTokens } : {}),
    },
    llmCallCount: agent.usage.llmCallCount,
    toolCallCount: agent.toolCallCount,
    turnCount: agent.usage.turnCount,
    ...(run.modelId ? { modelId: run.modelId } : {}),
    ...(run.providerId ? { providerId: run.providerId } : {}),
    reasoningSummaryPresent: (agent.usage.reasoningSummaryCount ?? 0) > 0,
    source: run.continuationMode === 'shared-session' || run.continuationMode === 'continued-live'
      ? 'shared-session'
      : 'local-agent',
  };
}

function normalizeExternalTelemetry(
  telemetry: AutomationRunTelemetry | undefined,
  run: AutomationRun,
  metadata?: Record<string, unknown>,
): AutomationRunTelemetry | undefined {
  if (!telemetry) return undefined;
  const normalized = normalizeRunTelemetry(telemetry, run);
  if (!normalized) return undefined;
  if (normalized.source) return normalized;
  const peerKind = typeof metadata?.remotePeerKind === 'string' ? metadata.remotePeerKind : undefined;
  return {
    ...normalized,
    source: peerKind === 'device' ? 'remote-device' : 'remote-node',
  };
}

export class AutomationManager {
  private static instance: AutomationManager | null = null;

  private readonly jobStore: AutomationJobStore;
  private readonly runStore: AutomationRunStore;
  private readonly legacyStore: PersistentStore<LegacySchedulerSnapshot>;
  private readonly spawnTask: (input: SpawnAutomationTaskInput) => string;
  private readonly configManager: ConfigManager;
  private readonly routeBindings: RouteBindingManager;
  private readonly sessionBroker: SharedSessionBroker;
  private readonly jobs = new Map<string, AutomationJob>();
  private readonly runs = new Map<string, AutomationRun>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private deliveryManager: AutomationDeliveryManager | null;
  private readonly deliveryInFlight = new Set<string>();
  private runtimeDispatch: DomainDispatch | null = null;
  private runtimeBus: RuntimeEventBus | null = null;
  private loaded = false;
  private running = false;
  private startPromise: Promise<void> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AutomationManagerConfig = {}) {
    this.jobStore = config.jobStore ?? new AutomationJobStore();
    this.runStore = config.runStore ?? new AutomationRunStore();
    this.legacyStore = config.legacyStore ?? new PersistentStore<LegacySchedulerSnapshot>(LEGACY_SCHEDULES_PATH);
    this.configManager = config.configManager ?? new ConfigManager();
    this.routeBindings = config.routeBindings ?? RouteBindingManager.getInstance();
    this.sessionBroker = config.sessionBroker ?? SharedSessionBroker.getInstance();
    this.spawnTask = config.spawnTask ?? ((input) => {
      const record = AgentManager.getInstance().spawn({
        mode: 'spawn',
        task: input.prompt,
        ...(input.modelId ? { model: input.modelId } : {}),
        ...(input.modelProvider ? { provider: input.modelProvider } : {}),
        ...(input.template ? { template: input.template } : {}),
        ...(input.toolAllowlist?.length ? { tools: [...input.toolAllowlist], restrictTools: true } : {}),
        ...(input.context ? { context: input.context } : {}),
      });
      return record.id;
    });
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
    }
    this.runtimeBus = config.runtimeBus ?? null;
    this.deliveryManager = config.deliveryManager ?? null;
  }

  static getInstance(): AutomationManager {
    if (!AutomationManager.instance) {
      AutomationManager.instance = new AutomationManager();
    }
    return AutomationManager.instance;
  }

  static resetInstance(): void {
    AutomationManager.instance?.stop();
    AutomationManager.instance = null;
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
    const now = Date.now();
    const enabled = input.enabled ?? true;
    const job: AutomationJob = {
      id: `auto-${randomUUID().slice(0, 8)}`,
      labels: [],
      createdAt: now,
      updatedAt: now,
      createdBy: 'automation-manager',
      updatedBy: 'automation-manager',
      name: input.name.trim() || input.prompt.slice(0, 40),
      description: input.description ?? input.prompt,
      status: enabled ? 'enabled' : 'paused',
      enabled,
      schedule: input.schedule,
      execution: buildDefaultExecution(input, this.configManager),
      delivery: buildDefaultDelivery(input.delivery),
      failure: buildDefaultFailurePolicy(this.configManager, input.failure),
      source: buildDefaultSource(enabled, now),
      nextRunAt: enabled ? computeNextRun(input.schedule, now) : undefined,
      lastRunAt: undefined,
      lastRunId: undefined,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      pausedReason: enabled ? undefined : 'created-disabled',
      deleteAfterRun: input.deleteAfterRun ?? Boolean(this.configManager.get('automation.deleteAfterRun')),
      archivedAt: undefined,
    };
    this.jobs.set(job.id, job);
    await this.saveJobs();
    this.scheduleJob(job);
    this.syncJobToRuntime(job, 'automation.create');
    this.emitJobCreated(job);
    return job;
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
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const updated: AutomationJob = {
      ...job,
      enabled,
      status: enabled ? 'enabled' : 'paused',
      pausedReason: enabled ? undefined : 'operator-disabled',
      updatedAt: Date.now(),
      nextRunAt: enabled ? computeNextRun(job.schedule) : undefined,
      source: {
        ...job.source,
        enabled,
        updatedAt: Date.now(),
      },
    };
    this.jobs.set(jobId, updated);
    await this.saveJobs();
    if (enabled) this.scheduleJob(updated);
    else this.cancelTimer(jobId);
    this.syncJobToRuntime(updated, 'automation.toggle');
    this.emitJobUpdated(updated, ['enabled', 'status', 'pausedReason', 'nextRunAt']);
    return updated;
  }

  async updateJob(jobId: string, patch: UpdateAutomationJobInput): Promise<AutomationJob | null> {
    await this.start();
    const job = this.jobs.get(jobId);
    if (!job) return null;

    const nextEnabled = patch.enabled ?? job.enabled;
    const prompt = patch.prompt ?? job.execution.prompt ?? job.description ?? job.name;
    const updatedAt = Date.now();
    const updated: AutomationJob = {
      ...job,
      name: patch.name ?? job.name,
      description: patch.description ?? (patch.prompt ? patch.prompt : job.description),
      enabled: nextEnabled,
      status: nextEnabled ? 'enabled' : 'paused',
      schedule: patch.schedule ?? job.schedule,
      execution: {
        ...job.execution,
        prompt,
        template: patch.template ?? job.execution.template,
        target: patch.target ?? job.execution.target,
        modelId: patch.model ?? job.execution.modelId,
        modelProvider: patch.provider ?? job.execution.modelProvider,
        reasoningEffort: patch.reasoningEffort ?? job.execution.reasoningEffort,
        timeoutMs: patch.timeoutMs ?? job.execution.timeoutMs ?? (Number(this.configManager.get('automation.defaultTimeoutMs') ?? 0) || undefined),
        toolAllowlist: patch.toolAllowlist ?? job.execution.toolAllowlist,
        autoApprove: patch.autoApprove ?? job.execution.autoApprove,
      },
      delivery: buildDefaultDelivery({
        ...job.delivery,
        ...(patch.delivery ?? {}),
      }),
      failure: buildDefaultFailurePolicy(this.configManager, {
        ...job.failure,
        ...(patch.failure ?? {}),
        retryPolicy: {
          ...job.failure.retryPolicy,
          ...(patch.failure?.retryPolicy ?? {}),
        },
      }),
      deleteAfterRun: patch.deleteAfterRun ?? job.deleteAfterRun,
      pausedReason: nextEnabled ? undefined : job.pausedReason ?? 'operator-disabled',
      nextRunAt: nextEnabled ? computeNextRun(patch.schedule ?? job.schedule) : undefined,
      updatedAt,
      source: {
        ...job.source,
        enabled: nextEnabled,
        updatedAt,
      },
    };

    this.jobs.set(jobId, updated);
    await this.saveJobs();
    this.scheduleJob(updated);
    this.syncJobToRuntime(updated, 'automation.update');
    this.emitJobUpdated(updated, ['name', 'description', 'schedule', 'execution', 'delivery', 'failure', 'enabled']);
    return updated;
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
      AgentManager.getInstance().cancel(run.agentId);
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
    this.cancelTimer(job.id);
    if (!this.running || !job.enabled) return;

    const catchUpWindowMs = Number(this.configManager.get('automation.catchUpWindowMinutes') ?? 30) * 60_000;
    const nextRunAtCandidate = job.nextRunAt ?? computeNextRun(job.schedule);
    const nextRunAt = nextRunAtCandidate !== undefined && nextRunAtCandidate < (Date.now() - catchUpWindowMs)
      ? computeNextRun(job.schedule, Date.now())
      : nextRunAtCandidate;
    if (nextRunAt === undefined) return;

    const refreshed: AutomationJob = {
      ...job,
      nextRunAt,
    };
    this.jobs.set(job.id, refreshed);
    void this.saveJobs();

    const delayMs = Math.max(0, nextRunAt - Date.now());
    if (delayMs > MAX_TIMEOUT_MS) {
      const timer = setTimeout(() => this.scheduleJob(refreshed), MAX_TIMEOUT_MS);
      this.timers.set(job.id, timer);
      return;
    }

    const timer = setTimeout(() => {
      const latest = this.jobs.get(job.id);
      if (!latest?.enabled) return;
      if (this.activeRunCount() >= this.maxConcurrentRuns()) {
        const deferred: AutomationJob = {
          ...latest,
          nextRunAt: Date.now() + 15_000,
          updatedAt: Date.now(),
        };
        this.jobs.set(latest.id, deferred);
        void this.saveJobs();
        this.scheduleJob(deferred);
        return;
      }
      void this.executeJob(latest, 'scheduled', true)
        .catch((error) => {
          logger.error('AutomationManager: scheduled execution failed', {
            jobId: latest.id,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          const current = this.jobs.get(job.id);
          if (!current?.enabled) return;
          const next = computeNextRun(current.schedule);
          if (next !== undefined) {
            const updated: AutomationJob = {
              ...current,
              nextRunAt: next,
              updatedAt: Date.now(),
            };
            this.jobs.set(current.id, updated);
            void this.saveJobs();
            this.scheduleJob(updated);
            return;
          }
          const completedOneShot: AutomationJob = {
            ...current,
            enabled: false,
            status: 'paused',
            pausedReason: 'one-shot-complete',
            nextRunAt: undefined,
            updatedAt: Date.now(),
          };
          this.jobs.set(current.id, completedOneShot);
          this.cancelTimer(current.id);
          void this.saveJobs();
        });
    }, delayMs);
    this.timers.set(job.id, timer);
  }

  private cancelTimer(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
  }

  private async executeJob(
    job: AutomationJob,
    trigger: AutomationRunTrigger,
    dueRun: boolean,
    attempt = 1,
  ): Promise<AutomationRun> {
    const now = Date.now();
    const prompt = job.execution.prompt ?? job.description ?? job.name;
    const resolved = await this.resolveExecution(job, prompt, trigger);
    const effectiveJob = resolved.updatedJob ?? job;
    const run: AutomationRun = {
      id: `autorun-${job.id}-${now}-${randomUUID().slice(0, 6)}`,
      labels: trigger === 'manual' ? ['manual'] : ['scheduled'],
      createdAt: now,
      updatedAt: now,
      createdBy: 'automation-manager',
      updatedBy: 'automation-manager',
      jobId: job.id,
      status: 'running',
      triggeredBy: {
        ...effectiveJob.source,
        lastSeenAt: now,
        updatedAt: now,
      },
      target: resolved.target,
      execution: {
        ...effectiveJob.execution,
        prompt,
      },
      scheduleKind: effectiveJob.schedule.kind,
      queuedAt: now,
      startedAt: now,
      endedAt: undefined,
      durationMs: undefined,
      forceRun: trigger === 'manual',
      dueRun,
      attempt,
      sessionId: resolved.session?.id,
      routeId: resolved.route?.id,
      route: resolved.route,
      continuationMode: resolved.continuationMode,
      deliveryIds: [],
      deliveryAttempts: undefined,
      modelId: effectiveJob.execution.modelId,
      providerId: effectiveJob.execution.modelProvider,
      result: undefined,
      error: undefined,
      cancelledReason: undefined,
      agentId: resolved.agentId,
    };

    try {
      if (resolved.continuationMode === 'continued-live') {
        const runningRun: AutomationRun = {
          ...run,
          agentId: resolved.agentId,
        };
        const updatedJob: AutomationJob = {
          ...effectiveJob,
          lastRunAt: now,
          lastRunId: runningRun.id,
          runCount: effectiveJob.runCount + 1,
          updatedAt: now,
        };
        this.runs.set(runningRun.id, runningRun);
        this.jobs.set(updatedJob.id, updatedJob);
        await this.syncExecutionRoute(updatedJob, runningRun);
        this.pruneRunHistory(updatedJob.id);
        await Promise.all([this.saveJobs(), this.saveRuns()]);
        this.syncRunToRuntime(runningRun, 'automation.execute');
        this.syncJobToRuntime(updatedJob, 'automation.execute');
        this.emitRunQueued(updatedJob, runningRun);
        this.emitRunStarted(updatedJob, runningRun);
        return runningRun;
      }

      const agentId = this.spawnTask({
        prompt: resolved.task,
        modelId: effectiveJob.execution.modelId,
        modelProvider: effectiveJob.execution.modelProvider,
        template: effectiveJob.execution.template,
        toolAllowlist: effectiveJob.execution.toolAllowlist,
        ...(resolved.session?.id ? { context: `shared-session:${resolved.session.id}` } : {}),
      });
      const runningRun: AutomationRun = {
        ...run,
        agentId,
      };
      const updatedJob: AutomationJob = {
        ...effectiveJob,
        lastRunAt: now,
        lastRunId: runningRun.id,
        runCount: effectiveJob.runCount + 1,
        updatedAt: now,
      };
      if (resolved.session?.id && resolved.continuationMode !== 'background') {
        await this.sessionBroker.bindAgent(resolved.session.id, agentId);
      }
      this.runs.set(runningRun.id, runningRun);
      this.jobs.set(updatedJob.id, updatedJob);
      await this.syncExecutionRoute(updatedJob, runningRun);
      this.pruneRunHistory(updatedJob.id);
      await Promise.all([this.saveJobs(), this.saveRuns()]);
      this.syncRunToRuntime(runningRun, 'automation.execute');
      this.syncJobToRuntime(updatedJob, 'automation.execute');
      this.emitRunQueued(updatedJob, runningRun);
      this.emitRunStarted(updatedJob, runningRun);
      return runningRun;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedRun: AutomationRun = {
        ...run,
        status: 'failed',
        endedAt: now,
        durationMs: 0,
        error: message,
      };
      this.runs.set(failedRun.id, failedRun);
      const updatedJob = this.applyFailureToJob(effectiveJob, now);
      this.jobs.set(updatedJob.id, updatedJob);
      await this.syncExecutionRoute(updatedJob, failedRun);
      if (failedRun.sessionId && failedRun.continuationMode !== 'continued-live') {
        await this.sessionBroker.appendSystemMessage(failedRun.sessionId, `Automation failed: ${message}`, {
          automationJobId: updatedJob.id,
          automationRunId: failedRun.id,
          status: 'failed',
        });
      }
      this.pruneRunHistory(updatedJob.id);
      await Promise.all([this.saveJobs(), this.saveRuns()]);
      this.syncRunToRuntime(failedRun, 'automation.execute');
      this.syncJobToRuntime(updatedJob, 'automation.execute');
      this.emitRunFailed(updatedJob, failedRun, message, true);
      if (!updatedJob.enabled && effectiveJob.enabled) {
        this.emitJobAutoDisabled(updatedJob, updatedJob.pausedReason ?? 'failure-threshold-reached');
      }
      throw error;
    }
  }

  private async resolveExecution(
    job: AutomationJob,
    prompt: string,
    trigger: AutomationRunTrigger,
  ): Promise<ResolvedAutomationExecution> {
    const target = job.execution.target;
    await this.routeBindings.start();
    await this.sessionBroker.start();

    if (target.kind === 'isolated') {
      return {
        task: prompt,
        continuationMode: 'spawn',
        route: this.resolveRouteForTarget(target, job),
        target,
      };
    }

    if (target.kind === 'background') {
      return {
        task: prompt,
        continuationMode: 'background',
        route: this.resolveRouteForTarget(target, job),
        target,
      };
    }

    if (target.kind === 'route') {
      const routeId = target.routeId ?? job.delivery.replyToRouteId;
      if (!routeId) {
        throw new Error(`Automation route target requires a route binding (${job.id})`);
      }
      const route = this.routeBindings.getBinding(routeId);
      if (!route) {
        throw new Error(`Automation route target not found: ${routeId}`);
      }
      return await this.resolveSharedSessionExecution(job, prompt, trigger, {
        routeId: route.id,
        target: {
          ...target,
          routeId: route.id,
        },
      });
    }

    if (target.kind === 'session') {
      if (!target.sessionId) {
        throw new Error(`Automation session target requires sessionId (${job.id})`);
      }
      const existingSession = this.sessionBroker.getSession(target.sessionId);
      if (!existingSession && !target.createIfMissing) {
        throw new Error(`Automation session target not found: ${target.sessionId}`);
      }
      const session = await this.sessionBroker.ensureSession({
        sessionId: target.sessionId,
        title: `${job.name} automation session`,
        metadata: {
          source: 'automation',
          jobId: job.id,
        },
        participant: {
          surfaceKind: 'service',
          surfaceId: 'surface:automation',
          userId: 'automation',
          displayName: `Automation: ${job.name}`,
          lastSeenAt: Date.now(),
        },
      });
      return await this.resolveSharedSessionExecution(job, prompt, trigger, {
        sessionId: session.id,
        target: {
          ...target,
          sessionId: session.id,
        },
      });
    }

    if (target.kind === 'pinned') {
      const pinnedSessionId = target.pinnedSessionId ?? `auto-pin-${job.id}`;
      const session = await this.sessionBroker.ensureSession({
        sessionId: pinnedSessionId,
        title: `${job.name} automation session`,
        metadata: {
          source: 'automation',
          jobId: job.id,
          targetKind: 'pinned',
        },
        participant: {
          surfaceKind: 'service',
          surfaceId: 'surface:automation',
          userId: 'automation',
          displayName: `Automation: ${job.name}`,
          lastSeenAt: Date.now(),
        },
      });
      const updatedTarget: AutomationSessionTarget = {
        ...target,
        pinnedSessionId,
        sessionId: session.id,
      };
      return await this.resolveSharedSessionExecution(job, prompt, trigger, {
        sessionId: session.id,
        target: updatedTarget,
        updatedJob: target.pinnedSessionId === pinnedSessionId
          ? undefined
          : {
              ...job,
              updatedAt: Date.now(),
              execution: {
                ...job.execution,
                target: updatedTarget,
              },
            },
      });
    }

    if (target.kind === 'current') {
      const preferredSession = target.sessionId
        ? this.sessionBroker.getSession(target.sessionId)
        : await this.sessionBroker.findPreferredSession({
            surfaceKind: target.surfaceKind ?? 'tui',
          });
      if (!preferredSession && !target.createIfMissing) {
        throw new Error(`No active shared session found for current target (${job.id})`);
      }
      const session = preferredSession ?? await this.sessionBroker.ensureSession({
        title: `${job.name} automation session`,
        metadata: {
          source: 'automation',
          jobId: job.id,
          targetKind: 'current',
        },
        participant: {
          surfaceKind: target.surfaceKind ?? 'service',
          surfaceId: `surface:${target.surfaceKind ?? 'automation'}`,
          userId: 'automation',
          displayName: `Automation: ${job.name}`,
          lastSeenAt: Date.now(),
        },
      });
      return await this.resolveSharedSessionExecution(job, prompt, trigger, {
        sessionId: session.id,
        target: {
          ...target,
          sessionId: session.id,
        },
      });
    }

    return {
      task: prompt,
      continuationMode: 'spawn',
      route: this.resolveRouteForTarget(target, job),
      target,
    };
  }

  private async resolveSharedSessionExecution(
    job: AutomationJob,
    prompt: string,
    trigger: AutomationRunTrigger,
    input: {
      readonly sessionId?: string;
      readonly routeId?: string;
      readonly target: AutomationSessionTarget;
      readonly updatedJob?: AutomationJob;
    },
  ): Promise<ResolvedAutomationExecution> {
    const route = input.routeId
      ? this.routeBindings.getBinding(input.routeId)
      : this.resolveRouteForTarget(input.target, job);
    if (route?.id && input.target.preserveThread && (input.target.threadId || input.target.channelId)) {
      await this.routeBindings.patchBinding(route.id, {
        ...(input.target.threadId ? { threadId: input.target.threadId } : {}),
        ...(input.target.channelId ? { channelId: input.target.channelId } : {}),
      });
    }
    const submission = await this.sessionBroker.submitMessage({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(route?.id ? { routeId: route.id } : {}),
      surfaceKind: 'service',
      surfaceId: 'surface:automation',
      externalId: `automation:${job.id}`,
      userId: 'automation',
      displayName: `Automation: ${job.name}`,
      title: job.name,
      body: prompt,
      metadata: {
        automationJobId: job.id,
        trigger,
        targetKind: input.target.kind,
      },
    });
    return this.toResolvedExecution(job, input.target, submission, input.updatedJob);
  }

  private toResolvedExecution(
    job: AutomationJob,
    target: AutomationSessionTarget,
    submission: SharedSessionSubmission,
    updatedJob?: AutomationJob,
  ): ResolvedAutomationExecution {
    const resolvedTarget: AutomationSessionTarget = {
      ...target,
      sessionId: submission.session.id,
      ...(submission.routeBinding?.id ? { routeId: submission.routeBinding.id } : {}),
    };
    return {
      task: submission.task ?? (job.execution.prompt ?? job.description ?? job.name),
      continuationMode: submission.mode === 'continued-live' ? 'continued-live' : 'shared-session',
      session: submission.session,
      route: submission.routeBinding,
      agentId: submission.activeAgentId,
      target: resolvedTarget,
      updatedJob,
    };
  }

  private resolveRouteForTarget(target: AutomationSessionTarget, job: AutomationJob): AutomationRouteBinding | undefined {
    const routeId = target.routeId ?? job.delivery.replyToRouteId;
    if (!routeId) return undefined;
    return this.routeBindings.getBinding(routeId);
  }

  private async syncExecutionRoute(job: AutomationJob, run: AutomationRun): Promise<void> {
    if (!run.routeId) return;
    await this.routeBindings.patchBinding(run.routeId, {
      ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      jobId: job.id,
      runId: run.id,
      ...(run.target.threadId ? { threadId: run.target.threadId } : {}),
      ...(run.target.channelId ? { channelId: run.target.channelId } : {}),
    });
  }

  private applyFailureToJob(job: AutomationJob, timestamp: number, countRun = true): AutomationJob {
    const nextFailureCount = job.failureCount + 1;
    const shouldPause = Boolean(job.failure.disableAfterFailures)
      && nextFailureCount >= job.failure.maxConsecutiveFailures;
    return {
      ...job,
      lastRunAt: timestamp,
      runCount: countRun ? job.runCount + 1 : job.runCount,
      failureCount: nextFailureCount,
      enabled: shouldPause ? false : job.enabled,
      status: shouldPause ? 'paused' : job.status,
      pausedReason: shouldPause ? 'failure-threshold-reached' : job.pausedReason,
      updatedAt: timestamp,
    };
  }

  private reconcileActiveRuns(): void {
    let jobsChanged = false;
    let runsChanged = false;
    for (const run of this.runs.values()) {
      if (run.status !== 'running' || !run.agentId) continue;
      const agent = AgentManager.getInstance().getStatus(run.agentId);
      if (!agent) {
        const missingAgeMs = Date.now() - (run.startedAt ?? run.queuedAt);
        if (missingAgeMs < Math.max(300_000, Number(this.configManager.get('automation.catchUpWindowMinutes') ?? 30) * 60_000)) {
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
        this.runs.set(run.id, updatedRun);
        this.syncRunToRuntime(updatedRun, 'automation.reconcile');
        const job = this.jobs.get(run.jobId);
        if (job) {
          const updatedJob = this.applyFailureToJob(job, endedAt, false);
          this.jobs.set(job.id, updatedJob);
          void this.syncExecutionRoute(updatedJob, updatedRun);
          if (updatedRun.sessionId && updatedRun.continuationMode !== 'continued-live') {
            void this.sessionBroker.appendSystemMessage(updatedRun.sessionId, updatedRun.error ?? 'Agent state lost before completion', {
              status: 'failed',
              automationJobId: updatedJob.id,
              automationRunId: updatedRun.id,
            });
          }
          this.syncJobToRuntime(updatedJob, 'automation.reconcile');
          this.emitRunFailed(updatedJob, updatedRun, updatedRun.error ?? 'Agent state lost', false);
          this.scheduleFailureFollowUp(updatedJob, updatedRun);
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
      this.runs.set(run.id, updatedRun);
      this.syncRunToRuntime(updatedRun, 'automation.reconcile');
      runsChanged = true;

      const job = this.jobs.get(run.jobId);
      if (!job) continue;
      const wasEnabled = job.enabled;
      const updatedJob: AutomationJob = terminalStatus === 'completed'
        ? {
            ...job,
            successCount: job.successCount + 1,
            failureCount: 0,
            updatedAt: endedAt,
          }
        : this.applyFailureToJob(job, endedAt, false);
      this.jobs.set(job.id, updatedJob);
      void this.syncExecutionRoute(updatedJob, updatedRun);
      if (updatedRun.sessionId && updatedRun.continuationMode !== 'continued-live') {
        const sessionBody = terminalStatus === 'completed'
          ? String(updatedRun.result ?? '')
          : terminalStatus === 'failed'
            ? updatedRun.error ?? 'Agent failed'
            : updatedRun.cancelledReason ?? 'Agent cancelled';
        if (sessionBody.trim().length > 0) {
          void this.sessionBroker.completeAgent(updatedRun.sessionId, updatedRun.agentId ?? updatedRun.id, sessionBody, {
            status: terminalStatus,
            automationJobId: updatedJob.id,
            automationRunId: updatedRun.id,
            routeId: updatedRun.routeId,
          });
        }
      }
      this.syncJobToRuntime(updatedJob, 'automation.reconcile');
      if (terminalStatus === 'completed') {
        this.emitRunCompleted(updatedJob, updatedRun, 'success');
      } else if (terminalStatus === 'failed') {
        this.emitRunFailed(updatedJob, updatedRun, updatedRun.error ?? 'Agent failed', false);
      } else {
        this.emitRunCompleted(updatedJob, updatedRun, 'cancelled');
      }
      this.maybeDeliverRun(updatedJob, updatedRun);
      if (terminalStatus === 'completed' && updatedJob.deleteAfterRun) {
        this.cancelTimer(updatedJob.id);
        this.jobs.delete(updatedJob.id);
      } else if (terminalStatus !== 'completed') {
        this.scheduleFailureFollowUp(updatedJob, updatedRun);
      }
      if (!updatedJob.enabled && wasEnabled && terminalStatus !== 'completed') {
        this.emitJobAutoDisabled(updatedJob, updatedJob.pausedReason ?? 'failure-threshold-reached');
      }
      jobsChanged = true;
    }
    if (jobsChanged) void this.saveJobs();
    if (runsChanged) void this.saveRuns();
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
    this.maybeDeliverFailureNotice(job, run);
    if (!job.enabled) return;

    if (job.failure.action === 'cooldown') {
      const cooled: AutomationJob = {
        ...job,
        nextRunAt: Date.now() + Math.max(1_000, job.failure.cooldownMs),
        updatedAt: Date.now(),
      };
      this.jobs.set(job.id, cooled);
      this.scheduleJob(cooled);
      void this.saveJobs();
      return;
    }

    const maxAttempts = Math.max(1, job.execution.maxAttempts ?? 1);
    if (job.failure.action !== 'retry' || run.attempt >= maxAttempts) {
      return;
    }
    const retryKey = `${job.id}:${run.id}`;
    const existing = this.retryTimers.get(retryKey);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(retryKey);
      const latestJob = this.jobs.get(job.id);
      if (!latestJob?.enabled) return;
      if (this.activeRunCount() >= this.maxConcurrentRuns()) {
        this.scheduleFailureFollowUp(latestJob, run);
        return;
      }
      void this.executeJob(latestJob, 'scheduled', false, run.attempt + 1).catch((error) => {
        logger.warn('AutomationManager: retry execution failed', {
          jobId: latestJob.id,
          runId: run.id,
          attempt: run.attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, Math.max(1_000, job.failure.cooldownMs));
    this.retryTimers.set(retryKey, timer);
  }

  private maybeDeliverFailureNotice(job: AutomationJob, run: AutomationRun): void {
    if (!this.deliveryManager) return;
    const routeIds = [job.failure.notifyRouteId, job.failure.deadLetterRouteId].filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (routeIds.length === 0) return;
    const targets = routeIds.map((routeId) => ({
      kind: 'surface',
      routeId,
    } as const));
    const message = [
      `Automation failure: ${job.name}`,
      `Run: ${run.id}`,
      `Status: ${run.status}`,
      run.error ? `Error: ${run.error}` : null,
      run.cancelledReason ? `Cancelled: ${run.cancelledReason}` : null,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n');
    void this.deliveryManager.deliverText(job, run, message, targets).catch((error) => {
      logger.warn('AutomationManager: failure notice delivery failed', {
        jobId: job.id,
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private syncRuntimeSnapshot(): void {
    if (!this.runtimeDispatch) return;
    for (const source of this.collectSources()) {
      this.runtimeDispatch.syncAutomationSource(source, 'automation.bootstrap');
    }
    for (const job of this.jobs.values()) {
      this.runtimeDispatch.syncAutomationJob(job, 'automation.bootstrap');
    }
    for (const run of this.runs.values()) {
      this.runtimeDispatch.syncAutomationRun(run, 'automation.bootstrap');
    }
  }

  private collectSources(): AutomationSourceRecord[] {
    const sources = new Map<string, AutomationSourceRecord>();
    for (const job of this.jobs.values()) {
      sources.set(job.source.id, job.source);
    }
    for (const run of this.runs.values()) {
      if (!run.triggeredBy?.id) continue;
      sources.set(run.triggeredBy.id, run.triggeredBy);
    }
    return [...sources.values()];
  }

  private syncJobToRuntime(job: AutomationJob, source: string): void {
    this.runtimeDispatch?.syncAutomationSource(job.source, `${source}.source`);
    this.runtimeDispatch?.syncAutomationJob(job, source);
  }

  private syncRunToRuntime(run: AutomationRun, source: string): void {
    this.runtimeDispatch?.syncAutomationSource(run.triggeredBy, `${source}.source`);
    this.runtimeDispatch?.syncAutomationRun(run, source);
  }

  private emitterContext(traceId: string, sessionId?: string): import('../runtime/emitters/index.ts').EmitterContext {
    return {
      sessionId: sessionId ?? 'automation',
      source: 'automation-manager',
      traceId,
    };
  }

  private emitJobCreated(job: AutomationJob): void {
    if (!this.runtimeBus) return;
    emitAutomationJobCreated(this.runtimeBus, this.emitterContext(job.id, job.execution.target.sessionId), {
      jobId: job.id,
      name: job.name,
      scheduleKind: job.schedule.kind,
      enabled: job.enabled,
    });
  }

  private emitJobUpdated(job: AutomationJob, changedFields: string[]): void {
    if (!this.runtimeBus) return;
    emitAutomationJobUpdated(this.runtimeBus, this.emitterContext(job.id, job.execution.target.sessionId), {
      jobId: job.id,
      changedFields,
    });
    if (job.enabled) {
      emitAutomationJobEnabled(this.runtimeBus, this.emitterContext(job.id, job.execution.target.sessionId), {
        jobId: job.id,
      });
    } else {
      emitAutomationJobDisabled(this.runtimeBus, this.emitterContext(job.id, job.execution.target.sessionId), {
        jobId: job.id,
        reason: job.pausedReason ?? 'disabled',
      });
    }
  }

  private emitJobAutoDisabled(job: AutomationJob, reason: string): void {
    if (!this.runtimeBus) return;
    emitAutomationJobAutoDisabled(this.runtimeBus, this.emitterContext(job.id, job.execution.target.sessionId), {
      jobId: job.id,
      reason,
      consecutiveFailures: job.failureCount,
    });
  }

  private emitRunQueued(job: AutomationJob, run: AutomationRun): void {
    if (!this.runtimeBus) return;
    emitAutomationRunQueued(this.runtimeBus, this.emitterContext(run.id, job.execution.target.sessionId), {
      jobId: job.id,
      runId: run.id,
      scheduledAt: run.queuedAt,
      forced: run.forceRun,
    });
  }

  private emitRunStarted(job: AutomationJob, run: AutomationRun): void {
    if (!this.runtimeBus || run.startedAt === undefined) return;
    emitAutomationRunStarted(this.runtimeBus, this.emitterContext(run.id, job.execution.target.sessionId), {
      jobId: job.id,
      runId: run.id,
      startedAt: run.startedAt,
      attempt: run.attempt,
    });
  }

  private emitRunCompleted(job: AutomationJob, run: AutomationRun, outcome: 'success' | 'partial' | 'failed' | 'cancelled'): void {
    if (!this.runtimeBus || run.startedAt === undefined || run.endedAt === undefined) return;
    emitAutomationRunCompleted(this.runtimeBus, this.emitterContext(run.id, job.execution.target.sessionId), {
      jobId: job.id,
      runId: run.id,
      startedAt: run.startedAt,
      completedAt: run.endedAt,
      durationMs: run.durationMs ?? Math.max(0, run.endedAt - run.startedAt),
      outcome,
    });
  }

  private emitRunFailed(job: AutomationJob, run: AutomationRun, error: string, retryable: boolean): void {
    if (!this.runtimeBus || run.startedAt === undefined || run.endedAt === undefined) return;
    emitAutomationRunFailed(this.runtimeBus, this.emitterContext(run.id, job.execution.target.sessionId), {
      jobId: job.id,
      runId: run.id,
      startedAt: run.startedAt,
      failedAt: run.endedAt,
      error,
      retryable,
    });
  }

  private maybeDeliverRun(job: AutomationJob, run: AutomationRun): void {
    if (!this.deliveryManager) return;
    if (job.delivery.mode === 'none') return;
    if (this.deliveryInFlight.has(run.id)) return;
    if (run.deliveryIds.length > 0) return;
    this.deliveryInFlight.add(run.id);
    void this.deliveryManager.deliverJobRun(job, run)
      .then(async (deliveryAttempts) => {
        if (deliveryAttempts.length === 0) return;
        const latest = this.runs.get(run.id);
        if (!latest) return;
        const updated: AutomationRun = {
          ...latest,
          deliveryIds: deliveryAttempts.map((attempt) => attempt.id),
          deliveryAttempts,
          updatedAt: Date.now(),
        };
        this.runs.set(updated.id, updated);
        this.syncRunToRuntime(updated, 'automation.delivery');
        await this.saveRuns();
      })
      .catch((error) => {
        logger.warn('AutomationManager: delivery failed', {
          runId: run.id,
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.deliveryInFlight.delete(run.id);
      });
  }
}
