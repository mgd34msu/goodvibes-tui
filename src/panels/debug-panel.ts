import { ScrollableListPanel } from './scrollable-list-panel.ts';
import { createEmptyLine, type Line } from '../types/grid.ts';
import { fitDisplay, truncateDisplay } from '../utils/terminal-width.ts';
import type { TurnEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import type { Orchestrator } from '../core/orchestrator';
import {
  buildAlignedRow,
  buildBodyText,
  buildEmptyState,
  buildKeyboardHints,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  buildStyledPanelLine,
  resolvePrimaryScrollableSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  type ColumnSpec,
  type PanelWorkspaceSection,
} from './polish.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import { abbreviateCount } from '../utils/format-number.ts';
import { formatLatencyMs } from '../utils/format-duration.ts';
import { calcSessionCost } from '../export/cost-utils.ts';

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
  /**
   * HTTP-level status code hint. Only ever set from a real signal (scraped
   * from an error message); 0 means no real code is known. Never fabricated
   * (WO-137 dropped the old always-200-on-success convention — this layer
   * doesn't actually observe HTTP status codes on success).
   */
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
const AGES_REFRESH_MS = 1_000;

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  provName:   '#e2e8f0',
  input:      '#00ffff',
  output:     '#d000ff',
  colHdr:     '242',
});

const LATENCY_WARN_MS = 2_000;
const LATENCY_BAD_MS  = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTok(n: number): string {
  return abbreviateCount(n, { guard: 10_000, decimals: 1, mDecimals: 2 });
}

function fmtMs(ms: number): string {
  return formatLatencyMs(ms);
}

function fmtAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60)   return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function fmtUsd(value: number): string {
  if (value <= 0) return '$0';
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function callCost(entry: ApiCallEntry): number {
  return calcSessionCost(entry.inputTokens, entry.outputTokens, 0, 0, entry.model);
}

function latColor(ms: number): string {
  if (ms >= LATENCY_BAD_MS)  return C.bad;
  if (ms >= LATENCY_WARN_MS) return C.warn;
  return C.good;
}

function statusCodeFromError(msg: string): number {
  const m = msg.match(/\b(4\d{2}|5\d{2})\b/);
  return m ? parseInt(m[1]!, 10) : 0;
}

const CALL_COLUMNS: ColumnSpec[] = [
  { width: 8 },              // time
  { width: 1 },               // status glyph
  { width: 12 },              // provider
  { width: 26 },               // model (+ scraped status code suffix)
  { width: 8, align: 'right' }, // in
  { width: 8, align: 'right' }, // out
  { width: 8, align: 'right' }, // latency
  { width: 9, align: 'right' }, // cost
];

// ---------------------------------------------------------------------------
// DebugPanel
// ---------------------------------------------------------------------------

/**
 * Real-time API debug panel.
 *
 * Migrated onto ScrollableListPanel<ApiCallEntry> (WO-137) so nav
 * (up/down/j/k/pageup/pagedown/g/G), the '/' inline filter, and a
 * selected-row detail section come from the shared base class instead of a
 * bespoke render (SystemMessagesPanel precedent).
 *
 * Shows per-call log (model, provider, input/output tokens, latency, status,
 * cost), running session call total, and error history. Subscribes to typed
 * turn runtime events.
 */
export class DebugPanel extends ScrollableListPanel<ApiCallEntry> {
  private _unsubs: Array<() => void> = [];

  // Timing state
  private _turnStartMs: number | null = null;
  private _streamStartMs: number | null = null;

  // Token delta tracking (requires wired orchestrator)
  private _orchestrator: Orchestrator | null = null;
  private _prevInput  = 0;
  private _prevOutput = 0;

  // Real provider/model attribution for TURN_ERROR rows: the provider/model
  // named on the in-flight LLM request is the authoritative attribution
  // target when the turn subsequently errors (provider-health-panel.ts
  // precedent) — never a fabricated 'unknown'.
  private _inflightProvider: string | null = null;
  private _inflightModel: string | null = null;

  // Session data
  private _calls: ApiCallEntry[]  = [];
  private _errors: ApiCallEntry[] = [];
  private _totalCalls = 0;
  private _totalErrors = 0;

  // c=clear confirmation
  private confirm: ConfirmState<'clear'> | null = null;

  // Re-render timer so "Xs ago" ages stay live even without new events.
  private agesTimerId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly turnEvents: UiEventFeed<TurnEvent>,
    private readonly requestRender: () => void = () => {},
  ) {
    super('debug', 'Debug', '▧', 'incidents-diagnostics');
    this.filterEnabled = true;
    this.filterLabel = 'Filter calls';
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
      this.turnEvents.on('TURN_SUBMITTED', () => {
        this._turnStartMs  = Date.now();
        this._streamStartMs = null;
      }),
    );

    this._unsubs.push(
      this.turnEvents.on('STREAM_START', () => {
        this._streamStartMs = Date.now();
      }),
    );

    this._unsubs.push(
      this.turnEvents.on('LLM_REQUEST_STARTED', (env) => {
        this._inflightProvider = env.provider;
        this._inflightModel = env.model;
      }),
    );

    this._unsubs.push(
      this.turnEvents.on('LLM_RESPONSE_RECEIVED', (env) => {
        const now = Date.now();
        const latencyMs =
          this._streamStartMs !== null
            ? now - this._streamStartMs
            : this._turnStartMs !== null
              ? now - this._turnStartMs
              : 0;
        this._streamStartMs = null;
        this._inflightProvider = null;
        this._inflightModel = null;

        // Compute per-call token delta if orchestrator is wired
        let inputTokens  = env.inputTokens + (env.cacheReadTokens ?? 0) + (env.cacheWriteTokens ?? 0);
        let outputTokens = env.outputTokens;
        if (this._orchestrator) {
          const cu = this._orchestrator.usage;
          inputTokens  = Math.max(0, cu.input  - this._prevInput);
          outputTokens = Math.max(0, cu.output - this._prevOutput);
          this._prevInput  = cu.input;
          this._prevOutput = cu.output;
        }

        const entry: ApiCallEntry = {
          ts: now,
          provider: env.provider,
          model: env.model,
          inputTokens,
          outputTokens,
          latencyMs,
          // WO-137: no fabricated 200 — this layer never observes a real
          // HTTP status code on success, so 0 means "no code, just OK".
          statusCode: 0,
          status: 'ok',
        };
        this._pushCall(entry);
        this.markDirty();
        this.requestRender();
      }),
    );

    this._unsubs.push(
      this.turnEvents.on('TURN_ERROR', (env) => {
        this._streamStartMs = null;
        this._turnStartMs   = null;

        const msg  = env.error;
        const code = statusCodeFromError(msg);

        const entry: ApiCallEntry = {
          ts: Date.now(),
          provider: this._inflightProvider ?? 'n/a',
          model: this._inflightModel ?? 'n/a',
          inputTokens:  0,
          outputTokens: 0,
          latencyMs:    0,
          statusCode:   code,
          status:       'error',
          errorMessage: msg.slice(0, 120),
        };
        this._inflightProvider = null;
        this._inflightModel = null;
        this._pushCall(entry);
        this._pushError(entry);
        this.markDirty();
        this.requestRender();
      }),
    );

    this._unsubs.push(
      this.turnEvents.on('TURN_COMPLETED', () => {
        this._inflightProvider = null;
        this._inflightModel = null;
      }),
    );

    this._unsubs.push(
      this.turnEvents.on('TURN_CANCEL', () => {
        this._inflightProvider = null;
        this._inflightModel = null;
      }),
    );
  }

  private _pushCall(entry: ApiCallEntry): void {
    this._totalCalls++;
    // Follow-mode: only auto-jump to the new row when the selection was
    // already at (or past) the previous tail — mirrors the SystemMessagesPanel
    // "don't yank the cursor while the user is reviewing history" contract.
    const wasAtTail = this._calls.length === 0 || this.selectedIndex >= this._calls.length - 1;
    this._calls.push(entry);
    if (this._calls.length > MAX_CALL_LOG) {
      this._calls.shift();
      if (this.selectedIndex > 0) this.selectedIndex--;
    }
    if (wasAtTail) this.selectedIndex = this._calls.length - 1;
  }

  private _pushError(entry: ApiCallEntry): void {
    this._totalErrors++;
    this._errors.push(entry);
    if (this._errors.length > MAX_ERROR_LOG) this._errors.shift();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override onActivate(): void {
    super.onActivate();
    this._startAgesTimer();
  }

  override onDeactivate(): void {
    this._stopAgesTimer();
  }

  override onDestroy(): void {
    this._stopAgesTimer();
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
  }

  private _startAgesTimer(): void {
    if (this.agesTimerId) return;
    this.agesTimerId = this.registerTimer(setInterval(() => {
      if (this._calls.length === 0) return;
      this.markDirty();
      this.requestRender();
    }, AGES_REFRESH_MS));
  }

  private _stopAgesTimer(): void {
    if (this.agesTimerId) {
      this.clearTimer(this.agesTimerId);
      this.agesTimerId = null;
    }
  }

  // -------------------------------------------------------------------------
  // ScrollableListPanel contract
  // -------------------------------------------------------------------------

  protected getItems(): readonly ApiCallEntry[] {
    return this._calls;
  }

  protected override getPalette() { return C; }
  protected override getEmptyStateMessage() { return ' No calls yet'; }

  protected override filterMatches(entry: ApiCallEntry, q: string): boolean {
    return entry.provider.toLowerCase().includes(q)
      || entry.model.toLowerCase().includes(q)
      || entry.status.includes(q)
      || (entry.errorMessage?.toLowerCase().includes(q) ?? false);
  }

  protected renderItem(entry: ApiCallEntry, _index: number, selected: boolean, width: number): Line {
    const statusChar = entry.status === 'ok' ? '✓' : '✕';
    const statusFg   = entry.status === 'ok' ? C.good : C.bad;
    const codeSuffix = entry.status === 'error' && entry.statusCode > 0 ? ` [${entry.statusCode}]` : '';
    return buildAlignedRow(
      width,
      [
        { text: fmtAgo(entry.ts), fg: C.dim },
        { text: statusChar, fg: statusFg },
        { text: entry.provider, fg: C.provName },
        { text: entry.model + codeSuffix, fg: C.value },
        { text: fmtTok(entry.inputTokens), fg: C.input },
        { text: fmtTok(entry.outputTokens), fg: C.output },
        { text: fmtMs(entry.latencyMs), fg: latColor(entry.latencyMs) },
        { text: fmtUsd(callCost(entry)), fg: C.value },
      ],
      CALL_COLUMNS,
      { selected, selectedBg: C.selectBg },
    );
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(key: string): boolean {
    const confirmResult = handleConfirmInput(this.confirm, key);
    if (confirmResult === 'confirmed') {
      this.confirm = null;
      this._calls = [];
      this._errors = [];
      this._totalCalls = 0;
      this._totalErrors = 0;
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this.confirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') return true;

    if (!this.filterActive && key === 'c') {
      if (this._calls.length === 0) return false;
      this.confirm = { subject: 'clear', label: `${this._calls.length} API call(s)`, verb: 'Clear' };
      this.markDirty();
      return true;
    }

    return super.handleInput(key);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  override render(width: number, height: number): Line[] {
    this.clampSelection();

    if (this.confirm) {
      const lines = buildPanelWorkspace(width, height, {
        title: ' API Debug',
        sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this.confirm) }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    const intro = 'Recent provider calls, token deltas, latency, status codes, and cost, with error history.';

    if (this._calls.length === 0) {
      const lines = buildPanelWorkspace(width, height, {
        title: ' API Debug',
        intro,
        sections: [{
          title: 'Session',
          lines: buildEmptyState(
            width,
            this.getEmptyStateMessage(),
            'Completed provider calls and API failures will appear here with timing, token counts, status, and cost.',
            [],
            C,
          ),
        }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    const summarySection: PanelWorkspaceSection = { title: 'Session', lines: this._renderSummary(width) };
    const filterSection: PanelWorkspaceSection = { lines: [this.buildFilterLine(width)] };

    const visible = this.getVisibleItems();
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, visible.length - 1)));
    const selected = this.getSelectedItem();

    const rows: Line[] = visible.length > 0
      ? visible.map((entry, index) => this.renderItem(entry, index, index === this.selectedIndex, width))
      : [buildPanelLine(width, [[`  No calls match "${this.filterQuery.trim()}"  (Esc to clear)`, C.dim]])];

    const detailSection: PanelWorkspaceSection = selected
      ? {
          title: 'Selected Call',
          lines: [
            buildKeyValueLine(width, [
              { label: 'provider', value: selected.provider, valueColor: C.provName },
              { label: 'model', value: selected.model, valueColor: C.value },
              { label: 'status', value: selected.status === 'ok' ? 'OK' : 'ERROR', valueColor: selected.status === 'ok' ? C.good : C.bad },
              { label: 'when', value: fmtAgo(selected.ts), valueColor: C.dim },
            ], C),
            buildKeyValueLine(width, [
              { label: 'in', value: String(selected.inputTokens), valueColor: C.input },
              { label: 'out', value: String(selected.outputTokens), valueColor: C.output },
              { label: 'latency', value: fmtMs(selected.latencyMs), valueColor: latColor(selected.latencyMs) },
              { label: 'cost', value: fmtUsd(callCost(selected)), valueColor: C.value },
            ], C),
            ...(selected.errorMessage
              ? buildBodyText(width, selected.errorMessage, C, C.bad)
              : []),
          ],
        }
      : { title: 'Selected Call', lines: [] };

    const latestError = this._errors[this._errors.length - 1];
    const hints = this.filterActive
      ? [
          { keys: 'type', label: 'filter calls' },
          { keys: 'Enter', label: 'apply' },
          { keys: 'Esc', label: 'clear' },
        ]
      : [
          { keys: '↑/↓', label: 'select call' },
          { keys: '/', label: 'filter' },
          { keys: 'c', label: 'clear log' },
        ];

    const footerLines: Line[] = [
      ...(latestError
        ? [buildStyledPanelLine(width, [
            { text: ' ✕ latest error  ', fg: C.bad },
            { text: truncateDisplay(latestError.errorMessage ?? 'unknown error', Math.max(0, width - 18)), fg: C.dim },
          ])]
        : []),
      buildKeyboardHints(width, hints, C),
    ];

    const callSection = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines,
      palette: C,
      beforeSections: [summarySection, filterSection],
      section: {
        title: `API Call Log (${visible.length} of ${this._calls.length})`,
        scrollableLines: rows,
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollStart,
        minRows: 6,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [detailSection],
    });
    this.scrollStart = callSection.scrollOffset;

    this.needsRender = false;
    const lines = buildPanelWorkspace(width, height, {
      title: ' API Debug',
      intro,
      sections: [summarySection, filterSection, callSection.section, detailSection],
      footerLines,
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }

  // -------------------------------------------------------------------------
  // Section renderers
  // -------------------------------------------------------------------------

  private _renderSummary(width: number): Line[] {
    const errCount = this._totalErrors;
    const okCount  = this._totalCalls - this._totalErrors;
    const last = this._calls[this._calls.length - 1];
    const recent = this._calls.slice(-10);
    const avgLat = recent.length > 0
      ? Math.round(recent.reduce((s, c) => s + c.latencyMs, 0) / recent.length)
      : 0;
    const sessionTokens = this._calls.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0);
    const sessionCost = this._calls.reduce((s, c) => s + callCost(c), 0);

    const lines: Line[] = [
      buildStyledPanelLine(width, [
        { text: ' Calls ', fg: C.label },
        { text: String(this._totalCalls), fg: C.value },
        { text: '   OK ', fg: C.label },
        { text: String(okCount), fg: C.good },
        { text: '   Errors ', fg: C.label },
        { text: String(errCount), fg: errCount > 0 ? C.bad : C.dim },
        { text: '   Avg latency ', fg: C.label },
        { text: fmtMs(avgLat), fg: avgLat > 0 ? latColor(avgLat) : C.dim },
        { text: '   Tokens ', fg: C.label },
        { text: fmtTok(sessionTokens), fg: C.value },
        { text: '   Cost ', fg: C.label },
        { text: fmtUsd(sessionCost), fg: C.value },
      ]),
    ];
    // Live status: most recent call (latency / age) or wiring hint.
    if (last) {
      lines.push(buildStyledPanelLine(width, [
        { text: ' Last ', fg: C.label },
        { text: last.status === 'ok' ? '✓ ' : '✕ ', fg: last.status === 'ok' ? C.good : C.bad },
        { text: fitDisplay(last.model, 22), fg: C.value },
        { text: '  ' + fmtMs(last.latencyMs), fg: latColor(last.latencyMs) },
        { text: '  ' + fmtAgo(last.ts), fg: C.dim },
      ]));
    } else if (!this._orchestrator) {
      lines.push(buildStyledPanelLine(width, [
        { text: ' Per-call token deltas need the orchestrator wired (wireOrchestrator).', fg: C.dim },
      ]));
    }
    return lines;
  }
}
