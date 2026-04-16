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
      uiServices as unknown as Parameters<typeof InputHandler>[7],
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
});
