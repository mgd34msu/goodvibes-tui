import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { ServiceRegistry } from '../config/service-registry.ts';
import { SubscriptionManager, type ProviderSubscription, type PendingSubscriptionLogin } from '../config/subscriptions.ts';
import { listBuiltinSubscriptionProviders } from '../config/subscription-providers.ts';
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

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#e2e8f0',
  headerBg: '#1e293b',
  dim: '#64748b',
  info: '#38bdf8',
  good: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
  selectedBg: '#0f172a',
} as const;

interface SubscriptionRow {
  readonly provider: string;
  readonly hasOAuthConfig: boolean;
  readonly subscription: ProviderSubscription | null;
  readonly pending: PendingSubscriptionLogin | null;
}

function statusOf(row: SubscriptionRow): 'active' | 'pending' | 'available' | 'unconfigured' {
  if (row.subscription) return 'active';
  if (row.pending) return 'pending';
  return row.hasOAuthConfig ? 'available' : 'unconfigured';
}

function statusColor(status: ReturnType<typeof statusOf>): string {
  switch (status) {
    case 'active':
      return C.good;
    case 'pending':
      return C.warn;
    case 'available':
      return C.info;
    case 'unconfigured':
      return C.dim;
  }
}

export class SubscriptionPanel extends BasePanel {
  private readonly serviceRegistry: ServiceRegistry;
  private readonly subscriptionManager: SubscriptionManager;
  private rows: SubscriptionRow[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private logoutConfirmationTarget: string | null = null;

  public constructor(
    serviceRegistry: ServiceRegistry,
    subscriptionManager: SubscriptionManager,
  ) {
    super('subscription', 'Subscriptions', 'B', 'monitoring');
    this.serviceRegistry = serviceRegistry;
    this.subscriptionManager = subscriptionManager;
  }

  public override onActivate(): void {
    super.onActivate();
    this.refresh();
  }

  public handleInput(key: string): boolean {
    if (this.rows.length === 0) return false;
    const selected = this.rows[this.selectedIndex] ?? null;
    if (key === 'ArrowUp' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.logoutConfirmationTarget = null;
      this.markDirty();
      return true;
    }
    if (key === 'ArrowDown' || key === 'j') {
      this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + 1);
      this.logoutConfirmationTarget = null;
      this.markDirty();
      return true;
    }
    if (key === 'enter' || key === 'x') {
      if (!selected?.subscription) return false;
      if (this.logoutConfirmationTarget !== selected.provider) {
        this.logoutConfirmationTarget = selected.provider;
        this.markDirty();
        return true;
      }
      this.subscriptionManager.logout(selected.provider);
      this.logoutConfirmationTarget = null;
      this.refresh();
      this.markDirty();
      return true;
    }
    if (key === 'r') {
      this.refresh();
      this.logoutConfirmationTarget = null;
      this.markDirty();
      return true;
    }
    return false;
  }

  private refresh(): void {
    const manager = this.subscriptionManager;
    const services = this.serviceRegistry.getAll();
    const builtinProviders = listBuiltinSubscriptionProviders();
    const providers = new Set<string>([
      ...builtinProviders.map((provider) => provider.provider),
      ...Object.values(services)
        .filter((service) => service.authType === 'oauth' && service.oauth)
        .map((service) => service.providerId ?? service.name),
      ...manager.list().map((entry) => entry.provider),
      ...manager.listPending().map((entry) => entry.provider),
    ]);
    this.rows = [...providers]
      .sort((a, b) => a.localeCompare(b))
      .map((provider) => {
        const service = Object.values(services).find((entry) => (
          (entry.providerId ?? entry.name) === provider && entry.authType === 'oauth' && entry.oauth
        ));
        const builtin = builtinProviders.find((entry) => entry.provider === provider);
        return {
          provider,
          hasOAuthConfig: Boolean(service?.oauth) || Boolean(builtin),
          subscription: manager.get(provider),
          pending: manager.getPending(provider),
        } satisfies SubscriptionRow;
      });
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    this.refresh();

    const activeCount = this.rows.filter((row) => row.subscription).length;
    const pendingCount = this.rows.filter((row) => row.pending).length;
    const postureLines = [
      buildKeyValueLine(width, [
        { label: 'configured', value: String(this.rows.filter((row) => row.hasOAuthConfig).length), valueColor: C.info },
        { label: 'active', value: String(activeCount), valueColor: activeCount > 0 ? C.good : C.dim },
        { label: 'pending', value: String(pendingCount), valueColor: pendingCount > 0 ? C.warn : C.dim },
        { label: 'providers', value: String(this.rows.length), valueColor: C.value },
      ], C),
      buildKeyValueLine(width, [
        { label: 'selected', value: (this.rows[this.selectedIndex]?.provider ?? 'none'), valueColor: this.rows[this.selectedIndex] ? C.value : C.dim },
        { label: 'status', value: this.rows[this.selectedIndex] ? statusOf(this.rows[this.selectedIndex]!) : 'n/a', valueColor: this.rows[this.selectedIndex] ? statusColor(statusOf(this.rows[this.selectedIndex]!)) : C.dim },
      ], C),
      buildGuidanceLine(width, '/subscription login <provider> start', 'start or repair browser login for the selected provider route', C),
    ];
    const footerLines = [
      buildGuidanceLine(width, '/subscription login <provider> start', 'start browser-based provider login from the packaged subscription surface', C),
      buildPanelLine(width, [['  Up/Down move  Enter/X sign out selected provider  r refresh', C.dim]]),
    ] as const;

    if (this.rows.length === 0) {
      const lines: Line[] = [];
      lines.push(...buildSummaryBlock(width, 'Subscription posture', postureLines, C));
      lines.push(...buildEmptyState(
        width,
        ' No provider subscriptions are active yet.',
        'Built-in OAuth-capable providers and configured service providers will appear here once available for browser login or session import.',
        [
          { command: '/subscription login openai start', summary: 'start the first-class OpenAI subscription flow' },
          { command: '/login provider <name> start', summary: 'use the front-door auth surface for supported providers' },
          { command: '/services auth-review', summary: 'inspect configured service auth posture and stored secrets' },
        ],
        C,
      ));
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Provider Subscriptions',
        intro: 'Review provider login state, subscription-backed routing, and pending browser auth handshakes.',
        sections: [{ lines }] satisfies readonly PanelWorkspaceSection[],
        footerLines,
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace.slice(0, height);
    }

    const selected = this.rows[this.selectedIndex];
    const detailRows: Line[] = [];
    if (selected) {
      detailRows.push(buildKeyValueLine(width, [
        { label: 'provider', value: selected.provider, valueColor: C.value },
        { label: 'status', value: statusOf(selected), valueColor: statusColor(statusOf(selected)) },
        { label: 'oauth config', value: selected.hasOAuthConfig ? 'present' : 'missing', valueColor: selected.hasOAuthConfig ? C.good : C.bad },
      ], C));
      if (selected.subscription) {
        const expires = selected.subscription.expiresAt
          ? new Date(selected.subscription.expiresAt).toISOString()
          : 'n/a';
        detailRows.push(buildKeyValueLine(width, [
          { label: 'token type', value: selected.subscription.tokenType, valueColor: C.info },
          { label: 'expires', value: expires, valueColor: C.dim },
        ], C));
        detailRows.push(buildPanelLine(width, [[
          ` ${selected.subscription.overrideAmbientApiKeys
            ? 'Provider subscription overrides ambient API-key resolution for this provider.'
            : 'Stored for subscription-backed flows. Ambient API-key resolution remains unchanged.'}`,
          C.dim,
        ]]));
        if (this.logoutConfirmationTarget === selected.provider) {
          detailRows.push(buildPanelLine(width, [[` Press Enter or X again to sign out ${selected.provider}.`, C.warn]]));
        }
      } else if (selected.pending) {
        detailRows.push(buildPanelLine(width, [[' Login is pending. Finish with /subscription login <provider> finish <code>.', C.warn]]));
      } else if (selected.hasOAuthConfig) {
        detailRows.push(buildPanelLine(width, [[' Ready for login. Start with /subscription login <provider> start.', C.dim]]));
      } else {
        detailRows.push(buildPanelLine(width, [[' Add a provider-specific OAuth config or enable a built-in subscription provider to use subscription login.', C.bad]]));
      }
    }
    const postureSection: PanelWorkspaceSection = { lines: buildSummaryBlock(width, 'Subscription posture', postureLines, C) };
    const detailSection: PanelWorkspaceSection = { lines: buildDetailBlock(width, 'Selected provider', detailRows, C) };
    const rawProviderLines: Line[] = this.rows.map((row, absolute) => {
      const status = statusOf(row);
      return buildPanelListRow(width, [
        { text: row.provider.padEnd(16).slice(0, 16), fg: C.value },
        { text: ` ${status.toUpperCase().padEnd(12)}`, fg: statusColor(status) },
        { text: ` oauth=${row.hasOAuthConfig ? 'yes' : 'no'} `, fg: row.hasOAuthConfig ? C.info : C.dim },
        { text: ` override=${row.subscription ? 'active' : 'off'}`, fg: row.subscription ? C.good : C.dim },
      ], C, { selected: absolute === this.selectedIndex, selectedBg: C.selectedBg });
    });
    const resolvedProvidersSection = resolvePrimaryScrollableSection(width, height, {
      intro: 'Review provider login state, subscription-backed routing, and pending browser auth handshakes.',
      footerLines,
      palette: C,
      beforeSections: [postureSection],
      section: {
        title: 'Providers',
        scrollableLines: rawProviderLines,
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [detailSection],
    });
    this.scrollOffset = resolvedProvidersSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      postureSection,
      resolvedProvidersSection.section,
      detailSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Provider Subscriptions',
      intro: 'Review provider login state, subscription-backed routing, and pending browser auth handshakes.',
      sections,
      footerLines,
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
