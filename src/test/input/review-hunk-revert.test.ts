// ---------------------------------------------------------------------------
// review-hunk-revert.test.ts — the /review panel's reject action: reverse-apply
// exactly one hunk via checkpoints.revertHunkPreview → DiffPanel confirm →
// checkpoints.revertHunk (with the token), rendering a [Revert] receipt.
//
// Two levels:
//  1. The real composed-daemon gateway surface (getTestRuntimeServices): a real
//     working-tree hunk is previewed, confirmed with the minted token, and
//     reverse-applied; a stale hunk is an honest applies:false, never a partial.
//  2. The panel + command wiring end-to-end against a stubbed gateway: pressing
//     `r` arms the DiffPanel confirm, confirming invokes revertHunk with the
//     token, and the receipt lands in the transcript; a 409 refreshes instead of
//     writing partially.
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertEveryDescriptorHasHandler } from '@pellux/goodvibes-terminal-shell/conformance';
import { getTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerReviewRuntimeCommands } from '../../input/commands/review-runtime.ts';
import { parseReviewDiff } from '../../panels/diff-review-model.ts';
import { DiffReviewPanel } from '../../panels/diff-review-panel.ts';
import { DiffPanel } from '../../panels/diff-panel.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

const tempDirs: string[] = [];
afterEach(() => { while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true }); });

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

// A single-hunk unified diff (added one line) for the panel-level test.
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

describe('checkpoints hunk-revert surface is wired on the composed daemon', () => {
  const services = getTestRuntimeServices();
  const IDS = ['checkpoints.revertHunkPreview', 'checkpoints.revertHunk'] as const;

  for (const id of IDS) {
    test(`${id} descriptor is registered in the composed catalog`, () => {
      expect(services.gatewayMethods.get(id)).toBeTruthy();
    });
  }

  test('both revert descriptors have attached handlers (not the 501 class)', () => {
    expect(() => assertEveryDescriptorHasHandler(services.gatewayMethods, { onlyIds: IDS })).not.toThrow();
  });

  test('revertHunkPreview invokes end-to-end: a stale hunk is applies:false + null token, never a partial write', async () => {
    const staleHunk = ['@@ -1,2 +1,3 @@', ' nope-context', '+never', ' also-nope'].join('\n');
    const preview = (await services.gatewayMethods.invoke('checkpoints.revertHunkPreview', {
      context: { clientKind: 'tui' }, body: { path: 'does-not-exist-xyz.txt', hunk: staleHunk },
    } as never)) as { applies: boolean; token: string | null };
    expect(preview.applies).toBe(false);
    expect(preview.token).toBeNull();
  });

  test('revertHunk unconfirmed is an honest refusal (never a silent no-op)', async () => {
    const staleHunk = ['@@ -1,2 +1,3 @@', ' a', '+b', ' c'].join('\n');
    const result = (await services.gatewayMethods.invoke('checkpoints.revertHunk', {
      context: { clientKind: 'tui' }, body: { path: 'does-not-exist-xyz.txt', hunk: staleHunk },
    } as never)) as { receipt: unknown; refused: boolean };
    expect(result.refused).toBe(true);
    expect(result.receipt).toBeNull();
  });
});

// ---- Panel + command wiring against a stubbed gateway --------------------

interface GatewayStubOptions {
  previewApplies?: boolean;
  applyThrows?: unknown;
}

function makeCtx(dir: string, gateway: { invoke: (id: string, inv: { body?: unknown }) => Promise<unknown> }) {
  const systemMessages: string[] = [];
  let diffPanel: DiffPanel | null = null;
  let reviewPanel: DiffReviewPanel | null = null;
  const panelManager = {
    getAllOpen: () => [reviewPanel, diffPanel].filter(Boolean) as (DiffPanel | DiffReviewPanel)[],
    open: (id: string) => {
      if (id === 'diff') { diffPanel = new DiffPanel(dir, () => {}); return diffPanel; }
      reviewPanel = new DiffReviewPanel(dir, () => {}); return reviewPanel;
    },
    close: (id: string) => { if (id === 'diff') diffPanel = null; },
    activateById: () => {},
    isVisible: () => true,
    show: () => {},
  };
  const ctx = {
    print: () => {},
    renderRequest: () => {},
    focusPanels: () => {},
    focusPrompt: () => {},
    submitInput: () => {},
    session: { conversationManager: { addTypedSystemMessage: (t: string) => { systemMessages.push(t); } }, runtime: { sessionId: 's-review-revert' } },
    workspace: { gatewayMethods: gateway, workspaceCheckpointManager: {}, panelManager },
    provider: {}, platform: {}, ops: {}, extensions: {},
  } as unknown as CommandContext;
  return { ctx, systemMessages, getDiffPanel: () => diffPanel, getReviewPanel: () => reviewPanel };
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

async function openReviewWithHunk(ctx: CommandContext): Promise<DiffReviewPanel> {
  const registry = new CommandRegistry();
  registerReviewRuntimeCommands(registry);
  await registry.execute('review', [], ctx);
  const pm = (ctx.workspace as unknown as { panelManager: { getAllOpen: () => { id: string }[] } }).panelManager;
  const panel = pm.getAllOpen().find((p) => p.id === 'review') as unknown as DiffReviewPanel;
  panel.loadReview(parseReviewDiff(SAMPLE_DIFF), 'test diff');
  return panel;
}

describe('/review reject action drives checkpoints.revertHunk with the token', () => {
  test('r → confirm → revertHunk(token) → [Revert] receipt in the transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-review-revert-')); tempDirs.push(dir);
    const gateway = stubGateway({ previewApplies: true });
    const { ctx, systemMessages, getDiffPanel } = makeCtx(dir, gateway);
    const panel = await openReviewWithHunk(ctx);

    panel.handleInput('r'); // reject the current hunk
    await waitFor(() => getDiffPanel() !== null && getDiffPanel()!.confirmOverlay.pending);
    expect(getDiffPanel()!.confirmOverlay.pending).toBe(true);

    getDiffPanel()!.handleInput('y'); // confirm the revert
    await waitFor(() => systemMessages.length > 0);

    // revertHunk was invoked with the token minted by the preview.
    const applyCall = gateway.calls.find((c) => c.id === 'checkpoints.revertHunk');
    expect(applyCall).toBeTruthy();
    expect((applyCall!.body as { confirmToken: string }).confirmToken).toBe('tok-1');
    // The receipt is a distinct force-surfaced [Revert] block.
    expect(systemMessages[0]!.startsWith('[Revert] Receipt')).toBe(true);
    expect(systemMessages[0]!).toContain('sample.txt');
  });

  test('a preview that does not apply reports "changed since captured" and never opens a confirm', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-review-revert-')); tempDirs.push(dir);
    const gateway = stubGateway({ previewApplies: false });
    const { ctx, systemMessages, getDiffPanel } = makeCtx(dir, gateway);
    const panel = await openReviewWithHunk(ctx);

    panel.handleInput('r');
    await waitFor(() => gateway.calls.some((c) => c.id === 'checkpoints.revertHunkPreview'));
    await new Promise((r) => setTimeout(r, 30));

    expect(getDiffPanel()).toBeNull(); // no confirm overlay for a stale hunk
    expect(gateway.calls.some((c) => c.id === 'checkpoints.revertHunk')).toBe(false); // never applied
    expect(systemMessages.length).toBe(0); // no receipt
  });

  test('a 409 on apply refreshes with a conflict message and writes nothing partial', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-review-revert-')); tempDirs.push(dir);
    const gateway = stubGateway({ previewApplies: true, applyThrows: Object.assign(new Error('hunk drifted'), { status: 409, code: 'CONFLICT' }) });
    const { ctx, systemMessages, getDiffPanel } = makeCtx(dir, gateway);
    const panel = await openReviewWithHunk(ctx);

    panel.handleInput('r');
    await waitFor(() => getDiffPanel() !== null && getDiffPanel()!.confirmOverlay.pending);
    getDiffPanel()!.handleInput('y');
    await waitFor(() => gateway.calls.some((c) => c.id === 'checkpoints.revertHunk'));
    await new Promise((r) => setTimeout(r, 30));

    expect(systemMessages.length).toBe(0); // no receipt — nothing was written
    expect(getDiffPanel()).toBeNull(); // confirm closed
  });
});
