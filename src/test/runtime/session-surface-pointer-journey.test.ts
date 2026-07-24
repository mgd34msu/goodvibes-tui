/**
 * session-surface-pointer-journey.test.ts — the journey that was dead.
 *
 * The defect this pins: the TUI's write path and its read paths derived their
 * own storage scope independently at each call site. A resume wrote the
 * last-session pointer through `writeLastSessionPointer` with no scope at all
 * (the unscoped `.goodvibes/` fallback — and, at the worst call site, with the
 * options argument dropped entirely, so the write threw and was swallowed into
 * a log line), while `--continue` and the boot notice read a scoped path under
 * `.goodvibes/tui/`. Nothing errored. The pointer simply never existed where
 * anyone looked, so `--continue` silently did nothing and the boot notice
 * silently reported no previous session — forever.
 *
 * These tests run the REAL write path (the per-turn persistence in
 * turn-event-wiring.ts) and then the REAL read paths (announceResumeState and
 * applyInitialTuiCliState's `--continue` branch) against a SEPARATELY
 * CONSTRUCTED surface over the same directories — which is exactly what a
 * relaunched process does. If the two sides ever disagree about a path again,
 * these fail.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { readLastSessionPointer, writeLastSessionPointer } from '@/runtime/index.ts';
import { wireTurnEventHandlers, type WireTurnEventHandlersOptions } from '../../core/turn-event-wiring.ts';
import { announceResumeState } from '../../runtime/resume-notice.ts';
import { bindWriteLastSessionPointerToSurface } from '../../runtime/session-pointer-surface.ts';
import { applyInitialTuiCliState } from '../../cli/tui-startup.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;
beforeEach(() => { tmpDir = makeProjectTempDir('gv-pointer-journey'); });
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

// ── The write half: a real completed turn ───────────────────────────────────

type Emitter = { emit: (type: string, payload: unknown) => void };

function makeTurnFeed(): { events: WireTurnEventHandlersOptions['events']; emitTurn: Emitter['emit'] } {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const channel = {
    on: (type: string, fn: (payload: unknown) => void) => {
      const list = handlers.get(type) ?? [];
      list.push(fn);
      handlers.set(type, list);
      return () => {};
    },
  };
  return {
    events: { turns: channel, tools: channel, agents: channel, workflows: channel } as unknown as WireTurnEventHandlersOptions['events'],
    emitTurn: (type, payload) => { for (const fn of handlers.get(type) ?? []) fn(payload); },
  };
}

/**
 * Run one TURN_COMPLETED through the real wiring. This is the app's only
 * automatic write of a session + last-session pointer.
 */
function persistOneTurn(sessionId: string, dir: string, messages: Array<Record<string, unknown>>): void {
  const { events, emitTurn } = makeTurnFeed();
  wireTurnEventHandlers({
    events,
    conversation: {
      toJSON: () => ({ messages, timestamp: Date.now() }),
      getTitleSource: () => 'auto',
      title: 'Journey session',
    } as unknown as WireTurnEventHandlersOptions['conversation'],
    runtime: { sessionId, model: 'test-model', provider: 'test-provider' },
    orchestrator: { lastInputTokens: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    configManager: { get: () => undefined },
    providerRegistry: {
      getCurrentModel: () => ({ contextWindow: 200_000, id: 'test-model' }),
      getContextWindowForModel: (m: { contextWindow: number }) => m.contextWindow,
    },
    systemMessageRouter: { high: () => {}, low: () => {}, routeSystemMessage: () => {} },
    hookDispatcher: { fire: async () => ({}) } as unknown as WireTurnEventHandlersOptions['hookDispatcher'],
    // The writer's surface: built the way runtime/services.ts builds it.
    surface: makeTestSurface(dir),
    gitStatusProvider: { refresh: async () => null },
    lastGitInfoRef: { value: null },
    buildSessionContinuityHints: () => ({}),
    render: () => {},
    webhookNotifier: null,
  });
  emitTurn('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 't1', stopReason: 'completed' });
}

// ── The read half: what a relaunched process does ───────────────────────────

function makeStartupShellPaths(dir: string) {
  return {
    workingDirectory: dir,
    homeDirectory: dir,
    resolveProjectPath: (...segs: string[]) => [dir, '.goodvibes', ...segs].join('/'),
    resolveUserPath: (...segs: string[]) => [dir, '.goodvibes', ...segs].join('/'),
  };
}

describe('the last-session pointer survives the process boundary', () => {
  test('a completed turn writes a pointer a FRESHLY BUILT surface can read', () => {
    persistOneTurn('journey-1', tmpDir, [{ role: 'user', content: 'hello' }]);

    // A new process: nothing shared with the writer but the two directories.
    const relaunchSurface = makeTestSurface(tmpDir);
    expect(readLastSessionPointer({ surface: relaunchSurface })).toBe('journey-1');
    // And the file is genuinely where the surface says it is.
    expect(existsSync(relaunchSurface.lastSessionPointer)).toBe(true);
  });

  test('the boot notice reports the persisted session — the report that used to always be silent', async () => {
    persistOneTurn('journey-2', tmpDir, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);

    const relaunchSurface = makeTestSurface(tmpDir);
    const receipts: string[] = [];
    await announceResumeState({
      surface: relaunchSurface,
      sessionManager: new SessionManager(tmpDir, { surface: relaunchSurface }),
      checkpointManager: undefined,
      chainHistory: [],
      memoryAvailable: false,
      router: { high: (m) => receipts.push(m) },
    });

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain('Previous session found');
    // Two user messages went in; the notice counts user turns, not messages.
    expect(receipts[0]).toContain('2 turns');
    expect(receipts[0]).toContain('journey-2');
  });

  test('--continue dispatches a resume for the persisted session', async () => {
    persistOneTurn('journey-3', tmpDir, [{ role: 'user', content: 'hello' }]);

    const dispatched: Array<{ name: string; args: string[] }> = [];
    await applyInitialTuiCliState({
      cli: { command: 'tui', commandArgs: [], positionals: [], rawCommand: undefined, flags: { continueLast: true } } as never,
      input: { prompt: '', cursorPos: 0 } as never,
      commandRegistry: {
        execute: async (name: string, args: string[]) => { dispatched.push({ name, args }); return true; },
      } as never,
      commandContext: { workspace: {} } as never,
      shellPaths: makeStartupShellPaths(tmpDir) as never,
      // A relaunched process's own surface — same inputs, different object.
      surface: makeTestSurface(tmpDir),
      render: () => {},
    });

    expect(dispatched).toEqual([{ name: 'session', args: ['resume', 'journey-3'] }]);
  });

  test('bare --resume resolves through the same pointer', async () => {
    persistOneTurn('journey-4', tmpDir, [{ role: 'user', content: 'hello' }]);

    const dispatched: Array<{ name: string; args: string[] }> = [];
    await applyInitialTuiCliState({
      cli: { command: 'tui', commandArgs: [], positionals: [], rawCommand: undefined, flags: { resume: 'latest' } } as never,
      input: { prompt: '', cursorPos: 0 } as never,
      commandRegistry: {
        execute: async (name: string, args: string[]) => { dispatched.push({ name, args }); return true; },
      } as never,
      commandContext: { workspace: {} } as never,
      shellPaths: makeStartupShellPaths(tmpDir) as never,
      surface: makeTestSurface(tmpDir),
      render: () => {},
    });

    expect(dispatched).toEqual([{ name: 'session', args: ['resume', 'journey-4'] }]);
  });
});

describe('the resume seam writes the pointer through a bound closure, not a bare reference', () => {
  test('the bound closure writes a pointer a fresh surface reads back', () => {
    const surface = makeTestSurface(tmpDir);
    const write = bindWriteLastSessionPointerToSurface(surface);

    // Called the way every downstream caller calls it: one argument.
    write('resumed-session');

    expect(readLastSessionPointer({ surface: makeTestSurface(tmpDir) })).toBe('resumed-session');
  });

  test('the raw SDK function in the same one-argument slot writes NOTHING — the shape of the original bug', () => {
    // Structurally assignable to `(sessionId: string) => void`, so this
    // compiles; at runtime `options` is undefined, the legacy compat path
    // throws on the missing workingDirectory, and writeLastSessionPointer
    // swallows it into a log line. No file, no error, no clue.
    const bare: (sessionId: string) => void = writeLastSessionPointer;
    bare('resumed-session');

    const surface = makeTestSurface(tmpDir);
    expect(existsSync(surface.lastSessionPointer)).toBe(false);
    expect(readLastSessionPointer({ surface })).toBeNull();
  });
});
