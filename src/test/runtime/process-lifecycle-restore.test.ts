/**
 * Pins for restoreTerminal, the exit teardown must leave the user's terminal
 * exactly usable: no scrollback wipe (ESC[3J), cursor made visible on the
 * screen the shell prompt lands on (after the alt-screen switch), idempotent,
 * and no compositor frame may follow it (isTerminalRestored gate).
 *
 * Regression context: exiting the TUI sometimes left the shell prompt typing
 * over stale screen content, late frames after restore plus a scrollback
 * wipe issued from inside the alt screen.
 */
import { describe, expect, test } from 'bun:test';
import { installProcessLifecycle, type ProcessLifecycleDeps } from '../../runtime/process-lifecycle.ts';
import {
  ALT_SCREEN_EXIT,
  CLEAR_SCREEN,
  CURSOR_SHOW,
  FOCUS_DISABLE,
  KEYBOARD_EXT_DISABLE,
  MOUSE_DISABLE,
  PASTE_DISABLE,
} from '../../renderer/terminal-escapes.ts';

function makeHarness(noAltScreen: boolean): {
  handlers: ReturnType<typeof installProcessLifecycle>;
  written: () => string;
  rawModeCalls: boolean[];
  guardDisposed: () => boolean;
} {
  const chunks: string[] = [];
  const rawModeCalls: boolean[] = [];
  let disposed = false;
  const deps = {
    stdin: { setRawMode: (v: boolean) => { rawModeCalls.push(v); } },
    stdout: { write: (s: string) => { chunks.push(s); return true; } },
    ctx: {},
    noAltScreen,
    ansi: {
      CLEAR_SCREEN,
      ALT_SCREEN_EXIT,
      PASTE_DISABLE,
      KEYBOARD_EXT_DISABLE,
      MOUSE_DISABLE,
      CURSOR_SHOW,
      FOCUS_DISABLE,
    },
    getInput: () => { throw new Error('not used in these tests'); },
    render: () => {},
    getTerminalOutputGuard: () => ({ dispose: () => { disposed = true; } }),
    getPromptContentWidth: () => 80,
    buildSessionContinuityHints: () => ({}),
    unsubs: [],
    getRecoveryInterval: () => null,
    setRecoveryInterval: () => {},
    getStopSpokenOutputForExit: () => null,
  } as unknown as ProcessLifecycleDeps;
  const handlers = installProcessLifecycle(deps);
  return { handlers, written: () => chunks.join(''), rawModeCalls, guardDisposed: () => disposed };
}

describe('restoreTerminal', () => {
  test('alt-screen path: leaves the alt screen, shows the cursor AFTER the switch, never touches scrollback', () => {
    const h = makeHarness(false);
    expect(h.handlers.isTerminalRestored()).toBe(false);
    h.handlers.restoreTerminal();
    const out = h.written();

    expect(out).toContain(ALT_SCREEN_EXIT);
    expect(out).not.toContain('\x1b[3J'); // never wipe the user's scrollback
    // Cursor visibility must apply to the primary screen the prompt lands on.
    expect(out.indexOf(CURSOR_SHOW)).toBeGreaterThan(out.indexOf(ALT_SCREEN_EXIT));
    for (const seq of [PASTE_DISABLE, KEYBOARD_EXT_DISABLE, MOUSE_DISABLE, FOCUS_DISABLE]) {
      expect(out).toContain(seq);
    }
    expect(h.handlers.isTerminalRestored()).toBe(true);
    expect(h.guardDisposed()).toBe(true);
    expect(h.rawModeCalls).toEqual([false]);
  });

  test('no-alt-screen path: clears the painted-over screen without 3J and without an alt-screen exit', () => {
    const h = makeHarness(true);
    h.handlers.restoreTerminal();
    const out = h.written();

    expect(out).toContain('\x1b[2J\x1b[H');
    expect(out).not.toContain('\x1b[3J');
    expect(out).not.toContain(ALT_SCREEN_EXIT);
    expect(out.indexOf(CURSOR_SHOW)).toBeGreaterThan(out.indexOf('\x1b[2J\x1b[H'));
  });

  test('idempotent: a second call writes nothing more', () => {
    const h = makeHarness(false);
    h.handlers.restoreTerminal();
    const afterFirst = h.written();
    h.handlers.restoreTerminal();
    expect(h.written()).toBe(afterFirst);
  });
});
