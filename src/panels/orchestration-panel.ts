import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { getTrackedVisibleWindow } from '../renderer/surface-layout.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
  running: '#22c55e',
  ready: '#38bdf8',
  blocked: '#f59e0b',
  failed: '#ef4444',
  completed: '#a78bfa',
  selectBg: '#0f172a',
} as const;

function statusColor(status: string): string {
  switch (status) {
    case 'ready':
      return C.ready;
    case 'running':
      return C.running;
    case 'blocked':
      return C.blocked;
    case 'failed':
      return C.failed;
    case 'completed':
      return C.completed;
    default:
      return C.dim;
  }
}

export class OrchestrationPanel extends BasePanel {
  private readonly store?: RuntimeStore;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(store?: RuntimeStore) {
    super('orchestration', 'Orchestration', 'Q', 'monitoring');
    this.store = store;
    this.unsub = store ? store.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const graphs = this._graphs();
    if (graphs.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(graphs.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  private _graphs() {
    if (!this.store) return [];
    return [...this.store.getState().orchestration.graphs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const intro = 'Task graphs, node contracts, recursion guards, and WRFC-visible orchestration state.';

    if (!this.store) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Orchestration Control Room',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Runtime store not wired into this panel yet.',
            'The orchestration workspace needs the live runtime store before it can show graphs, nodes, and recursion guard events.',
            [{ command: '/orchestration', summary: 'reopen from the shell-owned runtime once orchestration is active' }],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const domain = this.store.getState().orchestration;
    const graphs = this._graphs();
    const postureLines = [
      buildKeyValueLine(width, [
        { label: 'graphs', value: String(domain.totalGraphs), valueColor: domain.totalGraphs > 0 ? C.value : C.dim },
        { label: 'active', value: String(domain.activeGraphIds.length), valueColor: domain.activeGraphIds.length > 0 ? C.running : C.dim },
        { label: 'completed', value: String(domain.totalCompletedGraphs), valueColor: domain.totalCompletedGraphs > 0 ? C.completed : C.dim },
        { label: 'failed', value: String(domain.totalFailedGraphs), valueColor: domain.totalFailedGraphs > 0 ? C.failed : C.dim },
        { label: 'guards', value: String(domain.recursionGuardTrips), valueColor: domain.recursionGuardTrips > 0 ? C.blocked : C.dim },
      ], C),
      buildGuidanceLine(width, '/orchestration', 'inspect recursive execution posture, graph health, and node contract flow', C),
    ];
    if (graphs.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Orchestration Control Room',
        intro,
        sections: [{
          title: 'Posture',
          lines: [
            ...postureLines,
            ...buildEmptyState(
              width,
              ' No orchestration graphs recorded yet.',
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

    this.selectedIndex = Math.min(this.selectedIndex, graphs.length - 1);
    const selected = graphs[this.selectedIndex]!;
    const graphWindow = getTrackedVisibleWindow(graphs.length, this.selectedIndex, Math.max(4, height - 16), this.scrollOffset, 1);
    this.scrollOffset = graphWindow.start;
    const graphLines: Line[] = [];
    for (let absolute = graphWindow.start; absolute < graphWindow.end; absolute++) {
      const graph = graphs[absolute]!;
      const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
      graphLines.push(buildPanelLine(width, [
        [' ', C.label, bg],
        [graph.status.padEnd(10), statusColor(graph.status), bg],
        [` ${graph.mode.padEnd(17)}`, C.value, bg],
        [` ${graph.id.slice(0, 8)} `, C.dim, bg],
        [graph.title.slice(0, Math.max(0, width - 39)), C.value, bg],
      ]));
    }
    if (graphs.length > graphWindow.count) {
      graphLines.push(buildPanelLine(width, [[`  showing ${graphWindow.start + 1}-${graphWindow.end} of ${graphs.length}`, C.dim]]));
    }

    const detailLines: Line[] = [
      buildPanelLine(width, [
        ['  Title: ', C.label],
        [selected.title, C.value],
        ['  Status: ', C.label],
        [selected.status, statusColor(selected.status)],
        ['  Mode: ', C.label],
        [selected.mode, C.value],
      ]),
      buildPanelLine(width, [
        ['  Nodes: ', C.label],
        [String(selected.nodeOrder.length), C.value],
        ['  Started: ', C.label],
        [selected.startedAt ? new Date(selected.startedAt).toLocaleTimeString() : 'n/a', C.dim],
        ['  Ended: ', C.label],
        [selected.endedAt ? new Date(selected.endedAt).toLocaleTimeString() : 'n/a', C.dim],
      ]),
    ];
    if (selected.lastRecursionGuard) {
      detailLines.push(buildPanelLine(width, [
        ['  Recursion guard: ', C.label],
        [`depth ${selected.lastRecursionGuard.depth} active ${selected.lastRecursionGuard.activeAgents} ${selected.lastRecursionGuard.reason}`, C.blocked],
      ]));
    }

    const nodes = selected.nodeOrder
      .map((nodeId) => selected.nodes.get(nodeId))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
    const focusNode = nodes[0];
    if (focusNode?.contract) {
      const toolCount = focusNode.contract.allowedTools?.length ?? 0;
      const evidenceCount = focusNode.contract.requiredEvidence?.length ?? 0;
      const scopeCount = focusNode.contract.writeScope?.length ?? 0;
      detailLines.push(buildPanelLine(width, [
        ['  Contract: ', C.label],
        [`tools ${toolCount}`, C.value],
        ['  evidence ', C.label],
        [String(evidenceCount), C.value],
        ['  write scope ', C.label],
        [String(scopeCount), C.value],
      ]));
      detailLines.push(buildPanelLine(width, [
        ['  Flow: ', C.label],
        [focusNode.contract.executionProtocol ?? 'direct', C.value],
        ['  Review: ', C.label],
        [focusNode.contract.reviewMode ?? 'none', C.value],
        ['  Lane: ', C.label],
        [focusNode.contract.communicationLane ?? 'default', C.value],
        ['  Inherits: ', C.label],
        [focusNode.contract.inheritsParentConstraints ? 'yes' : 'no', C.value],
      ]));
    }

    const nodeLines: Line[] = nodes.length === 0
      ? [buildPanelLine(width, [['  No nodes recorded yet.', C.dim]])]
      : nodes.map((node) => {
          const depends = node.dependencyNodeIds.length > 0 ? ` deps:${node.dependencyNodeIds.length}` : '';
          return buildPanelLine(width, [
            ['  ', C.label],
            [node.status.padEnd(10), statusColor(node.status)],
            [` ${node.role.padEnd(10)}`, C.value],
            [` ${node.id.slice(0, 8)} `, C.dim],
            [`${node.title}${depends}`.slice(0, Math.max(0, width - 34)), C.value],
          ]);
        });

    const sections: PanelWorkspaceSection[] = [
      { title: 'Posture', lines: postureLines },
      { title: 'Graphs', lines: graphLines },
      { title: 'Selected Graph', lines: detailLines },
      { title: 'Nodes', lines: nodeLines },
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Orchestration Control Room',
      intro,
      sections,
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
