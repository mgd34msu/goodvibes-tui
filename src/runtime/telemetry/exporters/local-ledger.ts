/**
 * LocalLedgerExporter — append-only JSON lines span exporter.
 *
 * Writes completed spans to a rotating JSON Lines (.jsonl) file.
 * Writes are fire-and-forget (non-blocking). Export failures are
 * logged but never thrown — they must not block the runtime.
 *
 * Also provides typed event ledger recording for deterministic replay.
 * Call `recordEvent()` to append a `LedgerEntry` to the ledger file.
 */
import { appendFileSync, statSync, renameSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { logger } from '../../../utils/logger.ts';
import type { ReadableSpan, SpanExporter } from '../types.ts';
import { summarizeError } from '../../../utils/error-display.ts';

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
  /**
   * Optional path for the typed event ledger file.
   * When provided, `recordEvent()` appends `LedgerEntry` lines here.
   * Defaults to `<filePath>.ledger.jsonl`.
   */
  readonly ledgerFilePath?: string;
}

/**
 * A single typed event entry in the replay ledger.
 *
 * Each entry captures the run identifier, a monotonically increasing
 * revision counter, the event name, payload, and wall-clock timestamp.
 * The revision counter is used by the deterministic replay engine for
 * seek and stepwise playback.
 */
export interface LedgerEntry {
  /** Run identifier — groups entries belonging to the same recorded run. */
  readonly runId: string;
  /** Monotonically increasing revision counter within the run (starts at 1). */
  readonly rev: number;
  /** Event name recorded in the typed runtime ledger. */
  readonly eventName: string;
  /** Full event payload, JSON-serialisable. */
  readonly payload: unknown;
  /** Wall-clock timestamp (epoch ms) when the event was recorded. */
  readonly ts: number;
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
  private readonly ledgerFilePath: string;

  constructor(config: LocalLedgerConfig) {
    this.filePath = config.filePath;
    this.maxFileSizeBytes = config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
    this.ledgerFilePath = config.ledgerFilePath ?? `${config.filePath}.ledger.jsonl`;
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
        logger.debug(`[local-ledger] export failed: ${summarizeError(err)}`);
      }
    });
  }

  /**
   * Record a typed event entry to the ledger file (fire-and-forget).
   *
   * Used by the deterministic replay engine to build a per-run event log.
   * Failures are logged but never thrown.
   *
   * @param entry - The ledger entry to append.
   *
   * @remarks
   * This method is used by the event recording integration that
   * wires typed runtime events to the ledger. The integration subscribes to the
   * runtime bus at session start and calls `recordEvent()` for each event that should
   * be included in the replay ledger. See `DeterministicReplayEngine.load()`
   * for the consumer side of this pipeline.
   */
  recordEvent(entry: LedgerEntry): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.ledgerFilePath, line, 'utf8');
    } catch (err) {
      // Non-fatal — ledger recording must not block the runtime.
      logger.debug(`[local-ledger] ledger write failed: ${summarizeError(err)}`);
    }
  }

  /**
   * Read all ledger entries for a given run.
   *
   * Parses the ledger file line-by-line. Malformed lines are skipped.
   * Returns entries sorted by revision (ascending).
   *
   * @param runId - The run to retrieve entries for.
   * @returns Ordered ledger entries for the run.
   */
  readRunEntries(runId: string): LedgerEntry[] {
    if (!existsSync(this.ledgerFilePath)) return [];

    const entries: LedgerEntry[] = [];
    let raw: string;
    try {
      raw = readFileSync(this.ledgerFilePath, 'utf8');
    } catch (err) {
      logger.debug(`[local-ledger] ledger read failed: ${summarizeError(err)}`);
      return [];
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        if (entry.runId === runId) {
          entries.push(entry);
        }
      } catch {
        // Skip malformed lines — ledger may have partial writes.
      }
    }

    entries.sort((a, b) => a.rev - b.rev);
    return entries;
  }

  /**
   * List all run IDs recorded in the ledger.
   */
  listRunIds(): string[] {
    if (!existsSync(this.ledgerFilePath)) return [];

    let raw: string;
    try {
      raw = readFileSync(this.ledgerFilePath, 'utf8');
    } catch (err) {
      logger.debug(`[local-ledger] ledger read failed: ${summarizeError(err)}`);
      return [];
    }

    const seen = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        if (typeof entry.runId === 'string') {
          seen.add(entry.runId);
        }
      } catch {
        // Skip malformed lines.
      }
    }
    return [...seen];
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
