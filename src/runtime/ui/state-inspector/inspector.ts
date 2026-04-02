/**
 * StateInspectorProvider — enhanced runtime state inspector data provider.
 *
 * Extends the basic StateInspectorPanel from diagnostics with:
 * - Bounded transition history via BoundedTransitionLog
 * - Domain-filtered snapshots
 * - Subscription registry showing active consumers with notification metadata
 *
 * This is a DATA PROVIDER — no UI rendering logic.
 * v3 Section 26 (Devtools / State Inspector).
 */
import type {
  StateSnapshot,
  DomainSnapshot,
  TransitionEntry,
  SubscriptionInfo,
  StateInspectorConfig,
} from './types.ts';
import { DEFAULT_MAX_TRANSITIONS } from './types.ts';
import { BoundedTransitionLog } from './transition-log.ts';
import type { InspectableDomain } from '../../diagnostics/panels/state-inspector.ts';

// ── Serialize helper ──────────────────────────────────────────────────────────

/**
 * Serialize a value to a JSON-safe representation.
 * Maps → plain objects, Sets → arrays, circular refs → '[Circular]'.
 */
function serializeSafe(value: unknown, seen = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (value instanceof Map) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      result[String(k)] = serializeSafe(v, seen);
    }
    return result;
  }

  if (value instanceof Set) {
    return [...value].map((v) => serializeSafe(v, seen));
  }

  if (Array.isArray(value)) {
    return value.map((v) => serializeSafe(v, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = serializeSafe(v, seen);
  }
  return result;
}

// ── Domain state cache ────────────────────────────────────────────────────────

/** Cached revision snapshot used to detect transitions. */
interface DomainCache {
  revision: number;
  lastUpdatedAt: number;
  source: string;
}

// ── StateInspectorProvider ────────────────────────────────────────────────────

/**
 * StateInspectorProvider — full-featured state inspector data provider.
 *
 * ### Usage
 * ```ts
 * const inspector = createStateInspector({
 *   domains: [sessionDomainAdapter, conversationDomainAdapter],
 *   maxTransitions: 500,
 * });
 *
 * const snapshot = inspector.getSnapshot();
 * const history = inspector.getTransitionHistory();
 * const subs = inspector.getSubscriptions();
 * ```
 */
export class StateInspectorProvider {
  private readonly _domains: InspectableDomain[];
  private readonly _transitionLog: BoundedTransitionLog;
  private readonly _observedDomains: ReadonlySet<string> | undefined;
  private readonly _subscriptions = new Map<string, SubscriptionInfo & { callback: () => void }>();
  private readonly _domainCache = new Map<string, DomainCache>();
  private _subIdCounter = 0;

  /**
   * @param domains - Domain adapters to inspect.
   * @param config - Optional configuration.
   */
  constructor(
    domains: InspectableDomain[] = [],
    config: StateInspectorConfig = {},
  ) {
    this._domains = [...domains];
    this._transitionLog = new BoundedTransitionLog(
      config.maxTransitions ?? DEFAULT_MAX_TRANSITIONS,
    );
    this._observedDomains = config.observedDomains
      ? new Set(config.observedDomains)
      : undefined;
  }

  // ── Domain management ───────────────────────────────────────────────────────

  /**
   * Register an additional domain for inspection.
   * Triggers a notification to all subscribers.
   *
   * @param domain - Domain adapter to register.
   */
  public registerDomain(domain: InspectableDomain): void {
    this._domains.push(domain);
    this._notifyAll();
  }

  /** Returns the names of all currently registered domains. */
  public registeredDomainNames(): string[] {
    return this._domains.map((d) => d.name);
  }

  // ── Snapshot API ────────────────────────────────────────────────────────────

  /**
   * Capture a point-in-time snapshot of all (or filtered) domains.
   *
   * @param domainFilter - Optional list of domain names to include.
   *   When undefined, all registered domains are captured.
   * @returns StateSnapshot.
   */
  public getSnapshot(domainFilter?: readonly string[]): StateSnapshot {
    const targetDomains = this._filterDomains(domainFilter);
    const domains: DomainSnapshot[] = targetDomains.map((domain) => ({
      domain: domain.name,
      revision: domain.getRevision(),
      lastUpdatedAt: domain.getLastUpdatedAt(),
      state: serializeSafe(domain.getState()) as Record<string, unknown>,
    }));

    return {
      capturedAt: Date.now(),
      domains,
      domainCount: domains.length,
      domainFilter,
    };
  }

  // ── Transition history API ───────────────────────────────────────────────────

  /**
   * Poll for new transitions and record any detected domain revisions.
   *
   * Call this periodically (e.g. after state mutations) to keep the
   * transition log up to date.
   *
   * @returns Number of new transitions recorded.
   */
  public poll(): number {
    let recorded = 0;
    const now = Date.now();

    for (const domain of this._domains) {
      if (this._observedDomains && !this._observedDomains.has(domain.name)) continue;

      const currentRevision = domain.getRevision();
      const cached = this._domainCache.get(domain.name);

      if (!cached || cached.revision !== currentRevision) {
        const fromRevision = cached?.revision ?? 0;
        const rawState = domain.getState();

        // Attempt to extract 'source' from the domain state
        const source =
          typeof (rawState as Record<string, unknown>)['source'] === 'string'
            ? (rawState as Record<string, unknown>)['source'] as string
            : 'unknown';

        this._transitionLog.append({
          domain: domain.name,
          fromRevision,
          toRevision: currentRevision,
          recordedAt: now,
          source,
          state: serializeSafe(rawState) as Record<string, unknown>,
        });

        this._domainCache.set(domain.name, {
          revision: currentRevision,
          lastUpdatedAt: domain.getLastUpdatedAt(),
          source,
        });

        recorded++;
      }
    }

    if (recorded > 0) this._notifyAll();
    return recorded;
  }

  /**
   * Return all retained transition entries in chronological order.
   *
   * @returns Ordered array of TransitionEntry.
   */
  public getTransitionHistory(): TransitionEntry[] {
    return this._transitionLog.getAll();
  }

  /**
   * Return transition history filtered by domain.
   *
   * @param domain - Domain name to filter by.
   */
  public getTransitionsByDomain(domain: string): TransitionEntry[] {
    return this._transitionLog.getByDomain(domain);
  }

  /**
   * Return transitions recorded at or after the given epoch ms timestamp.
   *
   * @param sinceMs - Inclusive lower bound (epoch ms).
   */
  public getTransitionsSince(sinceMs: number): TransitionEntry[] {
    return this._transitionLog.getSince(sinceMs);
  }

  /**
   * Return the N most recent transitions.
   *
   * @param n - Maximum number of entries.
   */
  public getLastTransitions(n: number): TransitionEntry[] {
    return this._transitionLog.getLast(n);
  }

  /** Total number of transitions ever recorded (not capped by maxTransitions). */
  get totalTransitions(): number {
    return this._transitionLog.totalAppended;
  }

  /**
   * Clear all stored transitions.
   * Does not reset subscription registry or domain cache.
   */
  public clearTransitionHistory(): void {
    this._transitionLog.clear();
  }

  // ── Subscription API ─────────────────────────────────────────────────────────

  /**
   * Subscribe to state inspector change notifications.
   *
   * @param callback - Function invoked when a domain transition is detected.
   * @param label - Human-readable label for this subscriber.
   * @param domainFilter - Optional domain names to restrict notifications to.
   * @returns Object with `id` (subscription ID) and `unsubscribe` function.
   */
  public subscribe(
    callback: () => void,
    label: string,
    domainFilter?: readonly string[],
  ): { id: string; unsubscribe: () => void } {
    const id = `sub-${++this._subIdCounter}`;
    const info: SubscriptionInfo & { callback: () => void } = {
      id,
      label,
      registeredAt: Date.now(),
      domainFilter,
      notificationCount: 0,
      lastNotifiedAt: undefined,
      callback,
      errorCount: 0,
      lastError: undefined,
    };
    this._subscriptions.set(id, info);
    return {
      id,
      unsubscribe: () => this._subscriptions.delete(id),
    };
  }

  /**
   * Return metadata for all active subscriptions.
   * Callbacks are not exposed.
   *
   * @returns Array of SubscriptionInfo.
   */
  public getSubscriptions(): SubscriptionInfo[] {
    return [...this._subscriptions.values()].map((sub) => ({
      id: sub.id,
      label: sub.label,
      registeredAt: sub.registeredAt,
      domainFilter: sub.domainFilter,
      notificationCount: sub.notificationCount,
      lastNotifiedAt: sub.lastNotifiedAt,
      errorCount: sub.errorCount,
      lastError: sub.lastError,
    }));
  }

  /**
   * Return the count of currently active subscriptions.
   */
  get subscriptionCount(): number {
    return this._subscriptions.size;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /** Filter domains by the provided list, or return all if undefined. */
  private _filterDomains(filter?: readonly string[]): InspectableDomain[] {
    if (!filter) return this._domains;
    const filterSet = new Set(filter);
    return this._domains.filter((d) => filterSet.has(d.name));
  }

  /** Notify all subscribers, tracking notification metadata. */
  private _notifyAll(): void {
    const now = Date.now();
    for (const sub of this._subscriptions.values()) {
      try {
        sub.callback();
        (sub as { notificationCount: number; lastNotifiedAt?: number }).notificationCount++;
        (sub as { notificationCount: number; lastNotifiedAt?: number }).lastNotifiedAt = now;
      } catch (err) {
        // Non-fatal: subscriber errors must not crash the provider
        (sub as { errorCount: number; lastError?: string }).errorCount =
          (sub.errorCount ?? 0) + 1;
        (sub as { errorCount: number; lastError?: string }).lastError =
          err instanceof Error ? err.message : String(err);
      }
    }
  }
}
