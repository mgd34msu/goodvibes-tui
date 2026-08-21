import { describe, expect, test } from 'bun:test';

import { handleBlockingShellInput, type PendingPermissionState } from '../../shell/blocking-input.ts';

/** Default journal-replay stubs: no journal file exists, so replay is a no-op. */
const JOURNAL_STUBS = {
  homeDirectory: '/tmp/test-home',
  sessionId: 'test-session',
  persistSnapshot: () => {},
} as const;

interface FromJSONCall {
  messages: Array<Record<string, unknown>>;
  title?: string;
  titleSource?: string;
}

function makeConversation() {
  const calls: FromJSONCall[] = [];
  /** Derived array pushed to on every fromJSON call. Safe to destructure. */
  const restored: Array<Record<string, unknown>>[] = [];
  return {
    calls,
    restored,
    conversation: {
      fromJSON: (data: FromJSONCall) => {
        calls.push(data);
        restored.push(data.messages);
      },
    },
  };
}

function makeRouter() {
  const messages: string[] = [];
  const lowMessages: string[] = [];
  return {
    messages,
    lowMessages,
    router: {
      high: (text: string) => messages.push(text),
      low: (text: string) => lowMessages.push(text),
    },
  };
}

describe('shell/blocking-input', () => {
  test('approves pending permission on y', () => {
    const resolved: Array<[boolean, boolean | undefined]> = [];
    const { conversation } = makeConversation();
    const { router } = makeRouter();
    let rendered = 0;
    let aborted = 0;

    const pendingPermission = {
      id: 'perm-1',
      toolName: 'write',
      reason: 'Need approval',
      resolve: (approved: boolean, remember?: boolean) => {
        resolved.push([approved, remember]);
      },
    } as unknown as PendingPermissionState;

    const result = handleBlockingShellInput({
      data: 'y',
      pendingPermission,
      abortTurn: () => { aborted++; },
      render: () => { rendered++; },
    });

    expect(result.handled).toBe(true);
    expect(result.pendingPermission).toBeNull();
    expect(resolved).toEqual([[true, false]]);
    expect(aborted).toBe(0);
    expect(rendered).toBe(1);
  });

  test('escape drops focus only: passes through to input, keeps the card pending, never denies', () => {
    const resolved: Array<[boolean, boolean | undefined]> = [];
    const { conversation } = makeConversation();
    const { router } = makeRouter();
    let aborted = 0;

    const pendingPermission = {
      id: 'perm-2',
      toolName: 'write',
      reason: 'Need approval',
      resolve: (approved: boolean, remember?: boolean) => {
        resolved.push([approved, remember]);
      },
    } as unknown as PendingPermissionState;

    const result = handleBlockingShellInput({
      data: '\x1b',
      pendingPermission,
      abortTurn: () => { aborted++; },
      render: () => {},
    });

    // Esc is not a card answer: it passes through to input (handled:false) so
    // the normal handler drops focus. The request stays pending; nothing denies
    // or aborts.
    expect(result.handled).toBe(false);
    expect(result.pendingPermission).toBe(pendingPermission);
    expect(resolved).toEqual([]);
    expect(aborted).toBe(0);
  });

  test('scroll, mouse, and PageUp keys pass through to input while a card is up (transcript stays scrollable)', () => {
    const { conversation } = makeConversation();
    const { router } = makeRouter();

    const pendingPermission = {
      id: 'perm-scroll',
      toolName: 'write',
      reason: 'Need approval',
      resolve: () => { throw new Error('scroll/mouse must never resolve the request'); },
    } as unknown as PendingPermissionState;

    // PageUp, PageDown, an SGR mouse-wheel event, and an arrow key.
    for (const data of ['\x1b[5~', '\x1b[6~', '\x1b[<64;10;5M', '\x1b[A']) {
      const result = handleBlockingShellInput({
        data,
        pendingPermission,
        abortTurn: () => { throw new Error('scroll/mouse must never abort'); },
        render: () => {},
      });
      // Not consumed: falls through to input.feed. The card is untouched.
      expect(result.handled).toBe(false);
      expect(result.pendingPermission).toBe(pendingPermission);
    }
  });

  test('answer keys still act while a card is up (passthrough does not swallow y/n)', () => {
    const { conversation } = makeConversation();
    const { router } = makeRouter();
    const resolved: Array<[boolean, boolean | undefined]> = [];
    const pendingPermission = {
      id: 'perm-answer',
      toolName: 'write',
      reason: 'Need approval',
      resolve: (approved: boolean, remember?: boolean) => { resolved.push([approved, remember]); },
    } as unknown as PendingPermissionState;

    const approve = handleBlockingShellInput({
      data: 'y',
      pendingPermission,
      abortTurn: () => {},
      render: () => {},
    });
    expect(approve.handled).toBe(true);
    expect(approve.pendingPermission).toBeNull();
    expect(resolved).toEqual([[true, false]]);
  });


  // ---------------------------------------------------------------------------
  // Hunk-mode routing, pendingPermission.hunkState present.
  //
  // Every non-hunk-mode test above passes `pendingPermission` objects with no
  // `hunkState` property, so they exercise the exact same y/a/n switch as
  // before this change, the regression safety net this suite is pinning.
  // ---------------------------------------------------------------------------
  describe('hunk-mode routing (pendingPermission.hunkState present)', () => {
    function makeHunkPending(overrides?: {
      selected?: number[];
      cursor?: number;
      resolve?: (approved: boolean, remember?: boolean, modifiedArgs?: Record<string, unknown>) => void;
    }) {
      const hunks = [
        { path: 'a.ts', find: 'one', replace: 'ONE' },
        { path: 'a.ts', find: 'two', replace: 'TWO' },
        { path: 'b.ts', find: 'three', replace: 'THREE' },
      ];
      const resolveCalls: Array<[boolean, boolean | undefined, Record<string, unknown> | undefined]> = [];
      const resolve = overrides?.resolve ?? ((approved: boolean, remember?: boolean, modifiedArgs?: Record<string, unknown>) => {
        resolveCalls.push([approved, remember, modifiedArgs]);
      });
      const pendingPermission = {
        callId: 'call-1',
        tool: 'edit',
        args: { edits: hunks },
        category: 'write',
        analysis: { classification: 'write', riskLevel: 'medium', summary: 'test', reasons: [] },
        resolve,
        hunkState: {
          hunks,
          cursor: overrides?.cursor ?? 0,
          selected: new Set(overrides?.selected ?? [0, 1, 2]),
        },
      } as unknown as PendingPermissionState;
      return { pendingPermission, resolveCalls };
    }

    test('j/k move the cursor without resolving', () => {
      const { conversation } = makeConversation();
      const { router } = makeRouter();
      const { pendingPermission, resolveCalls } = makeHunkPending();
      let rendered = 0;

      const result = handleBlockingShellInput({
        data: 'j',
        pendingPermission,
        abortTurn: () => {},
        render: () => { rendered++; },
      });

      expect(result.handled).toBe(true);
      expect(result.pendingPermission).not.toBeNull();
      expect((result.pendingPermission as unknown as { hunkState: { cursor: number } }).hunkState.cursor).toBe(1);
      expect(resolveCalls).toHaveLength(0);
      expect(rendered).toBe(1);
    });

    test('space toggles the cursor row without resolving', () => {
      const { conversation } = makeConversation();
      const { router } = makeRouter();
      const { pendingPermission, resolveCalls } = makeHunkPending();

      const result = handleBlockingShellInput({
        data: ' ',
        pendingPermission,
        abortTurn: () => {},
        render: () => {},
      });

      const hunkState = (result.pendingPermission as unknown as { hunkState: { selected: Set<number> } }).hunkState;
      expect(hunkState.selected.has(0)).toBe(false);
      expect(resolveCalls).toHaveLength(0);
    });

    test('enter resolves once with approved=true and a modifiedArgs payload matching the current selection', () => {
      const { conversation } = makeConversation();
      const { router } = makeRouter();
      const { pendingPermission, resolveCalls } = makeHunkPending({ selected: [0, 2] });
      let rendered = 0;

      const result = handleBlockingShellInput({
        data: '\r',
        pendingPermission,
        abortTurn: () => {},
        render: () => { rendered++; },
      });

      expect(result.handled).toBe(true);
      expect(result.pendingPermission).toBeNull();
      expect(resolveCalls).toHaveLength(1);
      const [approved, remember, modifiedArgs] = resolveCalls[0]!;
      expect(approved).toBe(true);
      expect(remember).toBe(false);
      expect(modifiedArgs).toEqual({
        edits: [
          { path: 'a.ts', find: 'one', replace: 'ONE' },
          { path: 'b.ts', find: 'three', replace: 'THREE' },
        ],
      });
      expect(rendered).toBe(1);
    });

    test('n resolves approved=false and calls abortTurn(), same as the non-hunk deny path', () => {
      const { conversation } = makeConversation();
      const { router } = makeRouter();
      const { pendingPermission, resolveCalls } = makeHunkPending();
      let aborted = 0;

      const result = handleBlockingShellInput({
        data: 'n',
        pendingPermission,
        abortTurn: () => { aborted++; },
        render: () => {},
      });

      expect(result.pendingPermission).toBeNull();
      expect(resolveCalls).toEqual([[false, false, undefined]]);
      expect(aborted).toBe(1);
    });

    test('esc resolves approved=false and calls abortTurn(), same as the non-hunk deny path', () => {
      const { conversation } = makeConversation();
      const { router } = makeRouter();
      const { pendingPermission, resolveCalls } = makeHunkPending();
      let aborted = 0;

      const result = handleBlockingShellInput({
        data: '\x1b',
        pendingPermission,
        abortTurn: () => { aborted++; },
        render: () => {},
      });

      expect(result.pendingPermission).toBeNull();
      expect(resolveCalls).toEqual([[false, false, undefined]]);
      expect(aborted).toBe(1);
    });

    test('a re-selects all hunks in hunk mode instead of the outer "allow always (session)" behavior', () => {
      const { conversation } = makeConversation();
      const { router } = makeRouter();
      const { pendingPermission, resolveCalls } = makeHunkPending({ selected: [1] });

      const result = handleBlockingShellInput({
        data: 'a',
        pendingPermission,
        abortTurn: () => {},
        render: () => {},
      });

      // Must NOT resolve (that would be the outer "remember" path), hunk mode
      // fully preempts the outer switch (Risk 1).
      expect(resolveCalls).toHaveLength(0);
      const hunkState = (result.pendingPermission as unknown as { hunkState: { selected: Set<number> } }).hunkState;
      expect(hunkState.selected.size).toBe(3);
    });
  });

  describe('approval-input debounce (Item 3a)', () => {
    function run(data: string, openedAt: number | undefined, now: number) {
      const resolved: Array<[boolean, boolean | undefined]> = [];
      let aborted = 0;
      const pendingPermission = {
        callId: 'perm-debounce',
        tool: 'write',
        openedAt,
        resolve: (approved: boolean, remember?: boolean) => { resolved.push([approved, remember]); },
      } as unknown as PendingPermissionState;
      const result = handleBlockingShellInput({
        data,
        pendingPermission,
        abortTurn: () => { aborted++; },
        render: () => {},
        now,
      });
      return { result, resolved, aborted };
    }

    test('a keystroke within 350ms of the prompt appearing is swallowed, not treated as approval', () => {
      const { result, resolved } = run('y', 1_000, 1_200); // 200ms later
      expect(result.handled).toBe(true);
      expect(result.pendingPermission).not.toBeNull(); // prompt stays open
      expect(resolved).toHaveLength(0); // never answered
    });

    test('a deny keystroke within the window is also swallowed (no accidental abort)', () => {
      const { result, resolved, aborted } = run('n', 1_000, 1_100);
      expect(result.pendingPermission).not.toBeNull();
      expect(resolved).toHaveLength(0);
      expect(aborted).toBe(0);
    });

    test('a keystroke after the window resolves normally', () => {
      const { resolved } = run('y', 1_000, 1_400); // 400ms later
      expect(resolved).toEqual([[true, false]]);
    });

    test('a prompt without openedAt is never debounced (back-compat)', () => {
      const { resolved } = run('y', undefined, 999_999);
      expect(resolved).toEqual([[true, false]]);
    });
  });
});
