import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { BasePanel } from './base-panel.ts';
import type { Line } from '../types/grid.ts';
import type { ModelDomainState, ProviderEvent, TurnEvent } from '@/runtime/index.ts';
import { createInitialModelState, evaluateSessionMaintenance } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import {
  type ProviderRuntimeInspectionQuery,
} from '../runtime/ui-service-queries.ts';
import {
  ProviderHealthTracker,
  type ProviderHealthMeta,
} from './provider-health-tracker.ts';
import {
  buildAccountPosture,
  type ProviderAccountPosture,
} from './provider-health-routes.ts';
import {
  buildProviderHealthDomainSummaries,
  type HealthDomainSummary,
} from './provider-health-domains.ts';
import {
  ProviderHealthDataProvider,
  type FallbackChainData,
  type ProviderHealthEntry,
} from '../runtime/ui/provider-health/index.ts';
import type { PanelIntegrationContext } from './types.ts';
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
import {
  buildEmptyState,
  buildKeyboardHints,
  buildPanelWorkspace,
  buildSummaryBlock,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';
import {
  buildChainLines,
  buildDomainLines,
  buildMaintenanceLines,
  buildPostureLines,
  buildProviderColumnHeader,
  buildProviderRow,
  buildRouteColumnHeader,
  buildRouteViewLines,
  buildSelectedDetailSection,
} from './provider-health-views.ts';

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
  /**
   * Model-domain access wired from the runtime store at the composition root
   * (selectModel over RuntimeStore). Drives fallback-chain rendering and
   * TURN_ERROR attribution to the active provider.
   */
  readonly modelState?: {
    readonly get: () => ModelDomainState;
    readonly subscribe: (listener: () => void) => () => void;
  };
}

type ConsoleView = 'providers' | 'routes' | 'domains';

const CONSOLE_VIEWS: readonly ConsoleView[] = ['providers', 'routes', 'domains'] as const;

// Base chrome plus console accents (domain accents only — hex ratchet).
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  title:   '#00ffff',
  unknown: '244',
  rowSelectBg: '#111827',
});

const INTRO = 'Provider console: status, latency timelines, error attribution, auth routes, and fallback posture.';

// ---------------------------------------------------------------------------
// ProviderHealthPanel — the merged provider console (WO-112)
// ---------------------------------------------------------------------------

/**
 * Single provider console. Absorbs the retired providers (stats) and accounts
 * panels:
 *  - Status, latency avg/p95, error attribution, sparkline timelines, and
 *    per-provider token/cost totals in one table (ProviderHealthDataProvider).
 *  - Fallback chain with current node and fallover count.
 *  - Auth routes with per-route freshness, issues, and repair hints
 *    (ProviderRuntimeInspectionQuery.inspectAll() is the single route source).
 *  - Repair Domains + Session Maintenance as a secondary 't' view.
 *  - Enter dispatches '/accounts repair <provider>' through the panel
 *    integration context; r forces a posture refresh.
 */
export class ProviderHealthPanel extends BasePanel {
  private _unsubs: Array<() => void> = [];
  private _tickTimerId: ReturnType<typeof setInterval> | null = null;
  private _selectedIndex = 0;
  private _scrollOffset = 0;
  private _view: ConsoleView = 'providers';
  private _accountRecords = new Map<string, ProviderAccountPosture>();
  private _accountRefreshAt = 0;
  private _accountLoading = false;
  private _inflightProvider: string | null = null;
  private _lastResponseProvider: string | null = null;
  private _unattributedError: string | null = null;
  private _modelState: ModelDomainState;
  private readonly _dataProvider: ProviderHealthDataProvider;
  private readonly providerHealthTracker = new ProviderHealthTracker();

  constructor(
    private readonly providerRuntime: ProviderRuntimeInspectionQuery,
    private readonly deps: ProviderHealthPanelDeps,
    private readonly requestRender: () => void = () => {},
  ) {
    super('provider-health', 'Health', 'N', 'providers');
    this._modelState = deps.modelState?.get() ?? this._syntheticModelState();
    this._dataProvider = new ProviderHealthDataProvider(this._buildHealthState(), this._modelState);
    this._subscribe();
    void this._refreshAccountPosture(true);
    // Background 30s posture refresh (auth routes go stale otherwise); cleared on destroy.
    this.registerTimer(setInterval(() => { void this._refreshAccountPosture(); }, 30_000));
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

    // The provider named on the in-flight LLM request is the authoritative
    // attribution target when the turn subsequently errors.
    this._unsubs.push(
      this.deps.turnEvents.on('LLM_REQUEST_STARTED', (payload) => {
        this._inflightProvider = payload.provider;
      }),
    );

    this._unsubs.push(
      this.deps.turnEvents.on('LLM_RESPONSE_RECEIVED', (payload) => {
        this.providerHealthTracker.onLlmResponse(payload.provider, {
          model: payload.model,
          inputTokens: payload.inputTokens,
          outputTokens: payload.outputTokens,
          ...(payload.cacheReadTokens !== undefined ? { cacheReadTokens: payload.cacheReadTokens } : {}),
          ...(payload.cacheWriteTokens !== undefined ? { cacheWriteTokens: payload.cacheWriteTokens } : {}),
        });
        this._lastResponseProvider = payload.provider;
        this._pushHealthState();
        this._markDirtyAndRender();
      }),
    );

    this._unsubs.push(
      this.deps.turnEvents.on('TURN_ERROR', (payload) => {
        const providerId = this._resolveActiveProviderId();
        if (providerId) {
          this.providerHealthTracker.onTurnError(payload.error, providerId);
          this._unattributedError = null;
        } else {
          // No provider is resolvable (nothing registered yet) — surface the
          // error in the posture block instead of inventing a phantom row.
          this._unattributedError = payload.error.slice(0, 120);
        }
        this._inflightProvider = null;
        this._pushHealthState();
        this._markDirtyAndRender();
      }),
    );

    this._unsubs.push(
      this.deps.turnEvents.on('TURN_COMPLETED', () => {
        this._inflightProvider = null;
      }),
    );

    this._unsubs.push(
      this.deps.turnEvents.on('TURN_CANCEL', () => {
        this._inflightProvider = null;
      }),
    );

    this._unsubs.push(
      this.deps.providerEvents.on('PROVIDERS_CHANGED', () => {
        this.providerHealthTracker.onProvidersChanged(this._knownProviders());
        void this._refreshAccountPosture(true);
        this._pushHealthState();
        this._markDirtyAndRender();
      }),
    );

    if (this.deps.modelState) {
      const modelState = this.deps.modelState;
      this._unsubs.push(modelState.subscribe(() => {
        const next = modelState.get();
        if (next !== this._modelState) {
          this._modelState = next;
          this._dataProvider.updateModelState(next);
          this._markDirtyAndRender();
        }
      }));
    }

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
    this._startTickTimer();
  }

  override onDeactivate(): void {
    super.onDeactivate();
    // Stop the per-second display tick while hidden (TokenBudgetPanel pattern);
    // the 30s posture refresh keeps running so data stays warm for preload.
    this._stopTickTimer();
  }

  override onDestroy(): void {
    super.onDestroy();
    this._tickTimerId = null;
    this._dataProvider.dispose();
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
  }

  private _startTickTimer(): void {
    if (this._tickTimerId !== null) return;
    this._tickTimerId = this.registerTimer(setInterval(() => {
      this.markDirty();
      this.requestRender();
    }, 1_000));
  }

  private _stopTickTimer(): void {
    if (this._tickTimerId !== null) {
      this.clearTimer(this._tickTimerId);
      this._tickTimerId = null;
    }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(key: string): boolean {
    if (key === 't' || key === 'tab') {
      const next = CONSOLE_VIEWS[(CONSOLE_VIEWS.indexOf(this._view) + 1) % CONSOLE_VIEWS.length];
      this._view = next ?? 'providers';
      this._scrollOffset = 0;
      this.markDirty();
      return true;
    }
    if (key === 'r') {
      void this._refreshAccountPosture(true);
      this.markDirty();
      return true;
    }
    const providers = this._knownProviders();
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

  /** Enter dispatches the real repair command for the selected provider. */
  handlePanelIntegrationAction(key: string, ctx: PanelIntegrationContext): boolean {
    if (key !== 'enter' && key !== 'return') return false;
    if (!ctx.executeCommand) return false;
    const provider = this._selectedProvider();
    if (!provider) return false;
    void ctx.executeCommand('accounts', ['repair', provider]).catch(() => {
      // Command output surfaces in conversation; dispatch failures are non-fatal here.
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Data plumbing
  // -------------------------------------------------------------------------

  private _knownProviders(): string[] {
    const known = new Set<string>([
      ...this.deps.providers.getSnapshot().providerIds,
      ...this.providerRuntime.listProviderIds(),
      ...this._accountRecords.keys(),
    ]);
    for (const health of this.providerHealthTracker.getAll()) known.add(health.name);
    return [...known].sort();
  }

  private _selectedProvider(): string | undefined {
    const providers = this._knownProviders();
    return providers[Math.min(this._selectedIndex, Math.max(0, providers.length - 1))];
  }

  /**
   * Resolve the provider that should own a TURN_ERROR: the in-flight LLM
   * request's provider, then the store model domain, then the configured
   * provider.model, then the last responding provider, then the sole known
   * provider. Never returns 'unknown'.
   */
  private _resolveActiveProviderId(): string | undefined {
    if (this._inflightProvider) return this._inflightProvider;
    if (this.deps.modelState) {
      const storeProvider = this.deps.modelState.get().activeProviderId;
      if (storeProvider && storeProvider !== 'unknown') return storeProvider;
    }
    const raw = this.deps.configManager.get('provider.model');
    if (typeof raw === 'string' && raw.includes(':')) {
      const providerId = raw.split(':')[0];
      if (providerId) return providerId;
    }
    if (this._lastResponseProvider) return this._lastResponseProvider;
    const known = this._knownProviders();
    if (known.length === 1) return known[0];
    return undefined;
  }

  private _syntheticModelState(): ModelDomainState {
    const base = createInitialModelState();
    const raw = this.deps.configManager.get('provider.model');
    if (typeof raw !== 'string' || !raw.includes(':')) return base;
    const [providerId = '', ...rest] = raw.split(':');
    const modelId = rest.join(':');
    if (!providerId || !modelId) return base;
    return {
      ...base,
      activeProviderId: providerId,
      activeModelId: modelId,
      displayName: raw,
      registryKey: raw,
      source: 'provider-health-panel',
      lastUpdatedAt: Date.now(),
    };
  }

  private _buildHealthState() {
    const activeId = this._resolveActiveProviderId();
    const meta: ProviderHealthMeta[] = this._knownProviders().map((providerId) => {
      const account = this._accountRecords.get(providerId);
      return {
        providerId,
        isActive: providerId === activeId,
        isConfigured: account ? account.activeRoute !== 'unconfigured' : true,
      };
    });
    return this.providerHealthTracker.buildHealthDomainState(meta);
  }

  private _pushHealthState(): void {
    this._dataProvider.updateHealthState(this._buildHealthState());
  }

  private async _refreshAccountPosture(force = false): Promise<void> {
    if (this._accountLoading) return;
    if (!force && Date.now() - this._accountRefreshAt < 15_000) return;
    this._accountLoading = true;
    try {
      const snapshots = await this.providerRuntime.inspectAll();
      this._accountRecords = new Map(
        snapshots
          .map((snapshot) => buildAccountPosture(snapshot))
          .map((record) => [record.providerId, record] as const),
      );
      this._accountRefreshAt = Date.now();
      this._pushHealthState();
      this.markDirty();
      this.requestRender();
    } finally {
      this._accountLoading = false;
    }
  }

  private _collectDomainSummaries(): HealthDomainSummary[] {
    return [...buildProviderHealthDomainSummaries({
      configManager: this.deps.configManager,
      auth: this.deps.localAuth.getSnapshot(),
      settings: this.deps.settings.getSnapshot(),
      remote: this.deps.remote.getSnapshot(),
      security: this.deps.security.getSnapshot(),
      intelligence: this.deps.intelligence.getSnapshot(),
      continuity: this.deps.continuity.getSnapshot(),
      worktrees: this.deps.worktrees.getSnapshot(),
      session: this.deps.session.getSnapshot(),
    })];
  }

  private _evaluateMaintenance() {
    const session = this.deps.session.getSnapshot();
    return evaluateSessionMaintenance({
      configManager: this.deps.configManager,
      currentTokens: session.estimatedContextTokens,
      contextWindow: session.contextWindow,
      messageCount: session.messageCount,
      session: session.session,
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  override render(width: number, height: number): Line[] {
    const palette = { ...DEFAULT_PANEL_PALETTE, header: C.title };

    const providers = this._knownProviders();
    this._selectedIndex = Math.min(this._selectedIndex, Math.max(0, providers.length - 1));

    if (providers.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: 'Health',
        intro: INTRO,
        sections: [{
          lines: buildEmptyState(
            width,
            ' No providers registered.',
            'Provider health appears here once model providers are available and the runtime begins making requests.',
            [
              { command: '/provider', summary: 'review current provider and model selection' },
              { command: '/subscription', summary: 'review provider login and subscription state' },
            ],
            palette,
          ),
        }],
        palette,
      });
    }

    const snapshot = this._dataProvider.getSnapshot();
    const entriesById = new Map(snapshot.entries.map((entry) => [entry.providerId, entry] as const));
    const selectedName = providers[this._selectedIndex];

    const footerHint = buildKeyboardHints(width, [
      { keys: 'j/k', label: 'select provider' },
      { keys: 'enter', label: 'repair auth routes' },
      { keys: 'r', label: 'refresh posture' },
      { keys: 't', label: `view: ${this._view}` },
      { keys: '/provider', label: 'switch model' },
    ], palette);

    const collapsedDomains = this._view !== 'domains'
      ? {
        attention: this._collectDomainSummaries().filter((summary) => summary.level === 'warn' || summary.level === 'bad').length,
        maintenanceLevel: this._evaluateMaintenance().level,
      }
      : undefined;

    const postureSection: PanelWorkspaceSection = {
      lines: buildSummaryBlock(width, 'Provider console posture', buildPostureLines(width, C, palette, {
        providers,
        entriesById,
        accounts: this._accountRecords,
        trackerRecords: this.providerHealthTracker.getAll(),
        compositeStatus: snapshot.compositeStatus,
        falloverCount: snapshot.fallbackChain.falloverCount,
        activeProvider: this._resolveActiveProviderId(),
        ...(collapsedDomains ? { collapsedDomains } : {}),
        unattributedError: this._unattributedError,
      }), palette),
    };

    if (this._view === 'domains') {
      return this._renderDomainsView(width, height, postureSection, footerHint, palette);
    }
    if (this._view === 'routes') {
      return this._renderRoutesView(width, height, postureSection, footerHint, palette, selectedName);
    }
    return this._renderProvidersView(width, height, postureSection, footerHint, palette, providers, entriesById, snapshot.fallbackChain, selectedName);
  }

  private _renderProvidersView(
    width: number,
    height: number,
    postureSection: PanelWorkspaceSection,
    footerHint: Line,
    palette: typeof DEFAULT_PANEL_PALETTE,
    providers: readonly string[],
    entriesById: ReadonlyMap<string, ProviderHealthEntry>,
    chain: FallbackChainData,
    selectedName: string | undefined,
  ): Line[] {
    const chainLines = buildChainLines(width, C, palette, chain);
    const chainSections: PanelWorkspaceSection[] = chainLines.length > 0
      ? [{ title: 'Fallback Chain', lines: chainLines }]
      : [];

    const rows = providers.map((name, absolute) => buildProviderRow(width, C, {
      name,
      entry: entriesById.get(name),
      health: this.providerHealthTracker.get(name),
      account: this._accountRecords.get(name),
      selected: absolute === this._selectedIndex,
    }));

    const selectedSections: PanelWorkspaceSection[] = selectedName
      ? [buildSelectedDetailSection(width, C, palette, {
        selectedName,
        entry: entriesById.get(selectedName),
        health: this.providerHealthTracker.get(selectedName),
        account: this._accountRecords.get(selectedName),
      })]
      : [];

    const resolved = resolvePrimaryScrollableSection(width, height, {
      intro: INTRO,
      footerLines: [footerHint],
      palette,
      beforeSections: [postureSection, ...chainSections],
      section: {
        title: 'Providers',
        fixedLines: [buildProviderColumnHeader(width, C)],
        scrollableLines: rows,
        selectedIndex: this._selectedIndex,
        scrollOffset: this._scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: selectedSections,
    });
    this._scrollOffset = resolved.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: 'Health',
      intro: INTRO,
      sections: [postureSection, ...chainSections, resolved.section, ...selectedSections],
      footerLines: [footerHint],
      palette,
    });
  }

  private _renderRoutesView(
    width: number,
    height: number,
    postureSection: PanelWorkspaceSection,
    footerHint: Line,
    palette: typeof DEFAULT_PANEL_PALETTE,
    selectedName: string | undefined,
  ): Line[] {
    const account = selectedName ? this._accountRecords.get(selectedName) : undefined;
    const routeLines = buildRouteViewLines(width, C, palette, account);

    const resolved = resolvePrimaryScrollableSection(width, height, {
      intro: INTRO,
      footerLines: [footerHint],
      palette,
      beforeSections: [postureSection],
      section: {
        title: `Auth Routes — ${selectedName ?? 'n/a'}`,
        fixedLines: [buildRouteColumnHeader(width, C)],
        scrollableLines: routeLines,
        selectedIndex: 0,
        scrollOffset: this._scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [],
    });
    this._scrollOffset = resolved.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: 'Health',
      intro: INTRO,
      sections: [postureSection, resolved.section],
      footerLines: [footerHint],
      palette,
    });
  }

  private _renderDomainsView(
    width: number,
    height: number,
    postureSection: PanelWorkspaceSection,
    footerHint: Line,
    palette: typeof DEFAULT_PANEL_PALETTE,
  ): Line[] {
    const domainLines = buildDomainLines(width, C, palette, this._collectDomainSummaries());
    const maintenanceSection: PanelWorkspaceSection = {
      title: 'Session Maintenance',
      lines: buildMaintenanceLines(width, C, palette, this._evaluateMaintenance()),
    };

    const resolved = resolvePrimaryScrollableSection(width, height, {
      intro: INTRO,
      footerLines: [footerHint],
      palette,
      beforeSections: [postureSection],
      section: {
        title: 'Repair Domains',
        fixedLines: [],
        scrollableLines: domainLines,
        selectedIndex: 0,
        scrollOffset: this._scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [maintenanceSection],
    });
    this._scrollOffset = resolved.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: 'Health',
      intro: INTRO,
      sections: [postureSection, resolved.section, maintenanceSection],
      footerLines: [footerHint],
      palette,
    });
  }
}
