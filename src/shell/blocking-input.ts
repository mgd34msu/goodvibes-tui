import type { ConversationManager } from '../core/conversation';
import type { PermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import type { SessionSnapshot } from '@/runtime/index.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { replayJournalForSession } from '../core/session-recovery.ts';
import { applyHunkKey, buildModifiedEditArgs, type HunkSelectionState } from '../permissions/hunk-selection.ts';

export type PendingPermissionState = PermissionRequest & {
  resolve: (approved: boolean, remember?: boolean, modifiedArgs?: Record<string, unknown>) => void;
  /** Present only when isHunkSelectable(request) was true when the prompt was opened. */
  hunkState?: HunkSelectionState;
  /** True once the user pressed `d` to expand a condensed low-risk card. (UX-B 2b.) */
  detailsExpanded?: boolean;
};

export type BlockingInputHandlerOptions = {
  data: string;
  pendingPermission: PendingPermissionState | null;
  recoveryPending: boolean;
  abortTurn: () => void;
  conversation: ConversationManager;
  systemMessageRouter: SystemMessageRouter;
  render: () => void;
  loadRecoveryConversation: () => SessionSnapshot | null;
  deleteRecoveryFile: () => void;
  /**
   * Copy the live recovery.jsonl aside to a preserved sibling so the dismiss
   * message's promise ("still on disk") survives this session's later 60s
   * autosaves, which would otherwise overwrite the shared recovery file with
   * the CURRENT (post-dismiss) session's state (W3 Finding 3). Optional so
   * every pre-existing test/caller that doesn't care about preservation is
   * unaffected; when omitted, dismiss behaves exactly as before.
   */
  preserveRecoveryFile?: () => { readonly preserved: boolean; readonly replacedPrevious: boolean };
  /**
   * Absolute home directory used to locate the transcript journal for this
   * recovery session. Required for journal replay on Ctrl+R restore.
   */
  homeDirectory: string;
  /**
   * The session ID that the recovery file belongs to. Required for journal
   * replay so the correct journal path can be resolved.
   */
  sessionId: string;
  /**
   * Persist the post-replay snapshot so the WAL gap is durably closed.
   * Called with the replayed message list. Best-effort — failures are swallowed
   * inside replayJournalForSession.
   */
  persistSnapshot: (messages: ConversationMessageSnapshot[]) => void;
  /**
   * Optional callback invoked after Ctrl+R restore to reopen panels captured in
   * the recovery snapshot's returnContext. When provided (as wired in main.ts),
   * the callback iterates snapshot.returnContext.openPanels and calls
   * panelManager.open() for each entry, then panelManager.show() + render() to
   * restore the panel posture from the recovered session. When omitted, panel
   * posture is not restored.
   */
  reopenPanels?: (snapshot: SessionSnapshot) => void;
};

export type BlockingInputHandlerResult = {
  handled: boolean;
  pendingPermission: PendingPermissionState | null;
  recoveryPending: boolean;
};

export function handleBlockingShellInput(
  options: BlockingInputHandlerOptions,
): BlockingInputHandlerResult {
  const {
    data,
    pendingPermission,
    recoveryPending,
    abortTurn,
    conversation,
    systemMessageRouter,
    render,
    loadRecoveryConversation,
    deleteRecoveryFile,
    preserveRecoveryFile,
    homeDirectory,
    sessionId,
    persistSnapshot,
    reopenPanels,
  } = options;

  if (pendingPermission) {
    const req = pendingPermission;

    if (req.hunkState) {
      const { state, commit } = applyHunkKey(req.hunkState, data);
      if (commit === 'apply') {
        req.resolve(true, false, buildModifiedEditArgs(req, state));
        render();
        return { handled: true, pendingPermission: null, recoveryPending };
      }
      if (commit === 'cancel') {
        req.resolve(false, false);
        abortTurn();
        render();
        return { handled: true, pendingPermission: null, recoveryPending };
      }
      render();
      return { handled: true, pendingPermission: { ...req, hunkState: state }, recoveryPending };
    }

    const key = data.toLowerCase().trim();

    if (key === 'y') {
      req.resolve(true, false);
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }

    if (key === 'a') {
      req.resolve(true, true);
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }

    if (key === 'n' || data === '\x1b' || data === '\x03') {
      req.resolve(false, false);
      abortTurn();
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }

    if (key === 'd') {
      // Toggle the condensed↔full detail view without resolving the request.
      render();
      return {
        handled: true,
        pendingPermission: { ...req, detailsExpanded: !req.detailsExpanded },
        recoveryPending,
      };
    }

    render();
    return { handled: true, pendingPermission, recoveryPending };
  }

  if (recoveryPending) {
    if (data === '\x12') {
      const recovery = loadRecoveryConversation();
      if (recovery) {
        conversation.fromJSON({
          messages: recovery.messages as Parameters<typeof conversation.fromJSON>[0]['messages'],
          title: recovery.title,
          titleSource: recovery.titleSource,
        });
        // Replay journal records that post-date the recovery snapshot so turns
        // written after the last recovery-file write (but before SIGKILL) are
        // not silently dropped. snapshotTimestamp=0 when timestamp is absent so
        // all journal records are replayed — safer than dropping.
        replayJournalForSession({
          homeDirectory,
          sessionId,
          snapshotTimestamp: recovery.timestamp ?? 0,
          conversation,
          persistSnapshot,
        });
        reopenPanels?.(recovery);
        systemMessageRouter.high('[Recovery] Session restored.');
        deleteRecoveryFile();
      } else {
        systemMessageRouter.high('[Recovery] Failed to restore saved data.');
      }
      render();
      return { handled: true, pendingPermission: null, recoveryPending: false };
    }

    if (data === '\x1b' || data === '\x03') {
      systemMessageRouter.high('[Recovery] Discarded recovery data.');
      deleteRecoveryFile();
      render();
      return { handled: true, pendingPermission: null, recoveryPending: false };
    }

    // Any other key demonstrates the user's intent to ignore the banner and
    // keep working — the prompt's own text invites exactly this ("start
    // typing to ignore it"). Previously this branch re-posted the same
    // '[Recovery] Ctrl+R to restore...' line on EVERY such key and never
    // cleared recoveryPending, so a user who took that invitation got a
    // fresh [Recovery] line injected into the transcript around every
    // character they typed, forever. Dismiss ONCE instead: clear
    // recoveryPending so it stops re-asserting, but do NOT delete the
    // recovery file — dismiss is not discard, and the file remains
    // restorable by the automatic recovery check on the next launch.
    //
    // W3 Finding 3: the promise below ("still on disk; you will be asked
    // again") used to go false silently — main.ts's 60s autosave overwrites
    // the single shared recovery.jsonl with the CURRENT session's state
    // within a minute. preserveRecoveryFile (when wired) copies it aside
    // NOW, while it still holds the dismissed session's data, so the
    // promise stays true. If an earlier dismiss's preserved snapshot gets
    // replaced by this one, say so honestly instead of silently discarding it.
    const preserveResult = preserveRecoveryFile?.();
    if (preserveResult?.replacedPrevious) {
      systemMessageRouter.low('[Recovery] Replacing the previously preserved (unrestored) snapshot with this one.');
    }
    systemMessageRouter.high('[Recovery] Dismissed — the unsaved session is still on disk; you will be asked again next time GoodVibes starts here.');
    render();
    return { handled: false, pendingPermission, recoveryPending: false };
  }

  return { handled: false, pendingPermission, recoveryPending };
}
