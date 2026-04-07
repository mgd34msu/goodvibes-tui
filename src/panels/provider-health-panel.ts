import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import type { RuntimeEventBus, ProviderEvent, TurnEvent } from '../runtime/events/index.ts';
import { providerRegistry } from '../providers/registry.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { getTrackedVisibleWindow } from '../renderer/surface-layout.ts';

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
    case 'online':       return { char: '*', color: C.online };
    case 'rate-limited': return { char: '!', color: C.rateLimit };
    case 'error':        return { char: 'x', color: C.error };
    default:             return { char: 'o', color: C.unknown };
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

  constructor(
    private readonly runtimeBus: RuntimeEventBus,
    private readonly requestRender: () => void = () => {},
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
    // Tick every second so cooldown countdowns stay live
    if (this._refreshTimer !== null) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => {
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

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  override render(width: number, height: number): Line[] {
    const intro = 'Live provider posture across latency, rate limits, recent failures, and runtime reachability.';

    const knownSet = new Set<string>();
    try {
      for (const m of providerRegistry.listModels()) knownSet.add(m.provider);
    } catch { /* ignore */ }
    for (const h of providerHealthTracker.getAll()) knownSet.add(h.name);
    const providers = [...knownSet].sort();
    this._selectedIndex = Math.min(this._selectedIndex, Math.max(0, providers.length - 1));

    if (providers.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: 'Provider Health',
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
    for (const name of providers) {
      const status = providerHealthTracker.get(name)?.status ?? 'unknown';
      if (status === 'online') online++;
      else if (status === 'rate-limited') rateLimited++;
      else if (status === 'error') errored++;
    }

    const summaryLines = [
      buildKeyValueLine(width, [
        { label: 'providers', value: String(providers.length), valueColor: C.value },
        { label: 'online', value: String(online), valueColor: C.online },
        { label: 'rate-limited', value: String(rateLimited), valueColor: C.rateLimit },
        { label: 'error', value: String(errored), valueColor: C.error },
      ], { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }),
      buildGuidanceLine(width, '/provider', 'review provider selection and routing if health posture degrades', { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' }),
    ];

    const listBudget = Math.max(4, height - 12);
    const window = getTrackedVisibleWindow(providers.length, this._selectedIndex, listBudget, this._scrollOffset, 1);
    this._scrollOffset = window.start;
    const providerLines: Line[] = providers.slice(window.start, window.end).map((name, index) => {
      const health = providerHealthTracker.get(name);
      const status = health?.status ?? 'unknown';
      const globalIndex = window.start + index;
      const bg = globalIndex === this._selectedIndex ? '#111827' : undefined;
      const latency = health?.lastLatencyMs !== undefined ? fmtMs(health.lastLatencyMs) : 'n/a';
      const latencyFg = health?.lastLatencyMs !== undefined ? latencyColor(health.lastLatencyMs) : C.dim;
      return buildPanelLine(width, [
        ['  ', C.label, bg],
        [name.padEnd(16), C.provName, bg],
        [statusLabel(status).padEnd(14), statusDot(status).color, bg],
        [' lat ', C.label, bg],
        [latency.padEnd(8), latencyFg, bg],
        [' ok ', C.label, bg],
        [fmtAgo(health?.lastSuccessAt).padEnd(10), C.value, bg],
      ]);
    });

    const selectedName = providers[this._selectedIndex];
    const selectedHealth = selectedName ? providerHealthTracker.get(selectedName) : undefined;
    const selectedLines: Line[] = [];
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
    }

    const sections: PanelWorkspaceSection[] = [
      { title: 'Summary', lines: summaryLines },
      { title: 'Providers', lines: providerLines },
    ];
    if (selectedLines.length > 0) sections.push({ title: 'Selected', lines: selectedLines });
    return buildPanelWorkspace(width, height, {
      title: 'Provider Health',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  j/k or Up/Down move  live cooldowns refresh while active', C.dim]])],
      palette: { ...DEFAULT_PANEL_PALETTE, header: C.title, headerBg: '#0f172a' },
    });
  }
}
