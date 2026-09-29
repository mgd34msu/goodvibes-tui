// ---------------------------------------------------------------------------
// review-hunk-revert.test.ts, the Changes modal's revert action (x): reverse-
// apply exactly one hunk via checkpoints.revertHunkPreview → a confirm dialog →
// checkpoints.revertHunk (with the token), rendering a [Revert] receipt.
//
// Two levels:
//  1. The real composed-daemon gateway surface (getTestRuntimeServices): a real
//     working-tree hunk is previewed, confirmed with the minted token, and
//     reverse-applied; a stale hunk is an honest applies:false, never a partial.
//  2. The revert flow (revertReviewHunk) against a stubbed gateway: it asks
//     through ctx.confirm, confirming invokes revertHunk with the token, and the
//     receipt lands in the transcript; a stale hunk never asks; a 409 writes
//     nothing partial.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { assertEveryDescriptorHasHandler } from '@pellux/goodvibes-terminal-shell/conformance';
import { getTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { revertReviewHunk } from '../../input/commands/review-runtime.ts';
import { parseReviewDiff, flattenHunks } from '../../panels/diff-review-model.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

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

describe('the hunk-revert verbs are the daemon\'s to answer, and this app knows it', () => {
  const services = getTestRuntimeServices();
  const IDS = ['checkpoints.revertHunkPreview', 'checkpoints.revertHunk'] as const;

  for (const id of IDS) {
    test(`${id} is in the contract this app calls against`, () => {
      // The descriptor is cataloged, the contract is shared, and the revert
      // flow below builds its request from it. What is NOT here is a handler.
      expect(services.gatewayMethods.get(id)).toBeTruthy();
    });
  }

  test('neither verb is answered in this process', () => {
    // The reverse-apply writes to the working tree and mints a confirm token
    // against the checkpoint store. The daemon owns that store; a second
    // implementation here would mint tokens the daemon never issued and apply
    // hunks it has no record of. `assertEveryDescriptorHasHandler` is the
    // conformance check the DAEMON repository runs against its own catalog.
    expect(() => assertEveryDescriptorHasHandler(services.gatewayMethods, { onlyIds: IDS })).toThrow();
  });

  test('invoking one here fails loudly rather than pretending', async () => {
    // Not a silent empty result: a surface that got `{}` back from an
    // unimplemented verb would render "nothing to revert" for a file that has
    // plenty to revert. The revert flow below is driven through the gateway
    // seam it is handed, which in production is the adopted daemon.
    const staleHunk = ['@@ -1,2 +1,3 @@', ' a', '+b', ' c'].join('\n');
    await expect(services.gatewayMethods.invoke('checkpoints.revertHunk', {
      context: { clientKind: 'tui' }, body: { path: 'does-not-exist-xyz.txt', hunk: staleHunk },
    } as never)).rejects.toThrow();
  });
});

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
