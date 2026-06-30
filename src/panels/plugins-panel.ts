import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { PluginManagerObserver, PluginStatus } from '@pellux/goodvibes-sdk/platform/plugins';
import {
  buildDetailBlock,
  buildEmptyState,
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
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

export class PluginsPanel extends ScrollableListPanel<PluginStatus> {
  private readonly manager: PluginManagerObserver;
  private readonly unsub: (() => void) | null;

  public constructor(manager: PluginManagerObserver) {
    super('plugins', 'Plugins', 'P', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter plugins';
    this.manager = manager;
    this.unsub = manager.subscribe(() => this.markDirty());
  }

  protected override filterMatches(plugin: PluginStatus, q: string): boolean {
    return plugin.name.toLowerCase().includes(q)
      || plugin.trustTier.toLowerCase().includes(q)
      || plugin.version.toLowerCase().includes(q);
  }

  public override onActivate(): void {
    super.onActivate();
    this.selectedIndex = 0;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected getItems(): readonly PluginStatus[] {
    return this.manager.list();
  }

  protected renderItem(plugin: PluginStatus, _index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [plugin.name.padEnd(22), C.value, bg],
      [` ${statusLabel(plugin).padEnd(11)}`, statusColor(plugin), bg],
      [` ${plugin.trustTier.toUpperCase().padEnd(10)}`, trustColor(plugin.trustTier), bg],
      [` ${plugin.version}`, C.dim, bg],
    ]);
  }

  protected override getEmptyStateMessage(): string {
    return ' No plugins discovered.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/plugin list', summary: 'inspect plugin discovery paths and current registry state' },
      { command: '/marketplace', summary: 'review curated ecosystem entries and provenance posture' },
    ];
  }

  public render(width: number, height: number): Line[] {
    const intro = 'Plugin trust, capabilities, signatures, and quarantine posture for the active ecosystem surface.';
    const plugins = this.getItems();

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

    // Provenance/error posture header — surface trust + quarantine pressure first.
    const quarantined = plugins.filter((p) => p.quarantined).length;
    const untrusted = plugins.filter((p) => p.trustTier === 'untrusted').length;
    const active = plugins.filter((p) => p.active).length;
    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'plugins', value: String(plugins.length), valueColor: C.info },
        { label: 'active', value: String(active), valueColor: active > 0 ? C.ok : C.dim },
        { label: 'untrusted', value: String(untrusted), valueColor: untrusted > 0 ? C.warn : C.dim },
        { label: 'quarantined', value: String(quarantined), valueColor: quarantined > 0 ? C.error : C.dim },
      ], C),
    ];

    this.clampSelection();
    const selected = plugins[this.selectedIndex]!;
    const selectedCaps = this.manager.capabilities(selected.name);
    const trustRecord = this.manager.getTrustRecord(selected.name);
    const quarantineRecord = this.manager.getQuarantineRecord(selected.name);
    const detailRows: Line[] = [
      buildPanelLine(width, [
        ['  Plugin: ', C.label],
        [selected.name, C.value],
        ['  v', C.label],
        [selected.version, C.dim],
        ['  State: ', C.label],
        [statusLabel(selected), statusColor(selected)],
        ['  Trust: ', C.label],
        [selected.trustTier, trustColor(selected.trustTier)],
      ]),
      buildPanelLine(width, [
        ['  Description: ', C.label],
        [truncateDisplay(selected.description, Math.max(0, width - 15)), C.dim],
      ]),
    ];

    if (selectedCaps) {
      detailRows.push(buildPanelLine(width, [
        ['  Capabilities: ', C.label],
        [String(selectedCaps.requested.length), C.value],
        ['  High-risk: ', C.label],
        [String(selectedCaps.highRisk.length), selectedCaps.highRisk.length > 0 ? C.warn : C.ok],
        ['  Blocked: ', C.label],
        [String(selectedCaps.blocked.length), selectedCaps.blocked.length > 0 ? C.error : C.ok],
      ]));
    }

    if (trustRecord?.signatureFingerprint) {
      detailRows.push(buildPanelLine(width, [
        ['  Signature: ', C.label],
        [truncateDisplay(trustRecord.signatureFingerprint, Math.max(0, width - 14)), C.info],
      ]));
    } else {
      detailRows.push(buildPanelLine(width, [['  Signature: unsigned (no provenance fingerprint on record)', C.warn]]));
    }

    if (quarantineRecord) {
      detailRows.push(buildPanelLine(width, [
        ['  Quarantine: ', C.label],
        [truncateDisplay(quarantineRecord.reason, Math.max(0, width - 14)), C.error],
      ]));
    }

    const hints = this.filterActive
      ? [{ keys: 'type', label: 'filter' }, { keys: 'Enter', label: 'apply' }, { keys: 'Esc', label: 'clear' }]
      : [
          { keys: 'Up/Down', label: 'move' },
          { keys: '/plugin', label: 'act' },
          { keys: '/', label: 'filter' },
        ];

    return this.renderList(width, height, {
      title: 'Plugin Control Room',
      header: headerLines,
      footer: [
        ...buildDetailBlock(width, `Plugin · ${selected.name}`, detailRows, C),
        buildKeyboardHints(width, hints, C),
      ],
    });
  }
}
