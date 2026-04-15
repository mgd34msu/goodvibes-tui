import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import { createEmptyLine } from '@pellux/goodvibes-sdk/platform/types/grid';
import { BasePanel } from './base-panel.ts';
import type { UiOrchestrationSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';

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
  private readonly readModel?: UiReadModel<UiOrchestrationSnapshot>;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(readModel?: UiReadModel<UiOrchestrationSnapshot>) {
    super('orchestration', 'Orchestration', 'Q', 'monitoring');
    this.readModel = readModel;
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
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
    if (!this.readModel) return [];
    return [...this.readModel.getSnapshot().graphs].sort((a, b) => b.createdAt - a.createdAt);
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const intro = 'Task graphs, node contracts, recursion guards, and WRFC-visible orchestration state.';

    if (!this.readModel) {
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

    const snapshot = this.readModel.getSnapshot();
    const graphs = this._graphs();
    const postureLines = [
      buildKeyValueLine(width, [
        { label: 'graphs', value: String(snapshot.totalGraphs), valueColor: snapshot.totalGraphs > 0 ? C.value : C.dim },
        { label: 'active', value: String(snapshot.activeGraphIds.length), valueColor: snapshot.activeGraphIds.length > 0 ? C.running : C.dim },
        { label: 'completed', value: String(snapshot.totalCompletedGraphs), valueColor: snapshot.totalCompletedGraphs > 0 ? C.completed : C.dim },
        { label: 'failed', value: String(snapshot.totalFailedGraphs), valueColor: snapshot.totalFailedGraphs > 0 ? C.failed : C.dim },
        { label: 'guards', value: String(snapshot.recursionGuardTrips), valueColor: snapshot.recursionGuardTrips > 0 ? C.blocked : C.dim },
      ], C),
      buildGuidanceLine(width, '/orchestration', 'inspect recursive execution posture, graph health, and node contract flow', C),
    ];
    if (graphs.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Orchestration Control Room',
        intro,
        sections: [{
          title: 'Orchestration posture',
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

    const postureSection: PanelWorkspaceSection = { title: 'Orchestration posture', lines: postureLines };
    const selectedGraphSection: PanelWorkspaceSection = { title: 'Selected Graph', lines: detailLines };
    const nodesSection: PanelWorkspaceSection = { title: 'Nodes', lines: nodeLines };
    const graphsSection = resolveScrollablePanelSection(width, height, {
      intro,
      palette: C,
      beforeSections: [postureSection],
      section: {
        title: 'Graphs',
        scrollableLines: graphs.map((graph, absolute) => {
          const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
          return buildPanelLine(width, [
            [' ', C.label, bg],
            [graph.status.padEnd(10), statusColor(graph.status), bg],
            [` ${graph.mode.padEnd(17)}`, C.value, bg],
            [` ${graph.id.slice(0, 8)} `, C.dim, bg],
            [graph.title.slice(0, Math.max(0, width - 39)), C.value, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [selectedGraphSection, nodesSection],
    });
    this.scrollOffset = graphsSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      postureSection,
      graphsSection.section,
      selectedGraphSection,
      nodesSection,
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
