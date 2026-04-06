import type { Line, Cell } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import { getRemoteRunnerRegistry } from '../runtime/remote/index.ts';

const C = {
  header: '#94a3b8',
  headerBg: '#1e293b',
  label: '#64748b',
  value: '#e2e8f0',
  dim: '#475569',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  info: '#38bdf8',
  empty: '#334155',
} as const;

function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells: Cell[] = [];
  let used = 0;
  for (const [text, fg, bg] of segments) {
    cells.push(createStyledCell(text, { fg, bg: bg ?? '' }));
    used += text.length;
  }
  if (used < width) cells.push(createStyledCell(' '.repeat(width - used), { fg: '' }));
  return cells;
}

function stateColor(state: string): string {
  switch (state) {
    case 'connected':
    case 'syncing':
      return C.ok;
    case 'degraded':
    case 'reconnecting':
    case 'authenticating':
    case 'initializing':
      return C.warn;
    case 'terminal_failure':
      return C.error;
    default:
      return C.dim;
  }
}

function formatTimestamp(value?: number): string {
  return value ? new Date(value).toLocaleTimeString() : 'n/a';
}

function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export class RemotePanel extends BasePanel {
  private readonly store?: RuntimeStore;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;

  public constructor(store?: RuntimeStore) {
    super('remote', 'Remote', 'R', 'monitoring');
    this.store = store;
    this.unsub = store ? store.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const activeConnections = this.getActiveConnections();
    if (activeConnections.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(activeConnections.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    if (key === 'home') {
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      this.selectedIndex = activeConnections.length - 1;
      this.markDirty();
      return true;
    }
    return false;
  }

  private getActiveConnections() {
    if (!this.store) return [];
    const acp = this.store.getState().acp;
    return acp.activeConnectionIds
      .map((id) => acp.connections.get(id))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];
    lines.push(buildLine(width, [[' Remote Control Room', C.header, C.headerBg]]));

    if (!this.store) {
      lines.push(buildLine(width, [[' Runtime store not wired into this panel yet.', C.empty]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    const state = this.store.getState();
    const daemon = state.daemon;
    const acp = state.acp;
    const activeConnections = this.getActiveConnections();
    const remoteRegistry = getRemoteRunnerRegistry();
    remoteRegistry.ensureContractsFromStore(this.store);
    const artifactCount = remoteRegistry.listArtifacts().length;
    const pools = remoteRegistry.listPools();

    lines.push(buildLine(width, [
      [' daemon ', C.label],
      [daemon.transportState.toUpperCase(), stateColor(daemon.transportState)],
      ['  running ', C.label],
      [daemon.isRunning ? 'yes' : 'no', daemon.isRunning ? C.ok : C.dim],
      ['  reconnects ', C.label],
      [String(daemon.reconnectAttempts), daemon.reconnectAttempts > 0 ? C.warn : C.ok],
      ['  jobs ', C.label],
      [String(daemon.runningJobCount), daemon.runningJobCount > 0 ? C.info : C.dim],
    ]));
    lines.push(buildLine(width, [
      [' ACP manager ', C.label],
      [acp.managerTransportState.toUpperCase(), stateColor(acp.managerTransportState)],
      ['  active connections ', C.label],
      [String(acp.activeConnectionIds.length), acp.activeConnectionIds.length > 0 ? C.info : C.dim],
      ['  total messages ', C.label],
      [String(acp.totalMessages), acp.totalMessages > 0 ? C.value : C.dim],
    ]));
    lines.push(buildLine(width, [
      [' runner contracts ', C.label],
      [String(remoteRegistry.listContracts().length), C.info],
      ['  pools ', C.label],
      [String(pools.length), pools.length > 0 ? C.info : C.dim],
      ['  review artifacts ', C.label],
      [String(artifactCount), artifactCount > 0 ? C.ok : C.dim],
    ]));
    if (daemon.lastError) {
      lines.push(buildLine(width, [
        [' daemon error ', C.label],
        [daemon.lastError.slice(0, Math.max(0, width - 14)), C.error],
      ]));
    }
    const contracts = remoteRegistry.listContracts();
    if (activeConnections.length === 0 && contracts.length === 0) {
      lines.push(buildLine(width, [[' No active ACP or remote subagent connections.', C.empty]]));
      lines.push(buildLine(width, [[' This surface tracks self-hosted daemon and ACP transport state.', C.dim]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, activeConnections.length - 1));
    const selected = activeConnections[this.selectedIndex] ?? null;

    if (activeConnections.length > 0) {
      lines.push(buildLine(width, [[' Active Connections', C.label]]));
      for (let index = 0; index < activeConnections.length && lines.length < height - 6; index++) {
        const connection = activeConnections[index]!;
        const bg = index === this.selectedIndex ? C.headerBg : undefined;
        lines.push(buildLine(width, [
          ['  ', C.label],
          [connection.agentId.padEnd(18), C.value, bg],
          [` ${connection.transportState.padEnd(18)}`, stateColor(connection.transportState), bg],
          [` msgs=${String(connection.messageCount).padEnd(6)}`, C.info, bg],
          [` errs=${String(connection.errorCount).padEnd(4)}`, connection.errorCount > 0 ? C.warn : C.dim, bg],
          [` ${connection.label}`.slice(0, Math.max(0, width - 54)), C.dim, bg],
        ]));
      }
    } else {
      lines.push(buildLine(width, [[' Registered Remote Runner Contracts', C.label]]));
      for (const contract of contracts.slice(0, Math.max(1, height - 8))) {
        lines.push(buildLine(width, [
          ['  ', C.label],
          [contract.runnerId.padEnd(18), C.value],
          [` ${contract.transport.state.padEnd(18)}`, stateColor(contract.transport.state), undefined],
          [` ${contract.template}`.slice(0, Math.max(0, width - 40)), C.dim],
        ]));
      }
      lines.push(buildLine(width, [[' No active connection is currently attached to these contracts.', C.dim]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    if (selected) {
      lines.push(buildLine(width, [[' Selected Connection', C.label]]));
      lines.push(buildLine(width, [
        ['  Agent: ', C.label],
        [selected.agentId, C.value],
        ['  State: ', C.label],
        [selected.transportState, stateColor(selected.transportState)],
        ['  Completing: ', C.label],
        [selected.completing ? 'yes' : 'no', selected.completing ? C.warn : C.dim],
      ]));
      lines.push(buildLine(width, [
        ['  Connected: ', C.label],
        [formatTimestamp(selected.connectedAt), C.dim],
        ['  Messages: ', C.label],
        [String(selected.messageCount), selected.messageCount > 0 ? C.info : C.dim],
        ['  Errors: ', C.label],
        [String(selected.errorCount), selected.errorCount > 0 ? C.warn : C.dim],
      ]));
      const contract = remoteRegistry.getContract(selected.agentId);
      if (contract) {
        lines.push(buildLine(width, [
          ['  Contract: ', C.label],
          [`${contract.template} / ${contract.trustClass}`, C.info],
          ['  Pool: ', C.label],
          [contract.poolId ?? '(none)', contract.poolId ? C.info : C.dim],
        ]));
        lines.push(buildLine(width, [
          ['  Depth: ', C.label],
          [String(contract.capabilityCeiling.orchestrationDepth), C.value],
          ['  Pools: ', C.label],
          [String(pools.length), pools.length > 0 ? C.info : C.dim],
        ]));
        lines.push(buildLine(width, [
          ['  Protocol: ', C.label],
          [contract.capabilityCeiling.executionProtocol, C.value],
          ['  Review: ', C.label],
          [contract.capabilityCeiling.reviewMode, C.value],
          ['  Lane: ', C.label],
          [contract.capabilityCeiling.communicationLane, C.value],
        ]));
        lines.push(buildLine(width, [
          ['  Tools: ', C.label],
          [truncate(contract.capabilityCeiling.allowedTools.join(', ') || '(none)', Math.max(0, width - 10)), C.dim],
        ]));
      }
      if (selected.taskId) {
        lines.push(buildLine(width, [
          ['  Task: ', C.label],
          [selected.taskId, C.value],
        ]));
      }
      const recentArtifact = remoteRegistry
        .listArtifacts()
        .find((artifact) => artifact.runnerId === selected.agentId);
      if (recentArtifact) {
        lines.push(buildLine(width, [[' Recent Review Artifact', C.label]]));
        lines.push(buildLine(width, [
          ['  Artifact: ', C.label],
          [recentArtifact.id, C.value],
          ['  Status: ', C.label],
          [recentArtifact.task.status, stateColor(recentArtifact.evidence.transportState)],
        ]));
        lines.push(buildLine(width, [
          ['  Summary: ', C.label],
          [truncate(recentArtifact.task.summary, Math.max(0, width - 12)), C.dim],
        ]));
      }
      if (selected.lastError) {
        lines.push(buildLine(width, [
          ['  Last error: ', C.label],
          [selected.lastError.slice(0, Math.max(0, width - 13)), C.error],
        ]));
      }
      lines.push(buildLine(width, [
        ['  Tip: ', C.label],
        ['Use ↑/↓ or j/k to inspect another connection.', C.dim],
      ]));
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
