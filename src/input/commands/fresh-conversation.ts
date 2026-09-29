/**
 * fresh-conversation.ts, what /clear does: start a fresh conversation in this
 * terminal session without losing the one on screen.
 *
 * /clear used to hide the transcript while keeping every message in the
 * model's context, so the header kept the old title and the status line kept
 * the old context usage, both true of a conversation the screen no longer
 * showed. Now the conversation on screen is first saved as its own session
 * (resumable by id, like /session fork, taking its view sidecar and rewind
 * anchors with it), then the live conversation is reset: no messages, no
 * title, the system prompt reloaded, no rewind anchors, and the usage counters
 * recomputed from the (empty) transcript, so the header and status line
 * describe the fresh conversation.
 */

import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionMeta } from '@pellux/goodvibes-sdk/platform/sessions';
import { clearTurnAnchors, getTurnAnchors, persistTurnAnchors, recordTurnAnchor } from '@pellux/goodvibes-sdk/platform/rewind';
import type { CommandContext } from '../command-registry.ts';
import { saveWorkTreeFolds } from '../../core/work-tree-fold-store.ts';

export interface FreshConversationResult {
  /** Session id the previous conversation was saved under, or null when there was nothing to keep. */
  readonly savedAs: string | null;
}

/** Whether a transcript holds a conversation worth keeping (anything the user or the model said). */
function hasConversation(ctx: CommandContext): boolean {
  return ctx.session.conversationManager.getMessageSnapshot().some((m) => m.role === 'user' || m.role === 'assistant');
}

/**
 * Save the conversation on screen as its own session, then reset the live one.
 * Throws (and changes nothing) when the save fails, so a conversation is never
 * dropped without a saved copy.
 */
export function startFreshConversation(ctx: CommandContext): FreshConversationResult {
  const conversation = ctx.session.conversationManager;
  const surface = ctx.workspace.surface;
  let savedAs: string | null = null;
  if (hasConversation(ctx) && ctx.session.sessionManager) {
    const id = `user-${randomBytes(4).toString('hex')}`;
    const exported = conversation.toJSON() as { messages?: unknown[] };
    const meta: SessionMeta = {
      title: conversation.title,
      model: ctx.session.runtime.model,
      provider: ctx.session.runtime.provider,
      timestamp: Date.now(),
      titleSource: conversation.getTitleSource(),
      // The user asked for this conversation to be set aside; it is not turn machinery.
      saveSource: 'user',
    };
    ctx.session.sessionManager.save(id, (exported.messages ?? []) as never[], meta);
    if (surface) {
      // The saved copy keeps its view (folds, failed/cancelled turn headers)
      // and its rewind anchors, which describe exactly that transcript.
      saveWorkTreeFolds(surface.sessionsDir, id, conversation.workTree.foldState(), conversation.workTree.turnOutcomes());
      for (const anchor of getTurnAnchors(ctx.session.runtime.sessionId)) recordTurnAnchor(id, anchor);
      persistTurnAnchors(id, surface);
    }
    savedAs = id;
  }

  const liveId = ctx.session.runtime.sessionId;
  conversation.resetAll();
  if (ctx.reloadSystemPrompt) ctx.session.runtime.systemPrompt = ctx.reloadSystemPrompt();
  // Rewind anchors and the view sidecar point into the old transcript.
  clearTurnAnchors(liveId);
  if (surface) {
    // persistTurnAnchors writes nothing for an empty list, so the old sidecar
    // (`<sessionId>.anchors.json`, the SDK's rewind/turn-anchors.ts name) is
    // removed here, or a later resume would bring the old anchors back.
    try {
      if (!/[\\/]/.test(liveId)) rmSync(join(surface.sessionsDir, `${liveId}.anchors.json`), { force: true });
    } catch {
      // best effort: the in-memory anchors are already gone
    }
    saveWorkTreeFolds(surface.sessionsDir, liveId, [], []);
  }
  // Token counters and context usage come from the transcript: now empty.
  ctx.session.hydrateSessionUsage?.();
  conversation.rebuildHistory();
  return { savedAs };
}
