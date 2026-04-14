/**
 * StateInspectorProvider — enhanced runtime state inspector data provider.
 *
 * Extends the basic StateInspectorPanel from diagnostics with:
 * - Bounded transition history via BoundedTransitionLog
 * - Domain-filtered snapshots
 * - Subscription registry showing active consumers with notification metadata
 *
 * This is a DATA PROVIDER — no UI rendering logic.
 * State inspector provider implementation.
 */
import type {
  StateSnapshot,
  DomainSnapshot,
  TransitionEntry,
  SubscriptionInfo,
  StateInspectorConfig,
  TimelineEvent,
  TimeTravelCursor,
} from './types.ts';
import { DEFAULT_MAX_TRANSITIONS, DEFAULT_TIMELINE_BUFFER_SIZE } from './types.ts';
import { BoundedTransitionLog } from './transition-log.ts';
import { TimelineBuffer } from './timeline.ts';
import type { InspectableDomain } from '../../diagnostics/panels/state-inspector.ts';
import { serializeSafe } from './serialize.ts';
import { summarizeError } from '../../../utils/error-display.ts';

// ── Domain state cache ────────────────────────────────────────────────────────

/** Cached revision snapshot used to detect transitions. */
interface DomainCache {
  revision: number;
  lastUpdatedAt: number;
  source: string;
}

// ── Internal mutable subscription type ───────────────────────────────────────

/** Internal mutable version of SubscriptionInfo, also carries the callback. */
interface MutableSubscriptionInfo {
  id: string;
  label: string;
  registeredAt: number;
  domainFilter: readonly string[] | undefined;
  notificationCount: number;
  lastNotifiedAt: number | undefined;
  callback: () => void;
  errorCount: number;
  lastError: string | undefined;
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
  private readonly _timeline: TimelineBuffer;
  private readonly _observedDomains: ReadonlySet<string> | undefined;
  private readonly _subscriptions = new Map<string, MutableSubscriptionInfo>();
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
    this._timeline = new TimelineBuffer(
      config.timelineBufferSize ?? DEFAULT_TIMELINE_BUFFER_SIZE,
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

        const serializedState = serializeSafe(rawState) as Record<string, unknown>;
        const entry = this._transitionLog.append({
          domain: domain.name,
          fromRevision,
          toRevision: currentRevision,
          recordedAt: now,
          source,
          state: serializedState,
        });

        // Record timeline event for time-travel replay
        this._timeline.append({
          capturedAt: now,
          domain: domain.name,
          transitionId: entry.id,
          snapshot: serializedState,
          label: source !== 'unknown' ? source : undefined,
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
   * Clear all stored transitions and timeline events.
   * Does not reset subscription registry or domain cache.
   */
  public clearTransitionHistory(): void {
    this._transitionLog.clear();
    this._timeline.clear();
  }

  // ── Time-travel API ──────────────────────────────────────────────────────────

  /**
   * Return all retained timeline events in chronological order.
   *
   * @returns Ordered array of TimelineEvent.
   */
  public getTimeline(): TimelineEvent[] {
    return this._timeline.getAll();
  }

  /**
   * Return the event at the current time-travel cursor position.
   * Returns undefined when the cursor is at the live position.
   *
   * @returns TimelineEvent or undefined when live.
   */
  public getCurrentTimelineEvent(): TimelineEvent | undefined {
    return this._timeline.getCurrentEvent();
  }

  /**
   * Current time-travel cursor state.
   */
  get timeTravelCursor(): TimeTravelCursor {
    return this._timeline.cursorState;
  }

  /**
   * Whether the inspector is currently in time-travel mode (cursor pinned).
   */
  get isTimeTravel(): boolean {
    return !this._timeline.isLive;
  }

  /**
   * Step the cursor one event backward (toward oldest).
   *
   * @returns true if the cursor moved.
   */
  public stepBack(): boolean {
    return this._timeline.stepBack();
  }

  /**
   * Step the cursor one event forward (toward live).
   *
   * @returns true if the cursor moved.
   */
  public stepForward(): boolean {
    return this._timeline.stepForward();
  }

  /**
   * Seek the cursor to an absolute logical index.
   * Pass `timeline.size` to return to live.
   *
   * @param index — Target index (size = live).
   */
  public seekTo(index: number): void {
    this._timeline.seekTo(index);
  }

  /**
   * Seek to the nearest event at or before a given epoch ms timestamp.
   *
   * @param epochMs — Target timestamp.
   */
  public seekToTime(epochMs: number): void {
    this._timeline.seekToTime(epochMs);
  }

  /**
   * Exit time-travel mode, returning the cursor to the live tail.
   */
  public exitTimeTravel(): void {
    this._timeline.exitTimeTravel();
  }

  /**
   * Get the snapshot at the current cursor position for display.
   * Returns undefined when live (callers should use getSnapshot() instead).
   *
   * @returns The pinned snapshot state or undefined when live.
   */
  public getTimeTravelSnapshot(): TimelineEvent | undefined {
    return this._timeline.getCurrentEvent();
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
    const info: MutableSubscriptionInfo = {
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
        sub.notificationCount++;
        sub.lastNotifiedAt = now;
      } catch (err) {
        // Non-fatal: subscriber errors must not crash the provider
        sub.errorCount = (sub.errorCount ?? 0) + 1;
        sub.lastError = summarizeError(err);
      }
    }
  }
}
