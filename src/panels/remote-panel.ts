import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import type { DistributedRuntimeManager } from '../runtime/remote/distributed-runtime-manager.ts';
import type { RemoteRunnerRegistry } from '../runtime/remote/runner-registry.ts';
import type { RemoteSupervisor } from '../runtime/remote/supervisor.ts';
import {
  buildDetailBlock,
  buildEmptyState,
  buildGuidanceLine,
  buildPanelListRow,
  buildPanelLine,
  buildSummaryBlock,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { getTrackedVisibleWindow } from '../renderer/surface-layout.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
  dim: '#475569',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
} as const;

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
  return truncateDisplay(text, width);
}

export interface RemotePanelDeps {
  readonly distributedRuntime: Pick<DistributedRuntimeManager, 'getSnapshot'>;
  readonly remoteRunnerRegistry: Pick<RemoteRunnerRegistry, 'listContracts' | 'ensureContractsFromStore' | 'listArtifacts' | 'listPools' | 'getContract'>;
  readonly remoteSupervisor: Pick<RemoteSupervisor, 'getSnapshot'>;
}

export class RemotePanel extends BasePanel {
  private readonly store?: RuntimeStore;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private browseMode: 'connections' | 'contracts' = 'connections';

  public constructor(
    store: RuntimeStore | undefined,
    private readonly deps: RemotePanelDeps,
  ) {
    super('remote', 'Remote', 'R', 'monitoring');
    this.store = store;
    this.unsub = store ? store.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const activeConnections = this.getActiveConnections();
    const contracts = this.store ? this.deps.remoteRunnerRegistry.listContracts() : [];
    const browseCount = this.browseMode === 'connections' && activeConnections.length > 0
      ? activeConnections.length
      : contracts.length;
    if (key === 'tab' && contracts.length > 0) {
      this.browseMode = this.browseMode === 'connections' ? 'contracts' : 'connections';
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (browseCount === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(browseCount - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    if (key === 'home') {
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      this.selectedIndex = Math.max(0, browseCount - 1);
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
    const intro = 'Bridge, ACP, runner-contract, and artifact posture for self-hosted remote work.';

    if (!this.store) {
      const sectionLines = buildEmptyState(
        width,
        ' Runtime store not wired into this panel yet.',
        'The remote control room needs the live runtime store so it can display ACP state, runner contracts, and replay artifacts.',
        [
          { command: '/remote setup', summary: 'review bootstrap, env, tunnel, and bridge guidance' },
          { command: '/remote panel', summary: 'reopen the panel from the shell-owned runtime' },
        ],
        C,
      );
      const lines = buildPanelWorkspace(width, height, {
        title: 'Remote Control Room',
        intro,
        sections: [{ lines: sectionLines }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    const state = this.store.getState();
    const daemon = state.daemon;
    const acp = state.acp;
    const activeConnections = this.getActiveConnections();
    const remoteRegistry = this.deps.remoteRunnerRegistry;
    const distributed = this.deps.distributedRuntime.getSnapshot() as {
      pairRequests?: { pending?: number };
      peers?: { total?: number; connected?: number; nodes?: number; devices?: number };
      work?: { queued?: number; claimed?: number };
    };
    const supervisor = this.deps.remoteSupervisor.getSnapshot(this.store);
    remoteRegistry.ensureContractsFromStore(this.store);
    const artifactCount = remoteRegistry.listArtifacts().length;
    const pools = remoteRegistry.listPools();
    const contracts = remoteRegistry.listContracts();

    const postureLines: Line[] = [
      buildPanelLine(width, [
        [' daemon ', C.label],
        [daemon.transportState.toUpperCase(), stateColor(daemon.transportState)],
        ['  running ', C.label],
        [daemon.isRunning ? 'yes' : 'no', daemon.isRunning ? C.ok : C.dim],
        ['  reconnects ', C.label],
        [String(daemon.reconnectAttempts), daemon.reconnectAttempts > 0 ? C.warn : C.ok],
        ['  jobs ', C.label],
        [String(daemon.runningJobCount), daemon.runningJobCount > 0 ? C.info : C.dim],
      ]),
      buildPanelLine(width, [
        [' ACP manager ', C.label],
        [acp.managerTransportState.toUpperCase(), stateColor(acp.managerTransportState)],
        ['  active connections ', C.label],
        [String(acp.activeConnectionIds.length), acp.activeConnectionIds.length > 0 ? C.info : C.dim],
        ['  total messages ', C.label],
        [String(acp.totalMessages), acp.totalMessages > 0 ? C.value : C.dim],
      ]),
      buildPanelLine(width, [
        [' runner contracts ', C.label],
        [String(contracts.length), C.info],
        ['  pools ', C.label],
        [String(pools.length), pools.length > 0 ? C.info : C.dim],
        ['  review artifacts ', C.label],
        [String(artifactCount), artifactCount > 0 ? C.ok : C.dim],
      ]),
      buildPanelLine(width, [
        [' supervisor ', C.label],
        [String(supervisor.sessions.length), C.info],
        ['  degraded ', C.label],
        [String(supervisor.degradedConnections), supervisor.degradedConnections > 0 ? C.warn : C.ok],
        [' distributed peers ', C.label],
        [String(distributed.peers?.total ?? 0), C.info],
        ['  connected ', C.label],
        [String(distributed.peers?.connected ?? 0), (distributed.peers?.connected ?? 0) > 0 ? C.ok : C.dim],
        ['  queued work ', C.label],
        [String(distributed.work?.queued ?? 0), (distributed.work?.queued ?? 0) > 0 ? C.info : C.dim],
      ]),
    ];

    if (daemon.lastError) {
      postureLines.push(buildPanelLine(width, [
        [' daemon error ', C.label],
        [daemon.lastError.slice(0, Math.max(0, width - 14)), C.error],
      ]));
    }
    postureLines.push(
      buildGuidanceLine(width, '/remote recover', 'resume remote state with runner, capability, and disconnect recovery hints', C),
      buildGuidanceLine(width, '/remote capabilities', 'inspect transport support before routing remote work or reattaching a session', C),
    );

    const footerLines = [
      buildGuidanceLine(width, '/remote setup', 'review bridge, tunnel, env, and bootstrap flows for self-hosted remote work', C),
      buildPanelLine(width, [[`  focus=${this.browseMode}  Up/Down move  Tab switch connections/contracts`, C.dim]]),
    ] as const;

    if (activeConnections.length === 0 && contracts.length === 0) {
      const idleLines = [
        ...postureLines,
        ...buildEmptyState(
          width,
          ' No active ACP or remote subagent connections.',
          'The remote control room is healthy but idle. Runner contracts, session bundles, and bridge pools will appear here once remote work starts.',
          [
            { command: '/remote setup', summary: 'review remote bootstrap and environment export' },
            { command: '/remote env', summary: 'emit a reusable remote shell snippet' },
            { command: '/bridge status', summary: 'inspect runner pools and existing remote artifacts' },
          ],
          C,
        ),
      ];
      const lines = buildPanelWorkspace(width, height, {
        title: 'Remote Control Room',
        intro,
        sections: [{ lines: buildSummaryBlock(width, 'Remote posture', idleLines, C) }],
        footerLines,
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    const viewingConnections = this.browseMode === 'connections' && activeConnections.length > 0;
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, (viewingConnections ? activeConnections.length : contracts.length) - 1),
    );
    const browseCount = viewingConnections ? activeConnections.length : contracts.length;
    const selected = viewingConnections ? activeConnections[this.selectedIndex] ?? null : null;
    const selectedContract = !viewingConnections ? contracts[this.selectedIndex] ?? null : null;
    const detailRows: Line[] = [];

    if (selected) {
      detailRows.push(buildPanelLine(width, [
        ['  Agent: ', C.label],
        [selected.agentId, C.value],
        ['  State: ', C.label],
        [selected.transportState, stateColor(selected.transportState)],
        ['  Completing: ', C.label],
        [selected.completing ? 'yes' : 'no', selected.completing ? C.warn : C.dim],
      ]));
      detailRows.push(buildPanelLine(width, [
        ['  Connected: ', C.label],
        [formatTimestamp(selected.connectedAt), C.dim],
        ['  Messages: ', C.label],
        [String(selected.messageCount), selected.messageCount > 0 ? C.info : C.dim],
        ['  Errors: ', C.label],
        [String(selected.errorCount), selected.errorCount > 0 ? C.warn : C.dim],
      ]));
      if (selected.lastError) {
        detailRows.push(buildPanelLine(width, [
          ['  Last error: ', C.label],
          [selected.lastError.slice(0, Math.max(0, width - 13)), C.error],
        ]));
      }

      const contract = remoteRegistry.getContract(selected.agentId);
      if (contract) {
        detailRows.push(buildPanelLine(width, [
          ['  Contract: ', C.label],
          [`${contract.template} / ${contract.trustClass}`, C.info],
          ['  Pool: ', C.label],
          [contract.poolId ?? '(none)', contract.poolId ? C.info : C.dim],
        ]));
        detailRows.push(buildPanelLine(width, [
          ['  Depth: ', C.label],
          [String(contract.capabilityCeiling.orchestrationDepth), C.value],
          ['  Pools: ', C.label],
          [String(pools.length), pools.length > 0 ? C.info : C.dim],
        ]));
        detailRows.push(buildPanelLine(width, [
          ['  Protocol: ', C.label],
          [contract.capabilityCeiling.executionProtocol, C.value],
          ['  Review: ', C.label],
          [contract.capabilityCeiling.reviewMode, C.value],
          ['  Lane: ', C.label],
          [contract.capabilityCeiling.communicationLane, C.value],
        ]));
        detailRows.push(buildPanelLine(width, [
          ['  Tools: ', C.label],
          [truncate(contract.capabilityCeiling.allowedTools.join(', ') || '(none)', Math.max(0, width - 10)), C.dim],
        ]));
      }

      if (selected.taskId) {
        detailRows.push(buildPanelLine(width, [
          ['  Task: ', C.label],
          [selected.taskId, C.value],
        ]));
      }

      const supervisorEntry = supervisor.sessions.find((entry) => entry.runnerId === selected.agentId);
      if (supervisorEntry) {
        detailRows.push(buildPanelLine(width, [
          ['  Heartbeat: ', C.label],
          [supervisorEntry.heartbeat.status, supervisorEntry.heartbeat.status === 'fresh' ? C.ok : supervisorEntry.heartbeat.status === 'stale' ? C.warn : C.error],
          ['  Protocol: ', C.label],
          [supervisorEntry.negotiation.executionProtocol, C.value],
          ['  Review: ', C.label],
          [supervisorEntry.negotiation.reviewMode, supervisorEntry.negotiation.reviewMode === 'wrfc' ? C.ok : C.dim],
        ]));
        detailRows.push(buildPanelLine(width, [[`  ${supervisorEntry.heartbeat.detail}`.slice(0, width), C.dim]]));
      }

      const recentArtifact = remoteRegistry.listArtifacts().find((artifact) => artifact.runnerId === selected.agentId);
      if (recentArtifact) {
        detailRows.push(buildPanelLine(width, [[' Recent Review Artifact', C.label]]));
        detailRows.push(buildPanelLine(width, [
          ['  Artifact: ', C.label],
          [recentArtifact.id, C.value],
          ['  Status: ', C.label],
          [recentArtifact.task.status, stateColor(recentArtifact.evidence.transportState)],
        ]));
        detailRows.push(buildPanelLine(width, [
          ['  Summary: ', C.label],
          [truncate(recentArtifact.task.summary, Math.max(0, width - 12)), C.dim],
        ]));
      }
      detailRows.push(buildPanelLine(width, [
        ['  Tip: ', C.label],
        ['Use Up/Down or j/k to inspect another connection.', C.dim],
      ]));
    } else if (selectedContract) {
      detailRows.push(buildPanelLine(width, [
        ['  Runner: ', C.label],
        [selectedContract.runnerId, C.value],
        ['  Template: ', C.label],
        [selectedContract.template, C.info],
        ['  Trust: ', C.label],
        [selectedContract.trustClass, C.value],
      ]));
      detailRows.push(buildPanelLine(width, [
        ['  Pool: ', C.label],
        [selectedContract.poolId ?? '(none)', selectedContract.poolId ? C.info : C.dim],
        ['  Transport: ', C.label],
        [selectedContract.transport.state, stateColor(selectedContract.transport.state)],
      ]));
      detailRows.push(buildPanelLine(width, [
        ['  Protocol: ', C.label],
        [selectedContract.capabilityCeiling.executionProtocol, C.value],
        ['  Review: ', C.label],
        [selectedContract.capabilityCeiling.reviewMode, C.value],
        ['  Lane: ', C.label],
        [selectedContract.capabilityCeiling.communicationLane, C.value],
      ]));
      detailRows.push(buildPanelLine(width, [
        ['  Tools: ', C.label],
        [truncate(selectedContract.capabilityCeiling.allowedTools.join(', ') || '(none)', Math.max(0, width - 10)), C.dim],
      ]));
      const supervisorEntry = supervisor.sessions.find((entry) => entry.runnerId === selectedContract.runnerId);
      if (supervisorEntry) {
        detailRows.push(buildPanelLine(width, [
          ['  Heartbeat: ', C.label],
          [supervisorEntry.heartbeat.status, supervisorEntry.heartbeat.status === 'fresh' ? C.ok : supervisorEntry.heartbeat.status === 'stale' ? C.warn : C.error],
          ['  Lane: ', C.label],
          [supervisorEntry.negotiation.communicationLane, C.info],
        ]));
        for (const action of supervisorEntry.recovery.slice(0, 2)) {
          detailRows.push(buildGuidanceLine(width, action.command, action.reason, C));
        }
      }
      const recentArtifact = remoteRegistry.listArtifacts().find((artifact) => artifact.runnerId === selectedContract.runnerId);
      if (recentArtifact) {
        detailRows.push(buildPanelLine(width, [
          ['  Recent artifact: ', C.label],
          [recentArtifact.id, C.ok],
          ['  Status: ', C.label],
          [recentArtifact.task.status, stateColor(recentArtifact.evidence.transportState)],
        ]));
      }
    }
    const postureSection: PanelWorkspaceSection = { lines: buildSummaryBlock(width, 'Remote posture', postureLines, C) };
    const detailSection: PanelWorkspaceSection = {
      lines: buildDetailBlock(width, selected ? 'Selected connection' : 'Selected contract', detailRows, C),
    };
    const browseTitle = viewingConnections ? 'Active Connections' : 'Registered Remote Runner Contracts';
    const rawBrowseLines: Line[] = viewingConnections
      ? activeConnections.map((connection, absolute) => {
          return buildPanelListRow(width, [
            { text: connection.agentId.padEnd(18), fg: C.value },
            { text: ` ${connection.transportState.padEnd(18)}`, fg: stateColor(connection.transportState) },
            { text: ` msgs=${String(connection.messageCount).padEnd(6)}`, fg: C.info },
            { text: ` errs=${String(connection.errorCount).padEnd(4)}`, fg: connection.errorCount > 0 ? C.warn : C.dim },
            { text: ` ${connection.label}`.slice(0, Math.max(0, width - 56)), fg: C.dim },
          ], C, { selected: absolute === this.selectedIndex, selectedBg: C.headerBg });
        })
      : [
          ...contracts.map((contract, absolute) => {
            return buildPanelListRow(width, [
              { text: contract.runnerId.padEnd(18), fg: C.value },
              { text: ` ${contract.transport.state.padEnd(18)}`, fg: stateColor(contract.transport.state) },
              { text: ` ${contract.template}`.slice(0, Math.max(0, width - 42)), fg: C.dim },
            ], C, { selected: absolute === this.selectedIndex, selectedBg: C.headerBg });
          }),
          buildPanelLine(width, [[' No active connection is currently attached to these contracts.', C.dim]]),
        ];
    const resolvedBrowseSection = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines,
      palette: C,
      beforeSections: [postureSection],
      section: {
        title: browseTitle,
        scrollableLines: rawBrowseLines,
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: viewingConnections ? { dimColor: C.dim } : undefined,
      },
      afterSections: [detailSection],
    });
    this.scrollOffset = resolvedBrowseSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      postureSection,
      resolvedBrowseSection.section,
      detailSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Remote Control Room',
      intro,
      sections,
      footerLines,
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
