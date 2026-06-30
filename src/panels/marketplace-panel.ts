import type { Line } from '../types/grid.ts';
import { fitDisplay, truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import {
  type EcosystemCatalogPathOptions,
  listInstalledEcosystemEntries,
  loadEcosystemCatalog,
  reviewEcosystemCatalogEntry,
  type EcosystemCatalogEntry,
  type EcosystemEntryKind,
} from '@/runtime/index.ts';
import type { UiMarketplaceSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

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

export class MarketplacePanel extends ScrollableListPanel<MarketplaceRow> {
  private rows: MarketplaceRow[] = [];
  private readonly unsub: (() => void) | null;

  public constructor(
    private readonly readModel?: UiReadModel<UiMarketplaceSnapshot>,
    private readonly ecosystemPaths?: EcosystemCatalogPathOptions,
  ) {
    super('marketplace', 'Marketplace', 'M', 'monitoring');
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public override onActivate(): void {
    super.onActivate();
    this.refresh();
  }

  // ---------------------------------------------------------------------------
  // ScrollableListPanel implementation
  // ---------------------------------------------------------------------------

  protected getItems(): readonly MarketplaceRow[] {
    return this.rows;
  }

  protected renderItem(row: MarketplaceRow, index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    const provenance = row.entry.provenance ?? 'local';
    return buildPanelLine(width, [
      ['  ', C.label, bg],
      [row.kind.padEnd(11), C.info, bg],
      [fitDisplay(row.entry.name, 20), C.value, bg],
      [` ${fitDisplay(provenance, 16)}`, provenance === 'local' ? C.dim : C.info, bg],
      [` ${(row.installed ? 'INSTALLED' : 'CURATED').padEnd(9)} `, statusColor(row.installed), bg],
      [` ${row.entry.version ?? 'n/a'}`, C.dim, bg],
    ]);
  }

  protected override getPalette() { return C; }
  protected override getEmptyStateMessage() {
    return this.ecosystemPaths
      ? ' No curated marketplace entries found yet.'
      : ' Marketplace catalog paths are not wired into this panel yet.';
  }
  protected override getEmptyStateActions() {
    return [
      { command: '/marketplace bundle import <path>', summary: 'import a curated marketplace bundle' },
      { command: '/marketplace catalog review', summary: 'inspect the current local catalog posture' },
      { command: '/marketplace publish <kind> <path>', summary: 'publish local ecosystem entries back into the curated catalog' },
    ];
  }

  private refresh(): void {
    if (!this.ecosystemPaths) {
      this.rows = [];
      this.clampSelection();
      return;
    }
    try {
      const installedPlugins = new Set(listInstalledEcosystemEntries('plugin', this.ecosystemPaths).map((receipt) => receipt.entry.id));
      const installedSkills = new Set(listInstalledEcosystemEntries('skill', this.ecosystemPaths).map((receipt) => receipt.entry.id));
      const installedHookPacks = new Set(listInstalledEcosystemEntries('hook-pack', this.ecosystemPaths).map((receipt) => receipt.entry.id));
      const installedPolicyPacks = new Set(listInstalledEcosystemEntries('policy-pack', this.ecosystemPaths).map((receipt) => receipt.entry.id));
      const rows: MarketplaceRow[] = [
        ...loadEcosystemCatalog('plugin', this.ecosystemPaths).map((entry) => ({ kind: 'plugin' as const, entry, installed: installedPlugins.has(entry.id) })),
        ...loadEcosystemCatalog('skill', this.ecosystemPaths).map((entry) => ({ kind: 'skill' as const, entry, installed: installedSkills.has(entry.id) })),
        ...loadEcosystemCatalog('hook-pack', this.ecosystemPaths).map((entry) => ({ kind: 'hook-pack' as const, entry, installed: installedHookPacks.has(entry.id) })),
        ...loadEcosystemCatalog('policy-pack', this.ecosystemPaths).map((entry) => ({ kind: 'policy-pack' as const, entry, installed: installedPolicyPacks.has(entry.id) })),
      ];
      this.rows = rows.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
      this.clampSelection();
      // I2: clear any previous catalog load error on successful refresh
      this.clearError();
    } catch (e) {
      // I2: surface catalog load failure
      this.setError(`Catalog load failed: ${summarizeError(e)}`);
    }
  }

  public render(width: number, height: number): Line[] {
    this.clampSelection();
    this.refresh();

    const intro = 'Curated local-first ecosystem with provenance, compatibility, rollback history, and receipt-aware lifecycle review.';
    const installedCount = this.rows.filter((row) => row.installed).length;
    const snapshot = this.readModel?.getSnapshot();
    const recommendations = snapshot?.recommendations ?? [];
    const startupIssues = snapshot?.startupIssues ?? [];

    if (this.rows.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: 'Marketplace Control Room',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            this.ecosystemPaths ? ' No curated marketplace entries found yet.' : ' Marketplace catalog paths are not wired into this panel yet.',
            this.ecosystemPaths
              ? 'The marketplace is ready, but no plugin, skill, hook-pack, or policy-pack catalogs are available in this workspace.'
              : 'The shell needs explicit marketplace catalog roots before this panel can inspect curated plugin, skill, hook-pack, or policy-pack entries.',
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
          [fitDisplay(`${recommendation.kind} ${recommendation.entry.id}`, 28), C.info],
          [truncateDisplay(` ${recommendation.title}`, Math.max(0, width - 31)), C.dim],
        ]))
      : [buildPanelLine(width, [['  No contextual marketplace recommendations right now.', C.dim]])];

    const startupIssueLines = startupIssues.length > 0
      ? startupIssues.slice(0, 4).map((issue) => buildPanelLine(width, [['  ', C.label], [issue.slice(0, Math.max(0, width - 2)), C.warn]]))
      : [buildPanelLine(width, [['  No startup or lifecycle issues are currently pushing marketplace repair recommendations.', C.dim]])];

    const selectedRow = this.rows[this.selectedIndex];
    const selectedLines: Line[] = [];
    if (selectedRow) {
      const review = reviewEcosystemCatalogEntry(selectedRow.entry, this.ecosystemPaths!);
      selectedLines.push(buildPanelLine(width, [
        ['  Provenance: ', C.label],
        [(selectedRow.entry.provenance ?? '(none)').slice(0, Math.max(0, width - 15)), selectedRow.entry.provenance ? C.info : C.dim],
      ]));
      selectedLines.push(buildPanelLine(width, [
        ['  Source: ', C.label],
        [selectedRow.entry.source.slice(0, Math.max(0, width - 11)), C.value],
      ]));
      selectedLines.push(buildKeyValueLine(width, [
        { label: 'Compatibility', value: review.compatibility.status, valueColor: review.compatibility.status === 'supported' ? C.good : C.warn },
        { label: 'Risk', value: review.riskLevel, valueColor: review.riskLevel === 'low' ? C.good : C.warn },
        { label: 'State', value: selectedRow.installed ? 'installed' : 'curated', valueColor: statusColor(selectedRow.installed) },
      ], C));
      selectedLines.push(buildGuidanceLine(width, '/marketplace review <id>', 'inspect full compatibility and receipt detail for the selected entry', C));
    }

    const postureSection: PanelWorkspaceSection = { title: 'Marketplace posture', lines: postureLines };
    const startupIssuesSection: PanelWorkspaceSection = { title: 'Startup Issues', lines: startupIssueLines };
    const recommendationsSection: PanelWorkspaceSection = { title: 'Recommendations', lines: recommendationLines };

    return this.renderList(width, height, {
      title: 'Marketplace Control Room',
      header: [
        ...postureLines,
        ...startupIssueLines,
        ...recommendationLines,
      ],
      footer: selectedLines.length > 0 && height >= 20 ? selectedLines : [],
    });
  }
}
