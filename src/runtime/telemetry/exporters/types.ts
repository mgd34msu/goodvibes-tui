/**
 * Type definitions for the fail-safe OTel export pipeline.
 *
 * These types are self-contained and do not depend on @opentelemetry packages.
 * They cover the export queue, retry configuration, and OTLP exporter settings.
 */

// ── Retry configuration ───────────────────────────────────────────────────────

/** Exponential backoff configuration for export retry. */
export interface RetryConfig {
  /** Maximum number of retry attempts after an initial failure. Default: 3. */
  readonly maxRetries: number;
  /** Base delay in milliseconds before the first retry. Default: 100. */
  readonly baseDelayMs: number;
  /** Multiplier applied to delay after each failure. Default: 2. */
  readonly backoffFactor: number;
  /** Maximum delay in milliseconds between retries. Default: 5000. */
  readonly maxDelayMs: number;
}

/** Default retry configuration. */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 100,
  backoffFactor: 2,
  maxDelayMs: 5000,
} as const;

// ── Export queue configuration ────────────────────────────────────────────────

/** Configuration for the fail-safe ExportQueue. */
export interface ExportQueueConfig {
  /**
   * Maximum number of span batches held in the queue.
   * When full, oldest entries are dropped. Default: 128.
   */
  readonly maxSize: number;
  /** Retry configuration for failed exports. */
  readonly retry: RetryConfig;
  /**
   * Maximum time in milliseconds to wait for a drain during shutdown.
   * Default: 5000.
   */
  readonly drainTimeoutMs: number;
}

/** Default export queue configuration. */
export const DEFAULT_QUEUE_CONFIG: ExportQueueConfig = {
  maxSize: 128,
  retry: DEFAULT_RETRY_CONFIG,
  drainTimeoutMs: 5000,
} as const;

// ── Export result ─────────────────────────────────────────────────────────────

/** Result of a single export attempt. */
export type ExportResultCode = 'success' | 'failure' | 'dropped';

/** Outcome of an export attempt. */
export interface ExportResult {
  /** Whether the export succeeded, failed, or was dropped. */
  readonly code: ExportResultCode;
  /** Number of spans in the batch. */
  readonly spanCount: number;
  /** Number of retry attempts made (0 = first attempt succeeded). */
  readonly attempts: number;
  /** Error message if the export failed after all retries. */
  readonly error?: string;
  /** Epoch ms when the export completed. */
  readonly completedAt: number;
}

// ── OTLP exporter configuration ───────────────────────────────────────────────

/** Configuration for the OtlpExporter. */
export interface OtlpConfig {
  /**
   * OTLP HTTP endpoint URL.
   * Example: 'http://localhost:4318/v1/traces'
   */
  readonly endpoint: string;
  /**
   * Maximum number of spans per export batch.
   * Default: 512.
   */
  readonly batchSize: number;
  /**
   * Timeout in milliseconds for each HTTP export attempt.
   * Default: 10000.
   */
  readonly timeoutMs: number;
  /**
   * Optional HTTP headers to include in OTLP requests
   * (e.g. authentication tokens).
   */
  readonly headers?: Record<string, string>;
  /** Export queue configuration. Defaults to DEFAULT_QUEUE_CONFIG. */
  readonly queue?: Partial<ExportQueueConfig>;
  /** Retry configuration. Overrides queue.retry when provided. */
  readonly retry?: Partial<RetryConfig>;
}

/** Default OTLP exporter configuration. */
export const DEFAULT_OTLP_CONFIG = {
  batchSize: 512,
  timeoutMs: 10000,
} as const;

// ── Export callback types ─────────────────────────────────────────────────────

/**
 * A function that performs the actual export of a span batch.
 * Must not throw — all errors must be caught internally.
 */
export type ExportFn<T> = (batch: T[]) => Promise<void>;

/** Callback invoked after each export attempt (for observability). */
export type ExportResultCallback = (result: ExportResult) => void;
