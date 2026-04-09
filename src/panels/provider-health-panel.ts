import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import type { RuntimeEventBus, ProviderEvent, TurnEvent } from '../runtime/events/index.ts';
import { providerRegistry } from '../providers/registry.ts';
import { buildProviderAccountSnapshot, type ProviderAccountRecord } from '../runtime/provider-accounts/registry.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import type { ConfigManager } from '../config/index.ts';
import { getLocalUserAuthManager } from '../runtime/local-auth.ts';
import { getSettingsControlPlaneSnapshot } from '../runtime/settings/control-plane.ts';
import { getRemoteSupervisor } from '../runtime/remote/index.ts';
import { checkRecoveryFile, readLastSessionPointer } from '../runtime/session-persistence.ts';
import { evaluateSessionMaintenance } from '../runtime/session-maintenance.ts';
import { listPersistedWorktreeMeta, summarizeWorktreeOwnership } from '../runtime/worktree/registry.ts';
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

export type ProviderStatus = 'online' | 'rate-limited' | 'error' | 'unknown';

export interface ProviderHealth {
  name: string;
  status: ProviderStatus;
  lastLatencyMs?: number;
  lastErrorMessage?: string;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  /** Timestamp when rate-limit cooldown expires (ms since epoch). 0 = not rate-limited. */
  rateLimitExpiresAt: number;
}

// ---------------------------------------------------------------------------
// ProviderHealthTracker — module-level singleton
// ---------------------------------------------------------------------------

/**
 * Singleton health tracker updated via typed turn runtime events.
 * Panels read from this; external code can also observe it.
 */
export class ProviderHealthTracker {
  private records = new Map<string, ProviderHealth>();

  /** Stream-start timestamp for computing latency. */
  private _streamStartMs: number | null = null;
  private _turnStartMs: number | null = null;

  /** Default rate-limit cooldown when no Retry-After header is available. */
  private static readonly DEFAULT_COOLDOWN_MS = 60_000;

  // -------------------------------------------------------------------------
  // Event wiring helpers (called by the panel on subscribe)
  // -------------------------------------------------------------------------

  onTurnStart(): void {
    this._turnStartMs = Date.now();
  }

  onStreamStart(): void {
    this._streamStartMs = Date.now();
  }

  onLlmResponse(providerName: string): void {
    const now = Date.now(); // single timestamp for consistency within this method
    const latencyMs =
      this._streamStartMs !== null
        ? now - this._streamStartMs
        : this._turnStartMs !== null
          ? now - this._turnStartMs
          : undefined;
    this._streamStartMs = null;

    this._recordSuccess(providerName, latencyMs);
  }

  onTurnError(error: string, providerName = 'unknown'): void {
    this._streamStartMs = null;
    this._turnStartMs = null;
    const msg = error;
    const isRateLimit = this._isRateLimitMessage(msg);

    this._recordError(providerName, msg, isRateLimit);
  }

  onProvidersChanged(): void {
    // Ensure new providers get an entry (status: unknown)
    try {
      for (const model of providerRegistry.listModels()) {
        if (!this.records.has(model.provider)) {
          this._ensureRecord(model.provider);
        }
      }
    } catch {
      // ignore
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getAll(): ProviderHealth[] {
    return [...this.records.values()];
  }

  get(name: string): ProviderHealth | undefined {
    return this.records.get(name);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _ensureRecord(name: string): ProviderHealth {
    let rec = this.records.get(name);
    if (!rec) {
      rec = { name, status: 'unknown', rateLimitExpiresAt: 0 };
      this.records.set(name, rec);
    }
    return rec;
  }

  private _recordSuccess(name: string, latencyMs?: number): void {
    const rec = this._ensureRecord(name);
    rec.status = 'online';
    rec.lastSuccessAt = Date.now();
    rec.lastErrorMessage = undefined;
    if (latencyMs !== undefined) rec.lastLatencyMs = latencyMs;
    // Clear rate-limit if it has expired or we just got a success
    if (rec.rateLimitExpiresAt > 0 && rec.rateLimitExpiresAt <= Date.now()) {
      rec.rateLimitExpiresAt = 0;
    }
  }

  private _recordError(name: string, message: string, isRateLimit: boolean): void {
    const rec = this._ensureRecord(name);
    rec.lastErrorAt = Date.now();
    rec.lastErrorMessage = message.slice(0, 120);
    if (isRateLimit) {
      rec.status = 'rate-limited';
      rec.rateLimitExpiresAt = Date.now() + ProviderHealthTracker.DEFAULT_COOLDOWN_MS;
    } else {
      rec.status = 'error';
    }
  }

  private _isRateLimitMessage(msg: string): boolean {
    const lower = msg.toLowerCase();
    return (
      lower.includes('429') ||
      lower.includes('402') ||
      /rate.limit|too many requests|quota exceeded|throttl|depleted|credits/.test(lower)
    );
  }
}

/** Shared singleton — created once, lives for the process lifetime. */
export const providerHealthTracker = new ProviderHealthTracker();

// ---------------------------------------------------------------------------
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

interface HealthDomainSummary {
  readonly name: string;
  readonly level: 'good' | 'warn' | 'bad' | 'info';
  readonly summary: string;
  readonly next: string;
  readonly details: readonly string[];
  readonly nextSteps: readonly string[];
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
  private _refreshTimer: ReturnType<typeof setInterval> | null = null;
  private _selectedIndex = 0;
  private _scrollOffset = 0;
  private _accountRecords = new Map<string, ProviderAccountRecord>();
  private _accountRefreshAt = 0;
  private _accountLoading = false;

  constructor(
    private readonly runtimeBus: RuntimeEventBus,
    private readonly requestRender: () => void = () => {},
    private readonly runtimeStore?: RuntimeStore,
    private readonly configManager?: ConfigManager,
  ) {
    super('provider-health', 'Health', 'N', 'monitoring');
    this._subscribe();
  }

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  private _subscribe(): void {
    this._unsubs.push(
      this.runtimeBus.on('TURN_SUBMITTED', () => {
        providerHealthTracker.onTurnStart();
      }),
    );

    this._unsubs.push(
      this.runtimeBus.on('STREAM_START', () => {
        providerHealthTracker.onStreamStart();
      }),
    );

    this._unsubs.push(
      this.runtimeBus.on<Extract<TurnEvent, { type: 'LLM_RESPONSE_RECEIVED' }>>('LLM_RESPONSE_RECEIVED', (env) => {
        providerHealthTracker.onLlmResponse(env.payload.provider);
        this.markDirty();
        this.requestRender();
      }),
    );

    this._unsubs.push(
      this.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', (env) => {
        providerHealthTracker.onTurnError(env.payload.error);
        this.markDirty();
        this.requestRender();
      }),
    );

    this._unsubs.push(
      this.runtimeBus.on<Extract<ProviderEvent, { type: 'PROVIDERS_CHANGED' }>>('PROVIDERS_CHANGED', () => {
        providerHealthTracker.onProvidersChanged();
        this.markDirty();
        this.requestRender();
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override onActivate(): void {
    super.onActivate();
    this.markDirty();
    void this._refreshAccountPosture(true);
    // Tick every second so cooldown countdowns stay live
    if (this._refreshTimer !== null) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => {
      if (Date.now() - this._accountRefreshAt > 30_000) {
        void this._refreshAccountPosture();
      }
      this.markDirty();
      this.requestRender();
    }, 1_000);
  }

  override onDeactivate(): void {
    if (this._refreshTimer !== null) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  override onDestroy(): void {
    this.onDeactivate();
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
  }

  handleInput(key: string): boolean {
    const knownSet = new Set<string>();
    try {
      for (const m of providerRegistry.listModels()) knownSet.add(m.provider);
    } catch { /* ignore */ }
    for (const h of providerHealthTracker.getAll()) knownSet.add(h.name);
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
      const snapshot = await buildProviderAccountSnapshot();
      this._accountRecords = new Map(snapshot.providers.map((record) => [record.providerId, record]));
      this._accountRefreshAt = Date.now();
      this.markDirty();
      this.requestRender();
    } finally {
      this._accountLoading = false;
    }
  }

  private _buildDomainSummaries(): HealthDomainSummary[] {
    const summaries: HealthDomainSummary[] = [];
    const auth = getLocalUserAuthManager().inspect();
    summaries.push({
      name: 'auth',
      level: auth.bootstrapCredentialPresent || auth.userCount <= 1 ? 'warn' : 'good',
      summary: auth.bootstrapCredentialPresent
        ? 'bootstrap credential file still present'
        : `${auth.userCount} users / ${auth.sessionCount} sessions`,
      next: auth.bootstrapCredentialPresent ? '/auth local clear-bootstrap-file' : '/auth local review',
      details: [
        auth.bootstrapCredentialPresent ? 'bootstrap credential file should be cleared after rotation' : `${auth.userCount} local auth users configured`,
        auth.userCount <= 1 ? 'only one local auth user configured' : `${auth.sessionCount} active local auth sessions`,
      ].filter(Boolean),
      nextSteps: auth.bootstrapCredentialPresent
        ? ['/auth local review', '/auth local rotate-password <user> <password>', '/auth local clear-bootstrap-file']
        : ['/auth local review'],
    });

    if (this.configManager) {
      const settings = getSettingsControlPlaneSnapshot(this.configManager);
      const settingIssueCount = settings.conflicts.length + settings.recentFailures.length + (settings.stagedManagedBundle ? 1 : 0);
      summaries.push({
        name: 'settings',
        level: settingIssueCount > 0 ? 'warn' : 'good',
        summary: settingIssueCount > 0
          ? `${settings.conflicts.length} conflicts / ${settings.recentFailures.length} failures${settings.stagedManagedBundle ? ' / staged bundle' : ''}`
          : 'settings control plane clean',
        next: settingIssueCount > 0 ? '/settingssync panel' : '/settingssync show <key>',
        details: [
          settings.conflicts.length > 0 ? `${settings.conflicts.length} unresolved import conflict(s)` : '',
          settings.recentFailures.length > 0 ? `${settings.recentFailures.length} recent sync or managed failure(s)` : '',
          settings.stagedManagedBundle ? `staged bundle ${settings.stagedManagedBundle.profileName} (${settings.stagedManagedBundle.risk}) awaits apply or rollback` : '',
          settings.managedLockCount > 0 ? `${settings.managedLockCount} managed lock(s) enforced` : '',
        ].filter(Boolean),
        nextSteps: settingIssueCount > 0
          ? ['/settingssync panel', '/settingssync show <key>', '/managed staged']
          : ['/settingssync show <key>'],
      });
    }

    if (this.runtimeStore) {
      const state = this.runtimeStore.getState();
      const remote = getRemoteSupervisor().getSnapshot(this.runtimeStore);
      summaries.push({
        name: 'remote',
        level: remote.degradedConnections > 0 ? 'warn' : remote.sessions.length > 0 ? 'good' : 'info',
        summary: remote.sessions.length === 0
          ? 'no remote sessions tracked'
          : `${remote.sessions.length} sessions / ${remote.degradedConnections} degraded`,
        next: remote.degradedConnections > 0 ? '/remote recover <runnerId>' : '/remote supervisor',
        details: remote.sessions.length === 0
          ? ['no remote sessions have been attached yet']
          : remote.sessions
              .filter((session) =>
                session.transportState === 'degraded'
                || session.transportState === 'reconnecting'
                || session.transportState === 'terminal_failure'
                || session.heartbeat.status !== 'fresh'
                || Boolean(session.lastError))
              .slice(0, 3)
              .map((session) => `${session.runnerId}: transport=${session.transportState} heartbeat=${session.heartbeat.status}${session.lastError ? ` error=${session.lastError}` : ''}`),
        nextSteps: remote.degradedConnections > 0
          ? ['/remote supervisor', '/remote recover <runnerId>', '/remote capabilities']
          : ['/remote supervisor'],
      });

      const degradedServers = [...state.mcp.servers.values()].filter((server) =>
        server.status !== 'connected' && server.status !== 'configured'
        || server.schemaFreshness !== 'fresh'
        || Boolean(server.lastError));
      summaries.push({
        name: 'mcp',
        level: degradedServers.length > 0 ? 'warn' : state.mcp.servers.size > 0 ? 'good' : 'info',
        summary: state.mcp.servers.size === 0
          ? 'no MCP servers configured'
          : `${state.mcp.connectedServerNames.length}/${state.mcp.servers.size} connected, ${degradedServers.length} need review`,
        next: degradedServers.length > 0 ? '/mcp repair' : '/mcp review',
        details: degradedServers.length === 0
          ? (state.mcp.servers.size === 0 ? ['no MCP servers registered'] : ['all MCP servers are healthy'])
          : degradedServers.slice(0, 3).map((server) => `${server.name}: status=${server.status} schema=${server.schemaFreshness}${server.lastError ? ` error=${server.lastError}` : ''}`),
        nextSteps: degradedServers.length > 0
          ? ['/mcp review', '/mcp auth-review', '/mcp repair']
          : ['/mcp review'],
      });

      const intelligence = state.intelligence;
      const intelligenceIssues = [
        intelligence.diagnosticsStatus,
        intelligence.symbolSearchStatus,
        intelligence.completionsStatus,
        intelligence.hoverStatus,
      ].filter((status) => status !== 'ready').length;
      summaries.push({
        name: 'intelligence',
        level: intelligenceIssues > 0 ? 'warn' : 'good',
        summary: intelligenceIssues > 0
          ? `${intelligenceIssues} readiness surface(s) degraded`
          : `ready (${intelligence.totalRequests} req / ${Math.round(intelligence.avgLatencyMs)}ms avg)`,
        next: intelligenceIssues > 0 ? '/intelligence repair' : '/intelligence review',
        details: [
          intelligence.diagnosticsStatus !== 'ready' ? `diagnostics=${intelligence.diagnosticsStatus}` : '',
          intelligence.symbolSearchStatus !== 'ready' ? `symbols=${intelligence.symbolSearchStatus}` : '',
          intelligence.completionsStatus !== 'ready' ? `completions=${intelligence.completionsStatus}` : '',
          intelligence.hoverStatus !== 'ready' ? `hover=${intelligence.hoverStatus}` : '',
        ].filter(Boolean),
        nextSteps: intelligenceIssues > 0
          ? ['/intelligence diagnostics', '/intelligence repair', '/health intelligence']
          : ['/intelligence review'],
      });

      const maintenance = evaluateSessionMaintenance({
        currentTokens: state.conversation.estimatedContextTokens,
        contextWindow: state.model.tokenLimits.contextWindow,
        messageCount: state.conversation.messageCount,
        session: state.session,
      });
      summaries.push({
        name: 'maintenance',
        level: maintenance.level === 'needs-repair'
          ? 'bad'
          : maintenance.level === 'suggest-compact' || maintenance.level === 'watch'
            ? 'warn'
            : 'good',
        summary: maintenance.summary,
        next: maintenance.nextSteps[0] ?? '/guidance review',
        details: maintenance.reasons.slice(0, 3),
        nextSteps: maintenance.nextSteps,
      });
    }

    const recovery = checkRecoveryFile();
    const lastPointer = readLastSessionPointer();
    summaries.push({
      name: 'continuity',
      level: recovery ? 'warn' : lastPointer ? 'good' : 'info',
      summary: recovery
        ? `recovery file present for ${recovery.sessionId ?? '(unknown session)'}`
        : lastPointer ? `last session pointer ${lastPointer}` : 'no last-session pointer',
      next: recovery ? '/session resume <id>' : '/session list',
      details: [
        recovery?.returnContext ? `last activity: ${recovery.returnContext.activityLabel}` : '',
        recovery?.returnContext ? `resume posture: ${recovery.returnContext.statusLabel}` : '',
        !lastPointer ? 'no persisted last-session pointer recorded' : '',
      ].filter(Boolean),
      nextSteps: recovery
        ? ['/session list', '/session resume <id>', '/health continuity']
        : ['/session list'],
    });

    const worktreeSummary = summarizeWorktreeOwnership(listPersistedWorktreeMeta());
    const worktreeIssues = worktreeSummary.discard + worktreeSummary.cleanupPending + worktreeSummary.paused;
    summaries.push({
      name: 'worktrees',
      level: worktreeIssues > 0 ? 'warn' : worktreeSummary.total > 0 ? 'good' : 'info',
      summary: worktreeSummary.total === 0
        ? 'no persisted worktrees'
        : `${worktreeSummary.total} tracked / ${worktreeIssues} need review`,
      next: worktreeIssues > 0 ? '/worktree recover <session|task> <id>' : '/worktree review',
      details: [
        worktreeSummary.paused > 0 ? `${worktreeSummary.paused} paused worktree(s)` : '',
        worktreeSummary.cleanupPending > 0 ? `${worktreeSummary.cleanupPending} cleanup pending` : '',
        worktreeSummary.discard > 0 ? `${worktreeSummary.discard} marked discard` : '',
      ].filter(Boolean),
      nextSteps: worktreeIssues > 0
        ? ['/worktree review', '/worktree recover <session|task> <id>']
        : ['/worktree review'],
    });

    return summaries;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  override render(width: number, height: number): Line[] {
    const intro = 'Cross-domain health workspace for providers, auth, settings, remote, MCP, continuity, worktrees, and maintenance posture.';

    const knownSet = new Set<string>();
    try {
      for (const m of providerRegistry.listModels()) knownSet.add(m.provider);
    } catch { /* ignore */ }
    for (const h of providerHealthTracker.getAll()) knownSet.add(h.name);
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
      const status = providerHealthTracker.get(name)?.status ?? 'unknown';
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
    for (const domain of this._buildDomainSummaries()) {
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
    const selectedHealth = selectedName ? providerHealthTracker.get(selectedName) : undefined;
    const selectedAccount = selectedName ? this._accountRecords.get(selectedName) : undefined;
    const selectedLines: Line[] = [];
    const maintenanceLines: Line[] = [];
    if (this.runtimeStore) {
      const state = this.runtimeStore.getState();
      const maintenance = evaluateSessionMaintenance({
        currentTokens: state.conversation.estimatedContextTokens,
        contextWindow: state.model.tokenLimits.contextWindow,
        messageCount: state.conversation.messageCount,
        session: state.session,
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
          { label: 'route', value: selectedAccount.activeRoute, valueColor: selectedAccount.activeRoute === 'subscription' ? C.title : selectedAccount.activeRoute === 'api-key' ? C.rateLimit : C.value },
          { label: 'preferred', value: selectedAccount.preferredRoute, valueColor: C.dim },
          { label: 'freshness', value: selectedAccount.authFreshness, valueColor: selectedAccount.authFreshness === 'expired' ? C.error : selectedAccount.authFreshness === 'expiring' || selectedAccount.authFreshness === 'pending' ? C.rateLimit : C.online },
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
          const health = providerHealthTracker.get(name);
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
