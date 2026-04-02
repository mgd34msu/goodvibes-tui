/**
 * LocalLedgerExporter — append-only JSON lines span exporter.
 *
 * Writes completed spans to a rotating JSON Lines (.jsonl) file.
 * Writes are fire-and-forget (non-blocking). Export failures are
 * logged but never thrown — they must not block the runtime.
 */
import { appendFileSync, statSync, renameSync, writeFileSync } from 'fs';
import { logger } from '../../../utils/logger.ts';
import type { ReadableSpan, SpanExporter } from '../types.ts';

/** Configuration for LocalLedgerExporter. */
export interface LocalLedgerConfig {
  /**
   * Absolute path to the output file (e.g. `/home/user/.goodvibes/telemetry/spans.jsonl`).
   */
  readonly filePath: string;
  /**
   * Maximum file size in bytes before rotation.
   * When the file exceeds this size, it is renamed to `<filePath>.1` and a
   * fresh file is started. Defaults to 10 MB.
   */
  readonly maxFileSizeBytes?: number;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * LocalLedgerExporter — writes spans as JSON lines to a rotating file.
 *
 * Usage:
 * ```ts
 * const exporter = new LocalLedgerExporter({
 *   filePath: '/home/user/.goodvibes/telemetry/spans.jsonl',
 *   maxFileSizeBytes: 5 * 1024 * 1024,
 * });
 * ```
 */
export class LocalLedgerExporter implements SpanExporter {
  readonly name = 'local-ledger';
  private readonly filePath: string;
  private readonly maxFileSizeBytes: number;

  constructor(config: LocalLedgerConfig) {
    this.filePath = config.filePath;
    this.maxFileSizeBytes = config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  }

  /**
   * Export a batch of spans as JSON lines (fire-and-forget).
   *
   * Intentionally not awaited by the tracer — failures are swallowed here
   * and logged to avoid any runtime impact.
   */
  async export(spans: ReadableSpan[]): Promise<void> {
    if (spans.length === 0) return;

    // Build the JSON lines payload synchronously (cheap, in-memory).
    const lines = spans
      .map((span) => {
        try {
          return JSON.stringify(span);
        } catch {
          return null;
        }
      })
      .filter((line): line is string => line !== null)
      .join('\n') + '\n';

    // All I/O in a microtask to keep the call non-blocking.
    await Promise.resolve().then(() => {
      try {
        this._rotateIfNeeded();
        appendFileSync(this.filePath, lines, 'utf8');
      } catch (err) {
        logger.debug(`[local-ledger] export failed: ${String(err)}`);
      }
    });
  }

  /** Flush is a no-op for synchronous append-only writes. */
  async flush(): Promise<void> {
    // Nothing to flush — writes are synchronous via appendFileSync.
  }

  /** Shutdown is a no-op for file-based exports. */
  async shutdown(): Promise<void> {
    // Nothing to tear down.
  }

  /**
   * Rotate the log file if it exceeds the configured maximum size.
   * Renames the current file to `<filePath>.1` (overwrites any existing `.1`).
   */
  private _rotateIfNeeded(): void {
    try {
      const stat = statSync(this.filePath);
      if (stat.size >= this.maxFileSizeBytes) {
        renameSync(this.filePath, `${this.filePath}.1`);
        writeFileSync(this.filePath, '', 'utf8');
        logger.debug(`[local-ledger] rotated ${this.filePath}`);
      }
    } catch {
      // File may not exist yet — first write will create it via appendFileSync.
    }
  }
}
