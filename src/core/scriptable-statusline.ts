/**
 * Scriptable status line.
 *
 * When the user sets `statusline.command` in settings.json, that command is run
 * as a POSIX shell command (`/bin/sh -c <command>`) at each turn boundary and
 * its first stdout line is shown in the status area. Every run is bounded by a
 * timeout (`statusline.timeoutMs`, default 2000ms) so a slow or hung command
 * can never stall the UI, and runs never overlap: a refresh requested while one
 * is in flight coalesces into a single trailing run.
 *
 * Output is sanitized to one safe line: first line only, ANSI escape sequences
 * and control characters stripped, trimmed, and length-capped. On failure
 * (non-zero exit, timeout, spawn error) the previous value is cleared so the
 * status area does not show stale text.
 */

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { readStatuslineSettings, STATUSLINE_DEFAULT_TIMEOUT_MS, type StatuslineSettings } from '../config/tui-extension-settings.ts';

/** Runs the shell command and resolves its raw stdout, or throws on failure/timeout. */
export type StatuslineCommandRunner = (command: string, cwd: string, timeoutMs: number) => Promise<string>;

export interface ScriptableStatuslineOptions {
  readonly configManager: Pick<ConfigManager, 'getRaw'>;
  readonly cwd: string;
  /** Turn-boundary event subscription surface. */
  readonly turns: { on(event: string, handler: () => void): () => void };
  /** Called after a refresh actually changes the rendered value, to trigger a repaint. */
  readonly onChange?: () => void;
  /** Injectable command runner (defaults to a Bun.spawn-based POSIX shell runner). Test seam. */
  readonly runner?: StatuslineCommandRunner;
  /** Read settings each refresh so live config edits take effect. Test seam / override. */
  readonly readSettings?: (configManager: Pick<ConfigManager, 'getRaw'>) => StatuslineSettings;
}

export interface ScriptableStatusline {
  /** The current sanitized status line, or null when disabled or the last run failed. */
  current(): string | null;
  /** Request a refresh now (coalesced against any in-flight run). */
  refresh(): void;
  /** Turn-boundary unsubscribe handles. */
  readonly unsubs: ReadonlyArray<() => void>;
}

const MAX_OUTPUT_CHARS = 512;
// Built from escape codes so no literal control byte appears in source.
// CSI/ANSI escape sequences: ESC (0x1b) '[' params intermediates final-byte.
const ANSI_ESCAPE = new RegExp('\\x1b\\[[0-9;?]*[ -/]*[@-~]', 'g');
// C0 control characters (0x00-0x1f) and DEL (0x7f).
const CONTROL_CHARS = new RegExp('[\\x00-\\x1f\\x7f]', 'g');

/** Reduce raw command stdout to a single safe status line. Exported for testing. */
export function sanitizeStatuslineOutput(raw: string): string | null {
  const firstLine = raw.split('\n', 1)[0] ?? '';
  const cleaned = firstLine
    .replace(ANSI_ESCAPE, '')
    .replace(/\t/g, ' ')
    .replace(CONTROL_CHARS, '')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_OUTPUT_CHARS ? cleaned.slice(0, MAX_OUTPUT_CHARS) : cleaned;
}

/** Default runner: `/bin/sh -c <command>` via Bun.spawn with a hard timeout. */
const defaultRunner: StatuslineCommandRunner = async (command, cwd, timeoutMs) => {
  const proc = Bun.spawn(['/bin/sh', '-c', command], {
    stdout: 'pipe',
    stderr: 'ignore',
    cwd,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  // A timed-out process is killed by Bun; treat any non-zero exit (including the
  // kill) as failure so stale output is cleared rather than shown.
  if (exitCode !== 0) throw new Error(`statusline command exited with code ${exitCode}`);
  return out;
};

export function createScriptableStatusline(options: ScriptableStatuslineOptions): ScriptableStatusline {
  const runner = options.runner ?? defaultRunner;
  const readSettings = options.readSettings ?? readStatuslineSettings;
  let value: string | null = null;
  let inFlight = false;
  let pending = false;

  const setValue = (next: string | null): void => {
    if (next === value) return;
    value = next;
    options.onChange?.();
  };

  const run = async (): Promise<void> => {
    inFlight = true;
    try {
      const settings = readSettings(options.configManager);
      if (!settings.command) {
        setValue(null);
        return;
      }
      const timeoutMs = settings.timeoutMs ?? STATUSLINE_DEFAULT_TIMEOUT_MS;
      try {
        const raw = await runner(settings.command, options.cwd, timeoutMs);
        setValue(sanitizeStatuslineOutput(raw));
      } catch {
        // Non-zero exit, timeout, or spawn error: clear rather than show stale text.
        setValue(null);
      }
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        void run();
      }
    }
  };

  const refresh = (): void => {
    if (inFlight) {
      pending = true;
      return;
    }
    void run();
  };

  const unsubs: Array<() => void> = [
    options.turns.on('TURN_COMPLETED', refresh),
    options.turns.on('TURN_ERROR', refresh),
    options.turns.on('TURN_CANCEL', refresh),
  ];

  // Prime once so an enabled statusline shows before the first turn completes.
  refresh();

  return {
    current: () => value,
    refresh,
    unsubs,
  };
}
