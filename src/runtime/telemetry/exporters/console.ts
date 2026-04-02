/**
 * ConsoleExporter — development-mode span exporter.
 *
 * Writes formatted span summaries to stderr. Intended for local development
 * and debugging — should not be used in production.
 */
import type { ReadableSpan, SpanExporter } from '../types.ts';
import { SpanStatusCode } from '../types.ts';

/** Verbosity level for console output. */
export type ConsoleVerbosity = 'minimal' | 'standard' | 'verbose';

/** Configuration for ConsoleExporter. */
export interface ConsoleExporterConfig {
  /**
   * How much detail to include per span.
   * - `minimal` — span name + status + duration only.
   * - `standard` — adds attributes (default).
   * - `verbose` — adds events and full attribute values.
   */
  readonly verbosity?: ConsoleVerbosity;
}

/**
 * ConsoleExporter — prints span data to stderr for development.
 *
 * Usage:
 * ```ts
 * const exporter = new ConsoleExporter({ verbosity: 'standard' });
 * ```
 */
export class ConsoleExporter implements SpanExporter {
  readonly name = 'console';
  private readonly verbosity: ConsoleVerbosity;

  constructor(config: ConsoleExporterConfig = {}) {
    this.verbosity = config.verbosity ?? 'standard';
  }

  /** Export spans by printing formatted summaries to stderr. */
  async export(spans: ReadableSpan[]): Promise<void> {
    for (const span of spans) {
      try {
        process.stderr.write(this._format(span) + '\n');
      } catch {
        // Writing to stderr should not throw but swallow any OS-level errors.
      }
    }
  }

  /** Flush is a no-op for synchronous stderr writes. */
  async flush(): Promise<void> {
    // Nothing buffered.
  }

  /** Shutdown is a no-op. */
  async shutdown(): Promise<void> {
    // Nothing to tear down.
  }

  /** Format a single span for console output. */
  private _format(span: ReadableSpan): string {
    const status =
      span.status.code === SpanStatusCode.ERROR
        ? 'ERROR'
        : span.status.code === SpanStatusCode.OK
          ? 'OK'
          : 'UNSET';

    const base =
      `[otel] ${span.name} | ${status} | ${span.durationMs}ms` +
      ` | trace=${span.spanContext.traceId.slice(0, 8)} span=${span.spanContext.spanId.slice(0, 8)}`;

    if (this.verbosity === 'minimal') {
      return base;
    }

    const attrEntries = Object.entries(span.attributes);
    const attrStr =
      attrEntries.length === 0
        ? ''
        : '\n  attrs: ' +
          attrEntries
            .map(([k, v]) => {
              const val =
                this.verbosity === 'verbose'
                  ? JSON.stringify(v)
                  : typeof v === 'string' && v.length > 64
                    ? JSON.stringify(v.slice(0, 64) + '...')
                    : JSON.stringify(v);
              return `${k}=${val}`;
            })
            .join(' ');

    if (this.verbosity === 'standard') {
      return base + attrStr;
    }

    // verbose — include events
    const eventsStr =
      span.events.length === 0
        ? ''
        : '\n  events: ' +
          span.events
            .map((e) => `${e.name}@${e.timestamp}`)
            .join(', ');

    if (span.status.message) {
      return base + attrStr + eventsStr + `\n  message: ${span.status.message}`;
    }

    return base + attrStr + eventsStr;
  }
}
