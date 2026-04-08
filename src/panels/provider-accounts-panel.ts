import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  buildEmptyState,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { getTrackedVisibleWindow } from '../renderer/surface-layout.ts';
import { buildProviderAccountSnapshot, type ProviderAccountRecord } from '../runtime/provider-accounts/registry.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  selectBg: '#1e293b',
} as const;

export class ProviderAccountsPanel extends BasePanel {
  private records: ProviderAccountRecord[] = [];
  private loading = false;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor() {
    super('accounts', 'Accounts', 'Q', 'monitoring');
    void this.refresh();
  }

  public override onActivate(): void {
    super.onActivate();
    if (!this.loading) void this.refresh();
  }

  public handleInput(key: string): boolean {
    if (key === 'r') {
      void this.refresh();
      return true;
    }
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(Math.max(0, this.records.length - 1), this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.markDirty();
    const snapshot = await buildProviderAccountSnapshot();
    this.records = [...snapshot.providers];
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.records.length - 1));
    this.loading = false;
    this.markDirty();
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const intro = 'Provider auth routes, subscription posture, quota-window hints, and routing-safety notes.';
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
    const window = getTrackedVisibleWindow(this.records.length, this.selectedIndex, Math.max(4, height - 12), this.scrollOffset, 1);
    this.scrollOffset = window.start;
    const listLines: Line[] = [];
    for (let absolute = window.start; absolute < window.end; absolute++) {
      const record = this.records[absolute]!;
      const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
      listLines.push(buildPanelLine(width, [
        [' ', C.label, bg],
        [record.providerId.padEnd(16), record.active ? C.good : C.value, bg],
        [` ${record.activeRoute.padEnd(14)}`, record.activeRoute === 'subscription' ? C.info : record.activeRoute === 'api-key' ? C.warn : record.activeRoute === 'service-oauth' ? C.value : C.dim, bg],
        [` models=${String(record.modelCount).padEnd(4)}`, C.dim, bg],
        [` ${record.authFreshness.padEnd(10)}`, record.authFreshness === 'expired' ? C.bad : record.authFreshness === 'expiring' || record.authFreshness === 'pending' ? C.warn : C.dim, bg],
        [` issues=${String(record.issues.length).padEnd(2)}`, record.issues.length > 0 ? C.bad : C.good, bg],
      ]));
    }
    const selected = this.records[this.selectedIndex]!;
    const detailLines: Line[] = [
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
      buildPanelLine(width, [[`  Active route reason: ${selected.activeRouteReason}`.slice(0, width), C.dim]]),
      buildPanelLine(width, [[`  Available routes: ${selected.availableRoutes.join(', ') || 'unconfigured'}`.slice(0, width), C.dim]]),
    ];
    if (selected.expiresAt) {
      detailLines.push(buildPanelLine(width, [
        ['  Expires: ', C.label],
        [new Date(selected.expiresAt).toISOString(), C.dim],
        ['  Token: ', C.label],
        [selected.tokenType ?? 'n/a', C.value],
      ]));
    }
    if (selected.fallbackRisk) {
      detailLines.push(buildPanelLine(width, [[`  fallback: ${selected.fallbackRisk}`.slice(0, width), C.warn]]));
    }
    for (const route of selected.routeRecords) {
      detailLines.push(buildPanelLine(width, [[
        `  route ${route.route}: ${route.usable ? 'usable' : 'blocked'} • ${route.freshness} • ${route.detail}`.slice(0, width),
        route.usable ? C.dim : C.bad,
      ]]));
      for (const issue of route.issues) {
        detailLines.push(buildPanelLine(width, [[`    issue: ${issue}`.slice(0, width), C.bad]]));
      }
    }
    for (const windowHint of selected.usageWindows) {
      detailLines.push(buildPanelLine(width, [[`  ${windowHint.label}: ${windowHint.detail}`.slice(0, width), C.dim]]));
    }
    for (const issue of selected.issues) {
      detailLines.push(buildPanelLine(width, [[`  issue: ${issue}`.slice(0, width), C.bad]]));
    }
    for (const note of selected.notes) {
      detailLines.push(buildPanelLine(width, [[`  note: ${note}`.slice(0, width), C.info]]));
    }
    for (const action of selected.recommendedActions) {
      detailLines.push(buildPanelLine(width, [[`  next: ${action}`.slice(0, width), C.value]]));
    }
    if (selected.issues.length === 0 && selected.notes.length === 0 && selected.usageWindows.length === 0 && selected.recommendedActions.length === 0) {
      detailLines.push(buildPanelLine(width, [['  No active account warnings for this provider.', C.dim]]));
    }
    const sections: PanelWorkspaceSection[] = [
      { title: 'Providers', lines: listLines },
      { title: 'Details', lines: detailLines },
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Provider Account Control Room',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down move  r refresh  /accounts routes <provider>  /accounts repair <provider>', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
