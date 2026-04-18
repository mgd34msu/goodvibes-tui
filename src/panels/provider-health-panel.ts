import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import type { ProviderAuthRouteDescriptor } from '@pellux/goodvibes-sdk/platform/providers/interface';
import type { ProviderEvent, TurnEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import {
  type ProviderRuntimeInspectionQuery,
} from '../runtime/ui-service-queries.ts';
import { ProviderHealthTracker, type ProviderStatus } from './provider-health-tracker.ts';
import {
  buildProviderHealthDomainSummaries,
  type HealthDomainSummary,
} from './provider-health-domains.ts';
import type {
  UiContinuitySnapshot,
  UiIntelligenceSnapshot,
  UiLocalAuthSnapshot,
  UiProvidersSnapshot,
  UiReadModel,
  UiRemoteSnapshot,
  UiSecuritySnapshot,
  UiSessionSnapshot,
  UiSettingsSnapshot,
  UiWorktreeSnapshot,
} from '../runtime/ui-read-models.ts';
import { evaluateSessionMaintenance } from '@pellux/goodvibes-sdk/platform/runtime/session-maintenance';
import {
  buildBodyText,
  buildDetailBlock,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelListRow,
  buildPanelLine,
  buildPanelWorkspace,
  buildSummaryBlock,
  DEFAULT_PANEL_PALETTE,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderHealthPanelDeps {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly turnEvents: UiEventFeed<TurnEvent>;
  readonly providerEvents: UiEventFeed<ProviderEvent>;
  readonly providers: UiReadModel<UiProvidersSnapshot>;
  readonly session: UiReadModel<UiSessionSnapshot>;
  readonly security: UiReadModel<UiSecuritySnapshot>;
  readonly localAuth: UiReadModel<UiLocalAuthSnapshot>;
  readonly settings: UiReadModel<UiSettingsSnapshot>;
  readonly remote: UiReadModel<UiRemoteSnapshot>;
  readonly intelligence: UiReadModel<UiIntelligenceSnapshot>;
  readonly continuity: UiReadModel<UiContinuitySnapshot>;
  readonly worktrees: UiReadModel<UiWorktreeSnapshot>;
}

// Colors
// ---------------------------------------------------------------------------

const C = {
  title:       '#00ffff',
  online:      '#5fd700',
  rateLimit:   '#ffaf00',
  error:       '#ff5f5f',
  unknown:     '244',
  label:       '244',
  value:       '252',
  dim:         '240',
  provName:    '#e2e8f0',
  errMsg:      '#ff5f5f',
  latGood:     '#5fd700',
  latWarn:     '#ffaf00',
  latBad:      '#ff5f5f',
  separator:   '#374151',
} as const;

const LATENCY_WARN_MS = 2_000;
const LATENCY_BAD_MS  = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusDot(status: ProviderStatus): { char: string; color: string } {
  switch (status) {
    case 'online':       return { char: '●', color: C.online };
    case 'rate-limited': return { char: '◐', color: C.rateLimit };
    case 'error':        return { char: '✕', color: C.error };
    default:             return { char: '○', color: C.unknown };
  }
}

function statusLabel(status: ProviderStatus): string {
  switch (status) {
    case 'online':       return 'online';
    case 'rate-limited': return 'rate-limited';
    case 'error':        return 'error';
    default:             return 'unknown';
  }
}

function latencyColor(ms: number): string {
  if (ms >= LATENCY_BAD_MS)  return C.latBad;
  if (ms >= LATENCY_WARN_MS) return C.latWarn;
  return C.latGood;
}

function fmtMs(ms: number): string {
  if (ms <= 0)      return 'n/a';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1_000)  return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtAgo(ts: number | undefined): string {
  if (!ts) return 'n/a';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60)  return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function fmtCooldown(expiresAt: number): string {
  const remaining = Math.ceil((expiresAt - Date.now()) / 1000);
  if (remaining <= 0) return 'expiring';
  return `${remaining}s cooldown`;
}

type ProviderPanelAuthRoute = ProviderAuthRouteDescriptor['route'] | 'unconfigured';
type ProviderPanelAuthFreshness = NonNullable<ProviderAuthRouteDescriptor['freshness']> | 'unconfigured';

interface ProviderRuntimeRecord {
  readonly providerId: string;
  readonly active: boolean;
  readonly modelCount: number;
  readonly activeRoute: ProviderPanelAuthRoute;
  readonly preferredRoute: ProviderPanelAuthRoute;
  readonly activeRouteReason: string;
  readonly authFreshness: ProviderPanelAuthFreshness;
  readonly fallbackRisk?: string;
  readonly issues: readonly string[];
  readonly recommendedActions: readonly string[];
}

function domainColor(level: HealthDomainSummary['level']): string {
  switch (level) {
    case 'good':
      return C.online;
    case 'warn':
      return C.rateLimit;
    case 'bad':
      return C.error;
    default:
      return C.value;
  }
}

const AUTH_ROUTE_PRIORITY: readonly ProviderPanelAuthRoute[] = [
  'subscription-oauth',
  'service-oauth',
  'secret-ref',
  'api-key',
  'anonymous',
  'none',
  'unconfigured',
] as const;

function routePriority(route: ProviderPanelAuthRoute): number {
  const priority = AUTH_ROUTE_PRIORITY.indexOf(route);
  return priority >= 0 ? priority : AUTH_ROUTE_PRIORITY.length;
}

function routeColor(route: ProviderPanelAuthRoute): string {
  switch (route) {
    case 'subscription-oauth':
      return C.title;
    case 'service-oauth':
      return C.online;
    case 'api-key':
      return C.rateLimit;
    case 'secret-ref':
      return C.value;
    case 'anonymous':
    case 'none':
      return C.dim;
    default:
      return C.value;
  }
}

function freshnessColor(freshness: ProviderPanelAuthFreshness): string {
  switch (freshness) {
    case 'expired':
      return C.error;
    case 'expiring':
    case 'pending':
      return C.rateLimit;
    case 'healthy':
      return C.online;
    default:
      return C.dim;
  }
}

function buildSyntheticAuthRoutes(
  auth: {
    readonly mode: 'api-key' | 'oauth' | 'anonymous' | 'none';
    readonly configured: boolean;
    readonly detail?: string;
    readonly envVars?: readonly string[];
  } | undefined,
): readonly ProviderAuthRouteDescriptor[] {
  if (!auth) return [];
  switch (auth.mode) {
    case 'none':
      return [{
        route: 'none',
        label: 'No auth required',
        configured: true,
        usable: true,
        freshness: 'healthy',
        detail: auth.detail ?? 'Provider does not require interactive credentials.',
      }];
    case 'anonymous':
      return [{
        route: 'anonymous',
        label: 'Anonymous / local access',
        configured: auth.configured,
        usable: auth.configured,
        freshness: auth.configured ? 'healthy' : 'unconfigured',
        detail: auth.detail ?? 'Provider can be used without stored credentials.',
      }];
    case 'api-key':
      return [{
        route: 'api-key',
        label: 'Ambient API key',
        configured: auth.configured,
        usable: auth.configured,
        freshness: auth.configured ? 'healthy' : 'unconfigured',
        detail: auth.detail ?? 'Provider expects a configured API key.',
        ...(auth.envVars?.length ? { envVars: auth.envVars } : {}),
        ...(auth.envVars?.length
          ? { repairHints: [`Set ${auth.envVars.join(' or ')} in the environment or secrets store.`] }
          : {}),
      }];
    case 'oauth':
      return [{
        route: 'service-oauth',
        label: 'OAuth session',
        configured: auth.configured,
        usable: auth.configured,
        freshness: auth.configured ? 'healthy' : 'unconfigured',
        detail: auth.detail ?? 'Provider expects an OAuth-backed credential.',
        repairHints: ['Refresh or repair the provider OAuth session before relying on it.'],
      }];
    default:
      return [];
  }
}

function getUsableRoute(route: ProviderAuthRouteDescriptor): boolean {
  return route.usable ?? route.configured;
}

function pickRoute(
  routes: readonly ProviderAuthRouteDescriptor[],
): ProviderAuthRouteDescriptor | null {
  if (routes.length === 0) return null;
  return [...routes].sort((left, right) => routePriority(left.route) - routePriority(right.route))[0] ?? null;
}

function buildProviderRuntimeRecord(
  snapshot: {
    readonly providerId: string;
    readonly active: boolean;
    readonly modelCount: number;
    readonly runtime: {
      readonly auth?: {
        readonly mode: 'api-key' | 'oauth' | 'anonymous' | 'none';
        readonly configured: boolean;
        readonly detail?: string;
        readonly envVars?: readonly string[];
        readonly routes?: readonly ProviderAuthRouteDescriptor[];
      };
    };
  },
): ProviderRuntimeRecord {
  const auth = snapshot.runtime.auth;
  const routes = auth?.routes?.length ? auth.routes : buildSyntheticAuthRoutes(auth);
  const configuredRoutes = routes.filter((route) => route.configured);
  const usableRoutes = routes.filter(getUsableRoute);
  const preferredRoute = pickRoute(configuredRoutes.length > 0 ? configuredRoutes : routes);
  const activeRoute = pickRoute(usableRoutes.length > 0 ? usableRoutes : (preferredRoute ? [preferredRoute] : []));
  const activeRouteId = activeRoute?.route ?? 'unconfigured';
  const preferredRouteId = preferredRoute?.route ?? activeRouteId;
  const authFreshness = activeRoute?.freshness ?? (activeRouteId === 'none' ? 'healthy' : 'unconfigured');
  const fallbackRisk = usableRoutes.length > 1
    ? 'Multiple auth routes are simultaneously usable; verify route priority before switching providers.'
    : undefined;

  const issueSet = new Set<string>();
  const actionSet = new Set<string>();

  if (activeRouteId === 'unconfigured' && auth?.mode !== 'none') {
    issueSet.add('Provider has no usable auth route configured.');
  }

  for (const route of routes) {
    if (route.freshness === 'expired') {
      issueSet.add(route.detail ?? `${route.label} is expired.`);
    } else if (route.freshness === 'pending') {
      issueSet.add(route.detail ?? `${route.label} is pending completion.`);
    } else if (route.configured && !getUsableRoute(route)) {
      issueSet.add(route.detail ?? `${route.label} is configured but not currently usable.`);
    }
    for (const hint of route.repairHints ?? []) {
      if (hint.trim().length > 0) actionSet.add(hint);
    }
  }

  if (fallbackRisk) issueSet.add(fallbackRisk);
  if (issueSet.size > 0 && actionSet.size === 0 && activeRouteId !== 'none') {
    actionSet.add(`Review ${snapshot.providerId} provider credentials and routing metadata.`);
  }

  return {
    providerId: snapshot.providerId,
    active: snapshot.active,
    modelCount: snapshot.modelCount,
    activeRoute: activeRouteId,
    preferredRoute: preferredRouteId,
    activeRouteReason: activeRoute?.detail
      ?? auth?.detail
      ?? (activeRouteId === 'none'
        ? 'Provider does not require interactive credentials.'
        : 'No usable auth route is configured for this provider.'),
    authFreshness,
    ...(fallbackRisk ? { fallbackRisk } : {}),
    issues: [...issueSet],
    recommendedActions: [...actionSet],
  };
}

// ---------------------------------------------------------------------------
// ProviderHealthPanel
// ---------------------------------------------------------------------------

/**
 * Real-time provider health / status dashboard.
 *
 * Displays for each known provider:
 *  - Status indicator (online / rate-limited / error / unknown)
 *  - Last response latency
 *  - Last seen timestamp
 *  - Last error message (if any)
 *  - Active cooldown timer for rate-limited providers
 */
export class ProviderHealthPanel extends BasePanel {
  private _unsubs: Array<() => void> = [];
  private _refreshTimerId: ReturnType<typeof setInterval> | null = null;
  private _selectedIndex = 0;
  private _scrollOffset = 0;
  private _accountRecords = new Map<string, ProviderRuntimeRecord>();
  private _accountRefreshAt = 0;
  private _accountLoading = false;
  private readonly providerHealthTracker = new ProviderHealthTracker();

  constructor(
    private readonly providerRuntime: ProviderRuntimeInspectionQuery,
    private readonly deps: ProviderHealthPanelDeps,
    private readonly requestRender: () => void = () => {},
  ) {
    super('provider-health', 'Health', 'N', 'monitoring');
    this._subscribe();
    void this._refreshAccountPosture(true);
    this._ensureRefreshTimer();
  }

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  private _subscribe(): void {
    this._unsubs.push(
      this.deps.turnEvents.on('TURN_SUBMITTED', () => {
        this.providerHealthTracker.onTurnStart();
      }),
    );

    this._unsubs.push(
      this.deps.turnEvents.on('STREAM_START', () => {
        this.providerHealthTracker.onStreamStart();
      }),
    );

    this._unsubs.push(
      this.deps.turnEvents.on('LLM_RESPONSE_RECEIVED', (payload) => {
        this.providerHealthTracker.onLlmResponse(payload.provider);
        this._markDirtyAndRender();
      }),
    );

    this._unsubs.push(
      this.deps.turnEvents.on('TURN_ERROR', (payload) => {
        this.providerHealthTracker.onTurnError(payload.error);
        this._markDirtyAndRender();
      }),
    );

    this._unsubs.push(
      this.deps.providerEvents.on('PROVIDERS_CHANGED', () => {
        this.providerHealthTracker.onProvidersChanged([
          ...new Set([
            ...this.deps.providers.getSnapshot().providerIds,
            ...this.providerRuntime.listProviderIds(),
          ]),
        ]);
        void this._refreshAccountPosture(true);
        this._markDirtyAndRender();
      }),
    );

    for (const readModel of [
      this.deps.providers,
      this.deps.session,
      this.deps.security,
      this.deps.localAuth,
      this.deps.settings,
      this.deps.remote,
      this.deps.intelligence,
      this.deps.continuity,
      this.deps.worktrees,
    ] as const) {
      this._unsubs.push(readModel.subscribe(() => this._markDirtyAndRender()));
    }
  }

  private _markDirtyAndRender(): void {
    this.markDirty();
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override onActivate(): void {
    super.onActivate();
    this.markDirty();
    void this._refreshAccountPosture(true);
    this._ensureRefreshTimer();
  }

  override onDeactivate(): void {
    super.onDeactivate();
  }

  override onDestroy(): void {
    super.onDestroy();
    this._refreshTimerId = null;
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
  }

  private _ensureRefreshTimer(): void {
    if (this._refreshTimerId !== null) return;
    this._refreshTimerId = this.registerTimer(setInterval(() => {
      if (Date.now() - this._accountRefreshAt > 30_000) {
        void this._refreshAccountPosture();
      }
      this.markDirty();
      this.requestRender();
    }, 1_000));
  }

  handleInput(key: string): boolean {
    const knownSet = new Set([
      ...this.deps.providers.getSnapshot().providerIds,
      ...this.providerRuntime.listProviderIds(),
      ...this._accountRecords.keys(),
    ]);
    for (const h of this.providerHealthTracker.getAll()) knownSet.add(h.name);
    const providers = [...knownSet].sort();
    if (providers.length === 0) return false;
    if (key === 'j' || key === 'down' || key === '\x1b[B') {
      this._selectedIndex = Math.min(providers.length - 1, this._selectedIndex + 1);
      this.markDirty();
      return true;
    }
    if (key === 'k' || key === 'up' || key === '\x1b[A') {
      this._selectedIndex = Math.max(0, this._selectedIndex - 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  private async _refreshAccountPosture(force = false): Promise<void> {
    if (this._accountLoading) return;
    if (!force && Date.now() - this._accountRefreshAt < 15_000) return;
    this._accountLoading = true;
    try {
      const snapshots = await this.providerRuntime.inspectAll();
      this._accountRecords = new Map(
        snapshots
          .map((snapshot) => buildProviderRuntimeRecord(snapshot))
          .map((record) => [record.providerId, record] as const),
      );
      this._accountRefreshAt = Date.now();
      this.markDirty();
      this.requestRender();
    } finally {
      this._accountLoading = false;
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  override render(width: number, height: number): Line[] {
    const intro = 'Cross-domain health workspace for providers, auth, settings, remote, MCP, continuity, worktrees, and maintenance posture.';

    const knownSet = new Set([
      ...this.deps.providers.getSnapshot().providerIds,
      ...this.providerRuntime.listProviderIds(),
      ...this._accountRecords.keys(),
    ]);
    for (const h of this.providerHealthTracker.getAll()) knownSet.add(h.name);
    const providers = [...knownSet].sort();
    this._selectedIndex = Math.min(this._selectedIndex, Math.max(0, providers.length - 1));

    if (providers.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: 'Health',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' No providers registered.',
            'Provider health appears here once model providers are available and the runtime begins making requests.',
            [
              { command: '/provider', summary: 'review current provider and model selection' },
              { command: '/subscription', summary: 'review provider login and subscription state' },
            ],
            { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' },
          ),
        }],
        palette: { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' },
      });
    }

    let online = 0;
    let rateLimited = 0;
    let errored = 0;
    let accountIssues = 0;
    let expiringAuth = 0;
    for (const name of providers) {
      const status = this.providerHealthTracker.get(name)?.status ?? 'unknown';
      if (status === 'online') online++;
      else if (status === 'rate-limited') rateLimited++;
      else if (status === 'error') errored++;
      const account = this._accountRecords.get(name);
      if (account) {
        accountIssues += account.issues.length;
        if (account.authFreshness === 'expiring' || account.authFreshness === 'expired' || account.authFreshness === 'pending') {
          expiringAuth++;
        }
      }
    }

    const postureLines = [
      buildKeyValueLine(width, [
        { label: 'providers', value: String(providers.length), valueColor: C.value },
        { label: 'online', value: String(online), valueColor: C.online },
        { label: 'rate-limited', value: String(rateLimited), valueColor: C.rateLimit },
        { label: 'error', value: String(errored), valueColor: C.error },
        { label: 'auth alerts', value: String(expiringAuth), valueColor: expiringAuth > 0 ? C.rateLimit : C.dim },
        { label: 'account issues', value: String(accountIssues), valueColor: accountIssues > 0 ? C.error : C.dim },
      ], { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }),
      buildGuidanceLine(width, '/provider', 'review provider selection and routing if health posture degrades', { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }),
      buildGuidanceLine(width, '/accounts', 'inspect auth routes, fallback posture, and billing-path safety', { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }),
    ];

    const domainLines: Line[] = [];
    for (const domain of buildProviderHealthDomainSummaries({
      configManager: this.deps.configManager,
      auth: this.deps.localAuth.getSnapshot(),
      settings: this.deps.settings.getSnapshot(),
      remote: this.deps.remote.getSnapshot(),
      security: this.deps.security.getSnapshot(),
      intelligence: this.deps.intelligence.getSnapshot(),
      continuity: this.deps.continuity.getSnapshot(),
      worktrees: this.deps.worktrees.getSnapshot(),
      session: this.deps.session.getSnapshot(),
    })) {
      domainLines.push(buildPanelLine(width, [
        ['  ', C.label],
        [domain.name.padEnd(14), C.provName],
        [domain.summary.slice(0, Math.max(0, width - 36)).padEnd(Math.max(0, width - 36)), domainColor(domain.level)],
        [' ', C.label],
        [domain.next.slice(0, 20), C.dim],
      ]));
      for (const detail of domain.details.slice(0, 2)) {
        domainLines.push(...buildBodyText(width, `    ${detail}`, { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }, C.dim));
      }
      if (domain.nextSteps.length > 1) {
        domainLines.push(...buildBodyText(width, `    next: ${domain.nextSteps.join('  |  ')}`, { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }, C.title));
      }
    }

    const selectedName = providers[this._selectedIndex];
    const selectedHealth = selectedName ? this.providerHealthTracker.get(selectedName) : undefined;
    const selectedAccount = selectedName ? this._accountRecords.get(selectedName) : undefined;
    const selectedLines: Line[] = [];
    const maintenanceLines: Line[] = [];
    const session = this.deps.session.getSnapshot();
    const maintenance = evaluateSessionMaintenance({
      configManager: this.deps.configManager,
      currentTokens: session.estimatedContextTokens,
      contextWindow: session.contextWindow,
      messageCount: session.messageCount,
      session: session.session,
    });
    maintenanceLines.push(buildKeyValueLine(width, [
      { label: 'level', value: maintenance.level, valueColor: maintenance.level === 'needs-repair' ? C.error : maintenance.level === 'suggest-compact' || maintenance.level === 'watch' ? C.rateLimit : C.online },
      { label: 'guidance', value: maintenance.guidanceMode, valueColor: C.value },
      { label: 'usage', value: `${maintenance.usagePct}%`, valueColor: maintenance.usagePct >= 80 ? C.error : maintenance.usagePct >= 70 ? C.rateLimit : C.value },
      { label: 'remaining', value: maintenance.remainingTokens.toLocaleString(), valueColor: C.value },
    ], { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }));
    for (const reason of maintenance.reasons.slice(0, 3)) {
      maintenanceLines.push(...buildBodyText(width, reason, { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }, C.dim));
    }
    if (maintenance.nextSteps.length > 0) {
      maintenanceLines.push(...buildBodyText(width, `Next: ${maintenance.nextSteps.join('  |  ')}`, { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }, C.title));
    }
    if (selectedName) {
      const status = selectedHealth?.status ?? 'unknown';
      selectedLines.push(buildKeyValueLine(width, [
        { label: 'provider', value: selectedName, valueColor: C.provName },
        { label: 'status', value: statusLabel(status), valueColor: statusDot(status).color },
        { label: 'last ok', value: fmtAgo(selectedHealth?.lastSuccessAt), valueColor: C.value },
      ], { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }));
      if (selectedHealth?.rateLimitExpiresAt && selectedHealth.rateLimitExpiresAt > Date.now()) {
        selectedLines.push(...buildBodyText(width, `Cooldown: ${fmtCooldown(selectedHealth.rateLimitExpiresAt)}`, { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }, C.rateLimit));
      }
      if (selectedHealth?.lastErrorMessage) {
        selectedLines.push(...buildBodyText(width, `Last error: ${selectedHealth.lastErrorMessage}`, { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }, C.errMsg));
      }
      if (selectedAccount) {
        selectedLines.push(buildKeyValueLine(width, [
          { label: 'route', value: selectedAccount.activeRoute, valueColor: routeColor(selectedAccount.activeRoute) },
          { label: 'preferred', value: selectedAccount.preferredRoute, valueColor: C.dim },
          { label: 'freshness', value: selectedAccount.authFreshness, valueColor: freshnessColor(selectedAccount.authFreshness) },
        ], { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }));
        selectedLines.push(buildKeyValueLine(width, [
          { label: 'models', value: String(selectedAccount.modelCount), valueColor: C.value },
          { label: 'active', value: selectedAccount.active ? 'yes' : 'no', valueColor: selectedAccount.active ? C.online : C.dim },
        ], { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }));
        selectedLines.push(...buildBodyText(width, `Auth route: ${selectedAccount.activeRouteReason}`, { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }, C.dim));
        if (selectedAccount.fallbackRisk) {
          selectedLines.push(...buildBodyText(width, `Fallback: ${selectedAccount.fallbackRisk}`, { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }, C.rateLimit));
        }
        if (selectedAccount.issues.length > 0) {
          selectedLines.push(...buildBodyText(width, `Issue: ${selectedAccount.issues[0]!}`, { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }, C.errMsg));
        }
        if (selectedAccount.recommendedActions.length > 0) {
          selectedLines.push(...buildBodyText(width, `Next: ${selectedAccount.recommendedActions[0]!}`, { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }, C.title));
        }
      }
    }

    const postureSection: PanelWorkspaceSection = { lines: buildSummaryBlock(width, 'Health posture', postureLines, { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }) };
    const domainsSection: PanelWorkspaceSection = { title: 'Repair Domains', lines: domainLines };
    const maintenanceSections = maintenanceLines.length > 0 ? [{ title: 'Session Maintenance', lines: maintenanceLines } satisfies PanelWorkspaceSection] : [];
    const selectedSections = selectedLines.length > 0 ? [{ lines: buildDetailBlock(width, 'Selected provider', selectedLines, { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }) } satisfies PanelWorkspaceSection] : [];
    const resolvedProvidersSection = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines: [buildPanelLine(width, [['  j/k or Up/Down move  live cooldowns refresh while active', C.dim]])],
      palette: { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' },
      beforeSections: [postureSection, domainsSection, ...maintenanceSections],
      section: {
        title: 'Providers',
        scrollableLines: providers.map((name, absolute) => {
          const health = this.providerHealthTracker.get(name);
          const status = health?.status ?? 'unknown';
          const latency = health?.lastLatencyMs !== undefined ? fmtMs(health.lastLatencyMs) : 'n/a';
          const latencyFg = health?.lastLatencyMs !== undefined ? latencyColor(health.lastLatencyMs) : C.dim;
          return buildPanelListRow(width, [
            { text: name.padEnd(16), fg: C.provName },
            { text: statusLabel(status).padEnd(14), fg: statusDot(status).color },
            { text: ' lat ', fg: C.label },
            { text: latency.padEnd(8), fg: latencyFg },
            { text: ' ok ', fg: C.label },
            { text: fmtAgo(health?.lastSuccessAt).padEnd(10), fg: C.value },
          ], { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }, { selected: absolute === this._selectedIndex, selectedBg: '#111827' });
        }),
        selectedIndex: this._selectedIndex,
        scrollOffset: this._scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: selectedSections,
    });
    this._scrollOffset = resolvedProvidersSection.scrollOffset;
    const sections: PanelWorkspaceSection[] = [
      postureSection,
      domainsSection,
      ...maintenanceSections,
      resolvedProvidersSection.section,
      ...selectedSections,
    ];
    return buildPanelWorkspace(width, height, {
      title: 'Health',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  j/k or Up/Down move  live cooldowns refresh while active', C.dim]])],
      palette: { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' },
    });
  }
}
