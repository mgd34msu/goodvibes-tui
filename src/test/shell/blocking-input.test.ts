import { describe, expect, test } from 'bun:test';

import { handleBlockingShellInput, type PendingPermissionState } from '../../shell/blocking-input.ts';

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
  return {
    messages,
    router: {
      high: (text: string) => messages.push(text),
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
    });

    expect(result.handled).toBe(true);
    expect(result.pendingPermission).toBeNull();
    expect(resolved).toEqual([[true, false]]);
    expect(aborted).toBe(0);
    expect(rendered).toBe(1);
  });

  test('denies pending permission on escape and aborts turn', () => {
    const resolved: Array<[boolean, boolean | undefined]> = [];
    const { conversation } = makeConversation();
    const { router } = makeRouter();
    let rendered = 0;
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
      render: () => { rendered++; },
      loadRecoveryConversation: () => null,
      deleteRecoveryFile: () => {},
    });

    expect(result.handled).toBe(true);
    expect(result.pendingPermission).toBeNull();
    expect(resolved).toEqual([[false, false]]);
    expect(aborted).toBe(1);
    expect(rendered).toBe(1);
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
    });

    expect(result.handled).toBe(true);
    expect(result.recoveryPending).toBe(false);
    expect(restored).toEqual([[{ role: 'user', content: 'restored' }]]);
    expect(messages).toContain('[Recovery] Session restored.');
    expect(deleted).toBe(1);
    expect(rendered).toBe(1);
  });

  test('stray key leaves recovery prompt active and file intact', () => {
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
    });

    // Stray key: prompt stays active, file is NOT deleted, key passes through.
    expect(result.handled).toBe(false);
    expect(result.recoveryPending).toBe(true);
    expect(restored).toEqual([]);
    expect(messages).toContain('[Recovery] Ctrl+R to restore · Esc to discard');
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
    });
    expect(deleted).toBe(0);
  });

  test('multiple stray keys each re-render hint without deleting file', () => {
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
    };

    for (const key of ['a', 'b', 'c', ' ', '\t']) {
      const r = handleBlockingShellInput({ ...base, data: key, recoveryPending: true });
      expect(r.recoveryPending).toBe(true);
    }

    expect(deleted).toBe(0);
    expect(rendered).toBe(5);
    // All stray hint messages present
    expect(messages.every((m) => m === '[Recovery] Ctrl+R to restore · Esc to discard')).toBe(true);
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
    });

    expect(result.handled).toBe(true);
    expect(result.recoveryPending).toBe(false);
    expect(restored).toEqual([]);
    expect(messages).toContain('[Recovery] Discarded recovery data.');
    expect(deleted).toBe(1);
    expect(rendered).toBe(1);
  });
});
