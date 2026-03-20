import { BasePanel } from './base-panel.ts';
import type { Line } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import type { EventBus } from '../core/event-bus.ts';
import { providerRegistry } from '../providers/registry.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPARKLINE_CHARS = '▁▂▃▄▅▆▇█';
const LATENCY_RING_SIZE = 20;

/** Latency thresholds in ms for color-coding. */
const LATENCY_GREEN  = 500;
const LATENCY_YELLOW = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderRecord {
  /** Provider name (e.g. 'anthropic', 'openai'). */
  name: string;
  /** Currently active model ID for this provider (last seen). */
  lastModelId: string;
  /** Ring buffer of per-request latencies in ms (most-recent last). */
  latencies: number[];
  /** Total request count. */
  requests: number;
  /** Error count. */
  errors: number;
  /** Total input + output tokens summed across all requests. */
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// ProviderStatsPanel
// ---------------------------------------------------------------------------

export class ProviderStatsPanel extends BasePanel {
  /** Per-provider metrics keyed by provider name. */
  private records: Map<string, ProviderRecord> = new Map();

  /** Timestamp (ms) recorded at turn:start — used to compute turn latency. */
  private _turnStartMs: number | null = null;

  /** Timestamp for the current streaming LLM call start. */
  private _streamStartMs: number | null = null;

  /** Unsubscribe functions for event listeners. */
  private _unsubs: Array<() => void> = [];

  constructor(private readonly bus: EventBus) {
    super('providers', 'Providers', 'R', 'monitoring');
    this._subscribe();
  }

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  private _subscribe(): void {
    // Record when a turn starts so we can compute latency later
    this._unsubs.push(
      this.bus.on('turn:start', () => {
        this._turnStartMs = Date.now();
      }),
    );

    // Per-streaming-call timing (each iteration of the agentic loop)
    this._unsubs.push(
      this.bus.on('turn:stream-start', () => {
        this._streamStartMs = Date.now();
      }),
    );

    // After each LLM response (streamed or not), record metrics.
    // Note: turn:llm-response carries no usage data, so tokens remain 0
    // until a richer event is available. Latency is computed from
    // stream-start (streaming) or turn-start (non-streaming).
    this._unsubs.push(
      this.bus.on('turn:llm-response', () => {
        const now = Date.now();
        const latencyMs = this._streamStartMs !== null
          ? now - this._streamStartMs
          : this._turnStartMs !== null
            ? now - this._turnStartMs
            : 0;
        // Reset stream start — ready for next iteration in the agentic loop
        this._streamStartMs = null;

        try {
          const model = providerRegistry.getCurrentModel();
          this._recordRequest(model.provider, model.id, latencyMs, false, 0);
        } catch {
          // Non-fatal: model may not be set yet (race at startup)
          this._recordRequest('unknown', 'unknown', latencyMs, false, 0);
        }

        this.markDirty();
        this.bus.emit('render:request');
      }),
    );

    // On error, record a failed request
    this._unsubs.push(
      this.bus.on('turn:error', () => {
        this._turnStartMs = null;
        this._streamStartMs = null;

        try {
          const model = providerRegistry.getCurrentModel();
          this._recordRequest(model.provider, model.id, 0, true, 0);
        } catch {
          this._recordRequest('unknown', 'unknown', 0, true, 0);
        }

        this.markDirty();
        this.bus.emit('render:request');
      }),
    );

    // Re-render when providers change (new custom providers loaded)
    this._unsubs.push(
      this.bus.on('providers:changed', () => {
        this.markDirty();
        this.bus.emit('render:request');
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Metric recording
  // -------------------------------------------------------------------------

  private _recordRequest(
    providerName: string,
    modelId: string,
    latencyMs: number,
    isError: boolean,
    tokens: number,
  ): void {
    let rec = this.records.get(providerName);
    if (!rec) {
      rec = {
        name: providerName,
        lastModelId: modelId,
        latencies: [],
        requests: 0,
        errors: 0,
        totalTokens: 0,
      };
      this.records.set(providerName, rec);
    }

    rec.lastModelId = modelId;
    rec.requests++;
    if (isError) rec.errors++;
    rec.totalTokens += tokens;

    if (latencyMs > 0) {
      rec.latencies.push(latencyMs);
      // Keep only the most recent LATENCY_RING_SIZE samples
      if (rec.latencies.length > LATENCY_RING_SIZE) {
        rec.latencies.shift();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override onDestroy(): void {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];

    // Title bar
    lines.push(this._buildTitleLine(width));

    // Separator
    lines.push(this._buildHRLine(width));

    // Provider rows
    const allProviders = providerRegistry.listModels().map(m => m.provider);
    const knownProviders = [...new Set(allProviders)];

    if (knownProviders.length === 0) {
      lines.push(this._buildTextLine('  No providers registered.', '#888888', width));
    } else {
      for (const provName of knownProviders) {
        const rec = this.records.get(provName);
        lines.push(...this._buildProviderRows(provName, rec, width));
      }
    }

    // Separator before totals
    lines.push(this._buildHRLine(width));

    // Session totals
    lines.push(this._buildTotalsLine(width));

    // Pad to fill height
    while (lines.length < height) {
      lines.push(createEmptyLine(width));
    }

    return lines.slice(0, height);
  }

  // -------------------------------------------------------------------------
  // Line builders
  // -------------------------------------------------------------------------

  private _buildTitleLine(width: number): Line {
    const label = ' Providers — per-provider performance metrics';
    const cells: Line = [];
    for (let i = 0; i < width; i++) {
      const ch = i < label.length ? label[i] : ' ';
      cells.push(createStyledCell(ch ?? ' ', { fg: '#e2e8f0', bold: i < 10 }));
    }
    return cells;
  }

  private _buildHRLine(width: number): Line {
    return Array.from({ length: width }, () =>
      createStyledCell('\u2500', { fg: '#374151' }),
    );
  }

  private _buildTextLine(text: string, fg: string, width: number): Line {
    const cells: Line = [];
    for (let i = 0; i < width; i++) {
      const ch = i < text.length ? text[i] : ' ';
      cells.push(createStyledCell(ch ?? ' ', { fg }));
    }
    return cells;
  }

  private _buildProviderRows(
    provName: string,
    rec: ProviderRecord | undefined,
    width: number,
  ): Line[] {
    const rows: Line[] = [];

    // Determine health
    const hasErrors = rec !== undefined && rec.errors > 0;
    const dotColor = hasErrors ? '#ef4444' : '#22c55e';

    // Model ID (truncated)
    const modelId = rec?.lastModelId ?? '—';
    const modelDisplay = modelId.length > 30 ? modelId.slice(0, 27) + '...' : modelId;

    // Header row: ● provider  model
    // Build as segments to avoid multi-byte char indexing issues
    const headerLine: Line = [];
    const segments: Array<{ text: string; fg: string; bold?: boolean }> = [
      { text: '  ', fg: '#94a3b8' },
      { text: '●', fg: dotColor },
      { text: ' ', fg: '#94a3b8' },
      { text: provName.padEnd(14), fg: '#e2e8f0', bold: true },
      { text: ' ', fg: '#94a3b8' },
      { text: modelDisplay, fg: '#cbd5e1' },
    ];

    let col = 0;
    for (const seg of segments) {
      for (const ch of seg.text) {
        if (col >= width) break;
        headerLine.push(createStyledCell(ch, { fg: seg.fg, bold: seg.bold ?? false }));
        col++;
      }
    }
    while (col < width) {
      headerLine.push(createStyledCell(' ', { fg: '' }));
      col++;
    }
    rows.push(headerLine);

    // Stats row
    if (rec === undefined || rec.requests === 0) {
      rows.push(this._buildTextLine('    No requests yet.', '#6b7280', width));
    } else {
      const avgLatency = this._avg(rec.latencies);
      const p95Latency = this._p95(rec.latencies);
      const errRate    = rec.requests > 0 ? (rec.errors / rec.requests) * 100 : 0;
      const sparkline  = this._sparkline(rec.latencies);

      const latFg = avgLatency < LATENCY_GREEN
        ? '#22c55e'
        : avgLatency < LATENCY_YELLOW
          ? '#eab308'
          : '#ef4444';

      const statsLine: Line = [];
      let scol = 0;

      const push = (ch: string, fg: string, bold = false): void => {
        if (scol < width) {
          statsLine.push(createStyledCell(ch, { fg, bold }));
          scol++;
        }
      };

      const pushStr = (s: string, fg: string, bold = false): void => {
        for (const ch of s) push(ch, fg, bold);
      };

      pushStr('    avg', '#6b7280');
      pushStr(this._fmtMs(avgLatency).padStart(6), latFg, true);
      pushStr('  p95', '#6b7280');
      pushStr(this._fmtMs(p95Latency).padStart(6), '#a78bfa');
      pushStr('  ', '#374151');
      pushStr(sparkline, latFg);
      pushStr('  err', '#6b7280');
      pushStr(errRate.toFixed(0).padStart(3) + '%', errRate > 0 ? '#ef4444' : '#22c55e');
      pushStr('  ' + rec.requests.toString().padStart(4) + 'r', '#94a3b8');
      if (rec.totalTokens > 0) {
        pushStr('  ' + rec.totalTokens.toString().padStart(6) + 'tok', '#64748b');
      }

      // Pad remainder
      while (scol < width) {
        statsLine.push(createStyledCell(' ', { fg: '' }));
        scol++;
      }

      rows.push(statsLine);
    }

    return rows;
  }

  private _buildTotalsLine(width: number): Line {
    let totalReq = 0;
    let totalErr = 0;
    let totalTok = 0;
    const allLatencies: number[] = [];

    for (const rec of this.records.values()) {
      totalReq += rec.requests;
      totalErr += rec.errors;
      totalTok += rec.totalTokens;
      for (const lat of rec.latencies) allLatencies.push(lat);
    }

    const avgAll = allLatencies.length > 0 ? this._avg(allLatencies) : 0;
    const tokPart = totalTok > 0 ? ` | ${totalTok} tok` : '';
    const text = ` Session: ${totalReq} req${tokPart} | ${totalErr} err | ${this._fmtMs(avgAll)} avg`;
    const line: Line = [];
    for (let i = 0; i < width; i++) {
      const ch = text[i] ?? ' ';
      line.push(createStyledCell(ch, { fg: '#6b7280', italic: true }));
    }
    return line;
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  private _avg(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  private _p95(arr: number[]): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
  }

  private _sparkline(latencies: number[]): string {
    if (latencies.length === 0) return ' '.repeat(LATENCY_RING_SIZE);
    const vals = latencies.slice(-LATENCY_RING_SIZE);
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const range = maxV - minV || 1;
    const spark: string[] = vals.map((v) => {
      const idx = Math.min(
        SPARKLINE_CHARS.length - 1,
        Math.floor(((v - minV) / range) * (SPARKLINE_CHARS.length - 1)),
      );
      return SPARKLINE_CHARS[idx] ?? '▁';
    });
    // Pad left to always be LATENCY_RING_SIZE wide
    while (spark.length < LATENCY_RING_SIZE) spark.unshift(' ');
    return spark.join('');
  }

  private _fmtMs(ms: number): string {
    if (ms <= 0) return '—';
    if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    return `${Math.round(ms)}ms`;
  }
}
