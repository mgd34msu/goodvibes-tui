import { describe, expect, test } from 'bun:test';
import { createScriptableStatusline, sanitizeStatuslineOutput, type StatuslineCommandRunner } from '@/core/scriptable-statusline.ts';
import type { StatuslineSettings } from '@/config/tui-extension-settings.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

const emptyConfig: Pick<ConfigManager, 'getRaw'> = { getRaw: () => ({} as ReturnType<ConfigManager['getRaw']>) };

/** A minimal turn-event emitter matching the subscription surface the statusline needs. */
function makeTurns() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    on(event: string, handler: () => void): () => void {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    emit(event: string): void {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

const settingsOf = (settings: StatuslineSettings) => () => settings;

describe('sanitizeStatuslineOutput', () => {
  test('keeps only the first line', () => {
    expect(sanitizeStatuslineOutput('one\ntwo\nthree')).toBe('one');
  });

  test('strips ANSI escape sequences', () => {
    expect(sanitizeStatuslineOutput('\x1b[31mred\x1b[0m status')).toBe('red status');
  });

  test('strips control characters', () => {
    expect(sanitizeStatuslineOutput('a\x07b\x00c')).toBe('abc');
  });

  test('converts tabs to spaces and trims', () => {
    expect(sanitizeStatuslineOutput('  a\tb  ')).toBe('a b');
  });

  test('returns null for empty/whitespace output', () => {
    expect(sanitizeStatuslineOutput('')).toBeNull();
    expect(sanitizeStatuslineOutput('   \n')).toBeNull();
  });

  test('caps very long output', () => {
    const long = 'x'.repeat(1000);
    expect(sanitizeStatuslineOutput(long)?.length).toBe(512);
  });
});

async function flush(): Promise<void> {
  // Let the coalescing async run() settle.
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('createScriptableStatusline', () => {
  test('is null when no command is configured', async () => {
    const statusline = createScriptableStatusline({
      configManager: emptyConfig,
      cwd: '/tmp',
      turns: makeTurns(),
      readSettings: settingsOf({}),
    });
    await flush();
    expect(statusline.current()).toBeNull();
  });

  test('renders the sanitized command output after priming', async () => {
    const runner: StatuslineCommandRunner = async () => 'branch main | clean\n';
    const statusline = createScriptableStatusline({
      configManager: emptyConfig,
      cwd: '/tmp',
      turns: makeTurns(),
      runner,
      readSettings: settingsOf({ command: 'echo hi' }),
    });
    await flush();
    expect(statusline.current()).toBe('branch main | clean');
  });

  test('refreshes on TURN_COMPLETED', async () => {
    let calls = 0;
    const runner: StatuslineCommandRunner = async () => `run ${++calls}`;
    const turns = makeTurns();
    const statusline = createScriptableStatusline({
      configManager: emptyConfig,
      cwd: '/tmp',
      turns,
      runner,
      readSettings: settingsOf({ command: 'x' }),
    });
    await flush();
    expect(statusline.current()).toBe('run 1');
    turns.emit('TURN_COMPLETED');
    await flush();
    expect(statusline.current()).toBe('run 2');
  });

  test('clears the value when the command fails', async () => {
    let ok = true;
    const runner: StatuslineCommandRunner = async () => {
      if (ok) return 'good';
      throw new Error('boom');
    };
    const turns = makeTurns();
    const statusline = createScriptableStatusline({
      configManager: emptyConfig,
      cwd: '/tmp',
      turns,
      runner,
      readSettings: settingsOf({ command: 'x' }),
    });
    await flush();
    expect(statusline.current()).toBe('good');
    ok = false;
    turns.emit('TURN_ERROR');
    await flush();
    expect(statusline.current()).toBeNull();
  });

  test('coalesces overlapping refreshes into a single trailing run', async () => {
    let running = 0;
    let maxConcurrent = 0;
    let total = 0;
    const runner: StatuslineCommandRunner = async () => {
      running += 1;
      total += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return `n${total}`;
    };
    const turns = makeTurns();
    const statusline = createScriptableStatusline({
      configManager: emptyConfig,
      cwd: '/tmp',
      turns,
      runner,
      readSettings: settingsOf({ command: 'x' }),
    });
    // Priming run is now in flight; fire several boundary refreshes on top of it.
    turns.emit('TURN_COMPLETED');
    turns.emit('TURN_COMPLETED');
    turns.emit('TURN_COMPLETED');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(maxConcurrent).toBe(1); // never overlapped
    expect(total).toBeLessThanOrEqual(2); // priming + one coalesced trailing run
  });
});
