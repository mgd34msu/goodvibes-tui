// ---------------------------------------------------------------------------
// fleet-tabs.ts
//
// Wave-3 (W3.1 Part C) — pure, testable tab-state model for FleetPanel's
// session tabs. No BasePanel/rendering dependency, mirroring the
// fleet-read-model.ts convention: this module owns attach/detach/switch as
// pure state transitions over a small immutable FleetTabsState, so the tab
// lifecycle is unit-testable without a live registry or a rendered panel.
//
// Tab-index convention: index 0 is always the fleet TREE (the panel's root
// view, never stored in `tabs`); `activeTabIndex` 1..N addresses
// `tabs[0..N-1]`. This mirrors the brief's "tree is the root/home tab"
// framing while keeping the array itself simple (only attached tabs).
//
// Attachable kinds: only 'agent' and 'wrfc-chain' carry anything worth
// attaching to (a transcript for an agent; a live member summary for a
// chain — see fleet-transcript.ts). workflow/trigger/schedule/watcher/
// background-process/wrfc-subtask nodes have no transcript and are never
// attachable (FleetPanel shows a status message instead, matching the
// existing i/K "not supported" convention).
// ---------------------------------------------------------------------------

import type { ProcessKind, ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { MessageLineCache } from '../core/conversation-line-cache.ts';
import { fleetKindTag } from './fleet-read-model.ts';

/** Node kinds that can be attached as a session tab. */
export type FleetAttachableKind = 'agent' | 'wrfc-chain';

export function isAttachableFleetKind(kind: ProcessKind): kind is FleetAttachableKind {
  return kind === 'agent' || kind === 'wrfc-chain';
}

/**
 * One attached session tab. `agentId` is the SDK attach handle for
 * `AgentManager.getConversationSnapshot(agentId)` — populated only for
 * 'agent' tabs (agent.ts sets ProcessNode.id = record.id, so node.id IS the
 * agentId; see the W3.1 brief's C2 note). 'wrfc-chain' tabs render a live
 * member-summary instead of a transcript (a chain has no single conversation
 * of its own — see fleet-transcript.ts renderFleetChainSummary) and carry an
 * empty agentId, unused.
 *
 * `lineCache` is a PER-TAB `MessageLineCache` (C5 backpressure): switching
 * tabs must never invalidate or thrash the main session's own cache, and a
 * background (non-focused) tab must render nothing beyond its existing
 * tree-row, so its cache simply stays empty (size 0) until the tab is
 * focused. Disposed (`.clear()`) on detach so a closed tab's rendered
 * Line[] are not retained (brief risk #8).
 */
export interface FleetTab {
  readonly nodeId: string;
  readonly kind: FleetAttachableKind;
  readonly agentId: string;
  readonly label: string;
  readonly lineCache: MessageLineCache;
  /**
   * Cached parsed ledger fallback for a terminal agent whose conversation
   * snapshot has been evicted from the SDK's retention ring (C6 degraded
   * path). `null` = not yet loaded/attempted; `[]` = loaded and empty (or
   * the load failed) — both render the same honest "no transcript" state
   * once loaded is true.
   */
  ledgerEntries: Record<string, unknown>[] | null;
  ledgerLoadStarted: boolean;
}

/** Immutable tab-bar state: the attached tabs plus which one (or the root tree) is active. */
export interface FleetTabsState {
  readonly tabs: readonly FleetTab[];
  /** 0 = root tree; 1..tabs.length addresses tabs[activeTabIndex - 1]. */
  readonly activeTabIndex: number;
}

export const EMPTY_FLEET_TABS_STATE: FleetTabsState = { tabs: [], activeTabIndex: 0 };

function shortNodeId(id: string): string {
  if (id.length <= 10) return id;
  // Trim a leading '-' left over from slicing mid-token (e.g. 'agent-done-01'
  // -> '-done-01' before this trim) so the label never starts with a stray
  // separator character.
  return id.slice(-8).replace(/^-+/, '');
}

export function fleetTabLabel(node: ProcessNode): string {
  return `${fleetKindTag(node.kind)} ${shortNodeId(node.id)}`;
}

function makeFleetTab(node: ProcessNode & { kind: FleetAttachableKind }): FleetTab {
  return {
    nodeId: node.id,
    kind: node.kind,
    agentId: node.kind === 'agent' ? node.id : '',
    label: fleetTabLabel(node),
    lineCache: new MessageLineCache(),
    ledgerEntries: null,
    ledgerLoadStarted: false,
  };
}

/** The currently-active tab, or null when the root tree is active. */
export function activeFleetTab(state: FleetTabsState): FleetTab | null {
  return state.activeTabIndex > 0 ? (state.tabs[state.activeTabIndex - 1] ?? null) : null;
}

/**
 * Attach a node as a tab (Enter on an attachable tree row). Re-focuses an
 * already-open tab for the same node instead of creating a duplicate.
 * Returns `state` unchanged if `node.kind` is not attachable — callers
 * (FleetPanel) are expected to guard with `isAttachableFleetKind` first and
 * report a status message rather than silently doing nothing; this
 * function's own no-op fallback is defense in depth.
 */
export function attachFleetTab(state: FleetTabsState, node: ProcessNode): FleetTabsState {
  if (!isAttachableFleetKind(node.kind)) return state;
  const existingIndex = state.tabs.findIndex((tab) => tab.nodeId === node.id);
  if (existingIndex >= 0) {
    return { tabs: state.tabs, activeTabIndex: existingIndex + 1 };
  }
  const tab = makeFleetTab(node as ProcessNode & { kind: FleetAttachableKind });
  const tabs = [...state.tabs, tab];
  return { tabs, activeTabIndex: tabs.length };
}

/**
 * Detach the tab at `tabIndex` (a plain index into `state.tabs`, NOT an
 * `activeTabIndex`). Disposes its line cache. Re-anchors `activeTabIndex`:
 * detaching the active tab falls back to the root tree; detaching a tab
 * before the active one shifts the active index left to keep pointing at
 * the same logical tab.
 */
export function detachFleetTab(state: FleetTabsState, tabIndex: number): FleetTabsState {
  if (tabIndex < 0 || tabIndex >= state.tabs.length) return state;
  state.tabs[tabIndex]?.lineCache.clear();
  const tabs = state.tabs.filter((_, i) => i !== tabIndex);
  const removedActiveSlot = tabIndex + 1;
  let activeTabIndex = state.activeTabIndex;
  if (activeTabIndex === removedActiveSlot) {
    activeTabIndex = 0;
  } else if (activeTabIndex > removedActiveSlot) {
    activeTabIndex -= 1;
  }
  return { tabs, activeTabIndex };
}

/** Detach whichever tab is currently active. No-op (returns state unchanged) when the root tree is active. */
export function detachActiveFleetTab(state: FleetTabsState): FleetTabsState {
  if (state.activeTabIndex === 0) return state;
  return detachFleetTab(state, state.activeTabIndex - 1);
}

/** Switch to an absolute tab-strip index (0 = root tree). Clamped to the valid range; out-of-range requests are a no-op. */
export function switchFleetTab(state: FleetTabsState, activeTabIndex: number): FleetTabsState {
  if (activeTabIndex < 0 || activeTabIndex > state.tabs.length) return state;
  if (activeTabIndex === state.activeTabIndex) return state;
  return { tabs: state.tabs, activeTabIndex };
}

/** Move focus to the next/previous tab in the strip (wrapping is deliberately NOT applied — clamps at the ends). */
export function stepFleetTab(state: FleetTabsState, direction: 1 | -1): FleetTabsState {
  const next = state.activeTabIndex + direction;
  return switchFleetTab(state, Math.max(0, Math.min(state.tabs.length, next)));
}
