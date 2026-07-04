import { format } from 'node:util';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

type WritableStreamLike = {
  write: {
    (buffer: string | Uint8Array, cb?: (error?: Error | null) => void): boolean;
    (buffer: string | Uint8Array, encoding?: BufferEncoding, cb?: (error?: Error | null) => void): boolean;
  };
};

export type TerminalOutputInterceptSource =
  | 'stdout'
  | 'stderr'
  | 'console.debug'
  | 'console.error'
  | 'console.info'
  | 'console.log'
  | 'console.warn';

export type TerminalOutputIntercept = {
  readonly source: TerminalOutputInterceptSource;
  readonly text: string;
  readonly preview: string;
};

export type TerminalOutputGuard = {
  setActive(active: boolean): void;
  allowTerminalWrite<T>(fn: () => T): T;
  dispose(): void;
};

export type TerminalOutputGuardOptions = {
  readonly stdout: WritableStreamLike;
  readonly stderr?: WritableStreamLike;
  readonly active?: boolean;
  readonly onIntercept?: (event: TerminalOutputIntercept) => void;
};

export type TuiTerminalOutputGuardOptions = {
  readonly stdout: WritableStreamLike;
  readonly stderr?: WritableStreamLike;
  readonly active?: boolean;
  /**
   * Called (rate-limited) after intercepts with the cumulative count of direct
   * writes captured this session, so an honest quiet counter (e.g. /debug) can
   * refresh. The per-write detail is already recorded to the activity log via
   * logger.warn — this callback intentionally does NOT push transcript lines.
   * (UX-B item 1a.)
   */
  readonly onCapture?: (total: number) => void;
};

const MAX_LOG_TEXT = 4_000;
const MAX_PREVIEW_TEXT = 180;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

let currentGuard: TerminalOutputGuard | null = null;

function writeCallback(args: unknown[]): ((error?: Error | null) => void) | undefined {
  const maybeCallback = args[args.length - 1];
  return typeof maybeCallback === 'function'
    ? maybeCallback as (error?: Error | null) => void
    : undefined;
}

function chunkToText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

function normalizeText(text: string): string {
  return text.replace(ANSI_RE, '').replace(/\r/g, '').trim();
}

function previewText(text: string): string {
  const singleLine = normalizeText(text).replace(/\s+/g, ' ');
  if (singleLine.length <= MAX_PREVIEW_TEXT) return singleLine;
  return `${singleLine.slice(0, MAX_PREVIEW_TEXT - 1)}...`;
}

function truncateForLog(text: string): string {
  if (text.length <= MAX_LOG_TEXT) return text;
  return `${text.slice(0, MAX_LOG_TEXT)}\n[truncated ${text.length - MAX_LOG_TEXT} byte(s)]`;
}

function invokeSuppressedCallback(args: unknown[]): void {
  const callback = writeCallback(args);
  if (callback) {
    queueMicrotask(() => callback(null));
  }
}

export function allowTerminalWrite<T>(fn: () => T): T {
  return currentGuard ? currentGuard.allowTerminalWrite(fn) : fn();
}

export function installTerminalOutputGuard(options: TerminalOutputGuardOptions): TerminalOutputGuard {
  const stdout = options.stdout;
  const stderr = options.stderr ?? process.stderr;
  const originalStdoutWriteMethod = stdout.write;
  const originalStderrWriteMethod = stderr.write;
  const originalStdoutWrite = (...args: unknown[]): boolean =>
    Reflect.apply(originalStdoutWriteMethod, stdout, args) as boolean;
  const originalStderrWrite = (...args: unknown[]): boolean =>
    Reflect.apply(originalStderrWriteMethod, stderr, args) as boolean;
  const originalConsole = {
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };

  let active = options.active ?? true;
  let disposed = false;
  let allowDepth = 0;
  let captureDepth = 0;

  const record = (source: TerminalOutputInterceptSource, text: string): void => {
    if (disposed || !active) return;
    const normalized = normalizeText(text);
    if (!normalized) return;
    if (normalized.startsWith('[ActivityLogger]')) return;
    if (captureDepth > 0) return;

    captureDepth++;
    try {
      const event: TerminalOutputIntercept = {
        source,
        text: truncateForLog(normalized),
        preview: previewText(normalized),
      };
      logger.warn('Intercepted terminal output while TUI renderer was active', {
        source: event.source,
        text: event.text,
      });
      options.onIntercept?.(event);
    } finally {
      captureDepth--;
    }
  };

  const shouldPassThrough = (): boolean => !active || allowDepth > 0 || disposed;

  stdout.write = ((...args: unknown[]) => {
    if (shouldPassThrough()) {
      return originalStdoutWrite(...args);
    }
    record('stdout', chunkToText(args[0]));
    invokeSuppressedCallback(args);
    return true;
  }) as WritableStreamLike['write'];

  stderr.write = ((...args: unknown[]) => {
    if (shouldPassThrough()) {
      return originalStderrWrite(...args);
    }
    record('stderr', chunkToText(args[0]));
    invokeSuppressedCallback(args);
    return true;
  }) as WritableStreamLike['write'];

  console.debug = (...args: unknown[]) => {
    if (!active || disposed) return originalConsole.debug(...args);
    record('console.debug', format(...args));
  };
  console.error = (...args: unknown[]) => {
    if (!active || disposed) return originalConsole.error(...args);
    record('console.error', format(...args));
  };
  console.info = (...args: unknown[]) => {
    if (!active || disposed) return originalConsole.info(...args);
    record('console.info', format(...args));
  };
  console.log = (...args: unknown[]) => {
    if (!active || disposed) return originalConsole.log(...args);
    record('console.log', format(...args));
  };
  console.warn = (...args: unknown[]) => {
    if (!active || disposed) return originalConsole.warn(...args);
    record('console.warn', format(...args));
  };

  const guard: TerminalOutputGuard = {
    setActive(nextActive) {
      active = nextActive;
    },
    allowTerminalWrite<T>(fn: () => T): T {
      allowDepth++;
      try {
        return fn();
      } finally {
        allowDepth--;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stdout.write = originalStdoutWriteMethod;
      stderr.write = originalStderrWriteMethod;
      console.debug = originalConsole.debug;
      console.error = originalConsole.error;
      console.info = originalConsole.info;
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      if (currentGuard === guard) {
        currentGuard = null;
      }
    },
  };

  currentGuard = guard;
  return guard;
}

export function installTuiTerminalOutputGuard(options: TuiTerminalOutputGuardOptions): TerminalOutputGuard {
  let totalInterceptedWrites = 0;
  let lastNoticeAt = 0;
  return installTerminalOutputGuard({
    stdout: options.stdout,
    stderr: options.stderr,
    active: options.active,
    onIntercept: () => {
      // Each intercept is already logged (logger.warn in record()). Here we only
      // maintain a cumulative counter and, rate-limited, refresh a quiet counter
      // surface — no repeated transcript lines. (UX-B item 1a.)
      totalInterceptedWrites++;
      const now = Date.now();
      if (now - lastNoticeAt < 5_000) return;
      lastNoticeAt = now;
      options.onCapture?.(totalInterceptedWrites);
    },
  });
}
