import { appendFile, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/** Maximum buffered entries before a flush is triggered. */
const LOG_BUFFER_MAX = 10;
/** Flush interval in milliseconds when buffer is below max. */
const LOG_FLUSH_INTERVAL_MS = 100;

/**
 * ActivityLogger — Persistent debug logger for GoodVibes.
 * Writes to .goodvibes/logs/activity.md
 *
 * Uses a buffered async writer to avoid blocking the event loop on every
 * log entry. Entries are flushed when the buffer reaches LOG_BUFFER_MAX
 * or after LOG_FLUSH_INTERVAL_MS, whichever comes first.
 */
class ActivityLogger {
  private logPath: string | null = null;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  configure(logDir: string): void {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    this.logPath = join(logDir, 'activity.md');
    if (this.buffer.length > 0) {
      this.flush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => this.flush(), LOG_FLUSH_INTERVAL_MS);
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.buffer.length === 0) return;
    if (!this.logPath) return;
    const chunk = this.buffer.splice(0).join('');
    appendFile(this.logPath, chunk, (err) => {
      if (err) {
        // Best-effort: cannot log the logger's own error without recursion
        process.stderr.write(`[ActivityLogger] flush error: ${err.message}\n`);
      }
    });
  }

  private write(level: string, message: string, data?: Record<string, unknown>) {
    const timestamp = new Date().toISOString();
    let entry = `[${timestamp}] [${level}] ${message}\n`;
    if (data) {
      entry += '```json\n' + JSON.stringify(data, null, 2) + '\n```\n';
    }
    this.buffer.push(entry);
    if (this.buffer.length >= LOG_BUFFER_MAX) {
      // Buffer full — flush immediately without waiting for the timer
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  info(message: string, data?: Record<string, unknown>) { this.write('INFO', message, data); }
  warn(message: string, data?: Record<string, unknown>) { this.write('WARN', message, data); }
  error(message: string, data?: Record<string, unknown>) { this.write('ERROR', message, data); }
  debug(message: string, data?: Record<string, unknown>) { this.write('DEBUG', message, data); }
}

export const logger = new ActivityLogger();

export function configureActivityLogger(logDir: string): void {
  logger.configure(logDir);
}
