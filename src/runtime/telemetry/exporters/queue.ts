/**
 * Fail-safe, bounded export queue with exponential-backoff retry.
 *
 * Guarantees:
 * - Never blocks the caller — all export work is dequeued asynchronously.
 * - Never throws — all errors are caught and logged.
 * - Drops oldest entries when full (back-pressure relief).
 * - Drains best-effort on shutdown with a configurable timeout.
 */
import type { ReadableSpan } from '../types.ts';
import type {
  ExportQueueConfig,
  ExportResult,
  ExportResultCallback,
  ExportFn,
  RetryConfig,
} from './types.ts';
import { DEFAULT_QUEUE_CONFIG } from './types.ts';

/** Internal entry held in the ring buffer. */
interface QueueEntry {
  readonly batch: ReadableSpan[];
  readonly enqueuedAt: number;
}

/**
 * Computes the delay in milliseconds for a given retry attempt using
 * exponential backoff with jitter (±10%).
 */
function computeDelay(attempt: number, config: RetryConfig): number {
  const base = config.baseDelayMs * Math.pow(config.backoffFactor, attempt);
  const capped = Math.min(base, config.maxDelayMs);
  // Add ±10% jitter to avoid thundering-herd
  const jitter = capped * 0.1 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

/** Awaitable sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded in-memory export queue with retry and overflow protection.
 *
 * @example
 * ```ts
 * const queue = new ExportQueue(
 *   async (batch) => {
 *     await fetch('http://localhost:4318/v1/traces', {
 *       method: 'POST',
 *       body: JSON.stringify(batch),
 *     });
 *   },
 *   { maxSize: 64, drainTimeoutMs: 3000, retry: { maxRetries: 2, baseDelayMs: 50, backoffFactor: 2, maxDelayMs: 1000 } },
 * );
 *
 * queue.enqueue(spans);
 * await queue.drain();
 * ```
 */
export class ExportQueue {
  private readonly _config: ExportQueueConfig;
  private readonly _exportFn: ExportFn<ReadableSpan>;
  private readonly _onResult?: ExportResultCallback;

  /** Ring buffer holding pending batches. */
  private readonly _ring: Array<QueueEntry | undefined>;
  private _head = 0;
  private _tail = 0;
  private _size = 0;

  /** True while a drain loop is running. */
  private _draining = false;
  /** True after shutdown() is called — no new enqueues accepted. */
  private _shutdown = false;

  /**
   * @param exportFn - The actual export implementation. Must not throw.
   * @param config - Queue configuration. Merged with defaults.
   * @param onResult - Optional callback invoked after each export attempt.
   */
  constructor(
    exportFn: ExportFn<ReadableSpan>,
    config?: Partial<ExportQueueConfig>,
    onResult?: ExportResultCallback,
  ) {
    this._config = {
      ...DEFAULT_QUEUE_CONFIG,
      ...config,
      retry: { ...DEFAULT_QUEUE_CONFIG.retry, ...config?.retry },
    };
    this._exportFn = exportFn;
    this._onResult = onResult;
    this._ring = new Array<QueueEntry | undefined>(this._config.maxSize);
  }

  /** Number of batches currently in the queue. */
  get size(): number {
    return this._size;
  }

  /** Whether the queue is currently draining. */
  get draining(): boolean {
    return this._draining;
  }

  /**
   * Enqueue a batch of spans for export.
   *
   * - If the queue is full, the oldest entry is dropped to make room.
   * - Starts the drain loop if not already running.
   * - No-op after shutdown().
   */
  enqueue(batch: ReadableSpan[]): void {
    if (this._shutdown) return;
    if (batch.length === 0) return;

    if (this._size >= this._config.maxSize) {
      // Drop oldest — advance head
      const dropped = this._ring[this._head];
      this._head = (this._head + 1) % this._config.maxSize;
      this._size--;
      if (dropped) {
        this._emitResult({
          code: 'dropped',
          spanCount: dropped.batch.length,
          attempts: 0,
          completedAt: Date.now(),
        });
      }
      console.warn(
        `[ExportQueue] Queue overflow — dropped oldest batch (size=${this._config.maxSize})`,
      );
    }

    this._ring[this._tail] = { batch, enqueuedAt: Date.now() };
    this._tail = (this._tail + 1) % this._config.maxSize;
    this._size++;

    this._startDrainLoop();
  }

  /**
   * Drain all queued batches best-effort, honouring drainTimeoutMs.
   * Waits until the queue is empty or the timeout elapses.
   */
  async drain(): Promise<void> {
    if (this._size === 0) return;

    const deadline = Date.now() + this._config.drainTimeoutMs;
    while (this._size > 0 && Date.now() < deadline) {
      await sleep(10);
    }
  }

  /**
   * Stop accepting new entries and drain remaining batches.
   * Returns after drain completes or drainTimeoutMs elapses.
   */
  async shutdown(): Promise<void> {
    this._shutdown = true;
    await this.drain();
  }

  // ── Private drain loop ───────────────────────────────────────────────────

  /** Starts the async drain loop if not already running. */
  private _startDrainLoop(): void {
    if (this._draining) return;
    this._draining = true;
    // Fire-and-forget — errors are swallowed inside _processNext
    void this._drainLoop();
  }

  /** Continuously drains entries until the queue is empty. */
  private async _drainLoop(): Promise<void> {
    try {
      while (this._size > 0) {
        const entry = this._dequeue();
        if (entry === undefined) break;
        await this._processEntry(entry);
      }
    } finally {
      this._draining = false;
      // If more entries arrived during the final iteration, restart
      if (this._size > 0) {
        this._startDrainLoop();
      }
    }
  }

  /** Dequeues and returns the oldest entry, or undefined if empty. */
  private _dequeue(): QueueEntry | undefined {
    if (this._size === 0) return undefined;
    const entry = this._ring[this._head];
    this._ring[this._head] = undefined;
    this._head = (this._head + 1) % this._config.maxSize;
    this._size--;
    return entry;
  }

  /**
   * Attempts to export a single batch with retry/backoff.
   * Never throws.
   */
  private async _processEntry(entry: QueueEntry): Promise<void> {
    const { maxRetries } = this._config.retry;
    let lastError: string | undefined;
    let attempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this._exportFn(entry.batch);
        this._emitResult({
          code: 'success',
          spanCount: entry.batch.length,
          attempts,
          completedAt: Date.now(),
        });
        return;
      } catch (err) {
        attempts++;
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries) {
          const delay = computeDelay(attempt, this._config.retry);
          console.warn(
            `[ExportQueue] Export attempt ${attempt + 1} failed — retrying in ${delay}ms: ${lastError}`,
          );
          await sleep(delay);
        }
      }
    }

    // All retries exhausted
    console.error(
      `[ExportQueue] Export failed after ${attempts} attempt(s) — dropping batch of ${entry.batch.length} span(s): ${lastError}`,
    );
    this._emitResult({
      code: 'failure',
      spanCount: entry.batch.length,
      attempts,
      error: lastError,
      completedAt: Date.now(),
    });
  }

  /** Safely invokes the result callback without throwing. */
  private _emitResult(result: ExportResult): void {
    if (this._onResult === undefined) return;
    try {
      this._onResult(result);
    } catch {
      // Result callback must not propagate
    }
  }
}
