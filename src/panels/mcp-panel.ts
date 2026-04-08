import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { mcpRegistry, type McpRegistry } from '../mcp/registry.ts';
import type { McpDecisionRecord } from '../runtime/mcp/types.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildEmptyState,
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
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  selectBg: '#0f172a',
} as const;

function modeColor(mode: string): string {
  switch (mode) {
    case 'allow-all':
      return C.error;
    case 'ask-on-risk':
      return C.warn;
    case 'constrained':
      return C.ok;
    case 'blocked':
      return C.error;
    default:
      return C.dim;
  }
}

function freshnessColor(freshness: string): string {
  switch (freshness) {
    case 'fresh':
      return C.ok;
    case 'stale':
    case 'fetch_failed':
      return C.warn;
    case 'quarantined':
      return C.error;
    default:
      return C.dim;
  }
}

function decisionColor(decision: McpDecisionRecord): string {
  if (decision.verdict === 'deny') return C.error;
  if (decision.verdict === 'ask') return C.warn;
  return decision.incoherent ? C.warn : C.ok;
}

export class McpPanel extends BasePanel {
  private readonly registry: McpRegistry;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(registry: McpRegistry = mcpRegistry) {
    super('mcp', 'MCP', 'Z', 'monitoring');
    this.registry = registry;
  }

  public handleInput(key: string): boolean {
    const entries = this.registry.listServerSecurity();
    if (key === 'r') {
      this.markDirty();
      return true;
    }
    if (entries.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(entries.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const intro = 'Trust, quarantine, scope, and recent security decisions for configured MCP servers.';
    const entries = this.registry.listServerSecurity();

    if (entries.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'MCP Control Room',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' No MCP servers configured or connected.',
            'Add MCP servers, inspect trust posture, and review risk-scoped policies here once the registry is populated.',
            [
              { command: '/mcp', summary: 'list server state and security posture' },
              { command: '/settings', summary: 'open the MCP settings category for trust and scope controls' },
            ],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    this.selectedIndex = Math.min(this.selectedIndex, entries.length - 1);
    const selected = entries[this.selectedIndex]!;
    const sandboxBinding = this.registry.listServerSandboxBindings().find((entry) => entry.name === selected.name);
    const window = getTrackedVisibleWindow(entries.length, this.selectedIndex, Math.max(4, height - 16), this.scrollOffset, 1);
    this.scrollOffset = window.start;
    const listLines: Line[] = [];
    for (let absolute = window.start; absolute < window.end; absolute++) {
      const entry = entries[absolute]!;
      const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
      listLines.push(buildPanelLine(width, [
        [' ', C.label, bg],
        [entry.name.padEnd(20), C.value, bg],
        [` ${(entry.connected ? 'CONNECTED' : 'DISCONNECTED').padEnd(13)}`, entry.connected ? C.ok : C.error, bg],
        [` ${entry.trustMode.padEnd(12)}`, modeColor(entry.trustMode), bg],
        [` ${entry.role.padEnd(10)}`, C.info, bg],
        [` ${entry.schemaFreshness}`, freshnessColor(entry.schemaFreshness), bg],
      ]));
    }
    if (entries.length > window.count) {
      listLines.push(buildPanelLine(width, [[`  showing ${window.start + 1}-${window.end} of ${entries.length}`, C.dim]]));
    }

    const detailLines: Line[] = [
      buildPanelLine(width, [
        ['  Server: ', C.label],
        [selected.name, C.value],
        ['  Trust: ', C.label],
        [selected.trustMode, modeColor(selected.trustMode)],
        ['  Role: ', C.label],
        [selected.role, C.info],
      ]),
      buildPanelLine(width, [
        ['  Schema: ', C.label],
        [selected.schemaFreshness, freshnessColor(selected.schemaFreshness)],
        ['  Approved by: ', C.label],
        [truncateDisplay(selected.quarantineApprovedBy ?? 'n/a', Math.max(0, width - 31)), selected.quarantineApprovedBy ? C.info : C.dim],
      ]),
      buildPanelLine(width, [
        ['  Scope: ', C.label],
        [truncateDisplay(
          `paths ${selected.allowedPaths.length > 0 ? selected.allowedPaths.join(', ') : 'unbounded'}  hosts ${selected.allowedHosts.length > 0 ? selected.allowedHosts.join(', ') : 'unbounded'}`,
          Math.max(0, width - 10),
        ), (selected.allowedPaths.length > 0 || selected.allowedHosts.length > 0) ? C.value : C.dim],
      ]),
      buildPanelLine(width, [
        ['  Sandbox: ', C.label],
        [truncateDisplay(
          sandboxBinding?.sessionId
            ? `${sandboxBinding.profileId ?? 'mcp'} ${sandboxBinding.state ?? 'unknown'} ${sandboxBinding.backend ?? 'n/a'} ${sandboxBinding.startupStatus ?? 'n/a'} (${sandboxBinding.sessionId})`
            : 'not isolated',
          Math.max(0, width - 13),
        ), sandboxBinding?.sessionId ? C.info : C.dim],
      ]),
    ];
    if (selected.schemaFreshness === 'quarantined') {
      detailLines.push(buildPanelLine(width, [
        ['  Quarantine: ', C.label],
        [truncateDisplay(`${selected.quarantineReason ?? 'unknown'}${selected.quarantineDetail ? ` - ${selected.quarantineDetail}` : ''}`, Math.max(0, width - 15)), C.error],
      ]));
    }

    const decisions = this.registry.listRecentSecurityDecisions?.(Math.max(0, height - 18)) ?? [];
    const selectedDecision = decisions.find((decision) => decision.serverName === selected.name);
    if (selectedDecision) {
      const summary = `${selectedDecision.serverName}:${selectedDecision.toolName} ${selectedDecision.verdict.toUpperCase()} ${selectedDecision.capability}${selectedDecision.incoherent ? ' incoherent' : ''}`;
      detailLines.push(buildPanelLine(width, [
        ['  Recent: ', C.label],
        [truncateDisplay(summary, Math.max(0, width - 10)), decisionColor(selectedDecision)],
      ]));
    }
    const decisionLines: Line[] = decisions.length === 0
      ? [buildPanelLine(width, [['  No MCP decisions recorded yet.', C.dim]])]
      : decisions.map((decision) => {
          const summary = `${decision.serverName}:${decision.toolName} ${decision.verdict.toUpperCase()} ${decision.capability}${decision.incoherent ? ' incoherent' : ''}`;
          return buildPanelLine(width, [
            ['  ', C.label],
            [truncateDisplay(summary, Math.max(0, width - 2)), decisionColor(decision)],
          ]);
        });

    const repairLines: Line[] = [];
    if (!selected.connected) {
      repairLines.push(buildPanelLine(width, [['  /mcp repair', C.warn], ['  review reconnect and startup posture for this server', C.dim]]));
    }
    if (selected.schemaFreshness !== 'fresh') {
      repairLines.push(buildPanelLine(width, [['  /mcp review', C.warn], ['  inspect schema freshness, quarantine, and trust posture', C.dim]]));
    }
    if (sandboxBinding?.sessionId) {
      repairLines.push(buildPanelLine(width, [['  /sandbox review', C.info], ['  verify the bound MCP isolation session and startup status', C.dim]]));
    }
    if (repairLines.length === 0) {
      repairLines.push(buildPanelLine(width, [['  No immediate MCP repair actions suggested for the selected server.', C.dim]]));
    }

    const sections: PanelWorkspaceSection[] = [
      { title: 'Servers', lines: listLines },
      { title: 'Selected Server', lines: detailLines },
      { title: 'Repair', lines: repairLines },
      { title: 'Recent Decisions', lines: decisionLines },
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'MCP Control Room',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down move  r refresh', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
