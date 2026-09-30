// ---------------------------------------------------------------------------
// review-hunk-revert.test.ts, the Changes modal's revert action (x): reverse-
// apply exactly one hunk via checkpoints.revertHunkPreview → a confirm dialog →
// checkpoints.revertHunk (with the token), rendering a [Revert] receipt.
//
// The revert flow (revertReviewHunk) against a stubbed gateway: it asks
// through ctx.confirm, confirming invokes revertHunk with the token, and the
// receipt lands in the transcript; a stale hunk never asks; a 409 writes
// nothing partial.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { revertReviewHunk } from '../../input/commands/review-runtime.ts';
import { parseReviewDiff, flattenHunks } from '../../views/diff-review-model.ts';

const SAMPLE_DIFF = [
  'diff --git a/sample.txt b/sample.txt',
  '--- a/sample.txt',
  '+++ b/sample.txt',
  '@@ -1,2 +1,3 @@',
  ' line1',
  '+ADDED',
  ' line2',
  '',
].join('\n');

// ---- The revert flow against a stubbed gateway ---------------------------

interface GatewayStubOptions {
  previewApplies?: boolean;
  applyThrows?: unknown;
}

function makeCtx(gateway: { invoke: (id: string, inv: { body?: unknown }) => Promise<unknown> }, confirmAnswer: boolean) {
  const systemMessages: string[] = [];
  const confirms: Array<{ title: string; body: string }> = [];
  const ctx = {
    print: () => {},
    renderRequest: () => {},
    confirm: async (opts: { title: string; body: string }) => { confirms.push(opts); return confirmAnswer; },
    session: { conversationManager: { addTypedSystemMessage: (t: string) => { systemMessages.push(t); } }, runtime: { sessionId: 's-review-revert' } },
    workspace: { gatewayMethods: gateway, workspaceCheckpointManager: {} },
    provider: {}, platform: {}, ops: {}, extensions: {},
  } as unknown as CommandContext;
  return { ctx, systemMessages, confirms };
}

function stubGateway(opts: GatewayStubOptions) {
  const calls: { id: string; body: unknown }[] = [];
  return {
    calls,
    invoke: async (id: string, inv: { body?: unknown }) => {
      calls.push({ id, body: inv.body });
      if (id === 'checkpoints.revertHunkPreview') {
        return opts.previewApplies === false
          ? { applies: false, conflict: 'file changed since captured', addedLinesRemoved: 0, removedLinesRestored: 0, token: null }
          : { applies: true, conflict: null, addedLinesRemoved: 1, removedLinesRestored: 0, token: 'tok-1' };
      }
      if (id === 'checkpoints.revertHunk') {
        if (opts.applyThrows) throw opts.applyThrows;
        return { receipt: { path: 'sample.txt', hunkHeader: '@@ -1,2 +1,3 @@', addedLinesRemoved: 1, removedLinesRestored: 0, safetyCheckpointId: 'cp-safety' }, refused: false, refusal: null };
      }
      throw new Error(`unexpected verb ${id}`);
    },
  };
}

function sampleHunk() {
  return flattenHunks(parseReviewDiff(SAMPLE_DIFF))[0]!;
}

describe('the Changes revert action drives checkpoints.revertHunk with the token', () => {
  test('preview → confirm → revertHunk(token) → [Revert] receipt in the transcript', async () => {
    const gateway = stubGateway({ previewApplies: true });
    const { ctx, systemMessages, confirms } = makeCtx(gateway, true);

    const message = await revertReviewHunk(ctx, sampleHunk());

    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.title).toBe('Revert this hunk?');
    const applyCall = gateway.calls.find((c) => c.id === 'checkpoints.revertHunk');
    expect(applyCall).toBeTruthy();
    expect((applyCall!.body as { confirmToken: string }).confirmToken).toBe('tok-1');
    expect(systemMessages[0]!.startsWith('[Revert] Receipt')).toBe(true);
    expect(systemMessages[0]!).toContain('sample.txt');
    expect(message).toContain('Reverted the hunk');
  });

  test('a preview that does not apply reports "changed since captured" and never asks', async () => {
    const gateway = stubGateway({ previewApplies: false });
    const { ctx, systemMessages, confirms } = makeCtx(gateway, true);

    const message = await revertReviewHunk(ctx, sampleHunk());

    expect(confirms).toEqual([]);
    expect(gateway.calls.some((c) => c.id === 'checkpoints.revertHunk')).toBe(false);
    expect(systemMessages.length).toBe(0);
    expect(message).toContain('Cannot revert');
  });

  test('answering no to the confirm changes nothing', async () => {
    const gateway = stubGateway({ previewApplies: true });
    const { ctx, systemMessages } = makeCtx(gateway, false);

    const message = await revertReviewHunk(ctx, sampleHunk());

    expect(gateway.calls.some((c) => c.id === 'checkpoints.revertHunk')).toBe(false);
    expect(systemMessages.length).toBe(0);
    expect(message).toContain('cancelled');
  });

  test('a 409 on apply reports the conflict and writes nothing partial', async () => {
    const gateway = stubGateway({ previewApplies: true, applyThrows: Object.assign(new Error('hunk drifted'), { status: 409, code: 'CONFLICT' }) });
    const { ctx, systemMessages } = makeCtx(gateway, true);

    const message = await revertReviewHunk(ctx, sampleHunk());

    expect(gateway.calls.some((c) => c.id === 'checkpoints.revertHunk')).toBe(true);
    expect(systemMessages.length).toBe(0);
    expect(message).toContain('Not reverted');
  });
});
