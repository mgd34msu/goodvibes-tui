/**
 * session-resume-core.ts, the ONE resume routine both resume seams call.
 *
 * Two independent call sites used to duplicate (and diverge from) this
 * sequence: `/session resume` (session-workflow.ts) and the panel/session-
 * browser resume (bootstrap-hook-bridge.ts's `createResumeSessionHandler`).
 * Divergences found by audit:
 *   - the panel seam skipped `restoreTurnAnchors` (message-anchored /rewind
 *     silently had no anchors after a panel resume)
 *   - the panel seam skipped `conversation.resetAll()` before `fromJSON()`
 *   - the panel seam skipped the `selectModel` reselection fallback (it set
 *     `runtime.model` straight from the saved meta, never re-resolving
 *     through the live provider registry)
 *   - the panel seam duplicated the panel-reopen loop WITHOUT the
 *     modal-redirect skip, so a MIGRATE-TO-MODAL id could pop a modal
 *     mid-resume
 *
 * Both seams now call this module so those four behaviors (plus the
 * panel-reopen-cap honesty note) are guaranteed identical by construction,
 * not by copy-paste discipline between two files.
 *
 * Callers own everything ABOVE and AROUND this core sequence: printing or
 * logging the outcome in their own idiom (`ctx.print` vs `conversation.log`),
 * and any extra plumbing that only one seam performs (hookDispatcher.fire,
 * sessionSpine.reopen, sharedSessionBroker.reopenSession,
 * writeLastSessionPointer, all bootstrap-hook-bridge-only, pre-existing
 * asymmetries out of this module's scope).
 */
import type { SessionManager, SessionMeta } from '@pellux/goodvibes-sdk/platform/sessions';
import type { SessionSurface } from '@/runtime/index.ts';
import type { ConversationManager } from './conversation.ts';
import { restoreTurnAnchors } from '@pellux/goodvibes-sdk/platform/rewind';
import { replayJournalForSession, type ReplayIntoConversationResult } from '@pellux/goodvibes-sdk/platform/runtime/operations';

export interface SessionResumeRuntime {
  sessionId: string;
  model: string;
  provider: string;
}

export interface SessionResumeDeps {
  readonly sessionManager: Pick<SessionManager, 'load' | 'save'>;
  readonly conversation: ConversationManager;
  readonly runtime: SessionResumeRuntime;
  /**
   * The app's declare-once session-storage handle. Both resume seams pass the
   * SAME one the runtime writes through, so the anchor sidecar and the
   * transcript journal this routine reads are guaranteed to be the files the
   * live session actually wrote, the scope can no longer be re-guessed per
   * seam.
   */
  readonly surface: SessionSurface;
  /**
   * Reselects the saved model through the live provider registry, falling
   * back to the raw saved id on failure (a saved model may no longer exist
   * locally). Omit to use the saved id directly without reselection.
   */
  readonly selectModel?: (model: string) => Promise<{ readonly registryKey: string; readonly providerId: string }>;
  readonly hydrateSessionUsage?: () => void;
}

export interface SessionResumeOutcome {
  readonly meta: SessionMeta;
  readonly resumedMessageCount: number;
  readonly restoredAnchorCount: number;
  readonly journalReplay: ReplayIntoConversationResult;
}

/**
 * The canonical resume sequence: load, reset + restore the conversation,
 * restore rewind anchors, replay any post-snapshot journal records, hydrate
 * footer usage and reselect the model.
 *
 * Sessions saved while the TUI still had side panes carry
 * `returnContext.openPanels`; it is read as part of the saved return context
 * and otherwise ignored (there are no panes to reopen).
 */
export async function resumeSessionCore(sessionId: string, deps: SessionResumeDeps): Promise<SessionResumeOutcome> {
  const { meta, messages } = deps.sessionManager.load(sessionId);

  deps.conversation.resetAll();
  deps.conversation.fromJSON({
    messages: messages as never[],
    title: meta.title,
    titleSource: meta.titleSource,
  });
  deps.conversation.rebuildHistory();
  deps.runtime.sessionId = sessionId;

  // Restore this session's message-anchored rewind anchors from its sidecar
  // so /rewind works identically before and after the resume, the in-memory
  // registry is process-local, so a fresh process starts with none for the
  // loaded session.
  const restoredAnchorCount = restoreTurnAnchors(sessionId, deps.surface);

  // Journal replay: recover turns that post-date the loaded snapshot.
  const journalReplay = replayJournalForSession({
    surface: deps.surface,
    sessionId,
    snapshotTimestamp: meta.timestamp ?? 0,
    conversation: deps.conversation,
    persistSnapshot: (replayedMessages) => {
      deps.sessionManager.save(sessionId, replayedMessages as never[], {
        title: deps.conversation.title || meta.title,
        model: meta.model,
        provider: meta.provider,
        timestamp: Date.now(),
        titleSource: meta.titleSource,
        returnContext: meta.returnContext,
        // Machinery: this write exists only to durably close the journal gap
        // the replay just filled. The user's own save/fork/rename acts stamp
        // 'user' at their own call sites (session-workflow.ts).
        saveSource: 'auto',
      });
    },
  });

  // Hydrate the footer's token counters from the resumed (+ journal-replayed)
  // history now, before the caller renders.
  deps.hydrateSessionUsage?.();

  if (meta.model) {
    if (deps.selectModel) {
      try {
        const selected = await deps.selectModel(meta.model);
        deps.runtime.model = selected.registryKey;
        deps.runtime.provider = selected.providerId;
      } catch {
        deps.runtime.model = meta.model; // model may not exist locally
      }
    } else {
      deps.runtime.model = meta.model;
    }
  }
  if (meta.provider) deps.runtime.provider = meta.provider;

  return {
    meta,
    resumedMessageCount: deps.conversation.getMessageCount(),
    restoredAnchorCount,
    journalReplay,
  };
}
