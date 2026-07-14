import type { PermissionRequest, RememberTier } from '@pellux/goodvibes-sdk/platform/permissions';
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
  abortTurn: () => void;
  render: () => void;
  /** Injectable clock for the approval-input debounce; defaults to Date.now(). Tests only. */
  now?: number;
};

export type BlockingInputHandlerResult = {
  handled: boolean;
  pendingPermission: PendingPermissionState | null;
};

export function handleBlockingShellInput(
  options: BlockingInputHandlerOptions,
): BlockingInputHandlerResult {
  const {
    data,
    pendingPermission,
    abortTurn,
    render,
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
      return { handled: true, pendingPermission };
    }

    if (req.hunkState) {
      const { state, commit } = applyHunkKey(req.hunkState, data);
      if (commit === 'apply') {
        req.resolve(true, false, buildModifiedEditArgs(req, state));
        render();
        return { handled: true, pendingPermission: null };
      }
      if (commit === 'cancel') {
        req.resolve(false, false);
        abortTurn();
        render();
        return { handled: true, pendingPermission: null };
      }
      render();
      return { handled: true, pendingPermission: { ...req, hunkState: state } };
    }

    // Ctrl+C is ALWAYS the hard abort: deny and kill the turn, in every mode.
    if (data === '\x03') {
      req.resolve(false, false);
      abortTurn();
      render();
      return { handled: true, pendingPermission: null };
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
        return { handled: true, pendingPermission: null };
      }
      if (data === '\x1b') {
        if (req.replyMode === 'exec-answer') {
          // Esc on an exec-prompt: clear a draft first; with nothing typed it
          // declines the prompt (the run gets the honest unanswered result).
          if (buffer.length > 0) {
            render();
            return { handled: true, pendingPermission: { ...req, replyBuffer: '' } };
          }
          req.resolve(false, false);
          render();
          return { handled: true, pendingPermission: null };
        }
        // Esc leaves deny-reason mode back to the plain card.
        render();
        return { handled: true, pendingPermission: { ...req, replyMode: undefined, replyBuffer: undefined } };
      }
      if (data === '\x7f' || data === '\b') {
        render();
        return { handled: true, pendingPermission: { ...req, replyBuffer: buffer.slice(0, -1) } };
      }
      if (data.length >= 1 && !data.startsWith('\x1b') && data >= ' ') {
        render();
        return { handled: true, pendingPermission: { ...req, replyBuffer: buffer + data } };
      }
      render();
      return { handled: true, pendingPermission };
    }

    // Scroll, mouse, PageUp/Down, arrow, and panel-navigation keys — plus a
    // bare Esc — are not card answers. Pass them through to the normal input
    // handler so the transcript stays scrollable and Esc only drops focus. The
    // request stays pending (answer it with y/n or a remember tier when ready);
    // Ctrl+C above is still the hard abort, and 'n' still denies.
    if (data.startsWith('\x1b')) {
      return { handled: false, pendingPermission };
    }

    const key = data.toLowerCase().trim();

    if (key === 'y') {
      req.resolve(true, false);
      render();
      return { handled: true, pendingPermission: null };
    }

    if (key === 'a') {
      // Legacy always-this-session choice — the 'session' remember tier.
      req.resolve(true, true, undefined, { rememberTier: 'session' });
      render();
      return { handled: true, pendingPermission: null };
    }

    // Numbered remember tiers ([1]..[N], most specific first) from the SDK's
    // rememberOptions: approve AND remember at that tier. A generalizing tier
    // writes a durable user-origin rule; 'session' only caches in memory.
    if (/^[1-9]$/.test(key) && req.rememberOptions && req.rememberOptions.length > 0) {
      const option = req.rememberOptions[Number(key) - 1];
      if (option) {
        req.resolve(true, option.tier === 'session', undefined, { rememberTier: option.tier });
        render();
        return { handled: true, pendingPermission: null };
      }
      render();
      return { handled: true, pendingPermission };
    }

    if (key === 'n') {
      // Plain deny — feedback to the model (the SDK renders an honest "user
      // declined" result), never a turn abort. Ctrl+C above is the hard stop;
      // Esc drops focus (handled above) rather than denying.
      req.resolve(false, false);
      render();
      return { handled: true, pendingPermission: null };
    }

    if (key === 'd') {
      // Toggle the condensed↔full detail view without resolving the request.
      render();
      return {
        handled: true,
        pendingPermission: { ...req, detailsExpanded: !req.detailsExpanded },
      };
    }

    // Any other printable key starts deny-with-reason: what the user types
    // becomes the denial feedback, seeded with this first character.
    if (data.length === 1 && data >= ' ') {
      render();
      return { handled: true, pendingPermission: { ...req, replyMode: 'deny-reason', replyBuffer: data } };
    }

    render();
    return { handled: true, pendingPermission };
  }

  return { handled: false, pendingPermission };
}
