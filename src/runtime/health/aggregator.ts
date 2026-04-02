/**
 * RuntimeHealthAggregator — tracks health status for all runtime domains and
 * derives composite system health. Consumers subscribe to health changes or
 * query current health state.
 */

import type {
  HealthDomain,
  HealthStatus,
  DomainHealth,
  CompositeHealth,
} from './types.ts';

/** Shallow array equality check for string arrays */
function arraysEqual(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** All known domains, used to initialize health map on construction */
const ALL_DOMAINS = [
  'turn', 'toolExecution', 'permissions', 'tasks', 'agents',
  'plugins', 'mcp', 'transport', 'session', 'compaction',
  'conversation', 'model', 'panels', 'overlays', 'providerHealth',
  'daemon', 'acp', 'integrations', 'telemetry', 'git',
  'discovery', 'intelligence', 'uiPerf',
] as const satisfies HealthDomain[];

/** Compile-time check: ALL_DOMAINS must cover every HealthDomain value */
type _AssertAllDomainsCovered = typeof ALL_DOMAINS[number] extends HealthDomain ? HealthDomain extends typeof ALL_DOMAINS[number] ? true : never : never;

/** Default maximum recovery attempts before a domain is considered permanently failed */
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;

/**
 * Tracks per-domain health and derives composite system health.
 * All domains are initialized as 'unknown' at construction time.
 * Subscribers are notified synchronously on any health change.
 */
export class RuntimeHealthAggregator {
  private readonly domainHealth: Map<HealthDomain, DomainHealth>;
  private readonly subscribers: Set<(health: CompositeHealth) => void>;
  private readonly clock: () => number;

  /**
   * @param clock - Optional injectable clock function (default: Date.now).
   *   Useful in tests to control time without real clock dependencies.
   */
  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.domainHealth = new Map();
    this.subscribers = new Set();

    const now = this.clock();
    for (const domain of ALL_DOMAINS) {
      this.domainHealth.set(domain, {
        domain,
        status: 'unknown',
        lastTransitionAt: now,
        recoveryAttempts: 0,
        maxRecoveryAttempts: DEFAULT_MAX_RECOVERY_ATTEMPTS,
      });
    }
  }

  /**
   * Update a domain's health status and optionally override specific fields.
   * Notifies all subscribers if the status actually changed.
   */
  updateDomainHealth(
    domain: HealthDomain,
    status: HealthStatus,
    details?: Partial<Omit<DomainHealth, 'domain' | 'status' | 'lastTransitionAt'>>,
  ): void {
    const existing = this.domainHealth.get(domain);
    const now = this.clock();

    const updated: DomainHealth = {
      domain,
      status,
      lastTransitionAt: existing?.status !== status ? now : (existing?.lastTransitionAt ?? now),
      recoveryAttempts: details?.recoveryAttempts ?? existing?.recoveryAttempts ?? 0,
      maxRecoveryAttempts: details?.maxRecoveryAttempts ?? existing?.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS,
      degradedCapabilities: details?.degradedCapabilities ?? existing?.degradedCapabilities,
      failureReason: details?.failureReason ?? (status !== 'failed' ? undefined : existing?.failureReason),
    };

    this.domainHealth.set(domain, updated);

    // Only notify subscribers if something meaningful changed
    const statusChanged = existing?.status !== status;
    const capabilitiesChanged =
      details?.degradedCapabilities !== undefined &&
      !arraysEqual(details.degradedCapabilities, existing?.degradedCapabilities);
    const reasonChanged =
      details?.failureReason !== undefined &&
      details.failureReason !== existing?.failureReason;

    if (statusChanged || capabilitiesChanged || reasonChanged) {
      this.notifySubscribers();
    }
  }

  /**
   * Get the current health record for a specific domain.
   * Always returns a record (domains are pre-initialized as 'unknown').
   */
  getDomainHealth(domain: HealthDomain): DomainHealth {
    const health = this.domainHealth.get(domain);
    if (!health) {
      // Defensive fallback: domain not in ALL_DOMAINS list
      return {
        domain,
        status: 'unknown',
        lastTransitionAt: this.clock(),
        recoveryAttempts: 0,
        maxRecoveryAttempts: DEFAULT_MAX_RECOVERY_ATTEMPTS,
      };
    }
    return health;
  }

  /**
   * Get composite system health derived from all domain states.
   * Overall: 'failed' if any domain failed, 'degraded' if any degraded, 'healthy' otherwise.
   * Domains still 'unknown' do not contribute to 'degraded' or 'failed'.
   */
  getCompositeHealth(): CompositeHealth {
    const failedDomains: HealthDomain[] = [];
    const degradedDomains: HealthDomain[] = [];
    let lastUpdatedAt = 0;

    for (const health of this.domainHealth.values()) {
      if (health.status === 'failed') failedDomains.push(health.domain);
      else if (health.status === 'degraded') degradedDomains.push(health.domain);
      if (health.lastTransitionAt > lastUpdatedAt) lastUpdatedAt = health.lastTransitionAt;
    }

    return {
      overall: this.deriveOverallHealth(),
      domains: new Map(this.domainHealth),
      degradedDomains,
      failedDomains,
      lastUpdatedAt,
    };
  }

  /**
   * Check whether a domain is allowed to execute an operation.
   * A domain is blocked if it is 'failed' or 'degraded' and the optional operation
   * matches one of the degradedCapabilities for that domain.
   */
  canExecute(
    domain: HealthDomain,
    operation?: string,
  ): { allowed: boolean; reason?: string } {
    const health = this.getDomainHealth(domain);

    if (health.status === 'failed') {
      return {
        allowed: false,
        reason: health.failureReason ?? `Domain '${domain}' is in failed state`,
      };
    }

    if (health.status === 'degraded' && operation !== undefined) {
      const blocked = health.degradedCapabilities?.includes(operation) ?? false;
      if (blocked) {
        return {
          allowed: false,
          reason: `Operation '${operation}' is unavailable while domain '${domain}' is degraded`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Subscribe to composite health changes.
   * The callback is invoked synchronously after every domain health update.
   * Returns an unsubscribe function.
   */
  subscribe(callback: (health: CompositeHealth) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /** Derive overall health status from all domain states */
  private deriveOverallHealth(): HealthStatus {
    let hasDegraded = false;
    let allUnknown = true;

    for (const health of this.domainHealth.values()) {
      if (health.status === 'failed') return 'failed';
      if (health.status === 'degraded') hasDegraded = true;
      if (health.status !== 'unknown') allUnknown = false;
    }

    if (allUnknown) return 'unknown';
    if (hasDegraded) return 'degraded';
    return 'healthy';
  }

  /** Notify all subscribers with current composite health */
  private notifySubscribers(): void {
    const composite = this.getCompositeHealth();
    for (const subscriber of this.subscribers) {
      subscriber(composite);
    }
  }
}
