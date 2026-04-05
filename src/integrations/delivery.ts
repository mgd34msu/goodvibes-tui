import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Delivery outcome taxonomy
// ---------------------------------------------------------------------------

/**
 * The three possible outcomes for a single integration delivery attempt.
 *
 * - `delivered`   — message reached the destination successfully
 * - `retrying`    — delivery failed with a retryable error; queued for retry
 * - `dead_letter` — all retry attempts exhausted or terminal failure; moved to DLQ
 */
export type DeliveryOutcome = 'delivered' | 'retrying' | 'dead_letter';

/**
 * Classification of a delivery failure.
 *
 * - `retryable` — transient error; should be retried with backoff
 *   (network timeout, HTTP 429, HTTP 5xx)
 * - `terminal`  — permanent error; should not be retried
 *   (HTTP 400/401/403/404, invalid URL, message too large)
 */
export type DeliveryFailureClass = 'retryable' | 'terminal';

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** HTTP status codes that indicate a retryable transient failure. */
const DELIVERY_RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Classify a delivery error as retryable or terminal.
 *
 * Rules (in order):
 * 1. Network errors with no HTTP status → retryable (timeout, ECONNREFUSED, etc.)
 * 2. HTTP 4xx (except 408/429) → terminal (auth failure, bad request, not found)
 * 3. HTTP 429 / 5xx → retryable
 * 4. Unknown → retryable (prefer retry over silent drop)
 */
export function classifyDeliveryError(error: unknown): DeliveryFailureClass {
  if (error instanceof DeliveryError) {
    return error.failureClass;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // HTTP status in message (e.g. "HTTP 400: bad request")
    const match = /http\s+(\d{3})/.exec(msg);
    if (match) {
      const status = parseInt(match[1]!, 10);
      return DELIVERY_RETRYABLE_STATUSES.has(status) ? 'retryable' : 'terminal';
    }
    // Network-level errors: timeout, connection refused, DNS failure
    if (
      msg.includes('timeout') ||
      msg.includes('aborted') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('network')
    ) {
      return 'retryable';
    }
    // TypeError for invalid URL or fetch misconfiguration
    if (error instanceof TypeError) {
      return 'terminal';
    }
  }
  // Default: retryable (never silently drop)
  return 'retryable';
}

// ---------------------------------------------------------------------------
// DeliveryError — typed error with explicit classification
// ---------------------------------------------------------------------------

/** Typed delivery error that carries an explicit failure classification. */
export class DeliveryError extends Error {
  constructor(
    message: string,
    public readonly failureClass: DeliveryFailureClass,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

// ---------------------------------------------------------------------------
// Dead-letter entry
// ---------------------------------------------------------------------------

/**
 * A single entry in the dead-letter queue.
 * Immutable snapshot of a delivery that exhausted all retry attempts.
 */
export interface DeadLetterEntry {
  /** Unique entry identifier. */
  readonly id: string;
  /** Integration channel (e.g. "slack", "discord", "webhook"). */
  readonly channel: string;
  /** Event name that triggered the delivery. */
  readonly event: string;
  /** Message payload that failed to deliver. */
  readonly payload: string;
  /** Epoch ms when the entry was created (first attempt). */
  readonly createdAt: number;
  /** Epoch ms when the entry moved to the DLQ. */
  readonly deadAt: number;
  /** Number of delivery attempts made. */
  readonly attempts: number;
  /** Final error message. */
  readonly finalError: string;
  /** Failure class of the final error. */
  readonly failureClass: DeliveryFailureClass;
}

// ---------------------------------------------------------------------------
// Delivery metrics
// ---------------------------------------------------------------------------

/** Counters for delivery SLO tracking. */
export interface DeliveryMetrics {
  /** Total delivery attempts (all channels combined). */
  readonly totalAttempts: number;
  /** Successfully delivered messages. */
  readonly delivered: number;
  /** Messages currently queued for retry. */
  readonly retrying: number;
  /** Messages moved to the dead-letter queue. */
  readonly deadLettered: number;
  /** Total entries in the DLQ (including previously replayed). */
  readonly dlqSize: number;
}

// ---------------------------------------------------------------------------
// Queue configuration
// ---------------------------------------------------------------------------

/** Configuration for the DeliveryQueue. */
export interface DeliveryQueueConfig {
  /**
   * Maximum retry attempts after the initial delivery attempt.
   * E.g., maxRetries: 3 means 4 total attempts (1 initial + 3 retries).
   */
  maxRetries: number;
  /** Initial backoff delay in ms (default: 1000). */
  initialDelayMs: number;
  /** Maximum backoff delay in ms (default: 30_000). */
  maxDelayMs: number;
  /** Maximum dead-letter queue size; oldest entries evicted when exceeded (default: 500). */
  maxDlqSize: number;
  /**
   * When true, SLO enforcement is active: dead-letter events are logged at
   * error level and metrics are updated. When false, failures are logged at
   * warn level only.
   *
   * Controlled by the `integration-delivery-slo` feature flag.
   */
  sloEnforced: boolean;
}

const DEFAULT_CONFIG: DeliveryQueueConfig = {
  maxRetries: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxDlqSize: 500,
  sloEnforced: false,
};

// ---------------------------------------------------------------------------
// Pending retry entry (internal)
// ---------------------------------------------------------------------------

interface PendingEntry {
  id: string;
  channel: string;
  event: string;
  payload: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  deliver: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// DeliveryQueue
// ---------------------------------------------------------------------------

/**
 * Delivery queue with retry/backoff and dead-letter storage.
 *
 * Wrap any integration send operation with `enqueue()`. The queue:
 *  1. Attempts delivery immediately.
 *  2. On retryable failure: schedules retry with exponential backoff + jitter.
 *  3. On terminal failure or exhausted retries: moves entry to DLQ.
 *  4. Emits `delivery:dead_letter` events to registered listeners.
 *
 * Dead-letter entries can be replayed via `replay()` or cleared with `clearDlq()`.
 *
 * Enable SLO enforcement via the `integration-delivery-slo` feature flag to
 * surface dead-letter failures as error-level log entries and expose them in
 * integration diagnostics.
 */
export class DeliveryQueue {
  private readonly _config: DeliveryQueueConfig;
  private readonly _dlq: DeadLetterEntry[] = [];
  private readonly _pending = new Map<string, PendingEntry>();
  private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _listeners = new Set<(entry: DeadLetterEntry) => void>();

  // Metrics counters
  private _totalAttempts = 0;
  private _delivered = 0;
  private _retrying = 0;
  private _deadLettered = 0;

  constructor(config: Partial<DeliveryQueueConfig> = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Enqueue a delivery attempt.
   *
   * @param channel - Integration channel identifier (e.g. "slack").
   * @param event   - Event name for tracing.
   * @param payload - Message text to deliver.
   * @param deliver - Async function that performs the actual delivery.
   * @returns The delivery outcome for the immediate attempt.
   */
  async enqueue(
    channel: string,
    event: string,
    payload: string,
    deliver: () => Promise<void>,
  ): Promise<DeliveryOutcome> {
    const id = `${channel}:${event}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const entry: PendingEntry = {
      id,
      channel,
      event,
      payload,
      createdAt: Date.now(),
      attempts: 0,
      nextAttemptAt: 0,
      deliver,
    };
    this._pending.set(id, entry);
    return this._attempt(entry);
  }

  /**
   * Replay all dead-letter entries.
   *
   * Each entry is re-enqueued with a fresh retry budget. The DLQ is cleared
   * on a per-entry basis as each replayed entry resolves.
   *
   * @param deliver - Optional delivery function override. When omitted,
   *   the original delivery function is not available (DLQ is persistent
   *   storage), so a no-op is used and the caller must provide one.
   *
   * @returns Array of per-entry replay results.
   */
  async replay(
    deliver: (entry: DeadLetterEntry) => Promise<void>,
  ): Promise<Array<{ id: string; outcome: DeliveryOutcome }>> {
    const entries = [...this._dlq];
    const results: Array<{ id: string; outcome: DeliveryOutcome }> = [];

    for (const dlqEntry of entries) {
      // Remove from DLQ before replaying
      const idx = this._dlq.findIndex((e) => e.id === dlqEntry.id);
      if (idx !== -1) this._dlq.splice(idx, 1);
      this._deadLettered = Math.max(0, this._deadLettered - 1);

      const outcome = await this.enqueue(
        dlqEntry.channel,
        dlqEntry.event,
        dlqEntry.payload,
        () => deliver(dlqEntry),
      );
      results.push({ id: dlqEntry.id, outcome });
    }

    return results;
  }

  /**
   * Register a listener invoked whenever an entry moves to the DLQ.
   * Returns an unsubscribe function.
   */
  onDeadLetter(listener: (entry: DeadLetterEntry) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Get current dead-letter queue contents (snapshot). */
  getDlq(): readonly DeadLetterEntry[] {
    return [...this._dlq];
  }

  /** Clear all dead-letter entries. */
  clearDlq(): number {
    const count = this._dlq.length;
    this._dlq.length = 0;
    return count;
  }

  /** Whether SLO enforcement is active for this queue. */
  get sloEnforced(): boolean { return this._config.sloEnforced; }

  /** Current delivery metrics snapshot. */
  getMetrics(): DeliveryMetrics {
    return {
      totalAttempts: this._totalAttempts,
      delivered: this._delivered,
      retrying: this._retrying,
      deadLettered: this._deadLettered,
      dlqSize: this._dlq.length,
    };
  }

  /**
   * Cancel all pending retry timers and clear internal state.
   * Call on shutdown to prevent timer leaks.
   */
  dispose(): void {
    for (const timer of this._timers.values()) {
      clearTimeout(timer);
    }
    this._timers.clear();
    this._pending.clear();
  }

  // -------------------------------------------------------------------------
  // Internal retry logic
  // -------------------------------------------------------------------------

  private async _attempt(entry: PendingEntry): Promise<DeliveryOutcome> {
    entry.attempts += 1;
    this._totalAttempts += 1;

    try {
      await entry.deliver();
      this._delivered += 1;
      if (entry.attempts > 1) this._retrying = Math.max(0, this._retrying - 1);
      this._pending.delete(entry.id);
      logger.debug('DeliveryQueue: delivered', {
        channel: entry.channel,
        event: entry.event,
        attempts: entry.attempts,
      });
      return 'delivered';
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failureClass = classifyDeliveryError(err);

      if (failureClass === 'terminal' || entry.attempts > this._config.maxRetries) {
        return this._moveToDlq(entry, errorMsg, failureClass);
      }

      // Schedule retry
      const delayMs = this._computeDelay(entry.attempts);
      entry.nextAttemptAt = Date.now() + delayMs;
      this._retrying += 1;

      logger.warn('DeliveryQueue: retrying', {
        channel: entry.channel,
        event: entry.event,
        attempt: entry.attempts,
        maxRetries: this._config.maxRetries,
        delayMs,
        error: errorMsg,
        failureClass,
      });

      const timer = setTimeout(() => {
        this._timers.delete(entry.id);
        this._retrying = Math.max(0, this._retrying - 1);
        // Fire-and-forget; outcome tracked via metrics
        void this._attempt(entry);
      }, delayMs);
      this._timers.set(entry.id, timer);

      return 'retrying';
    }
  }

  private _moveToDlq(
    entry: PendingEntry,
    finalError: string,
    failureClass: DeliveryFailureClass,
  ): DeliveryOutcome {
    const dlqEntry: DeadLetterEntry = {
      id: entry.id,
      channel: entry.channel,
      event: entry.event,
      payload: entry.payload,
      createdAt: entry.createdAt,
      deadAt: Date.now(),
      attempts: entry.attempts,
      finalError,
      failureClass,
    };

    // Bounded DLQ: evict oldest entry when limit exceeded
    if (this._dlq.length >= this._config.maxDlqSize) {
      this._dlq.shift();
      this._deadLettered = Math.max(0, this._deadLettered - 1);
    }

    this._dlq.push(dlqEntry);
    this._deadLettered += 1;
    this._pending.delete(entry.id);

    if (this._config.sloEnforced) {
      logger.error('DeliveryQueue: dead-lettered (SLO violated)', {
        id: dlqEntry.id,
        channel: dlqEntry.channel,
        event: dlqEntry.event,
        attempts: dlqEntry.attempts,
        finalError: dlqEntry.finalError,
        failureClass: dlqEntry.failureClass,
      });
    } else {
      logger.warn('DeliveryQueue: dead-lettered', {
        id: dlqEntry.id,
        channel: dlqEntry.channel,
        event: dlqEntry.event,
        attempts: dlqEntry.attempts,
        finalError: dlqEntry.finalError,
        failureClass: dlqEntry.failureClass,
      });
    }

    for (const listener of this._listeners) {
      try {
        listener(dlqEntry);
      } catch (err) {
        logger.debug('[delivery] listener error:', {
          error: err instanceof Error ? err.message : String(err),
          entryId: dlqEntry.id,
        });
      }
    }

    return 'dead_letter';
  }

  private _computeDelay(attempt: number): number {
    const exponential = this._config.initialDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.random() * this._config.initialDelayMs * 0.5;
    return Math.min(exponential + jitter, this._config.maxDelayMs);
  }
}

// ---------------------------------------------------------------------------
// Integration diagnostics queue status
// ---------------------------------------------------------------------------

/**
 * Snapshot of a DeliveryQueue for display in integration diagnostics.
 */
export interface IntegrationQueueStatus {
  /** Integration channel identifier. */
  readonly channel: string;
  /** Current delivery metrics. */
  readonly metrics: DeliveryMetrics;
  /** Dead-letter entries (most recent first, capped at 50 for display). */
  readonly dlqEntries: readonly DeadLetterEntry[];
  /** Whether SLO enforcement is active. */
  readonly sloEnforced: boolean;
  /** Epoch ms of this snapshot. */
  readonly capturedAt: number;
}

/**
 * Produce a diagnostics snapshot for a channel's DeliveryQueue.
 */
export function snapshotQueueStatus(
  channel: string,
  queue: DeliveryQueue,
  sloEnforced: boolean,
): IntegrationQueueStatus {
  const dlq = queue.getDlq();
  return {
    channel,
    metrics: queue.getMetrics(),
    dlqEntries: [...dlq].reverse().slice(0, 50),
    sloEnforced,
    capturedAt: Date.now(),
  };
}
