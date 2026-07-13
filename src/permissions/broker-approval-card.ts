/**
 * broker-approval-card — render a broker-originated approval ask as a real
 * TUI approval card.
 *
 * The approval broker publishes every ask (local runtime asks, plus
 * broker-originated ones like the CI fix-session offer). Local asks carry a
 * `localPrompt` that opens their own card; broker-originated asks do not, so
 * before this they were invisible in the TUI — the ask sat pending with no
 * surface. This helper opens a card straight from broker state for those.
 *
 * A local ask's own prompt is opened by the broker immediately AFTER it
 * publishes (see ApprovalBroker.requestApproval), so the open here is deferred
 * one microtask and re-checks: if a card (the local one, or another broker
 * card) is already up, it does nothing — only a genuinely unhandled ask surfaces.
 * The card's resolve answers the broker directly via resolveApproval, so a TUI
 * decision on a broker-originated ask reaches every waiter on that record.
 */

import { buildPendingPermissionExtras } from './hunk-selection.ts';
import type { ApprovalRequesterLookup } from './hunk-selection.ts';
import type { PendingPermissionState } from '../shell/blocking-input.ts';
import type { PermissionPromptRequest, RememberTier } from '@pellux/goodvibes-sdk/platform/permissions';

/** The broker seam this helper answers through — a subset of ApprovalBroker. */
export interface BrokerApprovalCardBroker extends ApprovalRequesterLookup {
  getApproval(approvalId: string): { readonly status: string; readonly request: PermissionPromptRequest } | null;
  resolveApproval(
    approvalId: string,
    input: {
      readonly approved: boolean;
      readonly remember?: boolean;
      readonly rememberTier?: RememberTier;
      readonly reason?: string;
      readonly modifiedArgs?: Record<string, unknown>;
      readonly actor: string;
      readonly actorSurface?: string;
    },
  ): Promise<unknown>;
}

export interface BrokerApprovalChangeParams {
  readonly approval: { readonly id: string; readonly callId: string; readonly status: string; readonly request: PermissionPromptRequest };
  readonly getPending: () => PendingPermissionState | null;
  readonly setPending: (pending: PendingPermissionState | null) => void;
  readonly broker: BrokerApprovalCardBroker;
  readonly render: () => void;
  /** Defers the open (default queueMicrotask); injectable so tests run it synchronously. */
  readonly defer?: (callback: () => void) => void;
}

const isActiveStatus = (status: string): boolean => status === 'pending' || status === 'claimed';

/**
 * React to one broker approval change: clear the active card when ITS approval
 * resolves, or open a card for a newly-pending broker-originated ask that no
 * local prompt is handling.
 */
export function handleBrokerApprovalChange(params: BrokerApprovalChangeParams): void {
  const { approval, getPending, setPending, broker, render } = params;
  const defer = params.defer ?? queueMicrotask;
  const active = isActiveStatus(approval.status);

  const pending = getPending();
  if (pending && pending.callId === approval.callId) {
    // This is the card already on screen — clear it once its approval resolves.
    if (!active) { setPending(null); render(); }
    return;
  }
  if (!active) return;

  defer(() => {
    if (getPending()) return; // a local card (or another broker card) is already up
    const current = broker.getApproval(approval.id);
    if (!current || !isActiveStatus(current.status)) return;
    setPending({
      ...current.request,
      ...buildPendingPermissionExtras(current.request, (decision) => {
        void broker.resolveApproval(approval.id, {
          approved: decision.approved,
          remember: decision.remember ?? false,
          ...(decision.rememberTier ? { rememberTier: decision.rememberTier } : {}),
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(decision.modifiedArgs ? { modifiedArgs: decision.modifiedArgs } : {}),
          actor: 'tui',
          actorSurface: 'tui',
        }).catch(() => {});
      }, broker),
    } as PendingPermissionState);
    render();
  });
}
