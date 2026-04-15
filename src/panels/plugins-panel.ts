import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import { createEmptyLine } from '@pellux/goodvibes-sdk/platform/types/grid';
import { BasePanel } from './base-panel.ts';
import type { PluginManagerObserver, PluginStatus } from '@pellux/goodvibes-sdk/platform/plugins/manager';
import {
  buildEmptyState,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  info: '#38bdf8',
  selectBg: '#0f172a',
} as const;

function trustColor(tier: PluginStatus['trustTier']): string {
  switch (tier) {
    case 'trusted':
      return C.ok;
    case 'limited':
      return C.warn;
    case 'untrusted':
      return C.error;
  }
}

function statusColor(status: PluginStatus): string {
  if (status.quarantined) return C.error;
  if (status.active) return C.ok;
  if (status.enabled) return C.warn;
  return C.dim;
}

function statusLabel(status: PluginStatus): string {
  if (status.quarantined) return 'QUARANTINED';
  if (status.active) return 'ACTIVE';
  if (status.enabled) return 'ENABLED';
  return 'DISABLED';
}

export class PluginsPanel extends BasePanel {
  private readonly manager: PluginManagerObserver;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(manager: PluginManagerObserver) {
    super('plugins', 'Plugins', 'P', 'monitoring');
    this.manager = manager;
    this.unsub = manager.subscribe(() => this.markDirty());
  }

  public override onActivate(): void {
    super.onActivate();
    this.selectedIndex = 0;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const plugins = this.manager.list();
    if (plugins.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(plugins.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const intro = 'Plugin trust, capabilities, signatures, and quarantine posture for the active ecosystem surface.';
    const plugins = this.manager.list();

    if (plugins.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Plugin Control Room',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' No plugins discovered.',
            'Use /plugin list for search paths, install hints, and trust review before activating plugin-backed flows.',
            [
              { command: '/plugin list', summary: 'inspect plugin discovery paths and current registry state' },
              { command: '/marketplace', summary: 'review curated ecosystem entries and provenance posture' },
            ],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    this.selectedIndex = Math.min(this.selectedIndex, plugins.length - 1);
    const selected = plugins[this.selectedIndex]!;
    const selectedCaps = this.manager.capabilities(selected.name);
    const trustRecord = this.manager.getTrustRecord(selected.name);
    const quarantineRecord = this.manager.getQuarantineRecord(selected.name);
    const detailLines: Line[] = [
      buildPanelLine(width, [
        ['  Plugin: ', C.label],
        [selected.name, C.value],
        ['  State: ', C.label],
        [statusLabel(selected), statusColor(selected)],
        ['  Trust: ', C.label],
        [selected.trustTier, trustColor(selected.trustTier)],
      ]),
      buildPanelLine(width, [
        ['  Description: ', C.label],
        [selected.description.slice(0, Math.max(0, width - 15)), C.dim],
      ]),
    ];

    if (selectedCaps) {
      detailLines.push(buildPanelLine(width, [
        ['  Capabilities: ', C.label],
        [String(selectedCaps.requested.length), C.value],
        ['  High-risk: ', C.label],
        [String(selectedCaps.highRisk.length), selectedCaps.highRisk.length > 0 ? C.warn : C.ok],
        ['  Blocked: ', C.label],
        [String(selectedCaps.blocked.length), selectedCaps.blocked.length > 0 ? C.error : C.ok],
      ]));
    }

    if (trustRecord?.signatureFingerprint) {
      detailLines.push(buildPanelLine(width, [
        ['  Signature: ', C.label],
        [trustRecord.signatureFingerprint, C.info],
      ]));
    }

    if (quarantineRecord) {
      detailLines.push(buildPanelLine(width, [
        ['  Quarantine: ', C.label],
        [quarantineRecord.reason.slice(0, Math.max(0, width - 14)), C.error],
      ]));
    }

    detailLines.push(buildPanelLine(width, [['  Inspect trust and capability state here, then use /plugin to take action.', C.dim]]));
    const detailSection: PanelWorkspaceSection = { title: 'Selected Plugin', lines: detailLines };
    const resolvedPluginsSection = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines: [buildPanelLine(width, [['  Up/Down move through discovered plugins', C.dim]])],
      palette: C,
      section: {
        title: 'Plugins',
        scrollableLines: plugins.map((plugin, absolute) => {
          const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
          return buildPanelLine(width, [
            [' ', C.label, bg],
            [plugin.name.padEnd(22), C.value, bg],
            [` ${statusLabel(plugin).padEnd(11)}`, statusColor(plugin), bg],
            [` ${plugin.trustTier.toUpperCase().padEnd(10)}`, trustColor(plugin.trustTier), bg],
            [` ${plugin.version}`, C.dim, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [detailSection],
    });
    this.scrollOffset = resolvedPluginsSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      resolvedPluginsSection.section,
      detailSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Plugin Control Room',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down move through discovered plugins', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
