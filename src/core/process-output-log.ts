/**
 * process-output-log.ts, a background process's output as timestamped lines.
 *
 * The process manager keeps each process's stdout and stderr as chunk arrays
 * that grow while it runs, but it does not record when a chunk arrived. This
 * log reads the arrays on every poll, splits new chunks into lines and stamps
 * each line with the time it was first seen. The poll runs twice a second
 * from startup (see shell/session-views.ts), so a stamp is at most about half
 * a second late. A partial line (no newline yet) is held until it completes
 * or the process ends.
 *
 * Bounded: each process keeps its newest MAX_LINES lines; a process the
 * manager no longer lists is dropped on the next poll.
 */

export interface ProcessLine {
  /** Epoch ms the line was first seen. */
  readonly at: number;
  readonly text: string;
  readonly stream: 'stdout' | 'stderr';
  /** The line reads as an error (drawn in the error color). */
  readonly error: boolean;
}

/** The slice of a process record this log reads (BackgroundProcess from the SDK). */
export interface ProcessRecordView {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly done: boolean;
}

/** Newest lines kept per process. */
export const MAX_LINES = 5000;

const ERROR_LINE = /\b(error|errors|failed|failure|fatal|exception|panic|traceback)\b|ERR!|✘|✖/i;
const PORT_PATTERNS: readonly RegExp[] = [
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/,
  /\blistening on (?:port )?:?(\d{2,5})\b/i,
  /\bport[ =:]+(\d{2,5})\b/i,
];

/** Terminal control sequences never reach the view: colors and cursor moves are stripped. */
function clean(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function isErrorLine(text: string): boolean {
  return ERROR_LINE.test(text);
}

/** The first port a line announces ("http://localhost:5173/", "listening on 3000"), when it names one. */
export function portOf(text: string): number | undefined {
  for (const pattern of PORT_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      const port = Number(m[1]);
      if (port > 0 && port < 65536) return port;
    }
  }
  return undefined;
}

interface StreamCursor { chunks: number; partial: string }

interface Entry {
  readonly lines: ProcessLine[];
  readonly out: StreamCursor;
  readonly err: StreamCursor;
  port: number | undefined;
  /** Lines dropped off the front by the bound. */
  dropped: number;
}

export class ProcessOutputLog {
  private readonly entries = new Map<string, Entry>();

  /**
   * Read every listed process's new output. `records` are the processes the
   * manager lists right now; anything else is forgotten.
   */
  poll(records: ReadonlyMap<string, ProcessRecordView>, now = Date.now()): boolean {
    let changed = false;
    for (const id of [...this.entries.keys()]) if (!records.has(id)) this.entries.delete(id);
    for (const [id, record] of records) {
      let entry = this.entries.get(id);
      if (!entry) {
        entry = { lines: [], out: { chunks: 0, partial: '' }, err: { chunks: 0, partial: '' }, port: undefined, dropped: 0 };
        this.entries.set(id, entry);
      }
      if (this.read(entry, entry.out, record.stdout, 'stdout', record.done, now)) changed = true;
      if (this.read(entry, entry.err, record.stderr, 'stderr', record.done, now)) changed = true;
    }
    return changed;
  }

  lines(id: string): readonly ProcessLine[] {
    return this.entries.get(id)?.lines ?? [];
  }

  /** Lines dropped off the front of this process's log by the bound. */
  dropped(id: string): number {
    return this.entries.get(id)?.dropped ?? 0;
  }

  /** The port the process announced, once one of its lines named it. */
  port(id: string): number | undefined {
    return this.entries.get(id)?.port;
  }

  private read(entry: Entry, cursor: StreamCursor, chunks: readonly string[], stream: ProcessLine['stream'], done: boolean, now: number): boolean {
    if (chunks.length < cursor.chunks) cursor.chunks = 0; // the manager trimmed its buffer: start over from what it has
    let changed = false;
    if (chunks.length > cursor.chunks) {
      const text = cursor.partial + chunks.slice(cursor.chunks).join('');
      cursor.chunks = chunks.length;
      const parts = text.split(/\r?\n/);
      cursor.partial = parts.pop() ?? '';
      for (const part of parts) this.push(entry, part, stream, now);
      changed = parts.length > 0;
    }
    if (done && cursor.partial) {
      this.push(entry, cursor.partial, stream, now);
      cursor.partial = '';
      changed = true;
    }
    return changed;
  }

  private push(entry: Entry, raw: string, stream: ProcessLine['stream'], now: number): void {
    // A carriage return without a newline redraws the same line (progress bars): keep what is left visible.
    const text = clean(raw.includes('\r') ? raw.slice(raw.lastIndexOf('\r') + 1) : raw).trimEnd();
    entry.lines.push({ at: now, text, stream, error: isErrorLine(text) });
    if (entry.port === undefined) entry.port = portOf(text);
    if (entry.lines.length > MAX_LINES) {
      const extra = entry.lines.length - MAX_LINES;
      entry.lines.splice(0, extra);
      entry.dropped += extra;
    }
  }
}
