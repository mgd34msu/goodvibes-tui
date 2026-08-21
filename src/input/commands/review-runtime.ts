import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { DiffReviewPanel } from '../../panels/diff-review-panel.ts';
import type { ReviewHunk } from '../../panels/diff-review-model.ts';
import { hunkPatchText, buildHunkRevertReceiptBlock } from '../../panels/diff-review-model.ts';
import { requirePanelManager } from './runtime-services.ts';

/** checkpoints.revertHunkPreview result, the read-only clean-or-conflict check plus a confirm token. */
interface RevertHunkPreview {
  readonly applies: boolean;
  readonly conflict: string | null;
  readonly addedLinesRemoved: number;
  readonly removedLinesRestored: number;
  readonly token: string | null;
}

/** checkpoints.revertHunk result, one applied hunk revert, or a confirmation refusal. */
interface RevertHunkResult {
  readonly receipt: {
    readonly path: string;
    readonly hunkHeader: string;
    readonly addedLinesRemoved: number;
    readonly removedLinesRestored: number;
    readonly safetyCheckpointId: string | null;
  } | null;
  readonly refused: boolean;
  readonly refusal: { readonly reason: string } | null;
}

/**
 * The review UI's invoke context.
 *
 * `explicitUserRequest: true` is honest here and only here-shaped: this path
 * runs because a person is looking at a hunk and pressed a key. Scheduled
 * work, triggers and channel-driven work must never set it, the distinction
 * is exactly "did the owner ask for this right now", and it is what lets a
 * confirmation-gated verb tell an authorized action apart from one initiated
 * by content.
 */
const INVOKE_CONTEXT = {
  context: { clientKind: 'tui' as const, metadata: { explicitUserRequest: true } },
};

/** True for the honest 409 the revert verb throws when the hunk drifted since it was captured. */
function isConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 409;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reject one hunk: checkpoints.revertHunkPreview (read-only clean check + token)
 * → DiffPanel confirm of exactly what reverts → checkpoints.revertHunk with that
 * token. A stale hunk is an honest "changed since captured" with a refresh, never
 * a partial write; a success renders the HUNK_REVERTED receipt into the transcript
 * and refreshes the review panel so the reverted hunk disappears from the diff.
 */
async function revertHunkFlow(ctx: CommandContext, panel: DiffReviewPanel, hunk: ReviewHunk): Promise<void> {
  const gateway = ctx.workspace.gatewayMethods;
  if (!gateway || !ctx.workspace.workspaceCheckpointManager) {
    panel.note('Hunk revert unavailable: the checkpoint/gateway surface is not wired in this session.');
    return;
  }
  const path = hunk.filePath;
  const hunkText = hunkPatchText(hunk);
  const sessionId = ctx.session.runtime.sessionId;

  let preview: RevertHunkPreview;
  try {
    preview = (await gateway.invoke('checkpoints.revertHunkPreview', { ...INVOKE_CONTEXT, body: { path, hunk: hunkText } })) as RevertHunkPreview;
  } catch (err) {
    panel.note(`Could not check this hunk: ${errorText(err)}`);
    return;
  }

  if (!preview.applies || !preview.token) {
    panel.note(`Cannot revert: ${preview.conflict ?? 'this hunk no longer applies'}. The file changed since this diff was captured; press r again after /review reloads. Nothing was changed.`);
    await panel.refresh();
    return;
  }

  const { DiffPanel } = await import('../../panels/diff-panel.ts');
  const pm = requirePanelManager(ctx);
  let diff = pm.getAllOpen().find((p) => p.id === 'diff');
  if (!diff) {
    try { diff = pm.open('diff'); } catch { panel.note('Could not open the diff panel to confirm the revert.'); return; }
  }
  pm.activateById('diff');
  if (!pm.isVisible()) pm.show();
  ctx.focusPanels?.();
  const diffPanel = diff as InstanceType<typeof DiffPanel>;
  diffPanel.showDiff(path, hunkText);

  const summary = `restore ${preview.removedLinesRestored} deleted / drop ${preview.addedLinesRemoved} added line(s)`;
  diffPanel.confirmOverlay.arm({
    id: `${path}:${hunk.header}`,
    label: `Revert hunk in ${path}: ${summary}`,
    verb: 'Revert',
    onConfirm: async () => {
      let result: RevertHunkResult;
      try {
        result = (await gateway.invoke('checkpoints.revertHunk', { ...INVOKE_CONTEXT, body: { path, hunk: hunkText, confirmToken: preview.token, sessionId } })) as RevertHunkResult;
      } catch (err) {
        pm.close('diff');
        ctx.focusPanels?.();
        if (isConflict(err)) {
          panel.note(`Not reverted: ${errorText(err)}. The file changed since captured; nothing was written. Reloading /review…`);
          await panel.refresh();
        } else {
          panel.note(`Revert failed: ${errorText(err)}`);
        }
        return;
      }
      pm.close('diff');
      ctx.focusPanels?.();
      const receipt = result.receipt;
      if (!receipt) {
        panel.note(`Revert not applied: ${result.refusal?.reason ?? 'confirmation was refused.'}`);
        return;
      }
      ctx.session.conversationManager.addTypedSystemMessage(buildHunkRevertReceiptBlock(receipt), 'operational');
      await panel.refresh();
    },
    onCancel: () => {
      pm.close('diff');
      ctx.focusPanels?.();
      panel.note('Revert cancelled: nothing changed.');
    },
  });
  ctx.renderRequest();
}

/**
 * `/review`, open the comment-on-hunk review loop. Loads this session's file
 * changes (the files the SDK SessionChangeTracker recorded) as a git working-
 * tree diff, hunk-boundaried, and wires the panel's steering submit path to the
 * session so an attached comment is sent to the model as a steering message with
 * structured context (file path, line range, patch excerpt). A hunk can also be
 * rejected: `r` reverse-applies exactly that one hunk via checkpoints.revertHunk
 * (preview + confirm), a working-tree change recorded as a [Revert] receipt.
 */
export function registerReviewRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'review',
    aliases: [],
    description: 'Review this session\'s diff hunk-by-hunk, steer comments, or revert a hunk',
    async handler(_args, ctx) {
      const pm = requirePanelManager(ctx);
      let panel = pm.getAllOpen().find((p) => p.id === 'review');
      if (!panel) {
        try {
          panel = pm.open('review');
        } catch {
          ctx.print('Could not open the review panel.');
          return;
        }
      }
      pm.activateById('review');
      if (!pm.isVisible()) pm.show();

      const reviewPanel = panel as DiffReviewPanel;
      if (ctx.submitInput) {
        reviewPanel.setSubmit((text) => ctx.submitInput!(text));
      }
      reviewPanel.setRevertHandler((hunk) => { void revertHunkFlow(ctx, reviewPanel, hunk); });
      await reviewPanel.loadSessionReview();
      ctx.focusPanels?.();
      ctx.renderRequest();
    },
  });
}
