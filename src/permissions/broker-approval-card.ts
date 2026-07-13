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
  readonly approval: {
    readonly id: string;
    readonly callId: string;
    readonly status: string;
    readonly request: PermissionPromptRequest;
    /** Present once an ACCEPTED ask (e.g. a ci:fix-session offer) has spawned its session. */
    readonly fixSessionId?: string | undefined;
  };
  readonly getPending: () => PendingPermissionState | null;
  readonly setPending: (pending: PendingPermissionState | null) => void;
  readonly broker: BrokerApprovalCardBroker;
  readonly render: () => void;
  /**
   * Fired when a record carries the id of a session an accepted ask spawned
   * (the CI fix-session). The surface that accepted — attached now — turns this
   * into a jump/attach affordance. Called each time the field is seen; the
   * caller de-duplicates by id.
   */
  readonly onFixSessionStarted?: (fixSessionId: string) => void;
  /** Defers the open (default queueMicrotask); injectable so tests run it synchronously. */
  readonly defer?: (callback: () => void) => void;
}

const isActiveStatus = (status: string): boolean => status === 'pending' || status === 'claimed';

export interface FixSessionAffordanceDeps {
  /** Announce the ready fix session as one actionable line — never a retype instruction. */
  readonly notify: (message: string) => void;
  /** Arm the one-key jump with the spawned session id; the surface consumes it on the jump key. */
  readonly arm: (fixSessionId: string) => void;
}

/**
 * Build the one-key jump/attach affordance for a spawned fix-session: the first
 * time a given session id is seen it ARMS the jump (the surface attaches on the
 * jump key — the machine does the resume, the user never retypes an id) and
 * surfaces a one-line actionable notice. Repeats are no-ops (de-duplicated by
 * id), so the live record update and the listApprovals refresh path can both
 * feed it safely.
 */
export function buildFixSessionAffordance(deps: FixSessionAffordanceDeps): (fixSessionId: string) => void {
  const seen = new Set<string>();
  return (fixSessionId) => {
    if (seen.has(fixSessionId)) return;
    seen.add(fixSessionId);
    deps.arm(fixSessionId);
    deps.notify('[CI] Fix session ready — press j to jump to it.');
  };
}

export interface FixSessionAttachKeyDeps {
  /** The armed fix-session id (the surface clears the arm before calling this). */
  readonly armedFixSessionId: string;
  /** Attach/jump to the fix session — runs the resume so the user never retypes an id. */
  readonly attach: (fixSessionId: string) => void;
  readonly render: () => void;
}

/**
 * Consume the keypress that follows an armed fix-session notice: the jump key
 * ('j') attaches to the armed session; any other key just falls through (the
 * caller has already cleared the arm, so the affordance is one-shot). Returns
 * true only when it performed the jump.
 */
export function handleFixSessionAttachKey(data: string, deps: FixSessionAttachKeyDeps): boolean {
  if (data === 'j') {
    deps.attach(deps.armedFixSessionId);
    deps.render();
    return true;
  }
  return false;
}

/**
 * The refresh path: sweep current approval records for spawned fix-sessions and
 * feed each to the (de-duplicating) affordance. Catches a session stamped before
 * the live subscription attached, or a record update the subscription missed.
 */
export function refreshFixSessionsFromApprovals(
  listApprovals: () => readonly { readonly fixSessionId?: string | undefined }[],
  onFixSessionStarted: (fixSessionId: string) => void,
): void {
  for (const record of listApprovals()) {
    if (record.fixSessionId) onFixSessionStarted(record.fixSessionId);
  }
}

/**
 * React to one broker approval change: clear the active card when ITS approval
 * resolves, or open a card for a newly-pending broker-originated ask that no
 * local prompt is handling.
 */
export function handleBrokerApprovalChange(params: BrokerApprovalChangeParams): void {
  const { approval, getPending, setPending, broker, render } = params;
  const defer = params.defer ?? queueMicrotask;
  const active = isActiveStatus(approval.status);

  // An accepted ask that spawned a session (the CI fix-session) publishes its id
  // as a record update — the live in-process handle to jump to it. It arrives
  // after the card has resolved and cleared, so surface it independently of the
  // card lifecycle below.
  if (approval.fixSessionId) params.onFixSessionStarted?.(approval.fixSessionId);

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
