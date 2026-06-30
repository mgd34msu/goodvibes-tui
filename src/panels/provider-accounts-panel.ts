import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildDetailBlock,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelListRow,
  buildPanelLine,
  buildSummaryBlock,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';
import {
  type ProviderAccountRecord,
  type ProviderAccountSnapshot,
  type ProviderAccountSnapshotQuery,
} from './provider-account-snapshot.ts';

export interface ProviderAccountsPanelDeps {
  readonly providerAccounts: ProviderAccountSnapshotQuery;
}

const C = {
  ...DEFAULT_PANEL_PALETTE,
  selectBg: '#1e293b',
} as const;

export class ProviderAccountsPanel extends ScrollableListPanel<ProviderAccountRecord> {
  private records: ProviderAccountRecord[] = [];
  private loading = false;
  private readonly providerAccounts: ProviderAccountSnapshotQuery;

  public constructor(deps: ProviderAccountsPanelDeps) {
    super('accounts', 'Accounts', 'Q', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.providerAccounts = deps.providerAccounts;
    void this.refresh();
  }

  public override onActivate(): void {
    super.onActivate();
    if (!this.loading) void this.refresh();
  }

  protected getItems(): readonly ProviderAccountRecord[] {
    return this.records;
  }

  protected renderItem(item: ProviderAccountRecord, _index: number, selected: boolean, width: number): Line {
    return buildPanelListRow(width, [
      { text: item.providerId.padEnd(16), fg: item.active ? C.good : C.value },
      { text: ` ${item.activeRoute.padEnd(14)}`, fg: item.activeRoute === 'subscription' ? C.info : item.activeRoute === 'api-key' ? C.warn : item.activeRoute === 'service-oauth' ? C.value : C.dim },
      { text: ` models=${String(item.modelCount).padEnd(4)}`, fg: C.dim },
      { text: ` ${item.authFreshness.padEnd(10)}`, fg: item.authFreshness === 'expired' ? C.bad : item.authFreshness === 'expiring' || item.authFreshness === 'pending' ? C.warn : C.dim },
      { text: ` issues=${String(item.issues.length).padEnd(2)}`, fg: item.issues.length > 0 ? C.bad : C.good },
    ], C, { selected });
  }

  public handleInput(key: string): boolean {
    if (key === 'r') {
      void this.refresh();
      return true;
    }
    return super.handleInput(key);
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.markDirty();
    const snapshot = await this.buildSnapshot();
    this.records = [...snapshot.providers];
    this.clampSelection();
    this.loading = false;
    this.markDirty();
  }

  private async buildSnapshot(): Promise<ProviderAccountSnapshot> {
    return this.providerAccounts.loadSnapshot();
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const intro = 'Provider auth routes, subscription posture, quota-window hints, and routing-safety notes.';
    const footerLines = [buildPanelLine(width, [['  Up/Down move  r refresh  /accounts routes <provider>  /accounts repair <provider>', C.dim]])];
    if (this.loading && this.records.length === 0) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'Provider Account Control Room',
        intro,
        sections: [{ lines: [buildPanelLine(width, [[' Loading provider account posture...', C.info]])] }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }
    if (this.records.length === 0) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'Provider Account Control Room',
        intro,
        sections: [{
          lines: buildEmptyState(width, ' No provider accounts discovered.', 'Configure API keys or subscriptions to populate account routing posture.', [{ command: '/provider', summary: 'review current provider and model posture' }], C),
        }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }
    const issueCount = this.records.reduce((sum, record) => sum + record.issues.length + (record.fallbackRisk ? 1 : 0), 0);
    const expiredCount = this.records.filter((record) => record.authFreshness === 'expired').length;
    const pendingCount = this.records.filter((record) => record.pendingLogin).length;
    const fallbackCount = this.records.filter((record) => Boolean(record.fallbackRisk)).length;
    const selected = this.records[this.selectedIndex]!;
    const postureLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'providers', value: String(this.records.length), valueColor: C.value },
        { label: 'expired auth', value: String(expiredCount), valueColor: expiredCount > 0 ? C.bad : C.good },
        { label: 'pending login', value: String(pendingCount), valueColor: pendingCount > 0 ? C.warn : C.dim },
        { label: 'fallback risk', value: String(fallbackCount), valueColor: fallbackCount > 0 ? C.warn : C.good },
      ], C),
      buildKeyValueLine(width, [
        { label: 'total issues', value: String(issueCount), valueColor: issueCount > 0 ? C.bad : C.good },
        { label: 'selected', value: selected.providerId, valueColor: C.info },
        { label: 'route', value: selected.activeRoute, valueColor: selected.activeRoute === 'subscription' ? C.info : selected.activeRoute === 'api-key' ? C.warn : C.value },
        { label: 'freshness', value: selected.authFreshness, valueColor: selected.authFreshness === 'expired' ? C.bad : selected.authFreshness === 'expiring' || selected.authFreshness === 'pending' ? C.warn : C.good },
      ], C),
      buildGuidanceLine(width, '/accounts repair <provider>', 'review routing safety, fallback cost, and provider-specific recovery steps', C),
    ];
    const detailRows: Line[] = [
      buildKeyValueLine(width, [
        { label: 'provider', value: selected.providerId, valueColor: C.value },
        { label: 'active route', value: selected.activeRoute, valueColor: selected.activeRoute === 'subscription' ? C.info : selected.activeRoute === 'api-key' ? C.warn : selected.activeRoute === 'service-oauth' ? C.value : C.bad },
        { label: 'preferred route', value: selected.preferredRoute, valueColor: C.dim },
        { label: 'freshness', value: selected.authFreshness, valueColor: selected.authFreshness === 'expired' ? C.bad : selected.authFreshness === 'expiring' || selected.authFreshness === 'pending' ? C.warn : C.good },
      ], C),
      buildKeyValueLine(width, [
        { label: 'configured', value: selected.configured ? 'yes' : 'no', valueColor: selected.configured ? C.good : C.bad },
        { label: 'oauth ready', value: selected.oauthReady ? 'yes' : 'no', valueColor: selected.oauthReady ? C.info : C.dim },
        { label: 'pending login', value: selected.pendingLogin ? 'yes' : 'no', valueColor: selected.pendingLogin ? C.warn : C.dim },
      ], C),
      buildPanelLine(width, [[truncateDisplay(`  Active route reason: ${selected.activeRouteReason}`, width), C.dim]]),
      buildPanelLine(width, [[truncateDisplay(`  Available routes: ${selected.availableRoutes.join(', ') || 'unconfigured'}`, width), C.dim]]),
    ];
    if (selected.expiresAt) {
      detailRows.push(buildPanelLine(width, [
        ['  Expires: ', C.label],
        [new Date(selected.expiresAt).toISOString(), C.dim],
        ['  Token: ', C.label],
        [selected.tokenType ?? 'n/a', C.value],
      ]));
    }
    if (selected.fallbackRisk) {
      detailRows.push(buildPanelLine(width, [[truncateDisplay(`  fallback: ${selected.fallbackRisk}`, width), C.warn]]));
    }
    for (const route of selected.routeRecords) {
      detailRows.push(buildPanelLine(width, [[
        truncateDisplay(`  route ${route.route}: ${route.usable ? 'usable' : 'blocked'} • ${route.freshness} • ${route.detail}`, width),
        route.usable ? C.dim : C.bad,
      ]]));
      for (const issue of route.issues) {
        detailRows.push(buildPanelLine(width, [[truncateDisplay(`    issue: ${issue}`, width), C.bad]]));
      }
    }
    for (const windowHint of selected.usageWindows) {
      detailRows.push(buildPanelLine(width, [[truncateDisplay(`  ${windowHint.label}: ${windowHint.detail}`, width), C.dim]]));
    }
    for (const issue of selected.issues) {
      detailRows.push(buildPanelLine(width, [[truncateDisplay(`  issue: ${issue}`, width), C.bad]]));
    }
    for (const note of selected.notes) {
      detailRows.push(buildPanelLine(width, [[truncateDisplay(`  note: ${note}`, width), C.info]]));
    }
    for (const action of selected.recommendedActions) {
      detailRows.push(buildPanelLine(width, [[truncateDisplay(`  next: ${action}`, width), C.value]]));
    }
    if (selected.issues.length === 0 && selected.notes.length === 0 && selected.usageWindows.length === 0 && selected.recommendedActions.length === 0) {
      detailRows.push(buildPanelLine(width, [['  No active account warnings for this provider.', C.dim]]));
    }
    const postureSection: PanelWorkspaceSection = { lines: buildSummaryBlock(width, 'Provider posture', postureLines, C) };
    const detailsSection: PanelWorkspaceSection = { lines: buildDetailBlock(width, 'Selected provider', detailRows, C) };
    const rawProviderLines: Line[] = this.records.map((record, absolute) =>
      this.renderItem(record, absolute, absolute === this.selectedIndex, width),
    );
    const resolvedProvidersSection = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines,
      palette: C,
      beforeSections: [postureSection],
      section: {
        title: 'Providers',
        scrollableLines: rawProviderLines,
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollStart,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [detailsSection],
    });
    this.scrollStart = resolvedProvidersSection.scrollOffset;
    const sections: PanelWorkspaceSection[] = [
      postureSection,
      resolvedProvidersSection.section,
      detailsSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Provider Account Control Room',
      intro,
      sections,
      footerLines,
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
