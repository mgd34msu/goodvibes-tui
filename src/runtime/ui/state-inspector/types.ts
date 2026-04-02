/**
 * State inspector types — data structures for the StateInspectorProvider.
 *
 * These are purely data-oriented. No UI rendering logic lives here.
 * All values are JSON-safe unless explicitly noted.
 *
 * v3 Section 26 (Devtools / State Inspector).
 */

// ── Domain snapshot ───────────────────────────────────────────────────────────

/**
 * A point-in-time snapshot of a single domain's state.
 * Maps and Sets are serialized to plain objects/arrays at capture time.
 */
export interface DomainSnapshot {
  /** Domain identifier (matches RuntimeState domain key). */
  readonly domain: string;
  /** Monotonic revision counter at the time of capture. */
  readonly revision: number;
  /** Epoch ms timestamp of last mutation. */
  readonly lastUpdatedAt: number;
  /** The serialized domain state — JSON-safe. */
  readonly state: Record<string, unknown>;
}

/**
 * A point-in-time snapshot of the full RuntimeState across all domains.
 * Produced by `StateInspectorProvider.getSnapshot()`.
 */
export interface StateSnapshot {
  /** Epoch ms when this snapshot was captured. */
  readonly capturedAt: number;
  /** Snapshot of each registered domain. */
  readonly domains: readonly DomainSnapshot[];
  /** Total number of domains captured. */
  readonly domainCount: number;
  /** Optional filter applied when capturing (undefined = all domains). */
  readonly domainFilter?: readonly string[];
}

// ── Transition log ────────────────────────────────────────────────────────────

/**
 * A single state transition recorded in the bounded transition history.
 * Captures the diff between two consecutive domain revisions.
 */
export interface TransitionEntry {
  /** Unique sequential ID for this transition (monotonic, starts at 1). */
  readonly id: number;
  /** Domain that transitioned. */
  readonly domain: string;
  /** Revision number before this transition. */
  readonly fromRevision: number;
  /** Revision number after this transition. */
  readonly toRevision: number;
  /** Epoch ms when the transition was recorded. */
  readonly recordedAt: number;
  /** The mutation source string from the domain state. */
  readonly source: string;
  /** The new domain state after transition (JSON-safe). */
  readonly state: Record<string, unknown>;
}

// ── Subscription registry ─────────────────────────────────────────────────────

/**
 * Metadata describing an active subscription to the state inspector.
 */
export interface SubscriptionInfo {
  /** Unique subscription identifier. */
  readonly id: string;
  /** Human-readable label for the subscriber (e.g. panel name, component name). */
  readonly label: string;
  /** Epoch ms when this subscription was registered. */
  readonly registeredAt: number;
  /** Domain filter for this subscription — undefined means all domains. */
  readonly domainFilter?: readonly string[];
  /** Number of notifications delivered to this subscriber. */
  readonly notificationCount: number;
  /** Epoch ms of the last notification delivered. */
  readonly lastNotifiedAt?: number;
  /** Number of errors thrown by this subscriber's callback. */
  readonly errorCount?: number;
  /** Last error message thrown by this subscriber's callback. */
  readonly lastError?: string;
}

// ── Inspector configuration ───────────────────────────────────────────────────

/**
 * Configuration for the StateInspectorProvider.
 */
export interface StateInspectorConfig {
  /**
   * Maximum number of transition entries retained in history.
   * Oldest entries are evicted when the limit is reached.
   * @default 1000
   */
  readonly maxTransitions?: number;
  /**
   * Optional set of domain names to observe.
   * When provided, only listed domains will be tracked.
   * Undefined means all registered domains.
   */
  readonly observedDomains?: readonly string[];
}

/** Default maximum transition history size. */
export const DEFAULT_MAX_TRANSITIONS = 1000;
