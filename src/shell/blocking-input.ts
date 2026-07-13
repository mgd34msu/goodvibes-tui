import type { ConversationManager } from '../core/conversation';
import type { PermissionRequest, RememberTier } from '@pellux/goodvibes-sdk/platform/permissions';
import type { SessionSnapshot } from '@/runtime/index.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { replayJournalForSession } from '../core/session-recovery.ts';
import { applyHunkKey, buildModifiedEditArgs, type HunkSelectionState } from '../permissions/hunk-selection.ts';

export type PendingPermissionState = PermissionRequest & {
  resolve: (approved: boolean, remember?: boolean, modifiedArgs?: Record<string, unknown>, extras?: { rememberTier?: RememberTier; reason?: string }) => void;
  /** Present only when isHunkSelectable(request) was true when the prompt was opened. */
  hunkState?: HunkSelectionState;
  /** True once the user pressed `d` to expand a condensed low-risk card. (2b.) */
  detailsExpanded?: boolean;
  /**
   * Active typed-reply mode: 'deny-reason' (started by typing while the card
   * is up — Enter denies with the typed reason as feedback) or 'exec-answer'
   * (an exec-prompt ask; Enter approves with the typed answer feeding the
   * running command's stdin). Undefined = plain card keys.
   */
  replyMode?: 'deny-reason' | 'exec-answer';
  /** The reply draft while replyMode is active. */
  replyBuffer?: string;
  /**
   * Epoch ms when the prompt first appeared. Keystrokes that arrive within
   * APPROVAL_INPUT_DEBOUNCE_MS of this are swallowed (not interpreted as an
   * approve/deny response) so text typed ahead — before the user saw the
   * prompt — cannot accidentally answer it.
   */
  openedAt?: number;
  /** Requester attribution ("session abc12345" / a named agent) shown on the prompt; absent when unknown. */
  requestedBy?: string;
};

/**
 * Settle window after a permission prompt appears during which buffered
 * keystrokes are ignored rather than interpreted as the response. 350ms is long
 * enough to absorb type-ahead from before the prompt rendered, short enough not
 * to feel laggy to a user reacting to the prompt itself.
 */
export const APPROVAL_INPUT_DEBOUNCE_MS = 350;

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
  /** Injectable clock for the approval-input debounce; defaults to Date.now(). Tests only. */
  now?: number;
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

    // Input debounce: swallow any key that arrives within the settle window
    // after the prompt appeared, so type-ahead text from before the user saw
    // the prompt cannot answer it (neither approve, deny, nor navigate). The
    // prompt stays open; re-render and consume the key.
    const now = options.now ?? Date.now();
    if (req.openedAt !== undefined && now - req.openedAt < APPROVAL_INPUT_DEBOUNCE_MS) {
      render();
      return { handled: true, pendingPermission, recoveryPending };
    }

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

    // Ctrl+C is ALWAYS the hard abort: deny and kill the turn, in every mode.
    if (data === '\x03') {
      req.resolve(false, false);
      abortTurn();
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }

    // Typed-reply mode: deny-with-reason (started by typing on any card) or
    // exec-answer (an exec-prompt ask opens in this mode). Every printable
    // key is text here — nothing is a card command.
    if (req.replyMode) {
      const buffer = req.replyBuffer ?? '';
      if (data === '\r' || data === '\n') {
        if (req.replyMode === 'exec-answer') {
          // The typed answer feeds the running command's stdin via the
          // decision's modifiedArgs (SDK exec-prompt wiring contract).
          req.resolve(true, false, { answer: buffer });
        } else {
          // Deny is feedback: the reason rides the structured "user declined"
          // tool result so the model can adapt — the turn is NOT aborted.
          req.resolve(false, false, undefined, { reason: buffer });
        }
        render();
        return { handled: true, pendingPermission: null, recoveryPending };
      }
      if (data === '\x1b') {
        if (req.replyMode === 'exec-answer') {
          // Esc on an exec-prompt: clear a draft first; with nothing typed it
          // declines the prompt (the run gets the honest unanswered result).
          if (buffer.length > 0) {
            render();
            return { handled: true, pendingPermission: { ...req, replyBuffer: '' }, recoveryPending };
          }
          req.resolve(false, false);
          render();
          return { handled: true, pendingPermission: null, recoveryPending };
        }
        // Esc leaves deny-reason mode back to the plain card.
        render();
        return { handled: true, pendingPermission: { ...req, replyMode: undefined, replyBuffer: undefined }, recoveryPending };
      }
      if (data === '\x7f' || data === '\b') {
        render();
        return { handled: true, pendingPermission: { ...req, replyBuffer: buffer.slice(0, -1) }, recoveryPending };
      }
      if (data.length >= 1 && !data.startsWith('\x1b') && data >= ' ') {
        render();
        return { handled: true, pendingPermission: { ...req, replyBuffer: buffer + data }, recoveryPending };
      }
      render();
      return { handled: true, pendingPermission, recoveryPending };
    }

    // Scroll, mouse, PageUp/Down, arrow, and panel-navigation keys — plus a
    // bare Esc — are not card answers. Pass them through to the normal input
    // handler so the transcript stays scrollable and Esc only drops focus. The
    // request stays pending (answer it with y/n or a remember tier when ready);
    // Ctrl+C above is still the hard abort, and 'n' still denies.
    if (data.startsWith('\x1b')) {
      return { handled: false, pendingPermission, recoveryPending };
    }

    const key = data.toLowerCase().trim();

    if (key === 'y') {
      req.resolve(true, false);
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }

    if (key === 'a') {
      // Legacy always-this-session choice — the 'session' remember tier.
      req.resolve(true, true, undefined, { rememberTier: 'session' });
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }

    // Numbered remember tiers ([1]..[N], most specific first) from the SDK's
    // rememberOptions: approve AND remember at that tier. A generalizing tier
    // writes a durable user-origin rule; 'session' only caches in memory.
    if (/^[1-9]$/.test(key) && req.rememberOptions && req.rememberOptions.length > 0) {
      const option = req.rememberOptions[Number(key) - 1];
      if (option) {
        req.resolve(true, option.tier === 'session', undefined, { rememberTier: option.tier });
        render();
        return { handled: true, pendingPermission: null, recoveryPending };
      }
      render();
      return { handled: true, pendingPermission, recoveryPending };
    }

    if (key === 'n') {
      // Plain deny — feedback to the model (the SDK renders an honest "user
      // declined" result), never a turn abort. Ctrl+C above is the hard stop;
      // Esc drops focus (handled above) rather than denying.
      req.resolve(false, false);
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

    // Any other printable key starts deny-with-reason: what the user types
    // becomes the denial feedback, seeded with this first character.
    if (data.length === 1 && data >= ' ') {
      render();
      return { handled: true, pendingPermission: { ...req, replyMode: 'deny-reason', replyBuffer: data }, recoveryPending };
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
