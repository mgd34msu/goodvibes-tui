import type { PermissionCategory } from '@pellux/goodvibes-sdk/platform/permissions';
import { buildPermissionApprovalBrief, getDisplayArg } from '@pellux/goodvibes-sdk/platform/permissions';
import { activeTokens } from '../renderer/theme.ts';
import type { SurfaceLayer } from '../renderer/surface-kit.ts';
import type { HunkSelectionState } from './hunk-selection.ts';
import { rememberScopeKey, renderPermissionCard, type PermissionCardState } from './prompt-card.ts';
export { buildPendingPermissionExtras } from './hunk-selection.ts';
export { permissionButtons, type PermissionButton, type PermissionButtonId, type PermissionCardState } from './prompt-card.ts';

import type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
export type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest };

/**
 * View-only state the card renders beyond the request itself: the typed-reply
 * mode/draft (deny-with-reason, exec-prompt answer) and the honest count of
 * OTHER broker asks still waiting.
 */
export interface PromptViewState {
  readonly replyMode?: 'deny-reason' | 'exec-answer' | undefined;
  readonly replyBuffer?: string | undefined;
  readonly queueCount?: number | undefined;
}

/** The pending-permission fields the card reads (see shell/blocking-input.ts PendingPermissionState). */
export interface PendingPromptView {
  readonly callId: string;
  readonly hunkState?: HunkSelectionState | undefined;
  readonly detailsExpanded?: boolean | undefined;
  readonly requestedBy?: string | undefined;
  readonly replyMode?: 'deny-reason' | 'exec-answer' | undefined;
  readonly replyBuffer?: string | undefined;
  readonly choice?: number | undefined;
  readonly submenuOpen?: boolean | undefined;
  readonly submenuIndex?: number | undefined;
  readonly scroll?: number | undefined;
}

/**
 * PermissionPromptUI, the permission dialog (a kit modal with an amber cap,
 * see prompt-card.ts for the layout).
 *
 * Keys (shell/blocking-input.ts): ←→ choose a button, Enter confirms it;
 * y allow once, a allow for this session (1-9 remember at a tier when the
 * request offers tiers), n deny, d details; typing denies with a reason.
 */
export class PermissionPromptUI {
  /**
   * The exact session-scoped permission rule "Allow for session" remembers.
   * Mirrors the SDK PermissionManager's approval key (`<tool>:<path>`,
   * `<tool>:<command>`, else the bare `<tool>`).
   */
  static rememberScopeKey(request: PermissionPromptRequest): string {
    return rememberScopeKey(request);
  }

  /**
   * Assemble the card's view state from the pending-permission slot and the
   * broker's live queue (the honest count of OTHER pending asks; coalesced
   * asks share one record, so they are never double-counted).
   */
  static promptViewState(
    pending: { readonly callId: string; readonly replyMode?: 'deny-reason' | 'exec-answer' | undefined; readonly replyBuffer?: string | undefined },
    broker?: { listApprovals(limit?: number): ReadonlyArray<{ readonly callId: string; readonly status: string }> } | null,
  ): PromptViewState {
    let queueCount = 0;
    try {
      queueCount = broker?.listApprovals().filter((record) => record.status === 'pending' && record.callId !== pending.callId).length ?? 0;
    } catch {
      queueCount = 0; // an unreadable broker never blocks the card
    }
    return { replyMode: pending.replyMode, replyBuffer: pending.replyBuffer, queueCount };
  }

  /** The permission dialog as a modal layer. */
  static renderPromptModal(
    screenWidth: number,
    screenHeight: number,
    request: PermissionRequest,
    pending: PendingPromptView,
    broker?: Parameters<typeof PermissionPromptUI.promptViewState>[1],
  ): SurfaceLayer {
    const view = this.promptViewState(pending, broker);
    const state: PermissionCardState = {
      hunkState: pending.hunkState,
      detailsExpanded: pending.detailsExpanded,
      requestedBy: pending.requestedBy,
      replyMode: pending.replyMode,
      replyBuffer: pending.replyBuffer,
      queueCount: view.queueCount,
      choice: pending.choice,
      submenuOpen: pending.submenuOpen,
      submenuIndex: pending.submenuIndex,
      scroll: pending.scroll,
    };
    return renderPermissionCard(request, state, screenWidth, screenHeight);
  }

  /** Returns the key argument to display for a given tool invocation. */
  static getDisplayArg(tool: string, args: Record<string, unknown>): string {
    return getDisplayArg(tool, args);
  }

  /** Returns the category label and the active-theme color for display. */
  static getCategoryLabel(category: PermissionCategory): { label: string; color: string } {
    const p = activeTokens();
    switch (category) {
      case 'write':    return { label: 'WRITE',    color: p.warning };
      case 'execute':  return { label: 'EXECUTE',  color: p.error };
      case 'delegate': return { label: 'DELEGATE', color: p.blocked };
      default:         return { label: 'PERMISSION', color: p.textMuted };
    }
  }

  static getPromptTitle(request: PermissionPromptRequest): string {
    return buildPermissionApprovalBrief(request).title;
  }

  static getSubjectLabel(request: PermissionPromptRequest): string {
    return buildPermissionApprovalBrief(request).subjectLabel;
  }
}
