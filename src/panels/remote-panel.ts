import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { PanelIntegrationContext } from './types.ts';
import type { UiReadModel, UiRemoteSnapshot } from '../runtime/ui-read-models.ts';
import {
  buildDetailBlock,
  buildEmptyState,
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

// Base chrome only — title band, state colors, and text tokens all come
// straight from DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

function stateColor(state: string): string {
  switch (state) {
    case 'connected':
    case 'syncing':
      return C.good;
    case 'degraded':
    case 'reconnecting':
    case 'authenticating':
    case 'initializing':
      return C.warn;
    case 'terminal_failure':
      return C.bad;
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

// Splits a machine-generated slash-command string (e.g. `/remote show foo`)
// into the { name, args } shape ctx.executeCommand expects — the same
// leading-slash-stripping approach panel-integration-actions.ts uses for
// ApprovalPanel's dispatched command.
function parseCommand(command: string): { name: string; args: string[] } | null {
  const parts = command.replace(/^\//, '').split(/\s+/).filter(Boolean);
  const [name, ...args] = parts;
  return name ? { name, args } : null;
}

// Mirrors RemoteSupervisor's own stateIsDegraded()/degradedConnections
// definition (sdk/platform/runtime/remote/supervisor.js) so "degraded/stale"
// means the same thing here as it does in the posture summary above.
function isSupervisorEntryDegraded(entry: { transportState: string; heartbeat: { status: string } }): boolean {
  const degradedTransport = entry.transportState === 'degraded'
    || entry.transportState === 'reconnecting'
    || entry.transportState === 'terminal_failure';
  return degradedTransport || entry.heartbeat.status !== 'fresh';
}

export class RemotePanel extends BasePanel {
  private readonly readModel?: UiReadModel<UiRemoteSnapshot>;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private browseMode: 'connections' | 'contracts' = 'connections';
  // Set by handleInput (enter/r) and consumed on the very next
  // handlePanelIntegrationAction dispatch of that same key, mirroring the
  // token-budget-panel pattern — handleInput has no ctx.executeCommand.
  private pendingCommand: { name: string; args: string[] } | null = null;

  public constructor(readModel?: UiReadModel<UiRemoteSnapshot>) {
    super('remote', 'Remote', 'R', 'monitoring');
    this.readModel = readModel;
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    // r = dispatch /remote recover for whatever is currently selected (or
    // the runtime's first non-fresh session when nothing is selected).
    if (this.readModel && key === 'r') {
      const runnerId = this.getSelectedRunnerId();
      const parsed = parseCommand(runnerId ? `/remote recover ${runnerId}` : '/remote recover');
      if (parsed) {
        this.pendingCommand = parsed;
        return true;
      }
    }
    // Enter on a degraded/stale supervisor selection dispatches its
    // top recovery action (already machine-readable via .recovery[0].command)
    // instead of requiring the operator to retype it.
    if (this.readModel && (key === 'enter' || key === 'return')) {
      const entry = this.getSelectedSupervisorEntry();
      if (entry && isSupervisorEntryDegraded(entry) && entry.recovery.length > 0) {
        const parsed = parseCommand(entry.recovery[0].command);
        if (parsed) {
          this.pendingCommand = parsed;
          return true;
        }
      }
    }
    const activeConnections = this.getActiveConnections();
    const contracts = this.readModel?.getSnapshot().contracts ?? [];
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
    return this.readModel?.getSnapshot().acp.activeConnections ?? [];
  }

  // Runner id backing the currently browsed row, whichever browse mode is
  // active — shared by the Enter/r dispatch logic and render()'s own
  // selection lookups so they never drift apart.
  private getSelectedRunnerId(): string | null {
    const snapshot = this.readModel?.getSnapshot();
    if (!snapshot) return null;
    const activeConnections = this.getActiveConnections();
    const contracts = snapshot.contracts;
    const viewingConnections = this.browseMode === 'connections' && activeConnections.length > 0;
    if (viewingConnections) {
      return activeConnections[this.selectedIndex]?.agentId ?? null;
    }
    return contracts[this.selectedIndex]?.runnerId ?? null;
  }

  private getSelectedSupervisorEntry() {
    const snapshot = this.readModel?.getSnapshot();
    if (!snapshot) return null;
    const runnerId = this.getSelectedRunnerId();
    if (!runnerId) return null;
    return snapshot.supervisor.sessions.find((entry) => entry.runnerId === runnerId) ?? null;
  }

  public handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (!this.pendingCommand) return false;
    const { name, args } = this.pendingCommand;
    this.pendingCommand = null;
    void ctx.executeCommand?.(name, args);
    return true;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const intro = 'Bridge, ACP, runner-contract, and artifact posture for self-hosted remote work.';

    if (!this.readModel) {
      const sectionLines = buildEmptyState(
        width,
        ' Runtime store not wired into this panel yet.',
        'The remote control room needs the shell read model so it can display ACP state, runner contracts, and replay artifacts.',
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

    const snapshot = this.readModel.getSnapshot();
    const daemon = snapshot.daemon;
    const acp = snapshot.acp;
    const activeConnections = this.getActiveConnections();
    const artifactCount = snapshot.artifacts.length;
    const pools = snapshot.pools;
    const contracts = snapshot.contracts;
    const supervisor = snapshot.supervisor;
    const distributed = {
      pairRequests: { pending: snapshot.distributed.pairRequests.length },
      peers: {
        total: snapshot.distributed.peers.length,
        connected: snapshot.distributed.peers.filter((peer) => peer.status === 'connected').length,
        nodes: snapshot.distributed.peers.filter((peer) => peer.kind === 'node').length,
        devices: snapshot.distributed.peers.filter((peer) => peer.kind === 'device').length,
      },
      work: {
        queued: snapshot.distributed.work.filter((item) => item.status === 'queued').length,
        claimed: snapshot.distributed.work.filter((item) => item.status === 'claimed').length,
      },
    };

    const postureLines: Line[] = [
      buildPanelLine(width, [
        [' daemon ', C.label],
        [daemon.transportState.toUpperCase(), stateColor(daemon.transportState)],
        ['  running ', C.label],
        [daemon.isRunning ? 'yes' : 'no', daemon.isRunning ? C.good : C.dim],
        ['  reconnects ', C.label],
        [String(daemon.reconnectAttempts), daemon.reconnectAttempts > 0 ? C.warn : C.good],
        ['  jobs ', C.label],
        [String(daemon.runningJobCount), daemon.runningJobCount > 0 ? C.info : C.dim],
      ]),
      buildPanelLine(width, [
        [' ACP manager ', C.label],
        [acp.transportState.toUpperCase(), stateColor(acp.transportState)],
        ['  active connections ', C.label],
        [String(acp.activeConnections.length), acp.activeConnections.length > 0 ? C.info : C.dim],
        ['  total messages ', C.label],
        [String(acp.totalMessages), acp.totalMessages > 0 ? C.value : C.dim],
      ]),
      buildPanelLine(width, [
        [' runner contracts ', C.label],
        [String(contracts.length), C.info],
        ['  pools ', C.label],
        [String(pools.length), pools.length > 0 ? C.info : C.dim],
        ['  review artifacts ', C.label],
        [String(artifactCount), artifactCount > 0 ? C.good : C.dim],
      ]),
      buildPanelLine(width, [
        [' supervisor ', C.label],
        [String(supervisor.sessions.length), C.info],
        ['  degraded ', C.label],
        [String(supervisor.degradedConnections), supervisor.degradedConnections > 0 ? C.warn : C.good],
        [' distributed peers ', C.label],
        [String(distributed.peers?.total ?? 0), C.info],
        ['  connected ', C.label],
        [String(distributed.peers?.connected ?? 0), (distributed.peers?.connected ?? 0) > 0 ? C.good : C.dim],
        ['  queued work ', C.label],
        [String(distributed.work?.queued ?? 0), (distributed.work?.queued ?? 0) > 0 ? C.info : C.dim],
      ]),
    ];

    if (daemon.lastError) {
      postureLines.push(buildPanelLine(width, [
        [' daemon error ', C.label],
        [truncateDisplay(daemon.lastError, Math.max(0, width - 14)), C.bad],
      ]));
    }
    const canBrowse = activeConnections.length > 0 || contracts.length > 0;
    const canSwitch = contracts.length > 0 && activeConnections.length > 0;
    const navHint = !canBrowse
      ? `  focus=${this.browseMode}  idle - no connections or contracts to browse`
      : canSwitch
        ? `  focus=${this.browseMode}  Up/Down move  Tab switch connections/contracts  r=recover  Enter=recover selection`
        : `  focus=${this.browseMode}  Up/Down move  r=recover  Enter=recover selection`;
    const footerLines = [
      buildPanelLine(width, [[navHint, C.dim]]),
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
          [selected.lastError.slice(0, Math.max(0, width - 13)), C.bad],
        ]));
      }

      const contract = contracts.find((entry) => entry.runnerId === selected.agentId);
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
          [supervisorEntry.heartbeat.status, supervisorEntry.heartbeat.status === 'fresh' ? C.good : supervisorEntry.heartbeat.status === 'stale' ? C.warn : C.bad],
          ['  Protocol: ', C.label],
          [supervisorEntry.negotiation.executionProtocol, C.value],
          ['  Review: ', C.label],
          [supervisorEntry.negotiation.reviewMode, supervisorEntry.negotiation.reviewMode === 'wrfc' ? C.good : C.dim],
        ]));
        detailRows.push(buildPanelLine(width, [[truncateDisplay(`  ${supervisorEntry.heartbeat.detail}`, width), C.dim]]));
        if (isSupervisorEntryDegraded(supervisorEntry) && supervisorEntry.recovery.length > 0) {
          detailRows.push(buildPanelLine(width, [
            ['  Enter recovers: ', C.label],
            [supervisorEntry.recovery[0].reason, C.warn],
          ]));
        }
      }

      const recentArtifact = snapshot.artifacts.find((artifact) => artifact.runnerId === selected.agentId);
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
          [supervisorEntry.heartbeat.status, supervisorEntry.heartbeat.status === 'fresh' ? C.good : supervisorEntry.heartbeat.status === 'stale' ? C.warn : C.bad],
          ['  Lane: ', C.label],
          [supervisorEntry.negotiation.communicationLane, C.info],
        ]));
        if (isSupervisorEntryDegraded(supervisorEntry) && supervisorEntry.recovery.length > 0) {
          detailRows.push(buildPanelLine(width, [
            ['  Enter recovers: ', C.label],
            [supervisorEntry.recovery[0].reason, C.warn],
          ]));
        }
      }
      const recentArtifact = snapshot.artifacts.find((artifact) => artifact.runnerId === selectedContract.runnerId);
      if (recentArtifact) {
        detailRows.push(buildPanelLine(width, [
          ['  Recent artifact: ', C.label],
          [recentArtifact.id, C.good],
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
            { text: truncateDisplay(` ${connection.label}`, Math.max(0, width - 56)), fg: C.dim },
          ], C, { selected: absolute === this.selectedIndex, selectedBg: C.headerBg });
        })
      : [
          ...contracts.map((contract, absolute) => {
            return buildPanelListRow(width, [
              { text: contract.runnerId.padEnd(18), fg: C.value },
              { text: ` ${contract.transport.state.padEnd(18)}`, fg: stateColor(contract.transport.state) },
              { text: truncateDisplay(` ${contract.template}`, Math.max(0, width - 42)), fg: C.dim },
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
