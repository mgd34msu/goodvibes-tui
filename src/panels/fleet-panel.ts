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

  public constructor(
    private readonly readModel: FleetReadModel,
    actions: Partial<FleetActionCallbacks> = {},
  ) {
    super('fleet', 'Fleet', '⊟', 'runtime-ops');
    this.showSelectionGutter = true; // W0.8: visible ▸ focus indicator
    this.actions = { ...NOOP_ACTIONS, ...actions };
    this.confirmOverlay = new PanelConfirmOverlay(() => this.markDirty());
    this.unsub = readModel.subscribe(() => {
      this.applyFollow();
      this.markDirty();
    });
  }

  public override onActivate(): void {
    super.onActivate();
    // Time-derived fields (elapsed, follow target) stay live even when no
    // registry tick fires while this panel is on screen (cockpit-panel.ts
    // STALL_TICK_MS precedent).
    if (this.tickTimer === null) {
      this.tickTimer = this.registerTimer(setInterval(() => {
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
      this.needsRender = true;
    }
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
      this.actions.interrupt(selected.node.id);
      this.markDirty();
      return true;
    }

    if (key === 'K') {
      if (!selected || isTerminalProcessState(selected.node.state)) return false;
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

    return super.handleInput(key);
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

    return this.renderList(width, height, {
      title: 'Fleet',
      footer,
      hints: [
        { keys: 'j/k', label: 'navigate' },
        { keys: 'Enter', label: 'detail' },
        { keys: 'i', label: 'interrupt' },
        { keys: 'K', label: 'kill' },
        { keys: 'f', label: this.follow ? 'follow:on' : 'follow' },
      ],
    });
  }
}
