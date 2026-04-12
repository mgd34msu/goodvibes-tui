import { randomUUID } from 'node:crypto';
import type { ArtifactReference, ArtifactStore } from '../artifacts/index.ts';
import { ChannelDeliveryRouter, RouteBindingManager } from '../channels/index.ts';
import { ConfigManager } from '../config/manager.ts';
import { ServiceRegistry } from '../config/service-registry.ts';
import { createDomainDispatch } from '../runtime/store/index.ts';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { RouteSurfaceKind } from '../runtime/events/routes.ts';
import {
  emitDeliveryFailed,
  emitDeliveryQueued,
  emitDeliveryStarted,
  emitDeliverySucceeded,
} from '../runtime/emitters/index.ts';
import type { AutomationDeliveryAttempt, AutomationDeliveryTarget } from './delivery.ts';
import type { AutomationJob } from './jobs.ts';
import type { AutomationRouteBinding } from './routes.ts';
import type { AutomationRun } from './runs.ts';
import { classifyDeliveryError } from '../integrations/delivery.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateRetryDelay(baseDelayMs: number, attempt: number, strategy: 'fixed' | 'linear' | 'exponential', maxDelayMs?: number, jitterMs?: number): number {
  const multiplier = strategy === 'fixed' ? 1 : strategy === 'linear' ? attempt : Math.pow(2, attempt - 1);
  const base = baseDelayMs * multiplier;
  const jitter = jitterMs ? Math.floor(Math.random() * jitterMs) : 0;
  return Math.min(base + jitter, maxDelayMs ?? Number.MAX_SAFE_INTEGER);
}

function buildDeliveryMessage(job: AutomationJob, run: AutomationRun): string {
  const lines = [
    `Automation: ${job.name}`,
    `Run: ${run.id}`,
    `Status: ${run.status}`,
  ];
  if (run.error) lines.push(`Error: ${run.error}`);
  if (job.delivery.includeSummary) {
    const content = typeof run.result === 'string'
      ? run.result
      : run.result !== undefined
        ? JSON.stringify(run.result, null, 2)
        : '';
    if (content) {
      lines.push('');
      lines.push(content.length > 3500 ? `${content.slice(0, 3500)}...` : content);
    }
  }
  return lines.join('\n');
}

function toDeliveryKind(surfaceKind: string): 'notification' | 'reply' | 'action' | 'callback' {
  return surfaceKind === 'webhook' ? 'callback' : 'notification';
}

function toDeliverySurfaceKind(surfaceKind: AutomationDeliveryTarget['surfaceKind']): RouteSurfaceKind {
  return surfaceKind ?? 'webhook';
}

function extractArtifactReferences(result: unknown): ArtifactReference[] {
  if (!result || typeof result !== 'object') return [];
  const record = result as Record<string, unknown>;
  const rawItems = [
    ...(Array.isArray(record.artifacts) ? record.artifacts : []),
    ...(Array.isArray(record.attachments) ? record.attachments : []),
    ...(Array.isArray(record.artifactIds) ? record.artifactIds.map((artifactId) => ({ artifactId })) : []),
  ];
  const references: ArtifactReference[] = [];
  for (const entry of rawItems) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      references.push({ artifactId: entry.trim() });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const artifactId = typeof candidate.artifactId === 'string'
      ? candidate.artifactId
      : typeof candidate.id === 'string'
        ? candidate.id
        : '';
    if (!artifactId) continue;
    references.push({
      artifactId,
      ...(typeof candidate.label === 'string' ? { label: candidate.label } : {}),
      ...(typeof candidate.metadata === 'object' && candidate.metadata !== null
        ? { metadata: candidate.metadata as Record<string, unknown> }
        : {}),
    });
  }
  return references.filter((entry, index, values) => values.findIndex((candidate) => candidate.artifactId === entry.artifactId) === index);
}

interface ResolvedDeliveryTarget {
  readonly target: AutomationDeliveryTarget;
  readonly binding?: AutomationRouteBinding;
}

export class AutomationDeliveryManager {
  private readonly serviceRegistry: ServiceRegistry;
  private readonly configManager: ConfigManager;
  private readonly routeBindings: RouteBindingManager;
  private readonly deliveryRouter: ChannelDeliveryRouter;
  private runtimeDispatch: DomainDispatch | null = null;
  private runtimeBus: RuntimeEventBus | null = null;

  constructor(config: {
    readonly serviceRegistry?: ServiceRegistry;
    readonly configManager?: ConfigManager;
    readonly routeBindings: RouteBindingManager;
    readonly deliveryRouter?: ChannelDeliveryRouter;
    readonly artifactStore?: ArtifactStore;
    readonly runtimeStore?: RuntimeStore;
    readonly runtimeBus?: RuntimeEventBus;
  }) {
    this.serviceRegistry = config.serviceRegistry ?? new ServiceRegistry();
    this.configManager = config.configManager ?? new ConfigManager();
    this.routeBindings = config.routeBindings;
    this.deliveryRouter = config.deliveryRouter ?? new ChannelDeliveryRouter({
      configManager: this.configManager,
      serviceRegistry: this.serviceRegistry,
      ...(config.artifactStore ? { artifactStore: config.artifactStore } : {}),
    });
    if (config.runtimeStore) this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
    this.runtimeBus = config.runtimeBus ?? null;
  }

  attachRuntime(config: {
    readonly runtimeStore?: RuntimeStore | null;
    readonly runtimeBus?: RuntimeEventBus | null;
  }): void {
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
    }
    if (config.runtimeBus) {
      this.runtimeBus = config.runtimeBus;
    }
  }

  getDeliveryRouter(): ChannelDeliveryRouter {
    return this.deliveryRouter;
  }

  setControlPlaneGateway(gateway: import('../control-plane/gateway.ts').ControlPlaneGateway | null): void {
    this.deliveryRouter.setControlPlaneGateway(gateway);
  }

  async deliverJobRun(job: AutomationJob, run: AutomationRun): Promise<readonly AutomationDeliveryAttempt[]> {
    if (job.delivery.mode === 'none') return [];

    await this.routeBindings.start();
    const body = buildDeliveryMessage(job, run);
    const primaryTargets = this.resolveTargets(job.delivery.targets.length > 0
      ? [...job.delivery.targets]
      : job.delivery.replyToRouteId
        ? [{ kind: 'surface', routeId: job.delivery.replyToRouteId } satisfies AutomationDeliveryTarget]
        : []);
    const attempts = await this.deliverText(job, run, body, primaryTargets.map((entry) => entry.target));
    const needsFallback = attempts.length === 0 || attempts.every((attempt) => attempt.status === 'failed' || attempt.status === 'dead_lettered');
    if (!needsFallback || job.delivery.fallbackTargets.length === 0) {
      return attempts;
    }
    const fallbackAttempts = await this.deliverText(job, run, body, job.delivery.fallbackTargets);
    return [...attempts, ...fallbackAttempts];
  }

  async deliverText(
    job: AutomationJob,
    run: AutomationRun,
    body: string,
    targets: readonly AutomationDeliveryTarget[],
  ): Promise<readonly AutomationDeliveryAttempt[]> {
    await this.routeBindings.start();
    const resolvedTargets = this.resolveTargets(targets);
    if (resolvedTargets.length === 0) return [];

    const attempts: AutomationDeliveryAttempt[] = [];
    for (const resolved of resolvedTargets) {
      const target = resolved.target;
      const deliveryId = `delivery-${randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();
      let attempt: AutomationDeliveryAttempt = {
        id: deliveryId,
        runId: run.id,
        jobId: job.id,
        target,
        status: 'pending',
      };
      attempts.push(attempt);
      this.syncAttempt(attempt, run, 'queued');

      const retryPolicy = job.failure.retryPolicy;
      let attemptIndex = 0;
      let lastError = '';
      while (attemptIndex < Math.max(1, retryPolicy.maxAttempts)) {
        attemptIndex += 1;
        attempt = {
          ...attempt,
          status: 'sending',
          startedAt: Date.now(),
          error: undefined,
        };
        this.syncAttempt(attempt, run, 'started');
        try {
          const responseId = await this.sendTarget(resolved, body, job, run);
          if (resolved.binding?.id && responseId) {
            await this.routeBindings.captureReplyTarget(resolved.binding.id, responseId, resolved.binding.threadId);
          }
          attempt = {
            ...attempt,
            status: 'sent',
            endedAt: Date.now(),
            responseId: responseId ?? target.address ?? target.routeId ?? target.label ?? target.surfaceKind ?? 'delivered',
          };
          attempts[attempts.length - 1] = attempt;
          this.syncAttempt(attempt, run, 'succeeded');
          lastError = '';
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          const retryable = classifyDeliveryError(error) === 'retryable';
          const lastTry = attemptIndex >= Math.max(1, retryPolicy.maxAttempts);
          if (!retryable || lastTry) {
            attempt = {
              ...attempt,
              status: retryable ? 'dead_lettered' : 'failed',
              endedAt: Date.now(),
              error: lastError,
            };
            attempts[attempts.length - 1] = attempt;
            this.syncAttempt(attempt, run, 'failed', lastError, retryable);
            break;
          }
          const delayMs = calculateRetryDelay(
            retryPolicy.delayMs,
            attemptIndex,
            retryPolicy.strategy,
            retryPolicy.maxDelayMs,
            retryPolicy.jitterMs,
          );
          await sleep(delayMs);
        }
      }

      if (lastError && attempts[attempts.length - 1]?.status === 'sending') {
        const failedAttempt: AutomationDeliveryAttempt = {
          ...attempts[attempts.length - 1]!,
          status: 'failed',
          endedAt: Date.now(),
          error: lastError,
        };
        attempts[attempts.length - 1] = failedAttempt;
        this.syncAttempt(failedAttempt, run, 'failed', lastError, true);
      }
    }

    return attempts;
  }

  private resolveTargets(targets: readonly AutomationDeliveryTarget[]): ResolvedDeliveryTarget[] {
    return targets.map((target) => {
      if (!target.routeId) return target;
      const binding = this.routeBindings.getBinding(target.routeId);
      if (!binding) return { target };
      return {
        target: {
          ...target,
          surfaceKind: target.surfaceKind ?? binding.surfaceKind,
          address: target.address
            ?? (typeof binding.metadata.responseUrl === 'string' ? binding.metadata.responseUrl
              : typeof binding.metadata.callbackUrl === 'string' ? binding.metadata.callbackUrl
                : binding.channelId ?? binding.externalId),
          label: target.label ?? binding.title,
        },
        binding,
      };
    }).map((entry) => ('target' in entry ? entry : { target: entry }));
  }

  private async sendTarget(
    resolved: ResolvedDeliveryTarget,
    body: string,
    job: AutomationJob,
    run: AutomationRun,
  ): Promise<string | undefined> {
    return this.deliveryRouter.deliver({
      target: resolved.target,
      body,
      title: job.name,
      jobId: job.id,
      runId: run.id,
      status: run.status,
      includeLinks: job.delivery.includeLinks,
      ...(run.result !== undefined ? { attachments: extractArtifactReferences(run.result) } : {}),
      ...(run.agentId ? { agentId: run.agentId } : {}),
      ...(resolved.binding ? { binding: resolved.binding } : {}),
    });
  }

  private syncAttempt(
    attempt: AutomationDeliveryAttempt,
    run: AutomationRun,
    phase: 'queued' | 'started' | 'succeeded' | 'failed',
    error?: string,
    retryable = false,
  ): void {
    this.runtimeDispatch?.syncDeliveryAttempt(attempt, `deliveries.${phase}`);
    if (!this.runtimeBus) return;
    const surfaceKind = toDeliverySurfaceKind(attempt.target.surfaceKind);
    const targetId = attempt.target.address ?? attempt.target.routeId ?? 'unknown';
    const ctx = {
      sessionId: run.target.sessionId ?? 'automation',
      source: 'automation-delivery-manager',
      traceId: attempt.id,
    } as const;
    if (phase === 'queued') {
      emitDeliveryQueued(this.runtimeBus, ctx, {
        deliveryId: attempt.id,
        jobId: attempt.jobId,
        runId: attempt.runId,
        surfaceKind,
        targetId,
        deliveryKind: toDeliveryKind(surfaceKind),
      });
      return;
    }
    if (phase === 'started') {
      emitDeliveryStarted(this.runtimeBus, ctx, {
        deliveryId: attempt.id,
        jobId: attempt.jobId,
        runId: attempt.runId,
        surfaceKind,
        targetId,
        startedAt: attempt.startedAt ?? Date.now(),
      });
      return;
    }
    if (phase === 'succeeded') {
      emitDeliverySucceeded(this.runtimeBus, ctx, {
        deliveryId: attempt.id,
        jobId: attempt.jobId,
        runId: attempt.runId,
        surfaceKind,
        targetId,
        completedAt: attempt.endedAt ?? Date.now(),
        durationMs: Math.max(0, (attempt.endedAt ?? Date.now()) - (attempt.startedAt ?? Date.now())),
        statusCode: 200,
      });
      return;
    }
    emitDeliveryFailed(this.runtimeBus, ctx, {
      deliveryId: attempt.id,
      jobId: attempt.jobId,
      runId: attempt.runId,
      surfaceKind,
      targetId,
      failedAt: attempt.endedAt ?? Date.now(),
      error: error ?? attempt.error ?? 'delivery failed',
      retryable,
    });
  }
}
