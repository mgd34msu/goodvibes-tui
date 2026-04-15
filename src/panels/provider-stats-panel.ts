import { BasePanel } from './base-panel.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import type { ProviderEvent, TurnEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { UiEventFeed } from '@pellux/goodvibes-sdk/platform/runtime/ui-events';
import type { UiProvidersSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import {
  buildEmptyState,
  buildKeyValueLine,
  buildStyledPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { truncateDisplay } from '@pellux/goodvibes-sdk/platform/utils/terminal-width';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPARKLINE_CHARS = '._-:=+*#';
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

  constructor(
    private readonly turnEvents: UiEventFeed<TurnEvent>,
    private readonly providerEvents: UiEventFeed<ProviderEvent>,
    private readonly requestRender: () => void = () => {},
    private readonly providers: UiReadModel<UiProvidersSnapshot>,
  ) {
    super('providers', 'Providers', 'R', 'monitoring');
    this._subscribe();
  }

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  private _subscribe(): void {
    // Record when a turn starts so we can compute latency later
    this._unsubs.push(
      this.turnEvents.on('TURN_SUBMITTED', () => {
        this._turnStartMs = Date.now();
      }),
    );

    // Per-streaming-call timing (each iteration of the agentic loop)
    this._unsubs.push(
      this.turnEvents.on('STREAM_START', () => {
        this._streamStartMs = Date.now();
      }),
    );

    // After each LLM response (streamed or not), record metrics for the
    // current provider call inside the turn loop.
    this._unsubs.push(
      this.turnEvents.on('LLM_RESPONSE_RECEIVED', (env) => {
        const now = Date.now();
        const latencyMs = this._streamStartMs !== null
          ? now - this._streamStartMs
          : this._turnStartMs !== null
            ? now - this._turnStartMs
            : 0;
        // Reset stream start — ready for next iteration in the agentic loop
        this._streamStartMs = null;
        this._recordRequest(
          env.provider,
          env.model,
          latencyMs,
          false,
          env.inputTokens
            + env.outputTokens
            + (env.cacheReadTokens ?? 0)
            + (env.cacheWriteTokens ?? 0),
        );

        this.markDirty();
        this.requestRender();
      }),
    );

    // On error, record a failed request
    this._unsubs.push(
      this.turnEvents.on('TURN_ERROR', () => {
        this._turnStartMs = null;
        this._streamStartMs = null;
        this._recordRequest('unknown', 'unknown', 0, true, 0);

        this.markDirty();
        this.requestRender();
      }),
    );

    // Re-render when providers change (new custom providers loaded)
    this._unsubs.push(
      this.providerEvents.on('PROVIDERS_CHANGED', () => {
        this.markDirty();
        this.requestRender();
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

  override render(width: number, height: number): Line[] {
    const knownProviders = [...this.providers.getSnapshot().providerIds];

    if (knownProviders.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ' Provider Stats',
        intro: 'Per-provider request performance, latency distribution, error pressure, and session totals.',
        sections: [
          {
            lines: buildEmptyState(
              width,
              ' No providers registered',
              'Load or configure a provider to begin collecting per-provider latency and error metrics.',
              [],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const totalReq = [...this.records.values()].reduce((sum, rec) => sum + rec.requests, 0);
    const totalErr = [...this.records.values()].reduce((sum, rec) => sum + rec.errors, 0);
    const totalTok = [...this.records.values()].reduce((sum, rec) => sum + rec.totalTokens, 0);
    const allLatencies = [...this.records.values()].flatMap((rec) => rec.latencies);
    const providerSections: PanelWorkspaceSection[] = [
      {
        title: 'Session',
        lines: [
          buildKeyValueLine(width, [
            { label: 'Providers', value: String(knownProviders.length) },
            { label: 'Requests', value: String(totalReq), valueColor: DEFAULT_PANEL_PALETTE.info },
            { label: 'Errors', value: String(totalErr), valueColor: totalErr > 0 ? DEFAULT_PANEL_PALETTE.bad : DEFAULT_PANEL_PALETTE.good },
            { label: 'Tokens', value: String(totalTok), valueColor: DEFAULT_PANEL_PALETTE.value },
          ], DEFAULT_PANEL_PALETTE),
          buildKeyValueLine(width, [
            { label: 'Avg Latency', value: this._fmtMs(this._avg(allLatencies)), valueColor: this._latencyColor(this._avg(allLatencies)) },
            { label: 'P95', value: this._fmtMs(this._p95(allLatencies)), valueColor: DEFAULT_PANEL_PALETTE.warn },
          ], DEFAULT_PANEL_PALETTE),
        ],
      },
    ];

    for (const provName of knownProviders) {
      const rec = this.records.get(provName);
      providerSections.push({
        title: provName,
        lines: this._buildProviderRows(provName, rec, width),
      });
    }

    return buildPanelWorkspace(width, height, {
      title: ' Provider Stats',
      intro: 'Per-provider request performance, latency distribution, error pressure, and session totals.',
      sections: providerSections,
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  // -------------------------------------------------------------------------
  // Line builders
  // -------------------------------------------------------------------------

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
    const modelId = rec?.lastModelId ?? 'n/a';
    const modelDisplay = truncateDisplay(modelId, 30);

    // Header row: * provider  model
    // Build as segments to avoid multi-byte char indexing issues
    const headerLine = buildStyledPanelLine(width, [
      { text: '  ', fg: '#94a3b8' },
      { text: '●', fg: dotColor },
      { text: ' ', fg: '#94a3b8' },
      { text: `${truncateDisplay(provName, 14).padEnd(14)} `, fg: '#e2e8f0', bold: true },
      { text: modelDisplay, fg: '#cbd5e1' },
    ]);

    rows.push(headerLine);

    if (rec === undefined || rec.requests === 0) {
      rows.push(buildStyledPanelLine(width, [
        { text: '    No requests yet.', fg: '#6b7280' },
      ]));
    } else {
      const avgLatency = this._avg(rec.latencies);
      const p95Latency = this._p95(rec.latencies);
      const errRate = rec.requests > 0 ? (rec.errors / rec.requests) * 100 : 0;
      const sparkline = this._sparkline(rec.latencies);

      const latFg = avgLatency < LATENCY_GREEN
        ? '#22c55e'
        : avgLatency < LATENCY_YELLOW
          ? '#eab308'
          : '#ef4444';

      const segments = [
        { text: '    avg ', fg: '#6b7280' },
        { text: this._fmtMs(avgLatency).padStart(6), fg: latFg, bold: true },
        { text: '  p95 ', fg: '#6b7280' },
        { text: this._fmtMs(p95Latency).padStart(6), fg: '#a78bfa' },
        { text: '  ', fg: '#374151' },
        { text: sparkline, fg: latFg },
        { text: '  err ', fg: '#6b7280' },
        { text: `${errRate.toFixed(0).padStart(3)}%`, fg: errRate > 0 ? '#ef4444' : '#22c55e' },
        { text: `  ${rec.requests.toString().padStart(4)}r`, fg: '#94a3b8' },
      ] as const;
      const tokenSegment = rec.totalTokens > 0
        ? [{ text: `  ${rec.totalTokens.toString().padStart(6)}tok`, fg: '#64748b' }]
        : [];
      rows.push(buildStyledPanelLine(width, [...segments, ...tokenSegment]));
    }

    return rows;
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
      return SPARKLINE_CHARS[idx] ?? '.';
    });
    // Pad left to always be LATENCY_RING_SIZE wide
    while (spark.length < LATENCY_RING_SIZE) spark.unshift(' ');
    return spark.join('');
  }

  private _fmtMs(ms: number): string {
    if (ms <= 0) return 'n/a';
    if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    return `${Math.round(ms)}ms`;
  }

  private _latencyColor(ms: number): string {
    if (ms <= 0) return DEFAULT_PANEL_PALETTE.dim;
    if (ms < LATENCY_GREEN) return DEFAULT_PANEL_PALETTE.good;
    if (ms < LATENCY_YELLOW) return DEFAULT_PANEL_PALETTE.warn;
    return DEFAULT_PANEL_PALETTE.bad;
  }
}
