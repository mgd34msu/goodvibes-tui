export type ProviderStatus = 'online' | 'rate-limited' | 'error' | 'unknown';

export interface ProviderHealth {
  name: string;
  status: ProviderStatus;
  lastLatencyMs?: number;
  lastErrorMessage?: string;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  rateLimitExpiresAt: number;
}

/**
 * Tracks provider request posture from shell-facing turn and provider events.
 * The panel owns event subscriptions and feeds those events into this tracker.
 */
export class ProviderHealthTracker {
  private records = new Map<string, ProviderHealth>();
  private streamStartMs: number | null = null;
  private turnStartMs: number | null = null;

  private static readonly DEFAULT_COOLDOWN_MS = 60_000;

  onTurnStart(): void {
    this.turnStartMs = Date.now();
  }

  onStreamStart(): void {
    this.streamStartMs = Date.now();
  }

  onLlmResponse(providerName: string): void {
    const now = Date.now();
    const latencyMs =
      this.streamStartMs !== null
        ? now - this.streamStartMs
        : this.turnStartMs !== null
          ? now - this.turnStartMs
          : undefined;
    this.streamStartMs = null;

    this.recordSuccess(providerName, latencyMs);
  }

  onTurnError(error: string, providerName = 'unknown'): void {
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

  private ensureRecord(name: string): ProviderHealth {
    let record = this.records.get(name);
    if (!record) {
      record = { name, status: 'unknown', rateLimitExpiresAt: 0 };
      this.records.set(name, record);
    }
    return record;
  }

  private recordSuccess(name: string, latencyMs?: number): void {
    const record = this.ensureRecord(name);
    record.status = 'online';
    record.lastSuccessAt = Date.now();
    record.lastErrorMessage = undefined;
    if (latencyMs !== undefined) {
      record.lastLatencyMs = latencyMs;
    }
    if (record.rateLimitExpiresAt > 0 && record.rateLimitExpiresAt <= Date.now()) {
      record.rateLimitExpiresAt = 0;
    }
  }

  private recordError(name: string, message: string, isRateLimit: boolean): void {
    const record = this.ensureRecord(name);
    record.lastErrorAt = Date.now();
    record.lastErrorMessage = message.slice(0, 120);
    if (isRateLimit) {
      record.status = 'rate-limited';
      record.rateLimitExpiresAt = Date.now() + ProviderHealthTracker.DEFAULT_COOLDOWN_MS;
      return;
    }
    record.status = 'error';
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
