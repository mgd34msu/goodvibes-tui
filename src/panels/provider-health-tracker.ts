// ProviderStatus is the shared SDK type — imported from the runtime barrel
// to eliminate the duplicate local definition that diverged from the SDK shape.
import type {
  ProviderHealthDomainState,
  ProviderHealthRecord,
  ProviderStatus,
} from '@/runtime/index.ts';
import { calcSessionCost } from '../export/cost-utils.ts';

export type { ProviderStatus };

/** Token/cost usage delta carried by one LLM_RESPONSE_RECEIVED event. */
export interface ProviderUsageDelta {
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface ProviderHealth {
  name: string;
  status: ProviderStatus;
  lastLatencyMs?: number;
  lastErrorMessage?: string;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  rateLimitExpiresAt: number;
  /** Most recent model id seen for this provider (from LLM responses). */
  lastModelId?: string;
  /** Session request counter (successes + errors). */
  requests: number;
  /** Session error counter. */
  errors: number;
  /** Session token counters (absorbed from the retired provider-stats panel). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Session USD cost accumulated per call via calcSessionCost. */
  totalCostUsd: number;
  /** Ring buffer of recent request latencies in ms (most-recent last). */
  latencies: number[];
}

/** Per-provider identity/config metadata used to build SDK domain state. */
export interface ProviderHealthMeta {
  readonly providerId: string;
  readonly displayName?: string;
  readonly isActive: boolean;
  readonly isConfigured: boolean;
}

const LATENCY_RING_SIZE = 20;

function avg(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Tracks provider request posture from shell-facing turn and provider events.
 * The panel owns event subscriptions and feeds those events into this tracker.
 *
 * WO-112: the tracker also accumulates the session metrics the retired
 * provider-stats panel used to duplicate (latency ring, request/error/token
 * counters, per-call cost) and can project its records into the SDK
 * ProviderHealthDomainState shape so the orphaned ProviderHealthDataProvider
 * (60-point timelines, success/error rates, cache metrics) is the single
 * derivation engine for the provider console.
 */
export class ProviderHealthTracker {
  private records = new Map<string, ProviderHealth>();
  private streamStartMs: number | null = null;
  private turnStartMs: number | null = null;
  private revision = 0;

  private static readonly DEFAULT_COOLDOWN_MS = 60_000;

  onTurnStart(): void {
    this.turnStartMs = Date.now();
  }

  onStreamStart(): void {
    this.streamStartMs = Date.now();
  }

  onLlmResponse(providerName: string, usage?: ProviderUsageDelta): void {
    const now = Date.now();
    const latencyMs =
      this.streamStartMs !== null
        ? now - this.streamStartMs
        : this.turnStartMs !== null
          ? now - this.turnStartMs
          : undefined;
    this.streamStartMs = null;

    this.recordSuccess(providerName, latencyMs, usage);
  }

  /**
   * Record a turn error against a concrete provider. The panel resolves the
   * active provider (in-flight request, model domain, config, last response)
   * before calling this — the tracker never invents an 'unknown' row.
   */
  onTurnError(error: string, providerName: string): void {
    this.streamStartMs = null;
    this.turnStartMs = null;
    const isRateLimit = this.isRateLimitMessage(error);

    this.recordError(providerName, error, isRateLimit);
  }

  onProvidersChanged(providerIds: readonly string[]): void {
    try {
      for (const providerId of providerIds) {
        if (!this.records.has(providerId)) {
          this.ensureRecord(providerId);
        }
      }
    } catch {
      // Ignore provider catalog churn while the shell is refreshing.
    }
  }

  getAll(): ProviderHealth[] {
    return [...this.records.values()];
  }

  get(name: string): ProviderHealth | undefined {
    return this.records.get(name);
  }

  /**
   * Project tracked records into the SDK ProviderHealthDomainState shape so
   * ProviderHealthDataProvider can derive timelines, rates, and sort order.
   * Providers present in `meta` but never seen by the tracker are emitted as
   * zero-stat 'unknown' records; tracked providers missing from `meta` are
   * kept so attribution/table rows never silently disappear.
   */
  buildHealthDomainState(meta: readonly ProviderHealthMeta[]): ProviderHealthDomainState {
    const providers = new Map<string, ProviderHealthRecord>();
    const metaById = new Map(meta.map((entry) => [entry.providerId, entry] as const));
    const ids = new Set<string>([...metaById.keys(), ...this.records.keys()]);

    let degradedCount = 0;
    let unavailableCount = 0;
    let healthySeen = 0;

    for (const id of ids) {
      const record = this.records.get(id);
      const entry = metaById.get(id);
      const latencies = record?.latencies ?? [];
      const requests = record?.requests ?? 0;
      const errors = record?.errors ?? 0;
      const status: ProviderStatus = record?.status ?? 'unknown';

      if (status === 'degraded' || status === 'rate_limited' || status === 'auth_error') degradedCount++;
      if (status === 'unavailable') unavailableCount++;
      if (status === 'healthy') healthySeen++;

      const cacheRead = record?.cacheReadTokens ?? 0;
      const cacheWrite = record?.cacheWriteTokens ?? 0;
      const promptTokens = record?.inputTokens ?? 0;

      providers.set(id, {
        providerId: id,
        displayName: entry?.displayName ?? id,
        status,
        isActive: entry?.isActive ?? false,
        isConfigured: entry?.isConfigured ?? true,
        stats: {
          totalCalls: requests,
          successCalls: Math.max(0, requests - errors),
          errorCalls: errors,
          avgLatencyMs: Math.round(avg(latencies)),
          minLatencyMs: latencies.length > 0 ? Math.min(...latencies) : 0,
          maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
          lastSuccessAt: record?.lastSuccessAt,
          lastErrorAt: record?.lastErrorAt,
          lastErrorMessage: record?.lastErrorMessage,
        },
        ...(cacheRead + cacheWrite > 0
          ? {
            cacheMetrics: {
              cacheReadTokens: cacheRead,
              cacheWriteTokens: cacheWrite,
              hitRate: promptTokens + cacheRead > 0 ? cacheRead / (promptTokens + cacheRead) : 0,
            },
          }
          : {}),
        lastCheckedAt: Date.now(),
        ...(record && record.rateLimitExpiresAt > Date.now()
          ? { rateLimitResetAt: record.rateLimitExpiresAt }
          : {}),
      });
    }

    const compositeStatus = unavailableCount > 0
      ? 'critical'
      : degradedCount > 0
        ? 'degraded'
        : healthySeen > 0 && healthySeen === ids.size
          ? 'healthy'
          : ids.size === 0
            ? 'unknown'
            : healthySeen > 0
              ? 'healthy'
              : 'unknown';

    this.revision += 1;
    return {
      revision: this.revision,
      lastUpdatedAt: Date.now(),
      source: 'provider-health-panel',
      providers,
      compositeStatus,
      degradedCount,
      unavailableCount,
      warnings: [],
    };
  }

  private ensureRecord(name: string): ProviderHealth {
    let record = this.records.get(name);
    if (!record) {
      record = {
        name,
        status: 'unknown',
        rateLimitExpiresAt: 0,
        requests: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        latencies: [],
      };
      this.records.set(name, record);
    }
    return record;
  }

  private applyUsage(record: ProviderHealth, usage: ProviderUsageDelta | undefined): void {
    if (!usage) return;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    record.inputTokens += input;
    record.outputTokens += output;
    record.cacheReadTokens += cacheRead;
    record.cacheWriteTokens += cacheWrite;
    record.totalTokens += input + output + cacheRead + cacheWrite;
    if (usage.model) record.lastModelId = usage.model;
    const model = usage.model ?? record.lastModelId;
    if (model) {
      record.totalCostUsd += calcSessionCost(input, output, cacheRead, cacheWrite, model);
    }
  }

  private recordSuccess(name: string, latencyMs: number | undefined, usage?: ProviderUsageDelta): void {
    const record = this.ensureRecord(name);
    record.status = 'healthy';
    record.lastSuccessAt = Date.now();
    record.lastErrorMessage = undefined;
    record.requests += 1;
    this.applyUsage(record, usage);
    if (latencyMs !== undefined) {
      record.lastLatencyMs = latencyMs;
      if (latencyMs > 0) {
        record.latencies.push(latencyMs);
        if (record.latencies.length > LATENCY_RING_SIZE) record.latencies.shift();
      }
    }
    if (record.rateLimitExpiresAt > 0 && record.rateLimitExpiresAt <= Date.now()) {
      record.rateLimitExpiresAt = 0;
    }
  }

  private recordError(name: string, message: string, isRateLimit: boolean): void {
    const record = this.ensureRecord(name);
    record.lastErrorAt = Date.now();
    record.lastErrorMessage = message.slice(0, 120);
    record.requests += 1;
    record.errors += 1;
    if (isRateLimit) {
      record.status = 'rate_limited';
      record.rateLimitExpiresAt = Date.now() + ProviderHealthTracker.DEFAULT_COOLDOWN_MS;
      return;
    }
    record.status = 'degraded';
  }

  private isRateLimitMessage(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.includes('429')
      || lower.includes('402')
      || /rate.limit|too many requests|quota exceeded|throttl|depleted|credits/.test(lower)
    );
  }
}
