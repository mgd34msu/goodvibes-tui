/**
 * α1: InputFeedContext reuse across keystrokes.
 *
 * Verifies that the feedContext object reference is the same across multiple
 * feed() calls, confirming that no per-keystroke context allocation occurs.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import type { InputFeedContext } from '../../input/handler-feed.ts';
import * as handlerFeedModule from '../../input/handler-feed.ts';

describe('InputFeedContext reuse (α1)', () => {
  test('feedInputTokens receives the same context object on every feed() call', () => {
    // We spy on feedInputTokens to capture the context object passed to it.
    const capturedContextRefs: InputFeedContext[] = [];
    const spy = spyOn(handlerFeedModule, 'feedInputTokens').mockImplementation(
      (ctx: InputFeedContext) => {
        capturedContextRefs.push(ctx);
      },
    );

    // Build a minimal InputHandler — only needs enough to construct without crashing.
    // We import dynamically so the spy is in place before the module executes feedInputTokens.
    const { InputHandler } = require('../../input/handler.ts') as typeof import('../../input/handler.ts');
    const { SelectionManager } = require('../../input/selection.ts') as typeof import('../../input/selection.ts');

    const requestRender = mock(() => {});
    const getScrollTop = () => 0;
    const getViewportHeight = () => 24;
    const getHistory = mock(() => ({ getLineCount: () => 0 })) as ReturnType<typeof mock>;
    const scroll = mock(() => {});
    const exitApp = mock(() => {});

    // Minimal uiServices stub
    const uiServices = {
      agents: {
        agentManager: {
          getAllAgents: () => [],
          on: () => {},
          off: () => {},
        } as unknown,
        agentMessageBus: { on: () => {}, off: () => {} } as unknown,
        wrfcController: { on: () => {}, off: () => {} } as unknown,
      },
      environment: {
        shellPaths: {
          homeDirectory: '/tmp',
          workingDirectory: '/tmp',
          resolveProjectPath: (...parts: string[]) => parts.join('/'),
        },
      },
      providers: {
        favoritesStore: { getAll: () => [] } as unknown,
        benchmarkStore: { getAll: () => [] } as unknown,
        providerRegistry: { getAll: () => [] } as unknown,
      },
      sessions: {
        sessionManager: { getAll: () => [] } as unknown,
      },
      shell: {
        processManager: { getAll: () => [] } as unknown,
        bookmarkManager: { getAll: () => [] } as unknown,
        profileManager: { getAll: () => [] } as unknown,
        panelManager: { isVisible: () => false, getAllOpen: () => [] } as unknown,
        keybindingsManager: {
          matches: () => false,
          lookup: () => null,
        } as unknown,
      },
    };

    const selection = new SelectionManager();
    const handler = new InputHandler(
      requestRender,
      selection,
      getScrollTop,
      getViewportHeight,
      getHistory as unknown as () => import('../../core/history.ts').InfiniteBuffer,
      scroll,
      exitApp,
      uiServices as unknown as import('../../runtime/ui-services.ts').UiRuntimeServices,
    );

    // Feed 100 single-character keystrokes (each is one token).
    const ITERATIONS = 100;
    for (let i = 0; i < ITERATIONS; i++) {
      handler.feed('a');
    }

    // feedInputTokens should have been called ITERATIONS times.
    expect(capturedContextRefs.length).toBe(ITERATIONS);

    // Every call must have received the SAME context object reference.
    const firstRef = capturedContextRefs[0];
    for (let i = 1; i < capturedContextRefs.length; i++) {
      expect(capturedContextRefs[i]).toBe(firstRef);
    }

    spy.mockRestore();
  });

  test('mutable fields on the context reflect updated handler state between feeds', () => {
    // This test verifies that per-feed sync correctly propagates prompt/cursorPos
    // changes between feeds — i.e., the context is not stale after the first feed.
    const capturedContexts: Array<{ prompt: string; cursorPos: number }> = [];
    const spy = spyOn(handlerFeedModule, 'feedInputTokens').mockImplementation(
      (ctx: InputFeedContext) => {
        // Simulate what feedInputTokens does: mutate context fields
        ctx.prompt = ctx.prompt + 'x';
        ctx.cursorPos = ctx.prompt.length;
        capturedContexts.push({ prompt: ctx.prompt, cursorPos: ctx.cursorPos });
      },
    );

    const { InputHandler } = require('../../input/handler.ts') as typeof import('../../input/handler.ts');
    const { SelectionManager } = require('../../input/selection.ts') as typeof import('../../input/selection.ts');

    const uiServices = {
      agents: {
        agentManager: { getAllAgents: () => [], on: () => {}, off: () => {} } as unknown,
        agentMessageBus: { on: () => {}, off: () => {} } as unknown,
        wrfcController: { on: () => {}, off: () => {} } as unknown,
      },
      environment: {
        shellPaths: {
          homeDirectory: '/tmp',
          workingDirectory: '/tmp',
          resolveProjectPath: (...parts: string[]) => parts.join('/'),
        },
      },
      providers: {
        favoritesStore: { getAll: () => [] } as unknown,
        benchmarkStore: { getAll: () => [] } as unknown,
        providerRegistry: { getAll: () => [] } as unknown,
      },
      sessions: { sessionManager: { getAll: () => [] } as unknown },
      shell: {
        processManager: { getAll: () => [] } as unknown,
        bookmarkManager: { getAll: () => [] } as unknown,
        profileManager: { getAll: () => [] } as unknown,
        panelManager: { isVisible: () => false, getAllOpen: () => [] } as unknown,
        keybindingsManager: { matches: () => false, lookup: () => null } as unknown,
      },
    };

    const selection = new SelectionManager();
    const handler = new InputHandler(
      () => {},
      selection,
      () => 0,
      () => 24,
      (() => ({ getLineCount: () => 0 })) as unknown as () => import('../../core/history.ts').InfiniteBuffer,
      () => {},
      () => {},
      uiServices as unknown as import('../../runtime/ui-services.ts').UiRuntimeServices,
    );

    // Feed keystroke 'a' — mock simulates ctx.prompt becoming 'x', cursorPos=1
    handler.feed('a');
    expect(capturedContexts[0]?.prompt).toBe('x');
    expect(capturedContexts[0]?.cursorPos).toBe(1);

    // Feed keystroke 'b' — handler syncs ctx.prompt='x' from handler.prompt (set after 1st feed).
    // The mock will then append another 'x', making prompt='xx', cursorPos=2.
    handler.feed('b');
    expect(capturedContexts[1]?.prompt).toBe('xx');
    expect(capturedContexts[1]?.cursorPos).toBe(2);

    spy.mockRestore();
  });
});
