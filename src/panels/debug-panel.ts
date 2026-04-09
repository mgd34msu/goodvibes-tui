import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import type { RuntimeEventBus, TurnEvent } from '../runtime/events/index.ts';
import type { Orchestrator } from '../core/orchestrator.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildStyledPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  resolveStackedScrollableSections,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiCallStatus = 'ok' | 'error';

export interface ApiCallEntry {
  /** Wall-clock timestamp when the call completed. */
  ts: number;
  /** Provider name (e.g. "anthropic"). */
  provider: string;
  /** Model id (e.g. "claude-sonnet-4-5"). */
  model: string;
  /** Input tokens for this call. */
  inputTokens: number;
  /** Output tokens for this call. */
  outputTokens: number;
  /** End-to-end latency in ms (stream-start → llm-response, or turn-start → llm-response). */
  latencyMs: number;
  /** HTTP-level status code hint; 0 when unknown. */
  statusCode: number;
  /** 'ok' | 'error' */
  status: ApiCallStatus;
  /** Trimmed error message when status === 'error'. */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Constants / limits
// ---------------------------------------------------------------------------

const MAX_CALL_LOG   = 50;
const MAX_ERROR_LOG  = 20;

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = {
  title:      '#00ffff',
  ok:         '#5fd700',
  error:      '#ff5f5f',
  warn:       '#ffaf00',
  label:      '244',
  value:      '252',
  dim:        '240',
  provName:   '#e2e8f0',
  separator:  '#374151',
  input:      '#00ffff',
  output:     '#d000ff',
  latGood:    '#5fd700',
  latWarn:    '#ffaf00',
  latBad:     '#ff5f5f',
  sectionHdr: '238',
  colHdr:     '242',
} as const;

const LATENCY_WARN_MS = 2_000;
const LATENCY_BAD_MS  = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTok(n: number): string {
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}

function fmtMs(ms: number): string {
  if (ms <= 0)       return 'n/a';
  if (ms >= 10_000)  return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1_000)   return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60)   return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function latColor(ms: number): string {
  if (ms >= LATENCY_BAD_MS)  return C.latBad;
  if (ms >= LATENCY_WARN_MS) return C.latWarn;
  return C.latGood;
}

function statusCodeFromError(msg: string): number {
  const m = msg.match(/\b(4\d{2}|5\d{2})\b/);
  return m ? parseInt(m[1]!, 10) : 0;
}

// ---------------------------------------------------------------------------
// DebugPanel
// ---------------------------------------------------------------------------

/**
 * Real-time API debug panel.
 *
 * Shows per-call log (model, provider, input/output tokens, latency, status code),
 * running session call total, and error history.
 *
 * Subscribes to typed turn runtime events.
 */
export class DebugPanel extends BasePanel {
  private _unsubs: Array<() => void> = [];

  // Timing state
  private _turnStartMs: number | null = null;
  private _streamStartMs: number | null = null;

  // Token delta tracking (requires wired orchestrator)
  private _orchestrator: Orchestrator | null = null;
  private _prevInput  = 0;
  private _prevOutput = 0;

  // Session data
  private _calls: ApiCallEntry[]  = [];
  private _errors: ApiCallEntry[] = [];
  private _totalCalls = 0;
  private _totalErrors = 0;

  constructor(
    private readonly runtimeBus: RuntimeEventBus,
    private readonly requestRender: () => void = () => {},
  ) {
    super('debug', 'Debug', 'B', 'monitoring');
    this._subscribe();
  }

  // -------------------------------------------------------------------------
  // External wiring
  // -------------------------------------------------------------------------

  /**
   * Optionally wire to the main Orchestrator so per-call token deltas can be
   * computed. Call once after construction.
   */
  wireOrchestrator(orchestrator: Orchestrator): void {
    this._orchestrator = orchestrator;
  }

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  private _subscribe(): void {
    this._unsubs.push(
      this.runtimeBus.on('TURN_SUBMITTED', () => {
        this._turnStartMs  = Date.now();
        this._streamStartMs = null;
      }),
    );

    this._unsubs.push(
      this.runtimeBus.on('STREAM_START', () => {
        this._streamStartMs = Date.now();
      }),
    );

    this._unsubs.push(
      this.runtimeBus.on<Extract<TurnEvent, { type: 'LLM_RESPONSE_RECEIVED' }>>('LLM_RESPONSE_RECEIVED', (env) => {
        const now = Date.now();
        const latencyMs =
          this._streamStartMs !== null
            ? now - this._streamStartMs
            : this._turnStartMs !== null
              ? now - this._turnStartMs
              : 0;
        this._streamStartMs = null;

        // Compute per-call token delta if orchestrator is wired
        let inputTokens  = env.payload.inputTokens + (env.payload.cacheReadTokens ?? 0) + (env.payload.cacheWriteTokens ?? 0);
        let outputTokens = env.payload.outputTokens;
        if (this._orchestrator) {
          const cu = this._orchestrator.usage;
          inputTokens  = Math.max(0, cu.input  - this._prevInput);
          outputTokens = Math.max(0, cu.output - this._prevOutput);
          this._prevInput  = cu.input;
          this._prevOutput = cu.output;
        }

        const entry: ApiCallEntry = {
          ts: now,
          provider: env.payload.provider,
          model: env.payload.model,
          inputTokens,
          outputTokens,
          latencyMs,
          statusCode: 200,
          status: 'ok',
        };
        this._pushCall(entry);
        this.markDirty();
        this.requestRender();
      }),
    );

    this._unsubs.push(
      this.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', (env) => {
        this._streamStartMs = null;
        this._turnStartMs   = null;

        const msg  = env.payload.error;
        const code = statusCodeFromError(msg);

        const entry: ApiCallEntry = {
          ts: Date.now(),
          provider: 'unknown',
          model: 'unknown',
          inputTokens:  0,
          outputTokens: 0,
          latencyMs:    0,
          statusCode:   code,
          status:       'error',
          errorMessage: msg.slice(0, 120),
        };
        this._pushCall(entry);
        this._pushError(entry);
        this.markDirty();
        this.requestRender();
      }),
    );
  }

  private _pushCall(entry: ApiCallEntry): void {
    this._totalCalls++;
    this._calls.push(entry);
    if (this._calls.length > MAX_CALL_LOG) this._calls.shift();
  }

  private _pushError(entry: ApiCallEntry): void {
    this._totalErrors++;
    this._errors.push(entry);
    if (this._errors.length > MAX_ERROR_LOG) this._errors.shift();
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
    const sections: PanelWorkspaceSection[] = [
      {
        title: 'Session',
        lines: this._renderSummary(width),
      },
    ];

    if (this._calls.length === 0) {
      sections.push({
        title: 'API Call Log',
        lines: buildEmptyState(
          width,
          ' No calls yet',
          'Completed provider calls and API failures will appear here with timing, token counts, and status codes.',
          [],
          DEFAULT_PANEL_PALETTE,
        ),
      });
    } else {
      const rows = this._renderCallLog(width);
      if (this._errors.length > 0) {
        const errors = this._renderErrorHistory(width);
        const [callSection, errorSection] = resolveStackedScrollableSections(width, height, {
          palette: DEFAULT_PANEL_PALETTE,
          beforeSections: sections,
          sections: [
            {
              title: 'API Call Log',
              scrollableLines: rows,
              scrollOffset: Math.max(0, rows.length - 1),
              minRows: 8,
              weight: 2,
            },
            {
              title: 'Error History',
              scrollableLines: errors,
              scrollOffset: Math.max(0, errors.length - 1),
              minRows: 4,
              weight: 1,
            },
          ],
        });
        sections.push(callSection!.section, errorSection!.section);
      } else {
        const callSection = resolveScrollablePanelSection(width, height, {
          palette: DEFAULT_PANEL_PALETTE,
          beforeSections: sections,
          section: {
            title: 'API Call Log',
            scrollableLines: rows,
            scrollOffset: Math.max(0, rows.length - 1),
            minRows: 8,
          },
        });
        sections.push(callSection.section);
      }
    }

    return buildPanelWorkspace(width, height, {
      title: ' API Debug',
      intro: 'Recent provider calls, token deltas, latency, status codes, and error history.',
      sections,
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  // -------------------------------------------------------------------------
  // Section renderers
  // -------------------------------------------------------------------------

  private _renderSummary(width: number): Line[] {
    const errCount = this._totalErrors;
    const okCount  = this._totalCalls - this._totalErrors;
    return [
      buildStyledPanelLine(width, [
        { text: ' Calls: ', fg: C.label },
        { text: String(this._totalCalls), fg: C.value },
        { text: '  OK: ', fg: C.label },
        { text: String(okCount), fg: C.ok },
        { text: '  Errors: ', fg: C.label },
        { text: String(errCount), fg: errCount > 0 ? C.error : C.dim },
      ]),
    ];
  }

  private _renderCallLog(width: number): Line[] {
    const lines: Line[] = [];
    lines.push(this._callLogHeader(width));
    for (const entry of this._calls) {
      lines.push(this._callLogRow(entry, width));
    }

    return lines;
  }

  private _callLogHeader(width: number): Line {
    // Layout: time(8) status(2) provider(12) model(20) in(8) out(8) lat(8)
    const header = '  Time    S Provider     Model               In       Out      Lat';
    return this._textLine(header.slice(0, width), C.colHdr, width, { dim: true });
  }

  private _callLogRow(e: ApiCallEntry, width: number): Line {
    const timeStr    = fmtAgo(e.ts).padEnd(8);
    const statusChar = e.status === 'ok' ? '✓' : '✕';
    const statusFg   = e.status === 'ok' ? C.ok : C.error;
    const provStr    = e.provider.slice(0, 11).padEnd(12);
    const modelStr   = e.model.slice(0, 19).padEnd(20);
    const inStr      = fmtTok(e.inputTokens).padStart(8);
    const outStr     = fmtTok(e.outputTokens).padStart(8);
    const latStr     = fmtMs(e.latencyMs).padStart(8);

    const segments: Array<{ text: string; fg: string; bold?: boolean }> = [
      { text: '  ' + timeStr, fg: C.dim },
      { text: statusChar + ' ', fg: statusFg },
      { text: provStr, fg: C.provName },
      { text: modelStr, fg: C.value },
      { text: inStr, fg: C.input },
      { text: outStr, fg: C.output },
      { text: latStr, fg: latColor(e.latencyMs) },
    ];

    // Append status code for errors
    if (e.status === 'error' && e.statusCode > 0) {
      segments.push({ text: ` [${e.statusCode}]`, fg: C.error });
    }

    return buildStyledPanelLine(
      width,
      segments.map((seg) => ({ text: seg.text, fg: seg.fg, bold: seg.bold })),
    );
  }

  private _renderErrorHistory(width: number): Line[] {
    const lines: Line[] = [];
    for (const e of this._errors) {
      lines.push(this._errorRow(e, width));
    }

    return lines;
  }

  private _errorRow(e: ApiCallEntry, width: number): Line {
    const timeStr  = fmtAgo(e.ts).padEnd(8);
    const codeStr  = e.statusCode > 0 ? `[${e.statusCode}] ` : '';
    const msgStr   = (e.errorMessage ?? 'unknown error').slice(0, width - 12 - codeStr.length);
    const full     = `  ${timeStr} ${codeStr}${msgStr}`;
    return this._textLine(full.slice(0, width), C.error, width);
  }

  // -------------------------------------------------------------------------
  // Line-builder helpers
  // -------------------------------------------------------------------------

  private _textLine(
    text: string,
    fg: string,
    width: number,
    opts: { dim?: boolean } = {},
  ): Line {
    return buildStyledPanelLine(width, [{ text, fg, dim: opts.dim }]);
  }
}
