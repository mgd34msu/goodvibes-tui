/**
 * State inspector types — data structures for the StateInspectorProvider.
 *
 * These are purely data-oriented. No UI rendering logic lives here.
 * All values are JSON-safe unless explicitly noted.
 *
 * Types used by the state inspector subsystem.
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
   * Maximum number of timeline events retained for time-travel.
   * Each event stores a full domain snapshot.
   * @default DEFAULT_TIMELINE_BUFFER_SIZE (500)
   */
  readonly timelineBufferSize?: number;
  /**
   * Optional set of domain names to observe.
   * When provided, only listed domains will be tracked.
   * Undefined means all registered domains.
   */
  readonly observedDomains?: readonly string[];
}

/** Default maximum transition history size. */
export const DEFAULT_MAX_TRANSITIONS = 1000;

// ── Timeline buffer ───────────────────────────────────────────────────────────

/**
 * A single event stored in the inspector timeline buffer.
 * Each event captures a full point-in-time snapshot for time-travel replay.
 */
export interface TimelineEvent {
  /** Monotonically increasing sequence number within this session. */
  readonly seq: number;
  /** Epoch ms when this event was captured. */
  readonly capturedAt: number;
  /** Domain that caused this timeline event. */
  readonly domain: string;
  /** Transition ID that triggered this snapshot (references TransitionEntry.id). */
  readonly transitionId: number;
  /** Full domain state at this point in time (JSON-safe). */
  readonly snapshot: Record<string, unknown>;
  /** Optional label for display (e.g. mutation source). */
  readonly label?: string;
}

/**
 * Cursor state representing the current time-travel position.
 */
export interface TimeTravelCursor {
  /** Current logical index in the timeline (0 = oldest, total-1 = newest). */
  readonly index: number;
  /** Total number of events retained. */
  readonly total: number;
  /** Whether the cursor is at the live position (past the newest event). */
  readonly isLive: boolean;
}

/** Default maximum timeline events retained in the ring buffer. */
export const DEFAULT_TIMELINE_BUFFER_SIZE = 500;

// ── Selector hotspot analysis ─────────────────────────────────────────────────

/**
 * Metrics for a single selector key tracked by the hotspot sampler.
 */
export interface SelectorHotspot {
  /** Selector name / identifier. */
  readonly key: string;
  /** Number of calls within the current sliding window. */
  readonly callsInWindow: number;
  /** Calls per second within the current window. */
  readonly callsPerSecond: number;
  /** Total lifetime calls (not windowed). */
  readonly totalCalls: number;
  /** Average execution duration within window (ms). */
  readonly avgMs: number;
  /** p50 execution latency within window (ms). */
  readonly p50Ms: number;
  /** p95 execution latency within window (ms). */
  readonly p95Ms: number;
  /** p99 execution latency within window (ms). */
  readonly p99Ms: number;
  /** Maximum execution duration within window (ms). */
  readonly maxMs: number;
  /** True when calls/sec exceeds the churn threshold (> 10/sec). */
  readonly isChurnHotspot: boolean;
  /** True when p95 exceeds the latency threshold (> 5ms). */
  readonly isLatencyHotspot: boolean;
}

/**
 * Full hotspot analysis report produced by SelectorHotspotSampler.getReport().
 */
export interface HotspotReport {
  /** Epoch ms when this report was generated. */
  readonly generatedAt: number;
  /** Sliding window duration used for this report (ms). */
  readonly windowMs: number;
  /** All tracked selectors, sorted by callsInWindow descending. */
  readonly hotspots: readonly SelectorHotspot[];
}

/**
 * Configuration for SelectorHotspotSampler.
 */
export interface HotspotSamplerConfig {
  /**
   * Sliding window duration in milliseconds.
   * Samples older than this are dropped on each record().
   * @default DEFAULT_HOTSPOT_WINDOW_MS
   */
  readonly windowMs?: number;
  /**
   * Maximum number of raw samples retained per selector key.
   * Oldest samples are dropped when the cap is reached.
   * @default DEFAULT_HOTSPOT_MAX_SAMPLES_PER_KEY
   */
  readonly maxSamplesPerKey?: number;
}

/** Default sliding window duration for hotspot analysis (10 seconds). */
export const DEFAULT_HOTSPOT_WINDOW_MS = 10_000;

/** Default per-key sample cap to bound memory usage. */
export const DEFAULT_HOTSPOT_MAX_SAMPLES_PER_KEY = 200;
