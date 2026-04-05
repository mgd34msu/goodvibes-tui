import { describe, expect, test } from 'bun:test';

import { handleBlockingShellInput, type PendingPermissionState } from '../../shell/blocking-input.ts';

function makeConversation() {
  const restored: Array<Record<string, unknown>>[] = [];
  return {
    restored,
    conversation: {
      fromJSON: ({ messages }: { messages: Array<Record<string, unknown>> }) => {
        restored.push(messages);
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

  test('restores recovery snapshot on r', () => {
    const { conversation, restored } = makeConversation();
    const { router, messages } = makeRouter();
    let deleted = 0;
    let rendered = 0;

    const result = handleBlockingShellInput({
      data: 'r',
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
});
