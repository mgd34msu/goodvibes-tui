import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { fitDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { KeyName } from './types.ts';
import type { ProviderSubscription, PendingSubscriptionLogin } from '@pellux/goodvibes-sdk/platform/config';
import { listBuiltinSubscriptionProviders } from '@pellux/goodvibes-sdk/platform/config';
import { type ConfirmState, handleConfirmInput } from './confirm-state.ts';
import type { ServiceInspectionQuery, SubscriptionAccessQuery } from '../runtime/ui-service-queries.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyboardHints,
  buildKeyValueLine,
  buildPanelListRow,
  buildPanelLine,
  buildSummaryBlock,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';

// Base chrome only — title band, state colors, and text tokens all come
// straight from DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

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

export class SubscriptionPanel extends ScrollableListPanel<SubscriptionRow> {
  private readonly serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>;
  private readonly subscriptionManager: SubscriptionAccessQuery;
  private rows: SubscriptionRow[] = [];
  /** Pending logout confirmation — uses project-standard ConfirmState contract. */
  private confirm: ConfirmState<string> | null = null;

  public constructor(
    serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>,
    subscriptionManager: SubscriptionAccessQuery,
  ) {
    super('subscription', 'Subscriptions', 'B', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.serviceRegistry = serviceRegistry;
    this.subscriptionManager = subscriptionManager;
  }

  public override onActivate(): void {
    super.onActivate();
    this.refresh();
  }

  protected override getPalette() { return C; }
  protected override getEmptyStateMessage() { return ' No provider subscriptions are active yet.'; }
  protected override getEmptyStateActions() {
    return [
      { command: '/subscription login openai start', summary: 'start the first-class OpenAI subscription flow' },
      { command: '/login provider <name> start', summary: 'use the front-door auth surface for supported providers' },
      { command: '/services auth-review', summary: 'inspect configured service auth posture and stored secrets' },
    ];
  }

  protected getItems(): readonly SubscriptionRow[] {
    return this.rows;
  }

  protected renderItem(row: SubscriptionRow, index: number, selected: boolean, width: number): Line {
    const status = statusOf(row);
    return buildPanelListRow(width, [
      { text: fitDisplay(row.provider, 16), fg: C.value },
      { text: ` ${status.toUpperCase().padEnd(12)}`, fg: statusColor(status) },
      { text: ` oauth=${row.hasOAuthConfig ? 'yes' : 'no'} `, fg: row.hasOAuthConfig ? C.info : C.dim },
      { text: ` override=${row.subscription ? 'active' : 'off'}`, fg: row.subscription ? C.good : C.dim },
    ], C, { selected, selectedBg: C.selectBg });
  }

  public handleInput(key: KeyName): boolean {
    // Project-standard confirm contract: Enter/y confirm; n/Esc cancel; other absorbed.
    const confirmResult = handleConfirmInput(this.confirm, key);
    if (confirmResult === 'confirmed') {
      const provider = this.confirm!.subject;
      this.confirm = null;
      this.subscriptionManager.logout(provider);
      this.refresh();
      this.markDirty();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this.confirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') return true;

    if (this.rows.length === 0) return false;
    const selected = this.rows[this.selectedIndex] ?? null;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.confirm = null;
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + 1);
      this.confirm = null;
      this.markDirty();
      return true;
    }
    if (key === 'enter' || key === 'return') {
      if (!selected?.subscription) return false;
      this.confirm = { subject: selected.provider, label: selected.provider };
      this.markDirty();
      return true;
    }
    if (key === 'r') {
      this.refresh();
      this.confirm = null;
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

  /** Footer hints that reflect the current view: confirm-pending vs browsing. */
  private buildFooterHint(width: number): Line {
    if (this.confirm) {
      return buildKeyboardHints(width, [
        { keys: 'y/Enter', label: 'confirm sign out' },
        { keys: 'n/Esc', label: 'cancel' },
      ], C);
    }
    const selected = this.rows[this.selectedIndex];
    const hints: Array<{ keys: string; label: string }> = [{ keys: 'Up/Down', label: 'select' }];
    if (selected?.subscription) hints.push({ keys: 'Enter', label: 'sign out' });
    else if (selected?.hasOAuthConfig) hints.push({ keys: '/subscription login <p> start', label: 'sign in' });
    hints.push({ keys: 'r', label: 'refresh' });
    return buildKeyboardHints(width, hints, C);
  }

  public render(width: number, height: number): Line[] {
    this.refresh();
    this.clampSelection();
    const intro = 'Review provider login state, subscription-backed routing, and pending browser auth handshakes.';

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

    // Empty state: render posture + base empty state
    if (this.rows.length === 0) {
      const summaryLines = buildSummaryBlock(width, 'Subscription posture', postureLines, C);
      const emptyLines = buildEmptyState(
        width,
        this.getEmptyStateMessage(),
        'Built-in OAuth-capable providers and configured service providers will appear here once available for browser login or session import.',
        this.getEmptyStateActions(),
        C,
      );
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Provider Subscriptions',
        intro,
        sections: [{ lines: [...summaryLines, ...emptyLines] }],
        footerLines: [
          buildGuidanceLine(width, '/subscription login <provider> start', 'start browser-based provider login from the packaged subscription surface', C),
          this.buildFooterHint(width),
        ],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace.slice(0, height);
    }

    const selectedRow = this.rows[this.selectedIndex];
    const detailRows: Line[] = [];
    if (selectedRow) {
      detailRows.push(buildKeyValueLine(width, [
        { label: 'provider', value: selectedRow.provider, valueColor: C.value },
        { label: 'status', value: statusOf(selectedRow), valueColor: statusColor(statusOf(selectedRow)) },
        { label: 'oauth config', value: selectedRow.hasOAuthConfig ? 'present' : 'missing', valueColor: selectedRow.hasOAuthConfig ? C.good : C.bad },
      ], C));
      if (selectedRow.subscription) {
        const expires = selectedRow.subscription.expiresAt
          ? new Date(selectedRow.subscription.expiresAt).toISOString()
          : 'n/a';
        detailRows.push(buildKeyValueLine(width, [
          { label: 'token type', value: selectedRow.subscription.tokenType, valueColor: C.info },
          { label: 'expires', value: expires, valueColor: C.dim },
        ], C));
        detailRows.push(buildPanelLine(width, [[
          ` ${selectedRow.subscription.overrideAmbientApiKeys
            ? 'Provider subscription overrides ambient API-key resolution for this provider.'
            : 'Stored for subscription-backed flows. Ambient API-key resolution remains unchanged.'}`,
          C.dim,
        ]]));
        if (this.confirm?.subject === selectedRow.provider) {
          detailRows.push(buildPanelLine(width, [[` Sign out ${selectedRow.provider}? Press y or Enter to confirm, n or Esc to cancel.`, C.warn]]));
        }
      } else if (selectedRow.pending) {
        detailRows.push(buildPanelLine(width, [[' Login is pending. Finish with /subscription login <provider> finish <code>.', C.warn]]));
      } else if (selectedRow.hasOAuthConfig) {
        detailRows.push(buildPanelLine(width, [[' Ready for login. Start with /subscription login <provider> start.', C.dim]]));
      } else {
        detailRows.push(buildPanelLine(width, [[' Add a provider-specific OAuth config or enable a built-in subscription provider to use subscription login.', C.bad]]));
      }
    }

    const headerLines: Line[] = buildSummaryBlock(width, 'Subscription posture', postureLines, C);

    return this.renderList(width, height, {
      title: 'Provider Subscriptions',
      header: headerLines,
      footer: [
        ...detailRows,
        buildGuidanceLine(width, '/subscription login <provider> start', 'start browser-based provider login from the packaged subscription surface', C),
        this.buildFooterHint(width),
      ],
    });
  }
}
