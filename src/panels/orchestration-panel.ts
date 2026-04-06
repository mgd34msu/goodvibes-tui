import type { Cell, Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';

const C = {
  header: '#94a3b8',
  headerBg: '#1e293b',
  label: '#64748b',
  value: '#e2e8f0',
  dim: '#475569',
  running: '#22c55e',
  ready: '#38bdf8',
  blocked: '#f59e0b',
  failed: '#ef4444',
  completed: '#a78bfa',
  selectedBg: '#0f172a',
  empty: '#334155',
} as const;

function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells: Cell[] = [];
  for (const [text, fg, bg] of segments) {
    const style = { fg, bg: bg ?? '' };
    for (const ch of text) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, style));
    }
  }
  while (cells.length < width) cells.push(createStyledCell(' ', { fg: '' }));
  return cells.slice(0, width);
}

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
    const lines: Line[] = [];
    lines.push(buildLine(width, [[' Orchestration Control Room', C.header, C.headerBg]]));

    if (!this.store) {
      lines.push(buildLine(width, [[' Runtime store not wired into this panel yet.', C.empty]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    const domain = this.store.getState().orchestration;
    const graphs = this._graphs();
    if (graphs.length === 0) {
      lines.push(buildLine(width, [[' No orchestration graphs recorded yet.', C.empty]]));
      lines.push(buildLine(width, [[' Graphs, nodes, and recursion guard trips will appear here as orchestration starts.', C.dim]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    lines.push(buildLine(width, [[
      `graphs:${domain.totalGraphs} active:${domain.activeGraphIds.length} completed:${domain.totalCompletedGraphs} failed:${domain.totalFailedGraphs} guards:${domain.recursionGuardTrips}`,
      C.dim,
    ]]));

    this.selectedIndex = Math.min(this.selectedIndex, graphs.length - 1);
    const selected = graphs[this.selectedIndex]!;
    const visible = graphs.slice(0, Math.max(1, height - 8));
    for (let index = 0; index < visible.length; index++) {
      const graph = visible[index]!;
      const bg = index === this.selectedIndex ? C.selectedBg : undefined;
      lines.push(buildLine(width, [
        [' ', C.label, bg],
        [graph.status.padEnd(10), statusColor(graph.status), bg],
        [` ${graph.mode.padEnd(17)}`, C.value, bg],
        [` ${graph.id.slice(0, 8)} `, C.dim, bg],
        [graph.title.slice(0, Math.max(0, width - 39)), C.value, bg],
      ]));
    }

    lines.push(buildLine(width, [[' Details', C.label]]));
    lines.push(buildLine(width, [
      ['  Title: ', C.label],
      [selected.title, C.value],
      ['  Status: ', C.label],
      [selected.status, statusColor(selected.status)],
      ['  Mode: ', C.label],
      [selected.mode, C.value],
    ]));
    lines.push(buildLine(width, [
      ['  Nodes: ', C.label],
      [String(selected.nodeOrder.length), C.value],
      ['  Started: ', C.label],
      [selected.startedAt ? new Date(selected.startedAt).toLocaleTimeString() : 'n/a', C.dim],
      ['  Ended: ', C.label],
      [selected.endedAt ? new Date(selected.endedAt).toLocaleTimeString() : 'n/a', C.dim],
    ]));
    if (selected.lastRecursionGuard) {
      lines.push(buildLine(width, [
        ['  Recursion guard: ', C.label],
        [`depth ${selected.lastRecursionGuard.depth} active ${selected.lastRecursionGuard.activeAgents} ${selected.lastRecursionGuard.reason}`, C.blocked],
      ]));
    }

    const nodes = selected.nodeOrder
      .map((nodeId) => selected.nodes.get(nodeId))
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
      .slice(0, Math.max(0, height - lines.length - 1));
    const focusNode = nodes[0];
    if (focusNode?.contract) {
      const toolCount = focusNode.contract.allowedTools?.length ?? 0;
      const evidenceCount = focusNode.contract.requiredEvidence?.length ?? 0;
      const scopeCount = focusNode.contract.writeScope?.length ?? 0;
      lines.push(buildLine(width, [
        ['  Contract: ', C.label],
        [`tools ${toolCount}`, C.value],
        ['  evidence ', C.label],
        [String(evidenceCount), C.value],
        ['  write scope ', C.label],
        [String(scopeCount), C.value],
      ]));
      lines.push(buildLine(width, [
        ['  Protocol: ', C.label],
        [(focusNode.contract.executionProtocol ?? 'direct'), C.value],
        ['  Review: ', C.label],
        [(focusNode.contract.reviewMode ?? 'none'), C.value],
        ['  Inherits: ', C.label],
        [focusNode.contract.inheritsParentConstraints ? 'yes' : 'no', C.value],
      ]));
      if (focusNode.contract.communicationLane) {
        lines.push(buildLine(width, [
          ['  Communication: ', C.label],
          [focusNode.contract.communicationLane, C.value],
        ]));
      }
    }
    if (nodes.length > 0) lines.push(buildLine(width, [[' Nodes', C.label]]));
    for (const node of nodes.slice(0, Math.max(0, height - lines.length))) {
      const depends = node.dependencyNodeIds.length > 0 ? ` deps:${node.dependencyNodeIds.length}` : '';
      lines.push(buildLine(width, [
        ['  ', C.label],
        [node.status.padEnd(10), statusColor(node.status)],
        [` ${node.role.padEnd(10)}`, C.value],
        [` ${node.id.slice(0, 8)} `, C.dim],
        [`${node.title}${depends}`.slice(0, Math.max(0, width - 34)), C.value],
      ]));
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
