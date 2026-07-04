// ---------------------------------------------------------------------------
// fleet-panel.ts
//
// W2.2 — FleetPanel: the live unified observability tree. Renders the
// registered process fleet (agents incl. WRFC roles, WRFC chains/subtasks,
// workflow-tool FSMs, watchers, background processes) as a depth-first tree
// with a selected-row detail region.
//
// Coexists with (does not replace) the process modal, ops, wrfc, and
// inspector entry points this wave — only the footer process indicator's
// [Enter] is repointed to open this panel (see handler-feed-routes.ts).
// Removal of the older entry points is Wave 6.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import type { ProcessCostState, ProcessUsage } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import { PanelConfirmOverlay } from './panel-confirm-overlay.ts';
import { formatAgentCost } from './agent-inspector-shared.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildAlignedRow,
  buildPanelLine,
  DEFAULT_PANEL_PALETTE,
  type ColumnSpec,
  type PanelPalette,
} from './polish.ts';
import {
  fleetKindTag,
  fleetStateGlyph,
  fleetStateTone,
  fleetUsageTokens,
  hasFleetCost,
  isRunningProcessState,
  isTerminalProcessState,
  type FleetReadModel,
  type FleetStateTone,
  type FleetTreeRow,
} from './fleet-read-model.ts';

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
  /** Hard stop, optionally cascading to killable descendants. Returns the node ids acted on. */
  readonly kill: (id: string, opts: { readonly cascade: boolean }) => readonly string[];
}

const NOOP_ACTIONS: FleetActionCallbacks = {
  interrupt: (_id: string) => false,
  kill: (_id: string, _opts: { readonly cascade: boolean }) => [],
};

export class FleetPanel extends ScrollableListPanel<FleetTreeRow> {
  private readonly unsub: () => void;
  private readonly actions: FleetActionCallbacks;
  private readonly confirmOverlay: PanelConfirmOverlay;
  private follow = false;
  private detailFocused = false;
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

  public constructor(
    private readonly readModel: FleetReadModel,
    actions: Partial<FleetActionCallbacks> = {},
  ) {
    super('fleet', 'Fleet', '⊟', 'runtime-ops');
    this.showSelectionGutter = true; // W0.8: visible ▸ focus indicator
    this.actions = { ...NOOP_ACTIONS, ...actions };
    this.confirmOverlay = new PanelConfirmOverlay(() => this.markDirty());
    this.unsub = readModel.subscribe(() => {
      this.reanchorSelection();
      this.applyFollow();
      this.markDirty();
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
  }

  /** True once Enter has focused the selected row's detail (Wave-3 tab-attach seam). */
  public isDetailFocused(): boolean {
    return this.detailFocused;
  }

  public isFollowing(): boolean {
    return this.follow;
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

  public override handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    // Confirm overlay owns input first (K-armed kill confirm).
    if (this.confirmOverlay.handleInput(key)) return true;

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
      this.confirmOverlay.arm({
        id: node.id,
        label: `${node.kind} ${shortId}`,
        verb: 'Kill',
        onConfirm: () => { this.actions.kill(node.id, { cascade: true }); },
      });
      return true;
    }

    if (key === 'f') {
      this.follow = !this.follow;
      if (this.follow) this.applyFollow();
      this.markDirty();
      return true;
    }

    if (key === 'enter' || key === 'return') {
      if (!selected) return false;
      // Wave 3: attach session tab here (selected.node.id is the stable attach handle).
      this.detailFocused = true;
      this.markDirty();
      return true;
    }

    const consumed = super.handleInput(key);
    if (consumed) this.captureSelectionAnchor();
    return consumed;
  }

  protected renderItem(row: FleetTreeRow, _index: number, _selected: boolean, width: number): Line {
    const node = row.node;
    const tone = fleetStateTone(node.state);
    const color = toneColor(tone, C);
    const label = `${row.treePrefix}${node.label}`;
    const activity = node.currentActivity?.text ?? '';

    return buildAlignedRow(
      width,
      [
        { text: fleetStateGlyph(node.state), fg: color },
        { text: fleetKindTag(node.kind), fg: C.dim },
        { text: label, fg: C.value },
        { text: formatElapsed(node.elapsedMs), fg: C.dim },
        { text: formatFleetTokens(node.usage), fg: C.dim },
        { text: formatFleetCost(node.costUsd, node.costState), fg: C.value },
        { text: activity, fg: C.dim },
      ],
      planColumns(width),
    );
  }

  private renderDetail(row: FleetTreeRow, width: number): Line[] {
    const node = row.node;
    const color = toneColor(fleetStateTone(node.state), C);

    const line1 = buildPanelLine(width, [
      [' ', C.dim],
      [fleetStateGlyph(node.state), color],
      [` ${node.kind}`, C.dim],
      ['  id ', C.label],
      [node.id, C.value],
      ['  state ', C.label],
      [node.state, color],
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

  public override render(width: number, height: number): Line[] {
    const selected = this.getSelectedItem();
    const footer: Line[] = [];
    if (this.confirmOverlay.pending) {
      footer.push(...(this.confirmOverlay.renderLines(width) ?? []));
    } else if (selected) {
      footer.push(...this.renderDetail(selected, width));
    }

    // Only advertise i/K when the selected node can actually accept them —
    // most kinds (schedule/trigger/watcher/workflow/wrfc-chain/wrfc-subtask/
    // background-process) are never interruptible, and any kind stops being
    // killable once terminal. Matches the handleInput guards above.
    const canInterrupt = selected !== undefined
      && !isTerminalProcessState(selected.node.state)
      && selected.node.capabilities.interruptible;
    const canKill = selected !== undefined
      && !isTerminalProcessState(selected.node.state)
      && selected.node.capabilities.killable;

    const hints: Array<{ keys: string; label: string }> = [
      { keys: 'j/k', label: 'navigate' },
      { keys: 'Enter', label: 'detail' },
    ];
    if (canInterrupt) hints.push({ keys: 'i', label: 'interrupt' });
    if (canKill) hints.push({ keys: 'K', label: 'kill' });
    hints.push({ keys: 'f', label: this.follow ? 'follow:on' : 'follow' });

    return this.renderList(width, height, {
      title: 'Fleet',
      footer,
      hints,
    });
  }
}
