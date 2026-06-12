import type { ConversationManager } from '../core/conversation';
import type { PermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import type { SessionSnapshot } from '@/runtime/index.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { replayJournalForSession } from '../core/session-recovery.ts';

export type PendingPermissionState = PermissionRequest & {
  resolve: (approved: boolean, remember?: boolean) => void;
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
    homeDirectory,
    sessionId,
    persistSnapshot,
    reopenPanels,
  } = options;

  if (pendingPermission) {
    const req = pendingPermission;
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

    // Stray key: leave the recovery prompt active so the user can still Ctrl+R or Esc.
    systemMessageRouter.high('[Recovery] Ctrl+R to restore · Esc to discard');
    render();
    return { handled: false, pendingPermission, recoveryPending: true };
  }

  return { handled: false, pendingPermission, recoveryPending };
}
