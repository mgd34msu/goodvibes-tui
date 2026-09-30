import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { ReviewHunk } from '../../views/diff-review-model.ts';
import { hunkPatchText, buildHunkRevertReceiptBlock } from '../../views/diff-review-model.ts';

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
 * Revert one hunk in the working tree: checkpoints.revertHunkPreview (a
 * read-only clean check that returns a token), a confirm dialog naming exactly
 * what reverts, then checkpoints.revertHunk with that token. A hunk that no
 * longer applies is an honest "changed since captured", never a partial write;
 * a success adds the [Revert] receipt to the transcript. Resolves to the line
 * the Changes modal shows.
 */
export async function revertReviewHunk(ctx: CommandContext, hunk: ReviewHunk): Promise<string> {
  const gateway = ctx.workspace.gatewayMethods;
  if (!gateway || !ctx.workspace.workspaceCheckpointManager) {
    return 'Hunk revert unavailable: the checkpoint/gateway surface is not wired in this session.';
  }
  const path = hunk.filePath;
  const hunkText = hunkPatchText(hunk);
  const sessionId = ctx.session.runtime.sessionId;

  let preview: RevertHunkPreview;
  try {
    preview = (await gateway.invoke('checkpoints.revertHunkPreview', { ...INVOKE_CONTEXT, body: { path, hunk: hunkText } })) as RevertHunkPreview;
  } catch (err) {
    return `Could not check this hunk: ${errorText(err)}`;
  }
  if (!preview.applies || !preview.token) {
    return `Cannot revert: ${preview.conflict ?? 'this hunk no longer applies'}. The file changed since this diff was captured; the view has been reloaded. Nothing was changed.`;
  }

  const summary = `Restores ${preview.removedLinesRestored} deleted and drops ${preview.addedLinesRemoved} added line(s) in ${path} (${hunk.header}).`;
  const confirmed = ctx.confirm
    ? await ctx.confirm({ title: 'Revert this hunk?', body: `${summary}\nThe receipt in the transcript says how to undo it.`, confirmLabel: 'Revert', tone: 'danger' })
    : false;
  if (!confirmed) return 'Revert cancelled: nothing changed.';

  let result: RevertHunkResult;
  try {
    result = (await gateway.invoke('checkpoints.revertHunk', { ...INVOKE_CONTEXT, body: { path, hunk: hunkText, confirmToken: preview.token, sessionId } })) as RevertHunkResult;
  } catch (err) {
    return isConflict(err)
      ? `Not reverted: ${errorText(err)}. The file changed since captured; nothing was written.`
      : `Revert failed: ${errorText(err)}`;
  }
  const receipt = result.receipt;
  if (!receipt) return `Revert not applied: ${result.refusal?.reason ?? 'confirmation was refused.'}`;
  ctx.session.conversationManager.addTypedSystemMessage(buildHunkRevertReceiptBlock(receipt), 'operational');
  return `Reverted the hunk in ${receipt.path}; the receipt is in the transcript.`;
}

/**
 * `/review`, the comment-on-hunk review loop, in the Changes modal: this
 * session's file changes (the files the SDK SessionChangeTracker recorded) as a
 * working-tree diff, hunk by hunk. c attaches a comment to a hunk and Enter
 * sends the attached comments to the model as one steering message with each
 * hunk's file, line range and patch excerpt; x reverts a hunk (asks first).
 */
export function registerReviewRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'review',
    aliases: [],
    description: 'Review this session\'s diff hunk-by-hunk, steer comments, or revert a hunk',
    handler(_args, ctx) {
      if (!ctx.openChanges) {
        ctx.print('The Changes view is not available in this session.');
        return;
      }
      ctx.openChanges({ source: 'session' });
    },
  });
}
