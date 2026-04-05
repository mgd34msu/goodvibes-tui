import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import type { RuntimeEventBus, ProviderEvent, TurnEvent } from '../runtime/events/index.ts';
import { providerRegistry } from '../providers/registry.ts';

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
    case 'rate-limited': return { char: '◑', color: C.rateLimit };
    case 'error':        return { char: '●', color: C.error };
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
  if (ms <= 0)      return '—';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1_000)  return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtAgo(ts: number | undefined): string {
  if (!ts) return '—';
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

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  override render(width: number, height: number): Line[] {
    const lines: Line[] = [];

    lines.push(this._titleLine(width));
    lines.push(this._hrLine(width));

    // Collect known providers from registry + any with recorded health
    const knownSet = new Set<string>();
    try {
      for (const m of providerRegistry.listModels()) knownSet.add(m.provider);
    } catch { /* ignore */ }
    for (const h of providerHealthTracker.getAll()) knownSet.add(h.name);

    const providers = [...knownSet].sort();

    if (providers.length === 0) {
      lines.push(this._textLine('  No providers registered.', C.dim, width));
    } else {
      for (const name of providers) {
        if (lines.length >= height - 2) break;
        const health = providerHealthTracker.get(name);
        lines.push(...this._providerRows(name, health, width));
        lines.push(this._hrLine(width));
      }
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }

  // -------------------------------------------------------------------------
  // Line builders
  // -------------------------------------------------------------------------

  private _titleLine(width: number): Line {
    const line = createEmptyLine(width);
    const text = ' Provider Health';
    let x = 0;
    for (const ch of text) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg: C.title, bold: true });
    }
    return line;
  }

  private _hrLine(width: number): Line {
    return Array.from({ length: width }, () =>
      createStyledCell('\u2500', { fg: C.separator }),
    );
  }

  private _textLine(text: string, fg: string, width: number): Line {
    const line = createEmptyLine(width);
    let x = 0;
    for (const ch of text) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg });
    }
    return line;
  }

  private _providerRows(
    name: string,
    health: ProviderHealth | undefined,
    width: number,
  ): Line[] {
    const rows: Line[] = [];
    const status = health?.status ?? 'unknown';
    const dot = statusDot(status);

    // --- Row 1: status dot + provider name + status label + latency ---
    const row1 = createEmptyLine(width);
    const segments1: Array<{ text: string; fg: string; bold?: boolean }> = [
      { text: '  ', fg: C.dim },
      { text: dot.char, fg: dot.color },
      { text: ' ', fg: C.dim },
      { text: name.padEnd(16), fg: C.provName, bold: true },
      { text: statusLabel(status).padEnd(13), fg: dot.color },
    ];

    if (health?.lastLatencyMs !== undefined) {
      segments1.push(
        { text: 'lat: ', fg: C.label },
        { text: fmtMs(health.lastLatencyMs), fg: latencyColor(health.lastLatencyMs) },
      );
    }

    let col = 0;
    for (const seg of segments1) {
      for (const ch of seg.text) {
        if (col >= width) break;
        row1[col++] = createStyledCell(ch, { fg: seg.fg, bold: seg.bold ?? false });
      }
    }
    rows.push(row1);

    // --- Row 2: last seen + cooldown (if rate-limited) ---
    const row2Parts: Array<{ text: string; fg: string }> = [
      { text: '     ', fg: C.dim },
    ];

    if (health?.lastSuccessAt) {
      row2Parts.push(
        { text: 'last ok: ', fg: C.label },
        { text: fmtAgo(health.lastSuccessAt), fg: C.value },
        { text: '  ', fg: C.dim },
      );
    }

    const now = Date.now();
    if (health?.rateLimitExpiresAt && health.rateLimitExpiresAt > now) {
      row2Parts.push(
        { text: fmtCooldown(health.rateLimitExpiresAt), fg: C.rateLimit },
      );
    } else if (health?.lastErrorAt && health.status !== 'online') {
      row2Parts.push(
        { text: 'last err: ', fg: C.label },
        { text: fmtAgo(health.lastErrorAt), fg: C.errMsg },
      );
    }

    const row2 = createEmptyLine(width);
    let c2 = 0;
    for (const part of row2Parts) {
      for (const ch of part.text) {
        if (c2 >= width) break;
        row2[c2++] = createStyledCell(ch, { fg: part.fg });
      }
    }
    rows.push(row2);

    // --- Row 3: last error message (if any) ---
    if (health?.lastErrorMessage) {
      const prefix = '     err: ';
      const maxMsgLen = width - prefix.length;
      const msg = health.lastErrorMessage.slice(0, Math.max(0, maxMsgLen));
      const row3 = createEmptyLine(width);
      let c3 = 0;
      for (const ch of prefix) {
        if (c3 >= width) break;
        row3[c3++] = createStyledCell(ch, { fg: C.label });
      }
      for (const ch of msg) {
        if (c3 >= width) break;
        row3[c3++] = createStyledCell(ch, { fg: C.errMsg, dim: true });
      }
      rows.push(row3);
    }

    return rows;
  }
}
