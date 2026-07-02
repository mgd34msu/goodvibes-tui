/**
 * OrchestrationPanel — displays task graphs, node contracts, recursion guards,
 * and WRFC-visible orchestration state.
 *
 * Migrated (Wave B2): extends ScrollableListPanel<OrchestrationGraphRecord>.
 * Navigation (up/down/j/k) is handled by the base class.
 */

import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { UiOrchestrationSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import type { OrchestrationGraphRecord, OrchestrationNodeRecord } from '@/runtime/index.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import {
  buildEmptyState,
  buildKeyboardHints,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  type PanelPalette,
  type PanelWorkspaceSection,
} from './polish.ts';

// Domain accents only; base chrome (header/headerBg/info/good/warn/bad/
// selectBg) comes from DEFAULT_PANEL_PALETTE.
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  completed: '#a78bfa',   // completed-graph badge, distinct from running/good
} as const);

function statusColor(status: string): string {
  switch (status) {
    case 'ready':     return C.info;
    case 'running':   return C.good;
    case 'blocked':   return C.warn;
    case 'failed':    return C.bad;
    case 'completed': return C.completed;
    default:          return C.dim;
  }
}

/** One captured recursion-guard trip — built locally from `lastRecursionGuard` deltas (WO-131: the domain state only keeps the most recent trip per graph plus a running counter, no history list). */
interface GuardTripRecord {
  readonly graphId: string;
  readonly graphTitle: string;
  readonly depth: number;
  readonly activeAgents: number;
  readonly reason: string;
  readonly nodeId?: string | undefined;
  readonly triggeredAt: number;
}

const MAX_GUARD_TRIP_HISTORY = 50;

/** The cross-panel jump Enter dispatches for a focused node, consumed by the panel-integration router. */
export interface OrchestrationNodeJump {
  readonly kind: 'agent-jump' | 'task-jump';
  readonly id: string;
}

function nodesOf(graph: OrchestrationGraphRecord): OrchestrationNodeRecord[] {
  return graph.nodeOrder
    .map((nodeId) => graph.nodes.get(nodeId))
    .filter((node): node is OrchestrationNodeRecord => Boolean(node));
}

export class OrchestrationPanel extends ScrollableListPanel<OrchestrationGraphRecord> {
  private readonly readModel?: UiReadModel<UiOrchestrationSnapshot>;
  private readonly unsub: (() => void) | null;

  /** Stabilizes selection across re-sorts (new graphs prepend by createdAt) — keyed by graph id, not raw index. */
  private _selectedGraphId: string | null = null;

  /** Tab toggles which list up/down drives. */
  private _focus: 'graph' | 'node' = 'graph';
  /** Cursor within the selected graph's node list; persists across focus toggles. */
  private _nodeCursor = 0;

  /** Recursion-guard trip history accumulated from `lastRecursionGuard` deltas across all graphs, newest first. */
  private _guardTripHistory: GuardTripRecord[] = [];
  private readonly _seenGuardTripAt = new Map<string, number>();

  /** Set by handleInput('enter') while node-focused; consumed by the panel-integration router immediately after. */
  private _pendingNodeJump: OrchestrationNodeJump | null = null;

  public constructor(readModel?: UiReadModel<UiOrchestrationSnapshot>) {
    super('orchestration', 'Orchestration', 'Q', 'monitoring');
    this.readModel = readModel;
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  // ---------------------------------------------------------------------------
  // ScrollableListPanel contract
  // ---------------------------------------------------------------------------

  protected getItems(): readonly OrchestrationGraphRecord[] {
    if (!this.readModel) return [];
    return [...this.readModel.getSnapshot().graphs].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Keeps `selectedIndex` pointed at the same graph id after a re-sort (e.g. a new graph prepends). */
  private _syncSelectionFromId(graphs: readonly OrchestrationGraphRecord[]): void {
    if (this._selectedGraphId) {
      const idx = graphs.findIndex((g) => g.id === this._selectedGraphId);
      if (idx >= 0) {
        this.selectedIndex = idx;
        return;
      }
    }
    this.selectedIndex = graphs.length === 0 ? 0 : Math.min(this.selectedIndex, graphs.length - 1);
    this._selectedGraphId = graphs[this.selectedIndex]?.id ?? null;
  }

  /** Appends any newly-observed recursion-guard trips (across all graphs) to the local history list. */
  private _captureGuardTrips(): void {
    if (!this.readModel) return;
    for (const graph of this.readModel.getSnapshot().graphs) {
      const trip = graph.lastRecursionGuard;
      if (!trip) continue;
      if (this._seenGuardTripAt.get(graph.id) === trip.triggeredAt) continue;
      this._seenGuardTripAt.set(graph.id, trip.triggeredAt);
      this._guardTripHistory.unshift({
        graphId: graph.id,
        graphTitle: graph.title,
        depth: trip.depth,
        activeAgents: trip.activeAgents,
        reason: trip.reason,
        nodeId: trip.nodeId,
        triggeredAt: trip.triggeredAt,
      });
    }
    if (this._guardTripHistory.length > MAX_GUARD_TRIP_HISTORY) {
      this._guardTripHistory.length = MAX_GUARD_TRIP_HISTORY;
    }
  }

  protected renderItem(
    graph: OrchestrationGraphRecord,
    index: number,
    selected: boolean,
    width: number,
  ): Line {
    const bg = selected ? C.selectBg : undefined;
    const marker = selected ? '▸ ' : '  ';
    const nodeCount = `${graph.nodeOrder.length}n`;
    // Reserve room for marker(2) + status(10) + mode(17) + id(8) + nodes(~5) + gaps.
    const titleBudget = Math.max(0, width - 47);
    return buildPanelLine(width, [
      [marker, selected ? C.value : C.dim, bg],
      [graph.status.padEnd(10), statusColor(graph.status), bg],
      [` ${graph.mode.padEnd(17)}`, C.value, bg],
      [` ${graph.id.slice(0, 8)} `, C.dim, bg],
      [`${nodeCount.padStart(4)} `, C.dim, bg],
      [truncateDisplay(graph.title, titleBudget), C.value, bg],
    ]);
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected override getEmptyStateMessage(): string {
    return ' No orchestration graphs recorded yet.';
  }

  // ---------------------------------------------------------------------------
  // Input — Tab switches graph-list/node-list focus; up/down drives whichever
  // list has focus; Enter on a focused node jumps to the Inspector (agent
  // nodes) or Tasks (task-backed nodes) via the panel-integration router.
  // ---------------------------------------------------------------------------

  public override handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    const graphs = this.getItems();
    this._syncSelectionFromId(graphs);
    const selectedGraph = graphs[this.selectedIndex];
    const nodes = selectedGraph ? nodesOf(selectedGraph) : [];

    if (key === 'tab') {
      if (nodes.length === 0) return false;
      this._focus = this._focus === 'graph' ? 'node' : 'graph';
      this._nodeCursor = Math.min(this._nodeCursor, Math.max(0, nodes.length - 1));
      this.markDirty();
      return true;
    }

    if (this._focus === 'node' && nodes.length > 0) {
      switch (key) {
        case 'up':
        case 'k':
          this._nodeCursor = Math.max(0, this._nodeCursor - 1);
          this.markDirty();
          return true;
        case 'down':
        case 'j':
          this._nodeCursor = Math.min(nodes.length - 1, this._nodeCursor + 1);
          this.markDirty();
          return true;
        case 'enter':
        case 'return': {
          const node = nodes[this._nodeCursor];
          if (node?.agentId) {
            this._pendingNodeJump = { kind: 'agent-jump', id: node.agentId };
            return true;
          }
          if (node?.taskId) {
            this._pendingNodeJump = { kind: 'task-jump', id: node.taskId };
            return true;
          }
          return false;
        }
        default:
          return false;
      }
    }

    const consumed = super.handleInput(key);
    if (consumed) {
      const refreshed = this.getItems();
      this._selectedGraphId = refreshed[this.selectedIndex]?.id ?? this._selectedGraphId;
      // A different graph is selected — the node cursor no longer refers to a
      // meaningful row until Tab re-engages node focus for the new graph.
      this._focus = 'graph';
      this._nodeCursor = 0;
    }
    return consumed;
  }

  /**
   * Consumed by the panel-integration router immediately after handleInput
   * returns true for the same Enter keystroke while node-focused.
   */
  public consumePendingNodeJump(): OrchestrationNodeJump | null {
    const pending = this._pendingNodeJump;
    this._pendingNodeJump = null;
    return pending;
  }

  // ---------------------------------------------------------------------------
  // Render — multi-section layout (posture + scrollable graphs + detail + nodes)
  // ---------------------------------------------------------------------------

  public render(width: number, height: number): Line[] {
    const intro = 'Task graphs, node contracts, recursion guards, and WRFC-visible orchestration state.';

    if (!this.readModel) {
      this.needsRender = false;
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Orchestration Control Room',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Runtime store not wired into this panel yet.',
            'The orchestration workspace needs the live runtime store before it can show graphs, nodes, and recursion guard events.',
            [],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    this._captureGuardTrips();

    const snapshot = this.readModel.getSnapshot();
    const graphs = this.getItems();
    this._syncSelectionFromId(graphs);
    const postureLines = [
      buildKeyValueLine(width, [
        { label: 'graphs', value: String(snapshot.totalGraphs), valueColor: snapshot.totalGraphs > 0 ? C.value : C.dim },
        { label: 'active', value: String(snapshot.activeGraphIds.length), valueColor: snapshot.activeGraphIds.length > 0 ? C.good : C.dim },
        { label: 'completed', value: String(snapshot.totalCompletedGraphs), valueColor: snapshot.totalCompletedGraphs > 0 ? C.completed : C.dim },
        { label: 'failed', value: String(snapshot.totalFailedGraphs), valueColor: snapshot.totalFailedGraphs > 0 ? C.bad : C.dim },
        { label: 'guards', value: String(snapshot.recursionGuardTrips), valueColor: snapshot.recursionGuardTrips > 0 ? C.warn : C.dim },
      ], C),
    ];
    if (graphs.length === 0) {
      this.needsRender = false;
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Orchestration Control Room',
        intro,
        sections: [{
          title: 'Orchestration posture',
          lines: [
            ...postureLines,
            ...buildEmptyState(
              width,
              this.getEmptyStateMessage(),
              'Graphs, nodes, child contracts, and recursion guard trips will appear here as orchestration starts.',
              [
                { command: '/tasks', summary: 'create or inspect task flows that feed orchestration graphs' },
                { command: '/communication', summary: 'review structured agent communication alongside graph execution' },
              ],
              C,
            ),
          ],
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    this.clampSelection();
    const selected = graphs[this.selectedIndex]!;
    const isActive = snapshot.activeGraphIds.includes(selected.id);
    const elapsed = selected.startedAt
      ? formatElapsed(Math.max(0, (selected.endedAt ?? Date.now()) - selected.startedAt))
      : 'n/a';
    const detailLines: Line[] = [
      buildPanelLine(width, [
        ['  Title: ', C.label],
        [truncateDisplay(selected.title, Math.max(0, width - 11)), C.value],
      ]),
      buildPanelLine(width, [
        ['  Status: ', C.label],
        [selected.status, statusColor(selected.status)],
        ['  Mode: ', C.label],
        [selected.mode, C.value],
        ['  Live: ', C.label],
        [isActive ? 'yes' : 'no', isActive ? C.good : C.dim],
      ]),
      buildPanelLine(width, [
        ['  Nodes: ', C.label],
        [String(selected.nodeOrder.length), C.value],
        ['  Started: ', C.label],
        [selected.startedAt ? new Date(selected.startedAt).toLocaleTimeString() : 'n/a', C.dim],
        ['  Ended: ', C.label],
        [selected.endedAt ? new Date(selected.endedAt).toLocaleTimeString() : 'n/a', C.dim],
        ['  Duration: ', C.label],
        [elapsed, C.dim],
      ]),
    ];

    const nodes = nodesOf(selected);
    const nodeCursor = Math.min(this._nodeCursor, Math.max(0, nodes.length - 1));
    const focusNode = nodes[nodeCursor];
    detailLines.push(...this._buildNodeContractLines(width, focusNode));

    const nodeLines: Line[] = nodes.length === 0
      ? [buildPanelLine(width, [['  No nodes recorded yet.', C.dim]])]
      : nodes.map((node, idx) => {
          const isNodeCursor = this._focus === 'node' && idx === nodeCursor;
          const bg = isNodeCursor ? C.selectBg : undefined;
          const marker = isNodeCursor ? '▸ ' : '  ';
          const depends = node.dependencyNodeIds.length > 0 ? ` deps:${node.dependencyNodeIds.length}` : '';
          return buildPanelLine(width, [
            [marker, isNodeCursor ? C.value : C.label, bg],
            [node.status.padEnd(10), statusColor(node.status), bg],
            [` ${node.role.padEnd(10)}`, C.value, bg],
            [` ${node.id.slice(0, 8)} `, C.dim, bg],
            [truncateDisplay(`${node.title}${depends}`, Math.max(0, width - 36)), C.value, bg],
          ]);
        });

    const guardTripLines: Line[] = this._guardTripHistory.slice(0, 5).map((trip) => buildPanelLine(width, [
      [` ${new Date(trip.triggeredAt).toLocaleTimeString()} `, C.dim],
      [truncateDisplay(trip.graphTitle, Math.max(0, width - 60)), C.value],
      [`  depth ${trip.depth} active ${trip.activeAgents}`, C.warn],
      [` ${truncateDisplay(trip.reason, Math.max(0, width - 50))}`, C.dim],
    ]));

    const scrollableLines: Line[] = graphs.map((graph, index) =>
      this.renderItem(graph, index, index === this.selectedIndex, width),
    );

    // Context-aware footer: surface position + only the keys that work in the
    // currently-focused list (graph list vs node list).
    const footerLines: Line[] = [
      buildKeyboardHints(width, [
        { keys: `${this.selectedIndex + 1}/${graphs.length}`, label: 'graph' },
        ...(nodes.length > 0 ? [{ keys: 'Tab', label: this._focus === 'node' ? 'graph focus' : 'node focus' }] : []),
        ...(this._focus === 'node'
          ? [{ keys: '↑/↓', label: 'node' }, { keys: 'Enter', label: 'jump to node detail' }]
          : [{ keys: '↑/↓', label: 'select' }, { keys: 'g/G', label: 'top/bottom' }, { keys: 'PgUp/PgDn', label: 'page' }]),
      ], C),
    ];

    const postureSection: PanelWorkspaceSection = { title: 'Orchestration posture', lines: postureLines };
    const selectedGraphSection: PanelWorkspaceSection = { title: 'Selected Graph', lines: detailLines };
    const nodesSection: PanelWorkspaceSection = { title: 'Nodes', lines: nodeLines };
    const afterSections: PanelWorkspaceSection[] = [selectedGraphSection, nodesSection];
    if (guardTripLines.length > 0) {
      afterSections.push({ title: 'Guard trips (this session)', lines: guardTripLines });
    }
    const graphsSection = resolveScrollablePanelSection(width, height, {
      intro,
      footerLines,
      palette: C,
      beforeSections: [postureSection],
      section: {
        title: 'Graphs',
        scrollableLines,
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollStart,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections,
    });
    this.scrollStart = graphsSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      postureSection,
      graphsSection.section,
      ...afterSections,
    ];
    this.needsRender = false;
    const lines = buildPanelWorkspace(width, height, {
      title: 'Orchestration Control Room',
      intro,
      sections,
      footerLines,
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }

  /** Full node contract — allowedTools/requiredEvidence/writeScope/executionProtocol/reviewMode/communicationLane, plus inheritance. */
  private _buildNodeContractLines(width: number, node: OrchestrationNodeRecord | undefined): Line[] {
    if (!node) return [];
    const contract = node.contract;
    if (!contract) {
      return [buildPanelLine(width, [['  Contract: ', C.label], ['none recorded', C.dim]])];
    }
    const list = (arr: string[] | undefined) => arr && arr.length > 0 ? arr.join(', ') : 'none';
    return [
      buildPanelLine(width, [
        ['  Allowed tools: ', C.label],
        [truncateDisplay(list(contract.allowedTools), Math.max(0, width - 18)), C.value],
      ]),
      buildPanelLine(width, [
        ['  Required evidence: ', C.label],
        [truncateDisplay(list(contract.requiredEvidence), Math.max(0, width - 22)), C.value],
      ]),
      buildPanelLine(width, [
        ['  Write scope: ', C.label],
        [truncateDisplay(list(contract.writeScope), Math.max(0, width - 16)), C.value],
      ]),
      buildPanelLine(width, [
        ['  Flow: ', C.label],
        [contract.executionProtocol ?? 'direct', C.value],
        ['  Review: ', C.label],
        [contract.reviewMode ?? 'none', C.value],
        ['  Lane: ', C.label],
        [contract.communicationLane ?? 'default', C.value],
        ['  Inherits: ', C.label],
        [contract.inheritsParentConstraints ? 'yes' : 'no', C.value],
      ]),
    ];
  }
}
