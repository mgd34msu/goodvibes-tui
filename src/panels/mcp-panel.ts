import type { Line } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp/registry';
import type { McpDecisionRecord } from '@pellux/goodvibes-sdk/platform/runtime/mcp/types';

type McpServerSecurityEntry = ReturnType<McpRegistry['listServerSecurity']>[number];
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildStatusPill,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';

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

export class McpPanel extends ScrollableListPanel<McpServerSecurityEntry> {
  private readonly registry: McpRegistry;

  public constructor(registry: McpRegistry) {
    super('mcp', 'MCP', 'Z', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.registry = registry;
  }

  protected override getPalette() { return C; }
  protected override getEmptyStateMessage() { return ' No MCP servers configured or connected.'; }
  protected override getEmptyStateActions() {
    return [
      { command: '/mcp', summary: 'list server state and security posture' },
      { command: '/settings', summary: 'open the MCP settings category for trust and scope controls' },
    ];
  }

  protected getItems(): readonly McpServerSecurityEntry[] {
    return this.registry.listServerSecurity();
  }

  protected renderItem(entry: McpServerSecurityEntry, index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [entry.name.padEnd(20), C.value, bg],
      ...buildStatusPill(entry.connected ? 'good' : 'bad', ` ${(entry.connected ? 'CONNECTED' : 'DISCONNECTED').padEnd(13)}`, { bg }),
      [` ${entry.trustMode.padEnd(12)}`, modeColor(entry.trustMode), bg],
      [` ${entry.role.padEnd(10)}`, C.info, bg],
      [` ${entry.schemaFreshness}`, freshnessColor(entry.schemaFreshness), bg],
    ]);
  }

  public handleInput(key: string): boolean {
    if (key === 'r') {
      this.markDirty();
      return true;
    }
    return super.handleInput(key);
  }

  public render(width: number, height: number): Line[] {
    this.clampSelection();
    const entries = this.registry.listServerSecurity();
    const intro = 'Trust, quarantine, scope, and recent security decisions for configured MCP servers.';

    const connected = entries.filter((e) => e.connected).length;
    const quarantined = entries.filter((e) => e.schemaFreshness === 'quarantined').length;
    const disconnected = entries.length - connected;
    const staleSchemas = entries.filter((e) => e.schemaFreshness !== 'fresh').length;

    const headerLines: Line[] = [
      buildPanelLine(width, [['  MCP posture', C.label]]),
      buildKeyValueLine(width, [
        { label: 'servers', value: String(entries.length), valueColor: C.value },
        { label: 'connected', value: String(connected), valueColor: connected > 0 ? C.ok : C.dim },
        { label: 'disconnected', value: String(disconnected), valueColor: disconnected > 0 ? C.warn : C.dim },
        { label: 'stale schema', value: String(staleSchemas), valueColor: staleSchemas > 0 ? C.warn : C.dim },
        { label: 'quarantined', value: String(quarantined), valueColor: quarantined > 0 ? C.error : C.dim },
      ], C),
      buildGuidanceLine(width, '/mcp review', 'inspect trust, freshness, and quarantine posture for configured servers', C),
      buildGuidanceLine(width, '/mcp repair', 'review reconnect, auth, import, and startup remediation guidance', C),
    ];

    const selected = entries[this.selectedIndex];
    const detailLines: Line[] = [];
    const repairLines: Line[] = [];

    if (selected) {
      const sandboxBinding = this.registry.listServerSandboxBindings().find((e) => e.name === selected.name);
      const decisions = this.registry.listRecentSecurityDecisions?.(24) ?? [];
      const selectedDecision = decisions.find((d) => d.serverName === selected.name);

      detailLines.push(buildPanelLine(width, [
        ['  Server: ', C.label],
        [selected.name, C.value],
        ['  Trust: ', C.label],
        [selected.trustMode, modeColor(selected.trustMode)],
        ['  Role: ', C.label],
        [selected.role, C.info],
      ]));
      detailLines.push(buildPanelLine(width, [
        ['  Schema: ', C.label],
        [selected.schemaFreshness, freshnessColor(selected.schemaFreshness)],
        ['  Approved by: ', C.label],
        [truncateDisplay(selected.quarantineApprovedBy ?? 'n/a', Math.max(0, width - 31)), selected.quarantineApprovedBy ? C.info : C.dim],
      ]));
      detailLines.push(buildPanelLine(width, [
        ['  Scope: ', C.label],
        [truncateDisplay(
          `paths ${selected.allowedPaths.length > 0 ? selected.allowedPaths.join(', ') : 'unbounded'}  hosts ${selected.allowedHosts.length > 0 ? selected.allowedHosts.join(', ') : 'unbounded'}`,
          Math.max(0, width - 10),
        ), (selected.allowedPaths.length > 0 || selected.allowedHosts.length > 0) ? C.value : C.dim],
      ]));
      detailLines.push(buildPanelLine(width, [
        ['  Sandbox: ', C.label],
        [truncateDisplay(
          sandboxBinding?.sessionId
            ? `${sandboxBinding.profileId ?? 'mcp'} ${sandboxBinding.state ?? 'unknown'} ${sandboxBinding.backend ?? 'n/a'} ${sandboxBinding.startupStatus ?? 'n/a'} (${sandboxBinding.sessionId})`
            : 'not isolated',
          Math.max(0, width - 13),
        ), sandboxBinding?.sessionId ? C.info : C.dim],
      ]));
      if (selected.schemaFreshness === 'quarantined') {
        detailLines.push(buildPanelLine(width, [
          ['  Quarantine: ', C.label],
          [truncateDisplay(`${selected.quarantineReason ?? 'unknown'}${selected.quarantineDetail ? ` - ${selected.quarantineDetail}` : ''}`, Math.max(0, width - 15)), C.error],
        ]));
      }
      if (selectedDecision) {
        const summary = `${selectedDecision.serverName}:${selectedDecision.toolName} ${selectedDecision.verdict.toUpperCase()} ${selectedDecision.capability}${selectedDecision.incoherent ? ' incoherent' : ''}`;
        detailLines.push(buildPanelLine(width, [
          ['  Recent: ', C.label],
          [truncateDisplay(summary, Math.max(0, width - 10)), decisionColor(selectedDecision)],
        ]));
      }

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

      const allDecisions = this.registry.listRecentSecurityDecisions?.(24) ?? [];
      const decisionLines: Line[] = allDecisions.length === 0
        ? [buildPanelLine(width, [['  No MCP decisions recorded yet.', C.dim]])]
        : allDecisions.map((decision) => {
            const summary = `${decision.serverName}:${decision.toolName} ${decision.verdict.toUpperCase()} ${decision.capability}${decision.incoherent ? ' incoherent' : ''}`;
            return buildPanelLine(width, [
              ['  ', C.label],
              [truncateDisplay(summary, Math.max(0, width - 2)), decisionColor(decision)],
            ]);
          });
      detailLines.push(...repairLines);
      detailLines.push(...decisionLines);
    }

    return this.renderList(width, height, {
      title: 'MCP Control Room',
      header: headerLines,
      footer: [
        ...detailLines,
        buildPanelLine(width, [['  Up/Down move  r refresh', C.dim]]),
      ],
    });
  }
}
