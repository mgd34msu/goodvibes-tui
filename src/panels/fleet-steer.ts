// ---------------------------------------------------------------------------
// fleet-steer.ts
//
// Steer-badge rendering helpers and the "dropped inference"
// reconciliation pass, split out of fleet-panel.ts to keep that file under
// the architecture line cap (see check-architecture.ts's 800-line gate).
// Pure functions only; FleetPanel still owns the mutable FleetTab.steerBadge
// state itself (see fleet-tabs.ts's SteerBadge doc) and calls into this
// module rather than duplicating the logic inline.
// ---------------------------------------------------------------------------

import { STEER_TTL_MS, type ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { isTerminalProcessState } from './fleet-read-model.ts';
import type { FleetTab, SteerBadge, SteerBadgeStatus } from './fleet-tabs.ts';
import { buildPanelLine, DEFAULT_PANEL_PALETTE, type PanelPalette } from './polish.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';

/** Linger before an auto-resolved (consumed/dropped) steer badge is cleared from the tab. */
export const STEER_BADGE_LINGER_MS = 4_000;

export function steerBadgeGlyph(status: SteerBadgeStatus): string {
  switch (status) {
    case 'queued': return '⧗';
    case 'consumed': return '✓';
    case 'dropped': return '⚠';
  }
}

export function steerBadgeTone(status: SteerBadgeStatus, palette: PanelPalette): string {
  switch (status) {
    case 'queued': return palette.warn ?? DEFAULT_PANEL_PALETTE.warn;
    case 'consumed': return palette.good ?? DEFAULT_PANEL_PALETTE.good;
    case 'dropped': return palette.bad ?? DEFAULT_PANEL_PALETTE.bad;
  }
}

/** Labels of the currently live, steerable agent nodes other than `excludeNodeId` — offered when a steer target has gone inactive (WO item 4). */
export function liveSteerableLabels(nodes: readonly ProcessNode[], excludeNodeId: string): string[] {
  return nodes
    .filter((node) => node.id !== excludeNodeId && node.kind === 'agent' && node.capabilities.steerable && !isTerminalProcessState(node.state))
    .map((node) => node.label);
}

/** Refusal message for a steer that could not be queued: states why + preserves the draft + suggests live targets. */
export function steerRefusalMessage(reason: string, siblingLabels: readonly string[]): string {
  const suggestion = siblingLabels.length > 0
    ? ` Draft kept — steerable now: ${siblingLabels.slice(0, 3).join(', ')}${siblingLabels.length > 3 ? '…' : ''}.`
    : ' Draft kept — no other agents are currently steerable.';
  return `${reason}.${suggestion}`;
}

/** One-line honest status for a tab's steer badge; the queued line names the target and points at the ⧗ delivery badge (WO item 4). */
export function renderSteerBadgeLine(badge: SteerBadge, width: number, palette: PanelPalette, targetLabel?: string): Line {
  const glyph = steerBadgeGlyph(badge.status);
  const tone = steerBadgeTone(badge.status, palette);
  const forTarget = targetLabel ? ` for ${targetLabel}` : '';
  const label = badge.status === 'queued'
    ? `steer queued${forTarget} — delivers on its next turn (watch the ${glyph} badge)`
    : badge.status === 'consumed'
      ? 'steer consumed'
      : `steer dropped — ${badge.note ?? 'the target ended before delivery'}`;
  return buildPanelLine(width, [
    [' ', palette.dim],
    [glyph, tone],
    [` ${label}`, palette.dim],
  ]);
}

/**
 * The "dropped inference" risk: the SDK emits no
 * cancelled/expired signal for a queued steer, so a badge left `queued`
 * after its target node goes terminal (done/failed/killed/interrupted)
 * would hang forever with no honest resolution. Resolves any such badge to
 * `dropped`, and clears any already-resolved (consumed/dropped) badge past
 * its short linger so a tab doesn't accumulate stale indicators.
 *
 * Mutates `tab.steerBadge` in place (same mutable-slot convention as
 * `FleetTab.ledgerEntries` — see fleet-panel.ts's ensureLedgerLoaded).
 * Returns true when anything changed, so the caller knows whether to mark
 * itself dirty.
 */
export function reconcileSteerBadges(
  tabs: readonly FleetTab[],
  findLiveNode: (nodeId: string) => ProcessNode | null,
  now: number,
): boolean {
  let changed = false;
  for (const tab of tabs) {
    const badge = tab.steerBadge;
    if (!badge) continue;
    if (badge.status === 'queued') {
      const node = findLiveNode(tab.nodeId);
      if (!node || isTerminalProcessState(node.state)) {
        tab.steerBadge = {
          ...badge,
          status: 'dropped',
          note: node
            ? `the ${node.kind} went ${node.state} before the steer was delivered`
            : 'the target is no longer tracked',
          resolvedAt: now,
        };
        changed = true;
      } else if (badge.queuedAt !== undefined && now - badge.queuedAt > STEER_TTL_MS) {
        // Long-tool-call case: the target is still healthy and non-terminal,
        // but the underlying steer message's own TTL (the SDK's MessageBus —
        // see registry.js's steer(), which stamps every steer with
        // STEER_TTL_MS) has lapsed without a COMMUNICATION_CONSUMED ever
        // arriving. The SDK gives no explicit expiry signal, so without this
        // the badge would show 'queued' forever even though the message is
        // provably gone from the bus.
        tab.steerBadge = {
          ...badge,
          status: 'dropped',
          note: 'expired undelivered',
          resolvedAt: now,
        };
        changed = true;
      }
    } else if (badge.resolvedAt !== undefined && now - badge.resolvedAt > STEER_BADGE_LINGER_MS) {
      tab.steerBadge = null;
      changed = true;
    }
  }
  return changed;
}
