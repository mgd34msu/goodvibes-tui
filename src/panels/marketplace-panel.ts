import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { fitDisplay, truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import {
  type EcosystemCatalogPathOptions,
  installEcosystemCatalogEntry,
  listInstalledEcosystemEntries,
  loadEcosystemCatalog,
  reviewEcosystemCatalogEntry,
  uninstallEcosystemCatalogEntry,
  type EcosystemCatalogEntry,
  type EcosystemEntryKind,
} from '@/runtime/index.ts';
import type { UiMarketplaceSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

// Base chrome only — title band and text tokens come straight from
// DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

type MarketplaceReview = ReturnType<typeof reviewEcosystemCatalogEntry>;

type MarketplaceRow = {
  kind: EcosystemEntryKind;
  entry: EcosystemCatalogEntry;
  installed: boolean;
  /**
   * Computed once per refresh() (not per render()) so that render() never
   * touches disk — see the class-level note on the render()/refresh() split.
   */
  review: MarketplaceReview;
};

/** What a pending install/uninstall confirm will do once the user confirms. */
interface MarketplaceConfirmSubject {
  readonly kind: EcosystemEntryKind;
  readonly entryId: string;
  readonly action: 'install' | 'uninstall';
}

function statusColor(installed: boolean): string {
  return installed ? C.good : C.dim;
}

export class MarketplacePanel extends ScrollableListPanel<MarketplaceRow> {
  private rows: MarketplaceRow[] = [];
  private readonly unsub: (() => void) | null;
  // I1: confirm state for install/uninstall (destructive-adjacent — mutates disk)
  private confirm: ConfirmState<MarketplaceConfirmSubject> | null = null;
  // Entry id whose full review detail is expanded (Enter toggles); cleared on refresh.
  private expandedEntryId: string | null = null;

  public constructor(
    private readonly readModel?: UiReadModel<UiMarketplaceSnapshot>,
    private readonly ecosystemPaths?: EcosystemCatalogPathOptions,
  ) {
    super('marketplace', 'Marketplace', 'M', 'monitoring');
    this.filterEnabled = true;
    this.filterLabel = 'Filter marketplace';
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  protected override filterMatches(row: MarketplaceRow, q: string): boolean {
    return row.kind.toLowerCase().includes(q)
      || row.entry.name.toLowerCase().includes(q)
      || (row.entry.provenance ?? 'local').toLowerCase().includes(q);
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  // Disk reload happens here (activate) and on explicit 'r' refresh — never
  // inside render(), which used to reload all four catalogs every frame.
  public override onActivate(): void {
    super.onActivate();
    this.refresh();
  }

  protected override onSelect(row: MarketplaceRow): void {
    // Enter toggles the full review-detail block for the selected entry.
    this.expandedEntryId = this.expandedEntryId === row.entry.id ? null : row.entry.id;
    this.markDirty();
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

  public override handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    const confirmResult = handleConfirmInput(this.confirm, key);
    if (confirmResult === 'confirmed') {
      const subject = this.confirm!.subject;
      this.confirm = null;
      this._applyConfirmedAction(subject);
      this.markDirty();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this.confirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') return true;

    if (!this.filterActive) {
      if (key === 'r') {
        this.refresh();
        this.markDirty();
        return true;
      }

      const selectedRow = this.rows[this.selectedIndex];
      if (key === 'i' && selectedRow && !selectedRow.installed && this.ecosystemPaths) {
        this.confirm = {
          subject: { kind: selectedRow.kind, entryId: selectedRow.entry.id, action: 'install' },
          label: `${selectedRow.kind} ${selectedRow.entry.name}`,
          verb: 'Install',
        };
        this.markDirty();
        return true;
      }
      if (key === 'u' && selectedRow && selectedRow.installed && this.ecosystemPaths) {
        this.confirm = {
          subject: { kind: selectedRow.kind, entryId: selectedRow.entry.id, action: 'uninstall' },
          label: `${selectedRow.kind} ${selectedRow.entry.name}`,
          verb: 'Uninstall',
        };
        this.markDirty();
        return true;
      }

      // Recommendations become actionable jumps: pressing the digit shown next
      // to a recommendation row jumps the selection to (and expands) that
      // catalog entry, rather than only printing a static suggestion.
      if (/^[1-9]$/.test(key)) {
        const recommendations = this.readModel?.getSnapshot()?.recommendations ?? [];
        const recommendation = recommendations[Number(key) - 1];
        if (recommendation) {
          const targetIndex = this.rows.findIndex((row) => row.kind === recommendation.kind && row.entry.id === recommendation.entry.id);
          if (targetIndex >= 0) {
            this.selectedIndex = targetIndex;
            this.expandedEntryId = recommendation.entry.id;
            this.markDirty();
            return true;
          }
        }
      }
    }

    return super.handleInput(key);
  }

  private _applyConfirmedAction(subject: MarketplaceConfirmSubject): void {
    if (!this.ecosystemPaths) return;
    const verb = subject.action === 'install' ? 'Install' : 'Uninstall';
    try {
      const result = subject.action === 'install'
        ? installEcosystemCatalogEntry(subject.kind, subject.entryId, this.ecosystemPaths)
        : uninstallEcosystemCatalogEntry(subject.kind, subject.entryId, this.ecosystemPaths);
      if (!result.ok) {
        this.setError(`${verb} failed: ${result.error}`);
        return;
      }
      this.clearError();
      this.refresh();
    } catch (e) {
      this.setError(`${verb} failed: ${summarizeError(e)}`);
    }
  }

  private refresh(): void {
    if (!this.ecosystemPaths) {
      this.rows = [];
      this.clampSelection();
      return;
    }
    const ecosystemPaths = this.ecosystemPaths;
    try {
      const installedPlugins = new Set(listInstalledEcosystemEntries('plugin', ecosystemPaths).map((receipt) => receipt.entry.id));
      const installedSkills = new Set(listInstalledEcosystemEntries('skill', ecosystemPaths).map((receipt) => receipt.entry.id));
      const installedHookPacks = new Set(listInstalledEcosystemEntries('hook-pack', ecosystemPaths).map((receipt) => receipt.entry.id));
      const installedPolicyPacks = new Set(listInstalledEcosystemEntries('policy-pack', ecosystemPaths).map((receipt) => receipt.entry.id));
      const build = (kind: EcosystemEntryKind, installed: Set<string>): MarketplaceRow[] =>
        loadEcosystemCatalog(kind, ecosystemPaths).map((entry) => ({
          kind,
          entry,
          installed: installed.has(entry.id),
          review: reviewEcosystemCatalogEntry(entry, ecosystemPaths),
        }));
      const rows: MarketplaceRow[] = [
        ...build('plugin', installedPlugins),
        ...build('skill', installedSkills),
        ...build('hook-pack', installedHookPacks),
        ...build('policy-pack', installedPolicyPacks),
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

    if (this.confirm) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'Marketplace Control Room',
        sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this.confirm) }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

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

    // Recommendations become actionable jumps: each row is numbered and the
    // matching digit key jumps the main selection straight to that entry
    // (see handleInput) instead of only printing a static suggestion.
    const recommendationLines = recommendations.length > 0
      ? recommendations.slice(0, 4).map((recommendation, index) => buildPanelLine(width, [
          [`  [${index + 1}] `, C.info],
          [fitDisplay(`${recommendation.kind} ${recommendation.entry.id}`, 26), C.info],
          [truncateDisplay(` ${recommendation.title}`, Math.max(0, width - 33)), C.dim],
        ]))
      : [buildPanelLine(width, [['  No contextual marketplace recommendations right now.', C.dim]])];

    const startupIssueLines = startupIssues.length > 0
      ? startupIssues.slice(0, 4).map((issue) => buildPanelLine(width, [['  ', C.label], [truncateDisplay(issue, Math.max(0, width - 2)), C.warn]]))
      : [buildPanelLine(width, [['  No startup or lifecycle issues are currently pushing marketplace repair recommendations.', C.dim]])];

    const selectedRow = this.rows[this.selectedIndex];
    const selectedLines: Line[] = [];
    if (selectedRow) {
      // review is computed once in refresh() (not here) so render() never
      // touches disk.
      const review = selectedRow.review;
      selectedLines.push(buildPanelLine(width, [
        ['  Provenance: ', C.label],
        [truncateDisplay(selectedRow.entry.provenance ?? '(none)', Math.max(0, width - 15)), selectedRow.entry.provenance ? C.info : C.dim],
      ]));
      selectedLines.push(buildPanelLine(width, [
        ['  Source: ', C.label],
        [truncateDisplay(selectedRow.entry.source, Math.max(0, width - 11)), C.value],
      ]));
      selectedLines.push(buildKeyValueLine(width, [
        { label: 'Compatibility', value: review.compatibility.status, valueColor: review.compatibility.status === 'supported' ? C.good : C.warn },
        { label: 'Risk', value: review.riskLevel, valueColor: review.riskLevel === 'low' ? C.good : C.warn },
        { label: 'State', value: selectedRow.installed ? 'installed' : 'curated', valueColor: statusColor(selectedRow.installed) },
      ], C));

      if (this.expandedEntryId === selectedRow.entry.id) {
        // Enter = full review detail: every field reviewEcosystemCatalogEntry
        // returns, not just the compact compatibility/risk/state summary above.
        selectedLines.push(buildPanelLine(width, [
          ['  Source path: ', C.label],
          [truncateDisplay(review.sourcePath, Math.max(0, width - 16)), review.sourceExists ? C.good : C.warn],
        ]));
        selectedLines.push(buildKeyValueLine(width, [
          { label: 'Source kind', value: review.sourceKind, valueColor: C.info },
          { label: 'Source exists', value: review.sourceExists ? 'yes' : 'no', valueColor: review.sourceExists ? C.good : C.warn },
          { label: 'Recommended scope', value: review.recommendedScope, valueColor: C.info },
        ], C));
        selectedLines.push(buildPanelLine(width, [
          ['  Runtime fit: ', C.label],
          [review.runtimeFit.status, review.runtimeFit.status === 'supported' ? C.good : C.warn],
          [review.runtimeFit.reasons.length > 0 ? ` (${review.runtimeFit.reasons.join('; ')})` : '', C.dim],
        ]));
        if (review.compatibility.reasons.length > 0) {
          selectedLines.push(buildPanelLine(width, [
            ['  Compatibility notes: ', C.label],
            [truncateDisplay(review.compatibility.reasons.join('; '), Math.max(0, width - 24)), C.warn],
          ]));
        }
      } else {
        selectedLines.push(buildGuidanceLine(width, 'Enter', 'expand full compatibility, receipt, and runtime-fit detail for the selected entry', C));
      }
    }

    // Context-aware hints: filter mode vs. browse mode (install/uninstall only
    // make sense given the selected entry's current install state).
    const hints = this.filterActive
      ? [{ keys: 'type', label: 'filter' }, { keys: 'Enter', label: 'apply' }, { keys: 'Esc', label: 'clear' }]
      : [
          { keys: 'Up/Down', label: 'move' },
          { keys: 'Enter', label: 'detail' },
          ...(selectedRow && !selectedRow.installed ? [{ keys: 'i', label: 'install' }] : []),
          ...(selectedRow && selectedRow.installed ? [{ keys: 'u', label: 'uninstall' }] : []),
          ...(recommendations.length > 0 ? [{ keys: '1-9', label: 'jump to recommendation' }] : []),
          { keys: 'r', label: 'refresh' },
          { keys: '/', label: 'filter' },
        ];

    const footer: Line[] = selectedLines.length > 0 && height >= 20
      ? [...selectedLines, buildKeyboardHints(width, hints, C)]
      : [buildKeyboardHints(width, hints, C)];

    return this.renderList(width, height, {
      title: 'Marketplace Control Room',
      header: [
        ...postureLines,
        ...startupIssueLines,
        ...recommendationLines,
      ],
      footer,
    });
  }
}
