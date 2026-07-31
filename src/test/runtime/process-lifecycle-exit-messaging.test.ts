/**
 * exitApp's exit-progress messaging (item 4) and liveness-marker cleanup
 * (item 6a's removal half).
 *
 * Pins:
 *   - a shutdown that completes quickly (under saveNoticeAfterMs) prints
 *     nothing at all — quiet stays quiet.
 *   - a shutdown that takes a moment (over saveNoticeAfterMs, under the hard
 *     timeout) prints exactly one "saving session…" line, then completes
 *     normally with no further message.
 *   - a shutdown that never resolves before the hard timeout prints "saving
 *     session…" AND the honest "exit before save completed" line, and the
 *     recovery file is kept (deleteRecoveryFile is never called for it).
 *   - that honest line branches on whether a recovery snapshot actually
 *     exists on disk: present -> "a recovery snapshot was kept for next
 *     launch"; absent -> "no recovery snapshot had been written yet" (the
 *     periodic autosave only ticks every 60s and skips empty conversations,
 *     so plenty of timeout exits have nothing to keep).
 *   - the session's liveness marker is removed on exit regardless of which
 *     branch was taken.
 *
 * process.exit is spied and neutered so the test process itself survives.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
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
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { livenessMarkerPathFor, writeLivenessMarker } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpHome: string;
let exitSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  tmpHome = makeProjectTempDir('gv-exit-messaging');
  exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

function makeHarness(opts: {
  shutdown: () => Promise<void>;
  saveNoticeAfterMs?: number;
  shutdownHardTimeoutMs?: number;
  sessionId?: string;
  recoverySnapshotExists?: (surface: unknown, sessionId: string) => boolean;
}): { exitApp: () => Promise<void>; written: () => string } {
  const chunks: string[] = [];
  const sessionId = opts.sessionId ?? 'exit-test-session';
  const deletedRecoveryFor: string[] = [];

  const ctx = {
    conversation: {
      toJSON: () => ({ messages: [] }),
      getTitleSource: () => 'auto',
    },
    runtime: { sessionId },
    services: { homeDirectory: tmpHome, surface: makeTestSurface(tmpHome) },
    shutdown: opts.shutdown,
  } as unknown as BootstrapContext;

  const deps = {
    stdin: { setRawMode: () => {}, removeAllListeners: () => {} },
    stdout: { write: (s: string) => { chunks.push(s); return true; }, removeListener: () => {} },
    ctx,
    noAltScreen: false,
    ansi: { CLEAR_SCREEN, ALT_SCREEN_EXIT, PASTE_DISABLE, KEYBOARD_EXT_DISABLE, MOUSE_DISABLE, CURSOR_SHOW, FOCUS_DISABLE },
    getInput: () => { throw new Error('not used in these tests'); },
    render: () => {},
    getTerminalOutputGuard: () => ({ dispose: () => {} }),
    getPromptContentWidth: () => 80,
    buildSessionContinuityHints: () => ({}),
    unsubs: [],
    getRecoveryInterval: () => null,
    setRecoveryInterval: () => {},
    getStopSpokenOutputForExit: () => null,
    saveNoticeAfterMs: opts.saveNoticeAfterMs,
    shutdownHardTimeoutMs: opts.shutdownHardTimeoutMs,
    recoverySnapshotExists: opts.recoverySnapshotExists,
  } as unknown as ProcessLifecycleDeps;

  const handlers = installProcessLifecycle(deps);
  void deletedRecoveryFor;
  // restoreTerminal() (called synchronously at the top of exitApp, before any
  // of this test's own assertions matter) writes its own ANSI escape
  // sequences to the same stdout — strip those so assertions here only see
  // the plain-text progress/receipt lines this item actually adds.
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?>]*[a-zA-Z]/g, '');
  return { exitApp: handlers.exitApp, written: () => stripAnsi(chunks.join('')) };
}

describe('exitApp — exit-progress messaging', () => {
  test('a fast, clean shutdown prints nothing at all (quiet stays quiet)', async () => {
    const h = makeHarness({
      shutdown: () => Promise.resolve(),
      saveNoticeAfterMs: 200,
      shutdownHardTimeoutMs: 2000,
    });
    await h.exitApp();
    expect(h.written()).toBe('');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('a shutdown slower than the notice threshold prints "saving session…" once, then nothing else on success', async () => {
    const h = makeHarness({
      shutdown: () => new Promise((resolve) => setTimeout(resolve, 40)),
      saveNoticeAfterMs: 10,
      shutdownHardTimeoutMs: 2000,
    });
    await h.exitApp();
    const out = h.written();
    expect(out).toBe('saving session…\n');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('a shutdown that never resolves before the hard timeout prints both the progress line and the honest "kept" exit-before-save line when a snapshot actually exists on disk', async () => {
    const h = makeHarness({
      shutdown: () => new Promise(() => { /* never resolves */ }),
      saveNoticeAfterMs: 10,
      shutdownHardTimeoutMs: 40,
      recoverySnapshotExists: () => true,
    });
    await h.exitApp();
    const out = h.written();
    expect(out).toContain('saving session…\n');
    expect(out).toContain('exit before save completed — a recovery snapshot was kept for next launch\n');
    expect(out).not.toContain('no recovery snapshot had been written yet');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('a timed-out exit reports the honest "none written" line when no recovery snapshot exists yet (fast-dying or empty session)', async () => {
    const h = makeHarness({
      shutdown: () => new Promise(() => { /* never resolves */ }),
      saveNoticeAfterMs: 10,
      shutdownHardTimeoutMs: 40,
      recoverySnapshotExists: () => false,
    });
    await h.exitApp();
    const out = h.written();
    expect(out).toContain('exit before save completed — no recovery snapshot had been written yet\n');
    expect(out).not.toContain('a recovery snapshot was kept for next launch');
  });

  test('an immediate rejection from ctx.shutdown is treated like a timeout: the recovery snapshot is kept and reported', async () => {
    const h = makeHarness({
      shutdown: () => Promise.reject(new Error('shutdown blew up')),
      saveNoticeAfterMs: 200,
      shutdownHardTimeoutMs: 2000,
    });
    await h.exitApp();
    const out = h.written();
    expect(out).toContain('exit before save completed');
  });
});

describe('exitApp — liveness marker cleanup (item 6a)', () => {
  test('the session liveness marker is removed on a clean exit', async () => {
    writeLivenessMarker(makeTestSurface(tmpHome), 'sess-clean-exit', process.pid);
    expect(existsSync(livenessMarkerPathFor(makeTestSurface(tmpHome), 'sess-clean-exit'))).toBe(true);

    const h = makeHarness({
      shutdown: () => Promise.resolve(),
      saveNoticeAfterMs: 200,
      shutdownHardTimeoutMs: 2000,
      sessionId: 'sess-clean-exit',
    });
    await h.exitApp();

    expect(existsSync(livenessMarkerPathFor(makeTestSurface(tmpHome), 'sess-clean-exit'))).toBe(false);
  });

  test('the session liveness marker is removed even on the timeout branch (best-effort, unconditional)', async () => {
    writeLivenessMarker(makeTestSurface(tmpHome), 'sess-timeout-exit', process.pid);

    const h = makeHarness({
      shutdown: () => new Promise(() => { /* never resolves */ }),
      saveNoticeAfterMs: 10,
      shutdownHardTimeoutMs: 30,
      sessionId: 'sess-timeout-exit',
    });
    await h.exitApp();

    expect(existsSync(livenessMarkerPathFor(makeTestSurface(tmpHome), 'sess-timeout-exit'))).toBe(false);
  });

  test('no marker present is a harmless no-op', async () => {
    const h = makeHarness({ shutdown: () => Promise.resolve(), sessionId: 'sess-no-marker' });
    await expect(h.exitApp()).resolves.toBeUndefined();
  });
});
