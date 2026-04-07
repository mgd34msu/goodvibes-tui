import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { ServiceRegistry } from '../config/service-registry.ts';
import { getSubscriptionManager, type ProviderSubscription, type PendingSubscriptionLogin } from '../config/subscriptions.ts';
import { listBuiltinSubscriptionProviders } from '../config/subscription-providers.ts';
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
  private rows: SubscriptionRow[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private logoutConfirmationTarget: string | null = null;

  public constructor(serviceRegistry: ServiceRegistry = new ServiceRegistry()) {
    super('subscription', 'Subscriptions', 'B', 'monitoring');
    this.serviceRegistry = serviceRegistry;
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
      getSubscriptionManager().logout(selected.provider);
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
    const manager = getSubscriptionManager();
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
    const overviewLine = buildKeyValueLine(width, [
      { label: 'configured', value: String(this.rows.filter((row) => row.hasOAuthConfig).length), valueColor: C.info },
      { label: 'active', value: String(activeCount), valueColor: activeCount > 0 ? C.good : C.dim },
      { label: 'pending', value: String(pendingCount), valueColor: pendingCount > 0 ? C.warn : C.dim },
      { label: 'providers', value: String(this.rows.length), valueColor: C.value },
    ], C);
    const footerLines = [
      buildGuidanceLine(width, '/subscription login <provider> start', 'start browser-based provider login from the packaged subscription surface', C),
      buildPanelLine(width, [['  Up/Down move  Enter/X sign out selected provider  r refresh', C.dim]]),
    ] as const;

    if (this.rows.length === 0) {
      const lines: Line[] = [];
      lines.push(overviewLine);
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

    const window = getTrackedVisibleWindow(this.rows.length, this.selectedIndex, Math.max(4, height - 14), this.scrollOffset, 1);
    this.scrollOffset = window.start;
    const visible = this.rows.slice(window.start, window.end);
    const listLines: Line[] = [];
    for (let index = 0; index < visible.length; index++) {
      const row = visible[index]!;
      const absolute = window.start + index;
      const bg = absolute === this.selectedIndex ? C.selectedBg : undefined;
      const status = statusOf(row);
      listLines.push(buildPanelLine(width, [
        [' ', C.label, bg],
        [row.provider.padEnd(16).slice(0, 16), C.value, bg],
        [` ${status.toUpperCase().padEnd(12)}`, statusColor(status), bg],
        [` oauth=${row.hasOAuthConfig ? 'yes' : 'no'} `, row.hasOAuthConfig ? C.info : C.dim, bg],
        [` override=${row.subscription ? 'active' : 'off'}`, row.subscription ? C.good : C.dim, bg],
      ]));
    }
    if (this.rows.length > visible.length) {
      listLines.push(buildPanelLine(width, [[`  showing ${window.start + 1}-${window.end} of ${this.rows.length}`, C.dim]]));
    }

    const selected = this.rows[this.selectedIndex];
    const detailLines: Line[] = [];
    if (selected) {
      detailLines.push(buildKeyValueLine(width, [
        { label: 'provider', value: selected.provider, valueColor: C.value },
        { label: 'status', value: statusOf(selected), valueColor: statusColor(statusOf(selected)) },
        { label: 'oauth config', value: selected.hasOAuthConfig ? 'present' : 'missing', valueColor: selected.hasOAuthConfig ? C.good : C.bad },
      ], C));
      if (selected.subscription) {
        const expires = selected.subscription.expiresAt
          ? new Date(selected.subscription.expiresAt).toISOString()
          : 'n/a';
        detailLines.push(buildKeyValueLine(width, [
          { label: 'token type', value: selected.subscription.tokenType, valueColor: C.info },
          { label: 'expires', value: expires, valueColor: C.dim },
        ], C));
        detailLines.push(buildPanelLine(width, [[
          ` ${selected.subscription.overrideAmbientApiKeys
            ? 'Provider subscription overrides ambient API-key resolution for this provider.'
            : 'Stored for subscription-backed flows. Ambient API-key resolution remains unchanged.'}`,
          C.dim,
        ]]));
        if (this.logoutConfirmationTarget === selected.provider) {
          detailLines.push(buildPanelLine(width, [[` Press Enter or X again to sign out ${selected.provider}.`, C.warn]]));
        }
      } else if (selected.pending) {
        detailLines.push(buildPanelLine(width, [[' Login is pending. Finish with /subscription login <provider> finish <code>.', C.warn]]));
      } else if (selected.hasOAuthConfig) {
        detailLines.push(buildPanelLine(width, [[' Ready for login. Start with /subscription login <provider> start.', C.dim]]));
      } else {
        detailLines.push(buildPanelLine(width, [[' Add a provider-specific OAuth config or enable a built-in subscription provider to use subscription login.', C.bad]]));
      }
    }

    const sections: PanelWorkspaceSection[] = [
      { title: 'Overview', lines: [overviewLine] },
      { title: 'Providers', lines: listLines },
      { title: 'Selected Provider', lines: detailLines },
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
