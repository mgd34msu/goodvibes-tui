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
      recoveryPending: false,
      abortTurn: () => { aborted++; },
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => { rendered++; },
      loadRecoveryConversation: () => null,
      deleteRecoveryFile: () => {},
      ...JOURNAL_STUBS,
    });

    expect(result.handled).toBe(true);
    expect(result.pendingPermission).toBeNull();
    expect(resolved).toEqual([[true, false]]);
    expect(aborted).toBe(0);
    expect(rendered).toBe(1);
  });

  test('escape drops focus only — passes through to input, keeps the card pending, never denies', () => {
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
      recoveryPending: false,
      abortTurn: () => { aborted++; },
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => {},
      loadRecoveryConversation: () => null,
      deleteRecoveryFile: () => {},
      ...JOURNAL_STUBS,
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
        recoveryPending: false,
        abortTurn: () => { throw new Error('scroll/mouse must never abort'); },
        conversation: conversation as never,
        systemMessageRouter: router as never,
        render: () => {},
        loadRecoveryConversation: () => null,
        deleteRecoveryFile: () => {},
        ...JOURNAL_STUBS,
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
      recoveryPending: false,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => {},
      loadRecoveryConversation: () => null,
      deleteRecoveryFile: () => {},
      ...JOURNAL_STUBS,
    });
    expect(approve.handled).toBe(true);
    expect(approve.pendingPermission).toBeNull();
    expect(resolved).toEqual([[true, false]]);
  });

  test('restores recovery snapshot on ctrl-r', () => {
    const { conversation, restored } = makeConversation();
    const { router, messages } = makeRouter();
    let deleted = 0;
    let rendered = 0;

    const result = handleBlockingShellInput({
      data: '\x12',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => { rendered++; },
      loadRecoveryConversation: () => ({
        messages: [{ role: 'user', content: 'restored' }],
      }),
      deleteRecoveryFile: () => { deleted++; },
      ...JOURNAL_STUBS,
    });

    expect(result.handled).toBe(true);
    expect(result.recoveryPending).toBe(false);
    expect(restored).toEqual([[{ role: 'user', content: 'restored' }]]);
    expect(messages).toContain('[Recovery] Session restored.');
    expect(deleted).toBe(1);
    expect(rendered).toBe(1);
  });

  // A stray (non Ctrl+R / non Esc) key now DISMISSES the recovery
  // banner instead of re-asserting it forever — see blocking-input.ts's
  // stray-key branch doc comment. Dismiss must not touch the recovery file.
  test('stray key dismisses the recovery banner (once), forwards the keystroke, and leaves the file intact', () => {
    const { conversation, restored } = makeConversation();
    const { router, messages } = makeRouter();
    let deleted = 0;
    let rendered = 0;

    const result = handleBlockingShellInput({
      data: 'h',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => { rendered++; },
      loadRecoveryConversation: () => ({
        messages: [{ role: 'user', content: 'restored' }],
      }),
      deleteRecoveryFile: () => { deleted++; },
      ...JOURNAL_STUBS,
    });

    // Stray key: banner dismisses (recoveryPending clears), key passes
    // through to normal input (handled: false), file is NOT deleted.
    expect(result.handled).toBe(false);
    expect(result.recoveryPending).toBe(false);
    expect(restored).toEqual([]);
    expect(messages).toContain('[Recovery] Dismissed — the unsaved session is still on disk; you will be asked again next time GoodVibes starts here.');
    expect(deleted).toBe(0);
    expect(rendered).toBe(1);
  });

  test('ctrl-r restore hydrates title and titleSource from snapshot', () => {
    const { conversation, calls } = makeConversation();
    const { router } = makeRouter();
    let deleted = 0;

    handleBlockingShellInput({
      data: '\x12',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => {},
      loadRecoveryConversation: () => ({
        messages: [{ role: 'user', content: 'hi' }],
        title: 'My Saved Session',
        titleSource: 'user',
      }),
      deleteRecoveryFile: () => { deleted++; },
      ...JOURNAL_STUBS,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.title).toBe('My Saved Session');
    expect(calls[0]!.titleSource).toBe('user');
    expect(deleted).toBe(1);
  });

  test('ctrl-r restore invokes reopenPanels callback with snapshot', () => {
    const { conversation } = makeConversation();
    const { router } = makeRouter();
    const reopenedWith: Array<object> = [];

    const snapshot = {
      messages: [{ role: 'user', content: 'hi' }],
      title: 'panel-test',
      titleSource: 'system',
      returnContext: { openPanels: ['remote', 'approval'] },
    };

    handleBlockingShellInput({
      data: '\x12',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => {},
      loadRecoveryConversation: () => snapshot,
      deleteRecoveryFile: () => {},
      reopenPanels: (s) => { reopenedWith.push(s); },
      ...JOURNAL_STUBS,
    });

    expect(reopenedWith).toHaveLength(1);
    expect(reopenedWith[0]).toBe(snapshot);
  });

  test('ctrl-r deletes recovery file only after successful restore', () => {
    const { conversation } = makeConversation();
    const { router } = makeRouter();
    let deleted = 0;

    // Successful restore — file must be deleted
    handleBlockingShellInput({
      data: '\x12',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => {},
      loadRecoveryConversation: () => ({ messages: [{ role: 'user', content: 'x' }] }),
      deleteRecoveryFile: () => { deleted++; },
      ...JOURNAL_STUBS,
    });
    expect(deleted).toBe(1);

    // Failed load (returns null) — file must NOT be deleted
    deleted = 0;
    handleBlockingShellInput({
      data: '\x12',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => {},
      loadRecoveryConversation: () => null,
      deleteRecoveryFile: () => { deleted++; },
      ...JOURNAL_STUBS,
    });
    expect(deleted).toBe(0);
  });

  test('only the FIRST stray key dismisses the banner; later keys are silent (no repeated [Recovery] lines), file stays intact', () => {
    const { conversation } = makeConversation();
    const { router, messages } = makeRouter();
    let deleted = 0;
    let rendered = 0;

    const recoverySnapshot = { messages: [{ role: 'user', content: 'hi' }] };
    const base = {
      pendingPermission: null as null,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => { rendered++; },
      loadRecoveryConversation: () => recoverySnapshot,
      deleteRecoveryFile: () => { deleted++; },
      ...JOURNAL_STUBS,
    };

    // Chain recoveryPending through the sequence like a real caller would
    // (main.ts assigns `recoveryPending = blocking.recoveryPending` after
    // every call) — this is the exact regression the brief called out:
    // typing to ignore the banner must not inject a fresh [Recovery] line
    // around every subsequent character.
    let recoveryPending = true;
    for (const key of ['a', 'b', 'c', ' ', '\t']) {
      const r = handleBlockingShellInput({ ...base, data: key, recoveryPending });
      recoveryPending = r.recoveryPending;
    }

    expect(recoveryPending).toBe(false);
    expect(deleted).toBe(0); // dismiss is not discard — the file is never touched
    // Only the FIRST key (still recoveryPending=true) takes the dismiss
    // branch and renders; once dismissed, this handler is a pure pass-through
    // for the rest (handled:false, no render, no message) — the caller's own
    // normal input path renders on its own, same as any other keystroke.
    expect(rendered).toBe(1);
    // Exactly ONE dismiss message across all five keystrokes, not one per key.
    expect(messages).toEqual(['[Recovery] Dismissed — the unsaved session is still on disk; you will be asked again next time GoodVibes starts here.']);
  });

  // ---------------------------------------------------------------------------
  // W3 Finding 3: preserve-on-dismiss. main.ts's 60s autosave overwrites the
  // shared recovery.jsonl with the CURRENT session's state within a minute,
  // so the dismiss message's promise used to go false silently. Dismiss now
  // calls preserveRecoveryFile() (when wired) so the promise stays true.
  // ---------------------------------------------------------------------------
  describe('preserve-on-dismiss (W3 Finding 3)', () => {
    test('dismiss calls preserveRecoveryFile exactly once', () => {
      const { conversation } = makeConversation();
      const { router } = makeRouter();
      let calls = 0;

      handleBlockingShellInput({
        data: 'x',
        pendingPermission: null,
        recoveryPending: true,
        abortTurn: () => {},
        conversation: conversation as never,
        systemMessageRouter: router as never,
        render: () => {},
        loadRecoveryConversation: () => null,
        deleteRecoveryFile: () => {},
        preserveRecoveryFile: () => { calls += 1; return { preserved: true, replacedPrevious: false }; },
        ...JOURNAL_STUBS,
      });

      expect(calls).toBe(1);
    });

    test('dismiss without a replaced previous snapshot: no extra low-priority note', () => {
      const { conversation } = makeConversation();
      const { router, lowMessages } = makeRouter();

      handleBlockingShellInput({
        data: 'x',
        pendingPermission: null,
        recoveryPending: true,
        abortTurn: () => {},
        conversation: conversation as never,
        systemMessageRouter: router as never,
        render: () => {},
        loadRecoveryConversation: () => null,
        deleteRecoveryFile: () => {},
        preserveRecoveryFile: () => ({ preserved: true, replacedPrevious: false }),
        ...JOURNAL_STUBS,
      });

      expect(lowMessages).toEqual([]);
    });

    test('dismiss that replaces an earlier preserved snapshot: reports it honestly, does not touch the main dismiss line', () => {
      const { conversation } = makeConversation();
      const { router, messages, lowMessages } = makeRouter();

      const result = handleBlockingShellInput({
        data: 'x',
        pendingPermission: null,
        recoveryPending: true,
        abortTurn: () => {},
        conversation: conversation as never,
        systemMessageRouter: router as never,
        render: () => {},
        loadRecoveryConversation: () => null,
        deleteRecoveryFile: () => {},
        preserveRecoveryFile: () => ({ preserved: true, replacedPrevious: true }),
        ...JOURNAL_STUBS,
      });

      expect(result.recoveryPending).toBe(false);
      expect(lowMessages).toEqual(['[Recovery] Replacing the previously preserved (unrestored) snapshot with this one.']);
      expect(messages).toEqual(['[Recovery] Dismissed — the unsaved session is still on disk; you will be asked again next time GoodVibes starts here.']);
    });

    test('preserveRecoveryFile omitted (caller does not wire it): dismiss behaves exactly as before, no crash', () => {
      const { conversation } = makeConversation();
      const { router, messages } = makeRouter();

      const result = handleBlockingShellInput({
        data: 'x',
        pendingPermission: null,
        recoveryPending: true,
        abortTurn: () => {},
        conversation: conversation as never,
        systemMessageRouter: router as never,
        render: () => {},
        loadRecoveryConversation: () => null,
        deleteRecoveryFile: () => {},
        ...JOURNAL_STUBS,
      });

      expect(result.recoveryPending).toBe(false);
      expect(messages).toEqual(['[Recovery] Dismissed — the unsaved session is still on disk; you will be asked again next time GoodVibes starts here.']);
    });
  });

  /**
   * Production-wiring test: verifies the reopenPanels callback shape that main.ts
   * wires into handleBlockingShellInput. main.ts itself is not testable directly
   * (requires TTY/stdin/process), so this test replicates the exact callback
   * body from src/main.ts:~804 using a mock panelManager to confirm the
   * contract: panel ids from snapshot.returnContext.openPanels are opened,
   * panelManager.show() is called, and render() fires.
   */
  test('production-wiring: main.ts reopenPanels callback opens snapshot panels and calls show+render', () => {
    const { conversation } = makeConversation();
    const { router } = makeRouter();

    // Mock panelManager mirroring the API used in main.ts's reopenPanels wiring.
    const opened: string[] = [];
    let showed = 0;
    let rendered = 0;
    const panelManager = {
      open: (id: string) => { opened.push(id); },
      show: () => { showed++; },
    };

    const snapshot = {
      messages: [{ role: 'user', content: 'hi' }],
      title: 'wiring-test',
      titleSource: 'system' as const,
      returnContext: { openPanels: ['context', 'approval'] },
    };

    // This is the exact callback body from main.ts wired into handleBlockingShellInput.
    const mainTsReopenPanels = (s: typeof snapshot) => {
      const panels = s.returnContext?.openPanels;
      if (!panels || panels.length === 0) return;
      for (const panelId of panels.slice(0, 4)) {
        try { panelManager.open(panelId); } catch { /* unknown panel id — skip */ }
      }
      panelManager.show();
      ((): void => { rendered++; })(); // render() in main.ts
    };

    handleBlockingShellInput({
      data: '\x12',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => {},
      loadRecoveryConversation: () => snapshot,
      deleteRecoveryFile: () => {},
      reopenPanels: mainTsReopenPanels,
      ...JOURNAL_STUBS,
    });

    expect(opened).toEqual(['context', 'approval']);
    expect(showed).toBe(1);
    expect(rendered).toBe(1);
  });

  test('discards recovery on escape without passing escape to input', () => {
    const { conversation, restored } = makeConversation();
    const { router, messages } = makeRouter();
    let deleted = 0;
    let rendered = 0;

    const result = handleBlockingShellInput({
      data: '\x1b',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation: conversation as never,
      systemMessageRouter: router as never,
      render: () => { rendered++; },
      loadRecoveryConversation: () => ({
        messages: [{ role: 'user', content: 'restored' }],
      }),
      deleteRecoveryFile: () => { deleted++; },
      ...JOURNAL_STUBS,
    });

    expect(result.handled).toBe(true);
    expect(result.recoveryPending).toBe(false);
    expect(restored).toEqual([]);
    expect(messages).toContain('[Recovery] Discarded recovery data.');
    expect(deleted).toBe(1);
    expect(rendered).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Hunk-mode routing — pendingPermission.hunkState present.
  //
  // Every non-hunk-mode test above passes `pendingPermission` objects with no
  // `hunkState` property, so they exercise the exact same y/a/n switch as
  // before this change — the regression safety net this suite is pinning.
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
        recoveryPending: false,
        abortTurn: () => {},
        conversation: conversation as never,
        systemMessageRouter: router as never,
        render: () => { rendered++; },
        loadRecoveryConversation: () => null,
        deleteRecoveryFile: () => {},
        ...JOURNAL_STUBS,
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
        recoveryPending: false,
        abortTurn: () => {},
        conversation: conversation as never,
        systemMessageRouter: router as never,
        render: () => {},
        loadRecoveryConversation: () => null,
        deleteRecoveryFile: () => {},
        ...JOURNAL_STUBS,
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
        recoveryPending: false,
        abortTurn: () => {},
        conversation: conversation as never,
        systemMessageRouter: router as never,
        render: () => { rendered++; },
        loadRecoveryConversation: () => null,
        deleteRecoveryFile: () => {},
        ...JOURNAL_STUBS,
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
        recoveryPending: false,
        abortTurn: () => { aborted++; },
        conversation: conversation as never,
        systemMessageRouter: router as never,
        render: () => {},
        loadRecoveryConversation: () => null,
        deleteRecoveryFile: () => {},
        ...JOURNAL_STUBS,
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
        recoveryPending: false,
        abortTurn: () => { aborted++; },
        conversation: conversation as never,
        systemMessageRouter: router as never,
        render: () => {},
        loadRecoveryConversation: () => null,
        deleteRecoveryFile: () => {},
        ...JOURNAL_STUBS,
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
        recoveryPending: false,
        abortTurn: () => {},
        conversation: conversation as never,
        systemMessageRouter: router as never,
        render: () => {},
        loadRecoveryConversation: () => null,
        deleteRecoveryFile: () => {},
        ...JOURNAL_STUBS,
      });

      // Must NOT resolve (that would be the outer "remember" path) — hunk mode
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
        recoveryPending: false,
        abortTurn: () => { aborted++; },
        conversation: makeConversation().conversation as never,
        systemMessageRouter: makeRouter().router as never,
        render: () => {},
        loadRecoveryConversation: () => null,
        deleteRecoveryFile: () => {},
        now,
        ...JOURNAL_STUBS,
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
