import type { Line } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
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
import {
  listInstalledEcosystemEntries,
  loadEcosystemCatalog,
  reviewEcosystemCatalogEntry,
  type EcosystemCatalogEntry,
  type EcosystemEntryKind,
} from '../runtime/ecosystem/catalog.ts';
import { buildEcosystemRecommendations } from '../runtime/ecosystem/recommendations.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#e2e8f0',
  headerBg: '#1f2937',
} as const;

type MarketplaceRow = {
  kind: EcosystemEntryKind;
  entry: EcosystemCatalogEntry;
  installed: boolean;
};

function statusColor(installed: boolean): string {
  return installed ? C.good : C.dim;
}

export class MarketplacePanel extends BasePanel {
  private rows: MarketplaceRow[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(private readonly runtimeStore?: RuntimeStore) {
    super('marketplace', 'Marketplace', 'M', 'monitoring');
  }

  public override onActivate(): void {
    super.onActivate();
    this.refresh();
  }

  public handleInput(key: string): boolean {
    if (this.rows.length === 0) return false;
    if (key === 'ArrowUp' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'ArrowDown' || key === 'j') {
      this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  private refresh(): void {
    const installedPlugins = new Set(listInstalledEcosystemEntries('plugin').map((receipt) => receipt.entry.id));
    const installedSkills = new Set(listInstalledEcosystemEntries('skill').map((receipt) => receipt.entry.id));
    const installedHookPacks = new Set(listInstalledEcosystemEntries('hook-pack').map((receipt) => receipt.entry.id));
    const installedPolicyPacks = new Set(listInstalledEcosystemEntries('policy-pack').map((receipt) => receipt.entry.id));
    const rows: MarketplaceRow[] = [
      ...loadEcosystemCatalog('plugin').map((entry) => ({ kind: 'plugin' as const, entry, installed: installedPlugins.has(entry.id) })),
      ...loadEcosystemCatalog('skill').map((entry) => ({ kind: 'skill' as const, entry, installed: installedSkills.has(entry.id) })),
      ...loadEcosystemCatalog('hook-pack').map((entry) => ({ kind: 'hook-pack' as const, entry, installed: installedHookPacks.has(entry.id) })),
      ...loadEcosystemCatalog('policy-pack').map((entry) => ({ kind: 'policy-pack' as const, entry, installed: installedPolicyPacks.has(entry.id) })),
    ];
    this.rows = rows.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    this.refresh();

    const intro = 'Curated local-first ecosystem with provenance, compatibility, rollback history, and receipt-aware lifecycle review.';
    const installedCount = this.rows.filter((row) => row.installed).length;
    const recommendations = buildEcosystemRecommendations(this.runtimeStore);
    const runtimeState = this.runtimeStore?.getState();
    const startupIssues: string[] = [];
    if ((runtimeState?.permissions.denialCount ?? 0) >= 3) {
      startupIssues.push(`${runtimeState?.permissions.denialCount} permission denials suggest a policy-pack or trust posture review.`);
    }
    const authRequiredServers = [...(runtimeState?.mcp.servers.values() ?? [])].filter((server) => server.status === 'auth_required');
    if (authRequiredServers.length > 0) {
      startupIssues.push(`${authRequiredServers.length} MCP server${authRequiredServers.length === 1 ? '' : 's'} need auth or reconnect repair.`);
    }
    const staleSchemas = [...(runtimeState?.mcp.servers.values() ?? [])].filter((server) => server.schemaFreshness !== 'fresh');
    if (staleSchemas.length > 0) {
      startupIssues.push(`${staleSchemas.length} MCP server schema${staleSchemas.length === 1 ? ' is' : 's are'} stale or quarantined.`);
    }

    if (this.rows.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: 'Marketplace Control Room',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' No curated marketplace entries found yet.',
            'The marketplace is ready, but no plugin, skill, hook-pack, or policy-pack catalogs are available in this workspace.',
            [
              { command: '/marketplace bundle import <path>', summary: 'import a curated marketplace bundle' },
              { command: '/marketplace catalog review', summary: 'inspect the current local catalog posture' },
              { command: '/marketplace publish <kind> <path>', summary: 'publish local ecosystem entries back into the curated catalog' },
            ],
            C,
          ),
        }],
        palette: C,
      });
    }

    const postureLines = [
      buildKeyValueLine(width, [
        { label: 'curated', value: String(this.rows.length), valueColor: C.value },
        { label: 'installed', value: String(installedCount), valueColor: installedCount > 0 ? C.good : C.dim },
        { label: 'plugins', value: String(this.rows.filter((row) => row.kind === 'plugin').length), valueColor: C.info },
        { label: 'skills', value: String(this.rows.filter((row) => row.kind === 'skill').length), valueColor: C.info },
        { label: 'hooks', value: String(this.rows.filter((row) => row.kind === 'hook-pack').length), valueColor: C.info },
        { label: 'policies', value: String(this.rows.filter((row) => row.kind === 'policy-pack').length), valueColor: C.info },
      ], C),
      buildGuidanceLine(width, '/marketplace open', 'browse curated entries and inspect compatibility, provenance, and receipts', C),
    ];

    const recommendationLines = recommendations.length > 0
      ? recommendations.slice(0, 4).map((recommendation) => buildPanelLine(width, [
          ['  ', C.label],
          [`${recommendation.kind} ${recommendation.entry.id}`.slice(0, 28).padEnd(28), C.info],
          [` ${recommendation.title}`.slice(0, Math.max(0, width - 31)), C.dim],
        ]))
      : [buildPanelLine(width, [['  No contextual marketplace recommendations right now.', C.dim]])];

    const startupIssueLines = startupIssues.length > 0
      ? startupIssues.slice(0, 4).map((issue) => buildPanelLine(width, [['  ', C.label], [issue.slice(0, Math.max(0, width - 2)), C.warn]]))
      : [buildPanelLine(width, [['  No startup or lifecycle issues are currently pushing marketplace repair recommendations.', C.dim]])];

    const selected = this.rows[this.selectedIndex];
    const selectedLines: Line[] = [];
    if (selected) {
      const review = reviewEcosystemCatalogEntry(selected.entry);
      selectedLines.push(buildPanelLine(width, [
        ['  Provenance: ', C.label],
        [(selected.entry.provenance ?? '(none)').slice(0, Math.max(0, width - 15)), selected.entry.provenance ? C.info : C.dim],
      ]));
      selectedLines.push(buildPanelLine(width, [
        ['  Source: ', C.label],
        [selected.entry.source.slice(0, Math.max(0, width - 11)), C.value],
      ]));
      selectedLines.push(buildKeyValueLine(width, [
        { label: 'Compatibility', value: review.compatibility.status, valueColor: review.compatibility.status === 'compatible' ? C.good : C.warn },
        { label: 'Risk', value: review.riskLevel, valueColor: review.riskLevel === 'low' ? C.good : C.warn },
        { label: 'State', value: selected.installed ? 'installed' : 'curated', valueColor: statusColor(selected.installed) },
      ], C));
      selectedLines.push(buildGuidanceLine(width, '/marketplace review <id>', 'inspect full compatibility and receipt detail for the selected entry', C));
    }

    const introRows = 1;
    const fixedRows = postureLines.length + Math.min(5, selectedLines.length) + 5;
    const listBudget = Math.max(4, height - introRows - fixedRows);
    const window = getTrackedVisibleWindow(this.rows.length, this.selectedIndex, listBudget, this.scrollOffset, 1);
    this.scrollOffset = window.start;

    const catalogLines = this.rows.slice(window.start, window.end).map((row, index) => {
      const globalIndex = window.start + index;
      const bg = globalIndex === this.selectedIndex ? C.selectBg : undefined;
      const provenance = row.entry.provenance ?? 'local';
      return buildPanelLine(width, [
        ['  ', C.label, bg],
        [row.kind.padEnd(11), C.info, bg],
        [row.entry.name.slice(0, 20).padEnd(20), C.value, bg],
        [` ${provenance.slice(0, 16).padEnd(16)}`, provenance === 'local' ? C.dim : C.info, bg],
        [` ${(row.installed ? 'INSTALLED' : 'CURATED').padEnd(9)} `, statusColor(row.installed), bg],
        [` ${row.entry.version ?? 'n/a'}`, C.dim, bg],
      ]);
    });
    if (this.rows.length > window.count) {
      catalogLines.push(buildPanelLine(width, [[`  showing ${window.start + 1}-${window.end} of ${this.rows.length}`, C.dim]]));
    }

    const sections: PanelWorkspaceSection[] = [
      { title: 'Posture', lines: postureLines },
      { title: 'Startup Issues', lines: startupIssueLines },
      { title: 'Recommendations', lines: recommendationLines },
      { title: 'Catalog', lines: catalogLines },
    ];
    if (selectedLines.length > 0 && height >= 20) {
      sections.push({ title: 'Selected', lines: selectedLines });
    }

    return buildPanelWorkspace(width, height, {
      title: 'Marketplace Control Room',
      intro,
      sections,
      palette: C,
    });
  }
}
