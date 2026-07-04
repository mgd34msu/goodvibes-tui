// ---------------------------------------------------------------------------
// fleet-panel.ts
//
// W2.2 — FleetPanel: the live unified observability tree. Renders the
// registered process fleet (agents incl. WRFC roles, WRFC chains/subtasks,
// workflow-tool FSMs, watchers, background processes) as a depth-first tree
// with a selected-row detail region. Session tabs (W3.1 Part C): Enter on an
// attachable node (agent/wrfc-chain) opens a tab with that process's
// transcript/member summary — see fleet-tabs.ts + fleet-transcript.ts. This
// file owns input dispatch and layout; fleet-deep-link.ts owns the
// cross-panel jump target (DEBT-5 item 4).
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import type { Line } from '../types/grid.ts';
import type { ProcessCostState, ProcessUsage, SteerResult } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import { PanelConfirmOverlay } from './panel-confirm-overlay.ts';
import { formatAgentCost } from './agent-inspector-shared.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { isPanelSearchBackspace, isPanelSearchCancel, isPanelSearchCommit, isPanelSearchPrintable } from './search-focus.ts';
import { buildAlignedRow, buildKeyboardHints, buildPanelLine, buildPanelWorkspace, buildSearchInputLine, DEFAULT_PANEL_PALETTE, getPanelWorkspaceContentBudget, type ColumnSpec, type PanelPalette } from './polish.ts';
import {
  fleetKindTag,
  fleetUsageTokens,
  hasFleetCost,
  isRunningProcessState,
  isTerminalProcessState,
  type FleetReadModel,
  type FleetStateTone,
  type FleetTreeRow,
} from './fleet-read-model.ts';
import {
  activeFleetTab,
  appendSteerText,
  attachFleetTab,
  detachActiveFleetTab,
  EMPTY_FLEET_TABS_STATE,
  isAttachableFleetKind,
  stepFleetTab,
  type FleetTab,
  type FleetTabsState,
  type SteerBadge,
} from './fleet-tabs.ts';
import { reconcileSteerBadges as reconcileSteerBadgesPure, steerBadgeGlyph, steerBadgeTone } from './fleet-steer.ts';
import { FleetStopTracker, fleetStateDisplay, toggleFleetPause, buildFleetTreeHints } from './fleet-stop.ts';
import { resolveFleetDeepLinkIndex } from './fleet-deep-link.ts';
import { parseAgentLedger, renderFleetAgentTranscript, renderFleetChainSummary, renderFleetLedgerFallback, renderFleetTranscriptLoading } from './fleet-transcript.ts';
import { renderFleetTabStrip } from '../renderer/fleet-tab-strip.ts';

const C = DEFAULT_PANEL_PALETTE;

// Column widths for the tree row layout. `label` absorbs whatever width is
// left over after the fixed columns + gaps; on hostile (narrow) widths the
// trailing columns simply clip (buildAlignedRow/buildSelectablePanelLine stop
// writing once a cell would overflow the row) rather than throwing or
// wrapping — the tree stays readable, just denser.
const KIND_W = 8;
const ELAPSED_W = 7;
const TOKENS_W = 7;
const COST_W = 8;
const ACTIVITY_W = 20;
const GAP = 1;
const FIXED_W = 1 /* glyph */ + KIND_W + ELAPSED_W + TOKENS_W + COST_W + ACTIVITY_W + GAP * 6;

function planColumns(width: number): ColumnSpec[] {
  const labelWidth = Math.max(10, width - FIXED_W);
  return [
    { width: 1 },
    { width: KIND_W },
    { width: labelWidth },
    { width: ELAPSED_W, align: 'right' },
    { width: TOKENS_W, align: 'right' },
    { width: COST_W, align: 'right' },
    { width: ACTIVITY_W },
  ];
}

function toneColor(tone: FleetStateTone, palette: PanelPalette): string {
  switch (tone) {
    case 'active': return palette.info ?? DEFAULT_PANEL_PALETTE.info;
    case 'success': return palette.good ?? DEFAULT_PANEL_PALETTE.good;
    case 'failure': return palette.bad ?? DEFAULT_PANEL_PALETTE.bad;
    case 'warn': return palette.warn ?? DEFAULT_PANEL_PALETTE.warn;
    case 'muted': return palette.dim;
  }
}

function formatFleetTokens(usage: ProcessUsage | undefined): string {
  const total = fleetUsageTokens(usage);
  if (total === null) return 'n/a';
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
}

/** Honest cost display: never a fabricated $0.00 — 'unpriced' when costState says so. */
function formatFleetCost(costUsd: number | null | undefined, costState: ProcessCostState): string {
  if (!hasFleetCost(costUsd, costState)) return 'unpriced';
  const formatted = formatAgentCost(costUsd as number);
  return costState === 'estimated' ? `~${formatted}` : formatted;
}

export interface FleetActionCallbacks {
  /** Graceful interruption (AgentManager.cancel / trigger-schedule disable, via the registry). */
  readonly interrupt: (id: string) => boolean;
  /** Wave-6 (wo-F item d2): re-arm a `paused` node (disabled trigger/schedule or automation job) — interrupt()'s inverse. Honest false when not paused / non-resumable. */
  readonly resume: (id: string) => boolean;
  /** Hard stop, optionally cascading to killable descendants. Returns the node ids acted on. */
  readonly kill: (id: string, opts: { readonly cascade: boolean }) => readonly string[];
  /**
   * Wave-3 (C6): fetch an agent's conversation history — live (running) or
   * frozen (just-completed, still in the SDK's retention ring). Empty array
   * means "unavailable" (evicted, or never registered) — FleetPanel degrades
   * to the on-disk ledger fallback in that case, never fabricating content.
   */
  readonly getConversationSnapshot: (agentId: string) => readonly ConversationMessageSnapshot[];
  /** Wave-3 (C6): resolve the on-disk `<agentId>.jsonl` event-ledger path for the degraded fallback view. */
  readonly resolveSessionLogPath: (agentId: string) => string;
  /**
   * Wave-3 (W3.2): queue a human message for a live in-process agent (or a
   * wrfc-subtask's current live member agent), delivered at the target's
   * next turn boundary — never mid-token. Honest refusal
   * (`{queued:false,reason}`) for anything that cannot take mid-run input
   * (terminal nodes, non-agent kinds, the wrfc-chain coordinator itself).
   */
  readonly steer: (id: string, text: string) => SteerResult;
}

const NOOP_ACTIONS: FleetActionCallbacks = {
  interrupt: (_id: string) => false,
  resume: (_id: string) => false,
  kill: (_id: string, _opts: { readonly cascade: boolean }) => [],
  getConversationSnapshot: (_agentId: string) => [],
  resolveSessionLogPath: (agentId: string) => agentId,
  steer: (_id: string, _text: string) => ({ queued: false, reason: 'no live registry' }),
};

export class FleetPanel extends ScrollableListPanel<FleetTreeRow> {
  private readonly unsub: () => void;
  private readonly unsubConsumed: () => void;
  private readonly actions: FleetActionCallbacks;
  private readonly confirmOverlay: PanelConfirmOverlay;
  private follow = false;
  private tabsState: FleetTabsState = EMPTY_FLEET_TABS_STATE;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The node id the cursor is anchored to, independent of its row index.
   * `selectedIndex` is a plain offset into `getItems()`'s current order —
   * every snapshot rebuilds that array from scratch (new nodes, completed
   * nodes pruned, tree re-sorted), so a stale index silently points at
   * whatever row now happens to occupy that slot. `reanchorSelection()`
   * re-locates this id in every fresh snapshot and repoints selectedIndex
   * there; null means "no anchor yet" (follows the base class's index-0
   * default until the first navigation/tick establishes one).
   */
  private selectedNodeId: string | null = null;

  /** d1 (W6.2): the "stopping…" write-window overlay tracker (see fleet-stop.ts). */
  private readonly stopTracker = new FleetStopTracker();

  public constructor(
    private readonly readModel: FleetReadModel,
    actions: Partial<FleetActionCallbacks> = {},
    private readonly configManager: ConfigManager | null = null,
  ) {
    super('fleet', 'Fleet', '⊟', 'runtime-ops');
    this.showSelectionGutter = true; // W0.8: visible ▸ focus indicator
    this.actions = { ...NOOP_ACTIONS, ...actions };
    this.confirmOverlay = new PanelConfirmOverlay(() => this.markDirty());
    this.unsub = readModel.subscribe(() => {
      this.reanchorSelection();
      this.applyFollow();
      this.reconcileSteerBadges();
      this.markDirty();
    });
    // Wave-3 (W3.2): the honest "the agent actually consumed this steer at
    // its turn boundary" signal — see fleet-tabs.ts's SteerBadgeStatus doc.
    // A read-model without a runtimeBus dep never invokes this (graceful
    // no-op), same degrade as steer()/steerable without a messageBus dep.
    this.unsubConsumed = readModel.subscribeConsumed((event) => {
      let changed = false;
      for (const tab of this.tabsState.tabs) {
        const badge = tab.steerBadge;
        if (!badge || badge.messageId !== event.messageId) continue;
        // Consumed-wins: this real signal can still upgrade an already
        // 'dropped' (inferred) badge, as long as it hasn't linger-cleared yet.
        if (badge.status === 'queued' || badge.status === 'dropped') {
          tab.steerBadge = { messageId: badge.messageId, status: 'consumed', queuedAt: badge.queuedAt, resolvedAt: Date.now() };
          changed = true;
        }
      }
      if (changed) this.markDirty();
    });
  }

  public override onActivate(): void {
    super.onActivate();
    // Time-derived fields (elapsed, follow target) stay live even when no
    // registry tick fires while this panel is on screen (cockpit-panel.ts
    // STALL_TICK_MS precedent). Also re-anchors defensively in case the
    // underlying list changed without a subscribe notification.
    if (this.tickTimer === null) {
      this.tickTimer = this.registerTimer(setInterval(() => {
        this.reanchorSelection();
        this.applyFollow();
        this.reconcileSteerBadges();
        this.markDirty();
      }, 1000));
    }
  }

  public override onDeactivate(): void {
    super.onDeactivate();
    if (this.tickTimer !== null) {
      this.clearTimer(this.tickTimer);
      this.tickTimer = null;
    }
  }

  public override onDestroy(): void {
    super.onDestroy();
    this.unsub();
    this.unsubConsumed();
    for (const tab of this.tabsState.tabs) tab.lineCache.clear();
  }

  /** True while a session tab (not the root tree) is focused. Replaces the old Wave-2 isDetailFocused() seam. */
  public isTabActive(): boolean {
    return this.tabsState.activeTabIndex > 0;
  }

  /**
   * Wave-3 (W3.2): true while the steer composer on the active tab is open —
   * every character of a burst (paste, or several fast-typed chars in one
   * stdin chunk) must land in the draft one at a time rather than being
   * routed away as panel hotkeys or exploded to the main composer. See
   * Panel.isCapturingTextBurst's doc comment and git-panel.ts's
   * `commitMessage` precedent.
   */
  public override isCapturingTextBurst(): boolean {
    const tab = activeFleetTab(this.tabsState);
    return tab !== null && tab.steerDraft !== null;
  }

  /** Introspection for tests: the current tab-bar state (read-only). */
  public getTabsState(): FleetTabsState {
    return this.tabsState;
  }

  public isFollowing(): boolean {
    return this.follow;
  }

  /**
   * Ctrl+X (panel-close) collision resolution (Wave-3 Part C4): the global
   * shortcut route (handler-shortcuts.ts) calls this BEFORE closing the
   * panel. Detaching the active tab consumes the key; on the root tree tab
   * there is nothing to detach, so this returns false and Ctrl+X falls
   * through to its ordinary panel-close behavior.
   */
  public interceptPanelClose(): boolean {
    if (this.tabsState.activeTabIndex === 0) return false;
    this.tabsState = detachActiveFleetTab(this.tabsState);
    this.markDirty();
    return true;
  }

  protected getItems(): readonly FleetTreeRow[] {
    return this.readModel.getSnapshot().rows;
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected override getEmptyStateMessage(): string {
    return ' No processes tracked yet.';
  }

  /**
   * W3.3 (cross-restart honesty): a restart always starts from an empty
   * `AgentManager` Map (no bridge from a prior TUI/daemon registry), so a
   * completed process from a previous session can never reappear here — a
   * real, permanent limitation (W3.3 brief point 5), documented rather than
   * silently implying "nothing has ever run" or that a restart brings it back.
   */
  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      {
        command: 'previous sessions',
        summary: "not shown here — this list resets on TUI restart; each agent's .goodvibes/tui/sessions/<id>.jsonl event log still persists on disk",
      },
    ];
  }

  private applyFollow(): void {
    if (!this.follow) return;
    const rows = this.getItems();
    if (rows.length === 0) return;
    let bestIdx = -1;
    let bestStarted = -Infinity;
    rows.forEach((row, idx) => {
      if (!isRunningProcessState(row.node.state)) return;
      const started = row.node.startedAt ?? -Infinity;
      if (started >= bestStarted) {
        bestStarted = started;
        bestIdx = idx;
      }
    });
    if (bestIdx >= 0) {
      this.selectedIndex = bestIdx;
      this.selectedNodeId = rows[bestIdx]!.node.id;
      this.needsRender = true;
    }
  }

  /** Record the current selection's node id as the anchor for future snapshot updates. */
  private captureSelectionAnchor(): void {
    const item = this.getSelectedItem();
    this.selectedNodeId = item ? item.node.id : null;
  }

  /**
   * Re-locate `selectedNodeId` in the current (possibly just-changed)
   * snapshot and repoint `selectedIndex` at its new position — this is what
   * makes the selection follow a specific process across adds/removes/
   * reorders instead of drifting onto whatever row now occupies the old
   * index. When the anchored node is no longer present (completed and
   * pruned, killed and pruned, etc.) — or no anchor has been established
   * yet — falls back to the base class's clampSelection() (nearest valid
   * index, never an out-of-bounds/vanished selection) and re-anchors to
   * whatever that lands on.
   */
  private reanchorSelection(): void {
    const rows = this.getItems();
    if (this.selectedNodeId !== null) {
      const idx = rows.findIndex((row) => row.node.id === this.selectedNodeId);
      if (idx >= 0) {
        this.selectedIndex = idx;
        return;
      }
    }
    this.clampSelection();
    this.captureSelectionAnchor();
  }

  /** Find a node's live ProcessNode in the current snapshot, or null (pruned/never registered). */
  private findLiveNode(nodeId: string): FleetTreeRow['node'] | null {
    return this.getItems().find((row) => row.node.id === nodeId)?.node ?? null;
  }

  /** DEBT-5 item 4 (see fleet-deep-link.ts). */
  public receiveDeepLink(target: { readonly id: string; readonly kind?: string }): void {
    const idx = resolveFleetDeepLinkIndex(this.getItems(), target);
    if (idx < 0) { this.setError('node no longer present.'); return; }
    this.clearError(); this.selectedIndex = idx; this.selectedNodeId = target.id; this.markDirty();
  }

  /**
   * Wave-3 (W3.2, risk #2 — "dropped inference"): called on every read-model
   * snapshot update and on the panel's 1s tick. See fleet-steer.ts's
   * reconcileSteerBadges doc for why this is needed (the SDK emits no
   * cancelled/expired signal for a queued steer).
   */
  private reconcileSteerBadges(): void {
    if (this.tabsState.tabs.length === 0) return;
    const changed = reconcileSteerBadgesPure(this.tabsState.tabs, (id) => this.findLiveNode(id), Date.now());
    if (changed) this.markDirty();
  }

  /** Count of descendants of `nodeId` (in the current snapshot) that report `capabilities.killable` — the Wave-3 K-confirm child count (Part C7). */
  private countKillableDescendants(nodeId: string): number {
    const rows = this.getItems();
    const byParent = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.node.parentId) continue;
      const siblings = byParent.get(row.node.parentId) ?? [];
      siblings.push(row.node.id);
      byParent.set(row.node.parentId, siblings);
    }
    const byId = new Map(rows.map((row) => [row.node.id, row] as const));
    let count = 0;
    const stack = [...(byParent.get(nodeId) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const row = byId.get(id);
      if (row?.node.capabilities.killable) count++;
      for (const child of byParent.get(id) ?? []) stack.push(child);
    }
    return count;
  }

  /** Kick off (once) the async ledger-fallback load for a tab whose conversation snapshot is unavailable. */
  private ensureLedgerLoaded(tab: FleetTab): void {
    if (tab.ledgerLoadStarted) return;
    tab.ledgerLoadStarted = true;
    const path = this.actions.resolveSessionLogPath(tab.agentId);
    readFile(path, 'utf-8')
      .then((raw) => {
        tab.ledgerEntries = parseAgentLedger(raw);
        this.markDirty();
      })
      .catch(() => {
        tab.ledgerEntries = [];
        this.markDirty();
      });
  }

  public override handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    // Confirm overlay owns input first (K-armed kill confirm).
    if (this.confirmOverlay.handleInput(key)) return true;

    // Wave-3 (W3.2): once the steer composer is open on the active tab, it
    // owns EVERY key (same full-priority-while-composing contract as
    // git-panel.ts's commitMessage entry) until Enter (submit) or Esc
    // (cancel) — a burst/paste and single hotkeys like 'j'/'s'/'[' all land
    // in the draft, never as tree/tab navigation (W0.8 focus rule).
    const composingTab = activeFleetTab(this.tabsState);
    if (composingTab && composingTab.steerDraft !== null) {
      return this.handleSteerInput(composingTab, key);
    }

    // Tab switching works from ANY view (root tree or an attached tab) once
    // at least one tab is open — [ / ] step through Tree, tab 1, tab 2, ...
    // Ctrl+X detach is handled by interceptPanelClose(), not handleInput (it
    // must win a global-shortcut race — see that method's doc comment).
    if ((key === '[' || key === ']') && this.tabsState.tabs.length > 0) {
      this.tabsState = stepFleetTab(this.tabsState, key === ']' ? 1 : -1);
      this.markDirty();
      return true;
    }

    if (this.tabsState.activeTabIndex > 0) {
      if (key === 's') {
        return this.tryOpenSteerDraft(activeFleetTab(this.tabsState)!);
      }
      // A session tab is focused — the tree isn't visible, so tree-only keys
      // (navigate/i/K/f/Enter) don't apply here.
      return false;
    }

    const selected = this.getSelectedItem();

    if (key === 'i') {
      // Guard: only consume on a real, non-terminal node (cockpit-panel.ts
      // precedent) so the key falls through when there is nothing to act on.
      if (!selected || isTerminalProcessState(selected.node.state)) return false;
      // Not every kind can be interrupted (only 'agent' nodes ever are — see
      // the SDK's fleet adapters: schedule/trigger/watcher/workflow/
      // wrfc-chain/wrfc-subtask/background-process all report
      // capabilities.interruptible: false unconditionally). Consume the key
      // and say so rather than silently calling interrupt() on a node the
      // registry has no interrupt route for.
      if (!selected.node.capabilities.interruptible) {
        this.setError(`${selected.node.kind} does not support interrupt.`);
        return true;
      }
      this.actions.interrupt(selected.node.id);
      this.stopTracker.mark(selected.node.id);
      this.markDirty();
      return true;
    }

    if (key === 'K') {
      if (!selected || isTerminalProcessState(selected.node.state)) return false;
      if (!selected.node.capabilities.killable) {
        this.setError(`${selected.node.kind} does not support kill.`);
        return true;
      }
      const node = selected.node;
      const shortId = node.id.length > 8 ? node.id.slice(-8) : node.id;
      const childCount = this.countKillableDescendants(node.id);
      const suffix = childCount > 0 ? ` (+${childCount} child${childCount === 1 ? '' : 'ren'})` : '';
      this.confirmOverlay.arm({
        id: node.id,
        label: `${node.kind} ${shortId}${suffix}`,
        verb: 'Kill',
        // d1 (W6.2): mark 'stopping…' only once the kill is confirmed, not while
        // the confirm overlay is merely armed.
        onConfirm: () => {
          this.actions.kill(node.id, { cascade: true });
          this.stopTracker.mark(node.id);
        },
      });
      return true;
    }

    // d2 (W6.2): 'p' toggles pause<->resume by the selected node's state (see
    // toggleFleetPause in fleet-stop.ts).
    if (key === 'p') {
      if (!selected) return false;
      return toggleFleetPause(selected.node, {
        interrupt: (id) => this.actions.interrupt(id),
        resume: (id) => this.actions.resume(id),
        setError: (m) => this.setError(m),
        markDirty: () => this.markDirty(),
        tracker: this.stopTracker,
      });
    }

    if (key === 'f') {
      this.follow = !this.follow;
      if (this.follow) this.applyFollow();
      this.markDirty();
      return true;
    }

    if (key === 'enter' || key === 'return') {
      if (!selected) return false;
      const node = selected.node;
      if (!isAttachableFleetKind(node.kind)) {
        this.setError(`${node.kind} has no transcript to attach.`);
        return true;
      }
      this.tabsState = attachFleetTab(this.tabsState, node);
      this.markDirty();
      return true;
    }

    const consumed = super.handleInput(key);
    if (consumed) this.captureSelectionAnchor();
    return consumed;
  }

  /**
   * Wave-3 (W3.2): the `s` gate — mirrors the i/K capability-gating template
   * exactly (guard on the live node existing, non-terminal, and the specific
   * capability; consume the key and say so rather than silently no-op-ing).
   */
  private tryOpenSteerDraft(tab: FleetTab): boolean {
    const node = this.findLiveNode(tab.nodeId);
    if (!node || isTerminalProcessState(node.state) || !node.capabilities.steerable) {
      this.setError(`${node?.kind ?? tab.kind} does not support steering.`);
      return true;
    }
    tab.steerDraft = '';
    this.markDirty();
    return true;
  }

  /** Dispatch for the open steer composer — mirrors git-panel.ts's handleCommitMessageInput. */
  private handleSteerInput(tab: FleetTab, key: string): boolean {
    if (isPanelSearchCancel(key)) {
      tab.steerDraft = null;
      this.markDirty();
      return true;
    }
    if (isPanelSearchCommit(key)) {
      const text = (tab.steerDraft ?? '').trim();
      tab.steerDraft = null;
      if (text.length > 0) this.submitSteer(tab, text);
      this.markDirty();
      return true;
    }
    if (isPanelSearchBackspace(key)) {
      tab.steerDraft = (tab.steerDraft ?? '').slice(0, -1);
      this.markDirty();
      return true;
    }
    // Ordinary typing AND a pasted multi-line block's line-break characters
    // (delivered one at a time through the same burst pipeline — see
    // isCapturingTextBurst) both flow through appendSteerText, which
    // normalizes \r/\n to a collapsed space instead of corrupting the
    // one-line field or silently dropping the content.
    if (key.length === 1 && (isPanelSearchPrintable(key) || key === '\r' || key === '\n')) {
      tab.steerDraft = appendSteerText(tab.steerDraft ?? '', key);
      this.markDirty();
      return true;
    }
    return true; // absorb every other key while composing
  }

  /** Submit a composed steer message: queued -> badge; refused -> honest inline error (setError), same convention as the i/K "not supported" messages. */
  private submitSteer(tab: FleetTab, text: string): void {
    const result = this.actions.steer(tab.nodeId, text);
    if (result.queued) {
      // queuedAt drives reconcileSteerBadges' TTL-expiry fallback (fleet-steer.ts).
      tab.steerBadge = { messageId: result.messageId, status: 'queued', queuedAt: Date.now() };
    } else {
      this.setError(result.reason);
    }
    this.markDirty();
  }

  protected renderItem(row: FleetTreeRow, _index: number, _selected: boolean, width: number): Line {
    const node = row.node;
    // d1: while a stop is in flight, fleetStateDisplay overrides the state
    // glyph/label/tone with a display-only 'stopping…' so the row never claims
    // the past-tense outcome before the state has actually flipped.
    const stopping = this.stopTracker.isStopping(node.id);
    const disp = fleetStateDisplay(node.state, stopping);
    const color = toneColor(disp.tone, C);
    const label = `${row.treePrefix}${node.label}`;
    const badge = this.steerBadgeForNode(node.id);
    const activity = stopping
      ? disp.label
      : badge
        ? `${steerBadgeGlyph(badge.status)} ${node.currentActivity?.text ?? ''}`.trimEnd()
        : (node.currentActivity?.text ?? '');
    const activityColor = stopping ? color : badge ? steerBadgeTone(badge.status, C) : C.dim;

    return buildAlignedRow(
      width,
      [
        { text: disp.glyph, fg: color },
        { text: fleetKindTag(node.kind), fg: C.dim },
        { text: label, fg: C.value },
        { text: formatElapsed(node.elapsedMs), fg: C.dim },
        { text: formatFleetTokens(node.usage), fg: C.dim },
        { text: formatFleetCost(node.costUsd, node.costState), fg: C.value },
        { text: activity, fg: activityColor },
      ],
      planColumns(width),
    );
  }

  /** A node's steer badge, looked up via its attached tab (if any) — null when the node has no tab or no active/recent steer. */
  private steerBadgeForNode(nodeId: string): SteerBadge | null {
    return this.tabsState.tabs.find((t) => t.nodeId === nodeId)?.steerBadge ?? null;
  }

  private renderDetail(row: FleetTreeRow, width: number): Line[] {
    const node = row.node;
    // d1: mirror the tree row's 'stopping…' override so the literal state text
    // never claims 'killed' mid-write either.
    const disp = fleetStateDisplay(node.state, this.stopTracker.isStopping(node.id));
    const color = toneColor(disp.tone, C);

    const line1 = buildPanelLine(width, [
      [' ', C.dim],
      [disp.glyph, color],
      [` ${node.kind}`, C.dim],
      ['  id ', C.label],
      [node.id, C.value],
      ['  state ', C.label],
      [disp.label, color],
      ['  elapsed ', C.label],
      [formatElapsed(node.elapsedMs), C.value],
    ]);
    const line2 = buildPanelLine(width, [
      [' model ', C.label],
      [node.model ?? 'unknown', C.info],
      ['  tokens ', C.label],
      [formatFleetTokens(node.usage), C.value],
      ['  cost ', C.label],
      [formatFleetCost(node.costUsd, node.costState), C.value],
    ]);
    const activityText = node.currentActivity
      ? `${node.currentActivity.kind}: ${node.currentActivity.text}`
      : '(no recent activity)';
    const line3 = buildPanelLine(width, [
      [' activity ', C.label],
      [truncateDisplay(activityText, Math.max(0, width - 11)), C.dim],
    ]);
    // Wave 3 hook: approval history attaches here once session tabs land.
    const line4 = buildPanelLine(width, [
      [' approvals ', C.label],
      ['(Wave 3)', C.dim],
    ]);
    return [line1, line2, line3, line4];
  }

  /** Renders the active session tab's content (transcript / chain summary / ledger fallback) in place of the tree. */
  private renderTabView(width: number, height: number): Line[] {
    const palette = this.getPalette();
    const tab = activeFleetTab(this.tabsState);
    if (!tab) return this.renderTreeView(width, height); // defensive; should be unreachable
    const stripLine = renderFleetTabStrip(this.tabsState, width);

    const snapshotRows = this.readModel.getSnapshot().rows;
    const liveNode = snapshotRows.find((row) => row.node.id === tab.nodeId)?.node ?? null;
    // Wave-3 (W3.2): the steer composer only ever applies to 'agent' tabs
    // (wrfc-chain has no conversation loop of its own — see
    // fleet-tabs.ts's FleetAttachableKind doc); the live-node lookup is
    // shared with the isTerminal computation below either way.
    const canSteer = liveNode !== null && !isTerminalProcessState(liveNode.state) && liveNode.capabilities.steerable;

    // Wave-3 (W3.2): while composing, Enter/Esc replace the tab-switch/detach
    // hints (mirrors git-panel.ts's renderCommitCompose footer) so the
    // footer never advertises a key the composer itself has absorbed.
    const hints: Array<{ keys: string; label: string }> = tab.steerDraft !== null
      ? [{ keys: 'Enter', label: 'send' }, { keys: 'Esc', label: 'cancel' }]
      : [
        { keys: '[ ]', label: 'switch tab' },
        { keys: 'Ctrl+X', label: 'detach' },
        ...(canSteer ? [{ keys: 's', label: 'steer' }] : []),
      ];

    const errorLine = this.renderErrorLine(width);
    const composerLines: Line[] = [];
    if (tab.steerDraft !== null) {
      composerLines.push(buildSearchInputLine(
        width,
        'Steer: ',
        `${tab.steerDraft}_`,
        palette,
        { active: true, bg: palette.inputBg, valueColor: palette.info },
      ));
    } else if (tab.steerBadge) {
      composerLines.push(this.renderSteerBadgeLine(tab.steerBadge, width, palette));
    }

    const footerLines = [
      ...(errorLine ? [errorLine] : []),
      ...composerLines,
      buildKeyboardHints(width, hints, palette),
    ];
    const contentBudget = getPanelWorkspaceContentBudget(width, height, { footerLines, palette });
    const contentHeight = Math.max(1, contentBudget - (stripLine ? 1 : 0));

    let contentLines: Line[];

    if (tab.kind === 'wrfc-chain') {
      const memberRows = snapshotRows.filter((row) => row.node.parentId === tab.nodeId);
      // d3 (W6.2): a completed chain prunes its wrapper node, so an empty member
      // list can mean "finished", not "not started yet". Absent (pruned) OR
      // terminal => the honest "completed" wording; present + non-terminal with
      // no members yet => the "not started" wording.
      const chainDoneOrAbsent = liveNode === null || isTerminalProcessState(liveNode.state);
      contentLines = renderFleetChainSummary(memberRows, width, chainDoneOrAbsent);
    } else {
      const isTerminal = liveNode ? isTerminalProcessState(liveNode.state) : true;
      const snapshot = this.actions.getConversationSnapshot(tab.agentId);
      const result = renderFleetAgentTranscript(snapshot, isTerminal, tab.lineCache, width, contentHeight, this.configManager);
      if (result.mode === 'unavailable') {
        this.ensureLedgerLoaded(tab);
        contentLines = tab.ledgerEntries !== null
          ? renderFleetLedgerFallback(tab.ledgerEntries, width, contentHeight)
          : renderFleetTranscriptLoading(width);
      } else {
        contentLines = result.lines;
      }
    }

    const sections = [
      ...(stripLine ? [{ lines: [stripLine] }] : []),
      { lines: contentLines },
    ];
    return buildPanelWorkspace(width, height, { title: `Fleet — ${tab.label}`, sections, footerLines, palette });
  }

  /** One-line honest status for the active tab's steer badge (queued/consumed/dropped) — see fleet-tabs.ts's SteerBadgeStatus doc. */
  private renderSteerBadgeLine(badge: SteerBadge, width: number, palette: PanelPalette): Line {
    const glyph = steerBadgeGlyph(badge.status);
    const tone = steerBadgeTone(badge.status, palette);
    const label = badge.status === 'queued'
      ? 'steer queued — awaiting the agent\'s next turn'
      : badge.status === 'consumed'
        ? 'steer consumed'
        : `steer dropped — ${badge.note ?? 'the target ended before delivery'}`;
    return buildPanelLine(width, [
      [' ', palette.dim],
      [glyph, tone],
      [` ${label}`, palette.dim],
    ]);
  }

  private renderTreeView(width: number, height: number): Line[] {
    const selected = this.getSelectedItem();
    const footer: Line[] = [];
    if (this.confirmOverlay.pending) {
      footer.push(...(this.confirmOverlay.renderLines(width) ?? []));
    } else if (selected) {
      footer.push(...this.renderDetail(selected, width));
    }

    // Capability-gated tree hints — only advertise i/K/p when the selected node
    // can actually accept them (most kinds are never interruptible; nothing is
    // killable once terminal), incl. the d2 state-dependent p pause/resume chip.
    // Mirrors the handleInput guards above. See buildFleetTreeHints (fleet-stop.ts).
    const hints = buildFleetTreeHints(selected?.node, this.follow, this.tabsState.tabs.length > 0);

    // Tab strip renders only when tabs exist — omitting it entirely with no
    // tabs attached keeps the pre-Wave-3 root-tree rendering byte-identical.
    const stripLine = renderFleetTabStrip(this.tabsState, width);
    const header = stripLine ? [stripLine] : undefined;

    return this.renderList(width, height, {
      title: 'Fleet',
      header,
      footer,
      hints,
    });
  }

  public override render(width: number, height: number): Line[] {
    if (this.tabsState.activeTabIndex > 0) return this.renderTabView(width, height);
    return this.renderTreeView(width, height);
  }
}
