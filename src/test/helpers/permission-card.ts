/**
 * permission-card.ts, test helpers for the permission dialog (a kit modal).
 *
 * promptCardLines keeps the positional shape of the retired
 * PermissionPromptUI.createPromptLines so tests read the same, and renders
 * the dialog onto a tall screen (so nothing scrolls) as full-width lines.
 * The details block (tool, directory, decision, review reasons, raw args) is
 * expanded unless a test passes `false` explicitly, matching the old full card.
 */

import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import { PermissionPromptUI, type PromptViewState } from '../../permissions/prompt.ts';
import type { HunkSelectionState } from '../../permissions/hunk-selection.ts';
import { frameFromLayer } from './surface-frame.ts';

/** Screen height the card is rendered on (tall enough that no card scrolls). */
export const CARD_SCREEN_HEIGHT = 120;

export function promptCardLines(
  width: number,
  request: PermissionPromptRequest,
  hunkState?: HunkSelectionState,
  detailsExpanded?: boolean,
  requestedBy?: string,
  view?: PromptViewState,
  height: number = CARD_SCREEN_HEIGHT,
  extra: { readonly choice?: number; readonly submenuOpen?: boolean; readonly submenuIndex?: number } = {},
): Line[] {
  const queueCount = view?.queueCount ?? 0;
  const broker = queueCount > 0
    ? { listApprovals: () => Array.from({ length: queueCount }, (_, i) => ({ callId: `waiting-${i}`, status: 'pending' })) }
    : undefined;
  const pending = {
    callId: (request as { callId?: string }).callId ?? 'card-test',
    hunkState,
    detailsExpanded: detailsExpanded ?? true,
    requestedBy,
    replyMode: view?.replyMode,
    replyBuffer: view?.replyBuffer,
    ...extra,
  };
  return frameFromLayer(PermissionPromptUI.renderPromptModal(width, height, request as never, pending, broker), width, height);
}

/** The card's text rows (trailing spaces trimmed, blank rows dropped). */
export function promptCardText(...args: Parameters<typeof promptCardLines>): string[] {
  return promptCardLines(...args)
    .map((line) => line.map((cell) => cell.char).join('').trimEnd())
    .filter((text) => text.trim().length > 0);
}
