// ---------------------------------------------------------------------------
// fleet-tabs.ts
//
// Pure, testable tab-state model for FleetPanel's
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
 * Lifecycle of a queued steer message, tracked
 * per-tab. `queued` means `ProcessRegistry.steer()` accepted the message
 * onto the target's inbox, NOT that the agent has seen it — that is the
 * later, honest `consumed` transition (a `COMMUNICATION_CONSUMED` runtime-bus
 * event matching this badge's `messageId`). `dropped` is a TUI-side
 * inference: the SDK emits no "expired"/"cancelled" signal for a queued
 * steer, so if the target node goes terminal (done/failed/killed/
 * interrupted) while the badge is still `queued`, FleetPanel resolves it to
 * `dropped` itself rather than leaving the badge hanging forever (see
 * fleet-panel.ts reconcileSteerBadges — cross-WO note: the SDK engineer
 * confirmed no dropped signal exists).
 */
export type SteerBadgeStatus = 'queued' | 'consumed' | 'dropped';

/** A tab's steer-message badge state (null on the tab = no active/recent steer). */
export interface SteerBadge {
  readonly messageId: string;
  readonly status: SteerBadgeStatus;
  /** Present for 'dropped' — a one-line honest explanation shown in the tab. */
  readonly note?: string;
  /** epoch ms when status left 'queued' (consumed or dropped) — drives FleetPanel's linger-then-clear tick. */
  readonly resolvedAt?: number;
  /**
   * epoch ms when status entered 'queued' (set once, at submit time). Drives
   * fleet-steer.ts's reconcileSteerBadges TTL-expiry fallback: the SDK's
   * MessageBus attaches its own STEER_TTL_MS to the underlying steer message
   * (see registry.js's steer()) but never tells the TUI when that TTL lapses
   * without delivery — the "agent stays healthy/non-terminal through one
   * very long tool call, and the steer simply expires unseen in the bus"
   * case. Without this, that badge would show 'queued' forever. Optional
   * because older/hand-built badges (tests, pre-fix data) may not carry it —
   * absence just means "no TTL-expiry inference possible for this badge",
   * not an error.
   */
  readonly queuedAt?: number;
}

/**
 * Append one character of steer-composer input to a draft, normalizing a
 * pasted multi-line block's line breaks (terminals transmit bracketed-paste
 * newlines as literal `\r`/`\n` characters delivered one at a time through
 * the same per-char burst pipeline as ordinary typing — see
 * handler-feed-routes.ts's isCapturingTextBurst contract) to a single
 * collapsed space instead of either corrupting the one-line field with a
 * raw control character or silently dropping the content. Mirrors how a
 * plain single-line text input normalizes pasted newlines to whitespace.
 */
export function appendSteerText(draft: string, ch: string): string {
  if (ch === '\r' || ch === '\n') {
    if (draft.length === 0 || draft.endsWith(' ')) return draft;
    return `${draft} `;
  }
  return draft + ch;
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
  /**
   * The one-line steer composer's in-progress text, or `null`
   * when not composing. Mirrors git-panel.ts's `commitMessage` mutable-slot
   * convention (FleetPanel.isCapturingTextBurst() gates on this being
   * non-null so a burst/paste lands here char-by-char, never as tree/tab
   * hotkeys — see FleetPanel.handleSteerInput).
   */
  steerDraft: string | null;
  /** This tab's most recent steer message's lifecycle, or null. */
  steerBadge: SteerBadge | null;
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
    steerDraft: null,
    steerBadge: null,
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
