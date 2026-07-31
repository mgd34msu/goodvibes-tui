import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import type { Orchestrator } from '../core/orchestrator';
import { evaluateSessionMaintenance } from '@/runtime/index.ts';
import type { TurnEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '@/runtime/index.ts';
import type { UiReadModel, UiSessionSnapshot } from '../runtime/ui-read-models.ts';
import type { SessionMemoryQuery } from '@/runtime/index.ts';
import { calcSessionCost, describePricingSource, isModelPriced } from '../export/cost-utils.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import type { PanelIntegrationContext } from './types.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyboardHints,
  buildMeterLine,
  buildStatusPill,
  buildStyledPanelLine,
  buildTable,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  type PanelWorkspaceSection,
} from './polish.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Timestamp of the turn completion. */
  ts: number;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  // Token data-series colors (input/output/cache) — categorical, no shared equivalent
  input: '#00ffff',
  output: '#d000ff',
  cacheRead: '#00d700',
  cacheWrite: '#ffaf00',
  // Progress-bar track shade and per-turn table sub-header gray
  barBg: '236',
  turnHeader: '242',
});

// Warning thresholds for context window usage
const WARN_YELLOW = 0.70;
const WARN_RED = 0.90;

// Maximum turns to keep in per-turn history
const MAX_TURN_HISTORY = 10;

// Rows scrolled per pageup/pagedown key press through the Recent Turns history.
const PAGE_SCROLL_ROWS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a token count: up to 9999 shown as-is, then 10.0k, 1.2M, etc. */
function fmtTok(n: number): string {
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}

// ---------------------------------------------------------------------------
// TokenBudgetPanel
// ---------------------------------------------------------------------------

/**
 * Real-time token usage breakdown panel.
 *
 * Displays:
 *  - Stacked bar: input / output / cache-read / cache-write
 *  - Context window fill percentage with progress bar + pressure pill
 *  - Per-turn token usage (last 10 turns), scrollable
 *  - Cumulative session totals + inline cost estimate
 *  - Warning threshold indicators (yellow at 70%, red at 90%)
 *
 * Absorbs the former ContextVisualizerPanel ('context'): the pressure pill,
 * TURN_SUBMITTED/TURN_COMPLETED-driven refresh, and the compact-now action
 * all live here now. `PanelManager` aliases the retired `context` id to
 * `tokens` so old `/panel open context` calls keep working.
 */
export class TokenBudgetPanel extends BasePanel {
  /** Snapshot of cumulative usage from the Orchestrator after each turn. */
  private sessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** lastInputTokens from the Orchestrator — current context window occupancy. */
  private lastInputTokens = 0;
  /** Context window size from the model config (0 = unknown). */
  private contextWindow = 0;
  /** Per-turn snapshots — at most MAX_TURN_HISTORY entries. */
  private turnHistory: TurnUsage[] = [];
  /** Previous cumulative snapshot to compute per-turn delta. */
  private prevCumulative = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private orchestrator: Orchestrator | null = null;
  private getContextWindow: (() => number) | null = null;
  private sessionReadModel: UiReadModel<UiSessionSnapshot> | null = null;
  /** Resolver for the active model id, for inline cost display. */
  private getCurrentModelId: (() => string) | null = null;
  private readonly sessionMemoryStore: SessionMemoryQuery;
  private readonly configManager: Pick<ConfigManager, 'get'>;
  private readonly requestRender: () => void;

  /** Turn-event bus subscriptions — absorbed from ContextVisualizerPanel. */
  private unsubs: Array<() => void> = [];

  /** Manual scroll cursor into turnHistory; -1 = auto-follow the latest turn. */
  private turnScrollIndex = -1;

  /** Pending confirm dialog (currently only used for the compact-now action). */
  private confirm: ConfirmState<'compact'> | null = null;
  /**
   * Set when a confirm resolves to 'confirmed'; consumed by
   * handlePanelIntegrationAction on the very next dispatch of that same key
   * so it can reach the ctx.executeCommand bridge (handleInput has no ctx).
   */
  private compactConfirmedPending = false;

  constructor(
    sessionMemoryStore: SessionMemoryQuery,
    configManager: Pick<ConfigManager, 'get'>,
    requestRender: () => void = () => {},
    turnEvents?: UiEventFeed<TurnEvent>,
  ) {
    super('tokens', 'Tokens', '▢', 'providers');
    this.sessionMemoryStore = sessionMemoryStore;
    this.configManager = configManager;
    this.requestRender = requestRender;
    if (turnEvents) this._attachBus(turnEvents);
  }

  // ---------------------------------------------------------------------------
  // External wiring
  // ---------------------------------------------------------------------------

  /**
   * Wire the panel to live data sources. Call once after construction.
   *
   * @param orchestrator      The main Orchestrator instance (for usage + lastInputTokens).
   * @param getCtxWindow      Callback returning the current model's contextWindow value.
   * @param sessionReadModel  Session read model (for the Maintenance status line).
   * @param getCurrentModelId Callback returning the active model id, for the inline cost line.
   */
  wire(
    orchestrator: Orchestrator,
    getCtxWindow: () => number,
    sessionReadModel?: UiReadModel<UiSessionSnapshot>,
    getCurrentModelId?: () => string,
  ): void {
    this.orchestrator = orchestrator;
    this.getContextWindow = getCtxWindow;
    this.sessionReadModel = sessionReadModel ?? null;
    this.getCurrentModelId = getCurrentModelId ?? null;
  }

  /**
   * Snapshot a completed turn into per-turn history.
   * Should be called from a `turn:complete` event listener.
   */
  recordTurn(): void {
    if (!this.orchestrator) return;

    const cu = this.orchestrator.usage;
    const delta: TurnUsage = {
      input:      cu.input      - this.prevCumulative.input,
      output:     cu.output     - this.prevCumulative.output,
      cacheRead:  cu.cacheRead  - this.prevCumulative.cacheRead,
      cacheWrite: cu.cacheWrite - this.prevCumulative.cacheWrite,
      ts: Date.now(),
    };

    this.prevCumulative = { ...cu };

    this.turnHistory.push(delta);
    if (this.turnHistory.length > MAX_TURN_HISTORY) {
      this.turnHistory.shift();
    }
    // A freshly completed turn always pulls the view back to the latest entry.
    this.turnScrollIndex = -1;

    this._refreshAndRender();
  }

  // ---------------------------------------------------------------------------
  // Turn-event bus (absorbed from ContextVisualizerPanel)
  // ---------------------------------------------------------------------------

  private _attachBus(turnEvents: UiEventFeed<TurnEvent>): void {
    if (this.unsubs.length > 0) return;
    this.unsubs.push(turnEvents.on('TURN_COMPLETED', () => this.recordTurn()));
    this.unsubs.push(turnEvents.on('TURN_SUBMITTED', () => this._refreshAndRender()));
  }

  private _detachBus(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override onActivate(): void {
    super.onActivate();
    this.refresh();
    // Poll every 2 s while active so the context bar stays current during streaming
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => this._refreshAndRender(), 2_000);
  }

  override onDeactivate(): void {
    super.onDeactivate();
    this.confirm = null;
    // Stop the off-screen poll so a backgrounded Tokens tab does not keep
    // refreshing (and, once requestRender is wired, force a repaint) every 2 s.
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  override onDestroy(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this._detachBus();
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  private _pressureRatio(): number {
    return this.contextWindow > 0 ? this.lastInputTokens / this.contextWindow : 0;
  }

  private _pressureElevated(): boolean {
    return this.contextWindow > 0 && this._pressureRatio() >= WARN_YELLOW;
  }

  private _scrollTurns(delta: number): void {
    const current = this.turnScrollIndex === -1 ? this.turnHistory.length : this.turnScrollIndex;
    const next = current + delta;
    this.turnScrollIndex = Math.max(0, Math.min(this.turnHistory.length, next));
    this.markDirty();
  }

  handleInput(key: string): boolean {
    // Confirmation dialog — use the shared handleConfirmInput for y/n/Esc UX
    const confirmResult = handleConfirmInput(this.confirm, key);
    if (confirmResult === 'confirmed') {
      this.confirm = null;
      this.compactConfirmedPending = true;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this.confirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') return true;

    if (key === 'C' && this._pressureElevated()) {
      this.confirm = { subject: 'compact', label: 'Compact context now', verb: 'Compact' };
      this.markDirty();
      return true;
    }

    if (this.turnHistory.length > 0) {
      switch (key) {
        case 'up':       this._scrollTurns(-1); return true;
        case 'down':     this._scrollTurns(1); return true;
        case 'pageup':   this._scrollTurns(-PAGE_SCROLL_ROWS); return true;
        case 'pagedown': this._scrollTurns(PAGE_SCROLL_ROWS); return true;
      }
    }

    if (key === 'r') {
      this._refreshAndRender();
      return true;
    }

    return false;
  }

  /**
   * Executes the compact-now action once the confirm dialog resolves. This
   * lives in the integration hook (rather than inline in handleInput)
   * because only this hook carries the `ctx.executeCommand` bridge into the
   * real `/compact` command.
   */
  handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (!this.compactConfirmedPending) return false;
    this.compactConfirmedPending = false;
    void ctx.executeCommand?.('compact', []);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Data refresh
  // ---------------------------------------------------------------------------

  private refresh(): void {
    if (this.orchestrator) {
      const u = this.orchestrator.usage;
      this.sessionUsage.input      = u.input      ?? 0;
      this.sessionUsage.output     = u.output     ?? 0;
      this.sessionUsage.cacheRead  = u.cacheRead  ?? 0;
      this.sessionUsage.cacheWrite = u.cacheWrite ?? 0;
      this.lastInputTokens = this.orchestrator.lastInputTokens;
    }
    if (this.getContextWindow) {
      this.contextWindow = this.getContextWindow();
    }
    this.markDirty();
  }

  /**
   * Refresh data and request a repaint. Used by the background poll and on
   * turn completion, where no key event will otherwise drive a render.
   */
  private _refreshAndRender(): void {
    this.refresh();
    this.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  override render(width: number, height: number): Line[] {
    return this.trackedRender(() => {
    if (this.confirm) {
      return buildPanelWorkspace(width, height, {
        title: ' Token Budget',
        sections: [{
          title: 'Confirmation',
          lines: renderConfirmLines(width, this.confirm),
        }],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const sections: PanelWorkspaceSection[] = [];

    if (this.contextWindow > 0) {
      sections.push({
        title: 'Context',
        lines: this.renderContextBar(width),
      });
    }

    sections.push({
      title: 'Session',
      lines: [
        ...this.renderStackedBar(width, this.sessionUsage, 'Session'),
        ...this.renderTotals(width),
      ],
    });

    const elevated = this._pressureElevated();
    const footerHints = elevated
      ? [
          { keys: 'C', label: 'compact now' },
          { keys: 'up/down', label: 'scroll turns' },
          { keys: 'r', label: 'refresh' },
        ]
      : [
          { keys: 'up/down', label: 'scroll turns' },
          { keys: 'r', label: 'refresh' },
          { keys: '/compact', label: 'compress context' },
        ];

    if (this.turnHistory.length > 0) {
      const priorSections = [...sections];
      const scrollIndex = this.turnScrollIndex === -1 ? this.turnHistory.length : this.turnScrollIndex;
      const turnsSection = resolveScrollablePanelSection(width, height, {
        intro: 'Live context pressure, session token composition, cache usage, and recent turn deltas.',
        footerLines: [
          buildKeyboardHints(width, footerHints, DEFAULT_PANEL_PALETTE),
        ],
        palette: DEFAULT_PANEL_PALETTE,
        beforeSections: priorSections,
        section: {
          title: 'Recent Turns',
          scrollableLines: this.renderTurnHistory(width, this.turnHistory.length + 1),
          scrollOffset: scrollIndex,
          minRows: 6,
        },
        afterSections: [{
          title: 'Maintenance',
          lines: this.renderMaintenance(width),
        }],
      });
      sections.push(turnsSection.section);
    } else {
      sections.push({
        title: 'Recent Turns',
        lines: buildEmptyState(
          width,
          ' No turns recorded yet',
          'Token deltas appear here after completed turns so you can see context growth and cache usage.',
          [],
          DEFAULT_PANEL_PALETTE,
        ),
      });
    }

    sections.push({
      title: 'Maintenance',
      lines: this.renderMaintenance(width),
    });

    return buildPanelWorkspace(width, height, {
      title: ' Token Budget',
      intro: 'Live context pressure, session token composition, cache usage, and recent turn deltas.',
      sections,
      footerLines: [
        buildKeyboardHints(width, footerHints, DEFAULT_PANEL_PALETTE),
      ],
      palette: DEFAULT_PANEL_PALETTE,
    });
    });
  }

  private renderMaintenance(width: number): Line[] {
    const sessionSnapshot = this.sessionReadModel?.getSnapshot();
    const status = evaluateSessionMaintenance({
      configManager: this.configManager,
      currentTokens: this.lastInputTokens,
      contextWindow: this.contextWindow,
      messageCount: sessionSnapshot?.totalTurns,
      sessionMemoryCount: this.sessionMemoryStore.list().length,
      session: sessionSnapshot?.session,
    });

    const lines: Line[] = [
      this.paintTextLine(` ${status.summary}`, width, C.label),
    ];

    if (status.reasons[0]) {
      lines.push(this.paintTextLine(` ${status.reasons[0]}`, width, C.dim, { dim: true }));
    }

    if (status.guidanceMode !== 'off' && status.nextSteps.length > 0) {
      const nextStep = status.nextSteps[0]!;
      // when the recommended next step is /compact and C is armed
      // (see handleInput's elevated-only C branch and the footer hint),
      // advertise the key instead of the command — pressing C already
      // dispatches it for real, so printing '/compact' here was a redundant
      // action substitute.
      if (nextStep === '/compact' && this._pressureElevated()) {
        lines.push(buildGuidanceLine(width, 'C', 'compact context now — the recommended next maintenance action', DEFAULT_PANEL_PALETTE));
      } else {
        lines.push(buildGuidanceLine(width, nextStep, 'open the next maintenance action directly', DEFAULT_PANEL_PALETTE));
      }
    }

    return lines;
  }

  /**
   * Renders a compact stacked proportion bar:
   *   [########............] (input=cyan, output=purple, cacheR=green, cacheW=yellow)
   */
  private renderStackedBar(
    width: number,
    u: { input: number; output: number; cacheRead: number; cacheWrite: number },
    label: string,
  ): Line[] {
    const lines: Line[] = [];

    const labelLine = this.paintTextLine(` ${label}:`, width, C.label);
    lines.push(labelLine);

    const total = u.input + u.output + u.cacheRead + u.cacheWrite;
    if (total === 0) {
      lines.push(this.paintTextLine('  (no data)', width, C.dim, { dim: true }));
      return lines;
    }

    const BAR_W = Math.max(10, Math.min(40, width - 4));
    const segments: Array<{ color: string; label: string; count: number; cells: number }> = [
      { color: C.input,      label: 'In',  count: u.input,      cells: 0 },
      { color: C.output,     label: 'Out', count: u.output,     cells: 0 },
      { color: C.cacheRead,  label: 'CR',  count: u.cacheRead,  cells: 0 },
      { color: C.cacheWrite, label: 'CW',  count: u.cacheWrite, cells: 0 },
    ].filter(s => s.count > 0);

    // Distribute cells proportionally, ensuring they sum to BAR_W
    let assigned = 0;
    for (const seg of segments) {
      seg.cells = Math.floor((seg.count / total) * BAR_W);
      assigned += seg.cells;
    }
    // Give remainder to the largest segment
    const remainder = BAR_W - assigned;
    if (remainder > 0 && segments.length > 0) {
      const largest = segments.reduce((a, b) => (b.count > a.count ? b : a));
      largest.cells += remainder;
    }

    // Build bar line
    const usedCells = segments.reduce((sum, seg) => sum + seg.cells, 0);
    lines.push(buildStyledPanelLine(width, [
      { text: ' [', fg: C.label },
      ...segments.map((seg) => ({ text: '#'.repeat(seg.cells), fg: seg.color })),
      { text: '.'.repeat(Math.max(0, BAR_W - usedCells)), fg: C.barBg },
      { text: ']', fg: C.label },
    ]));

    // Legend line: In:12.3k  Out:4.5k  CR:6.7k  CW:1.2k  Total:24.7k
    const allSegs = [
      { color: C.input,      label: 'In',    count: u.input },
      { color: C.output,     label: 'Out',   count: u.output },
      { color: C.cacheRead,  label: 'CR',    count: u.cacheRead },
      { color: C.cacheWrite, label: 'CW',    count: u.cacheWrite },
    ];
    lines.push(buildStyledPanelLine(width, [
      { text: ' ', fg: C.dim },
      ...allSegs.flatMap((seg) => ([
        { text: `${seg.label}:`, fg: seg.color },
        { text: `${fmtTok(seg.count)} `, fg: C.value },
      ])),
      { text: ` Total:${fmtTok(total)}`, fg: C.value, bold: true },
    ]));

    return lines;
  }

  /** Renders a full-width progress bar for context window fill, plus a pressure pill (absorbed from ContextVisualizerPanel). */
  private renderContextBar(width: number): Line[] {
    const lines: Line[] = [];
    const pct = this.contextWindow > 0
      ? Math.min(1, this.lastInputTokens / this.contextWindow)
      : 0;
    const pctInt = Math.round(pct * 100);

    // Choose color based on thresholds
    let barColor: string;
    let warnSuffix = '';
    if (pct >= WARN_RED) {
      barColor = C.bad;
      warnSuffix = ' ! CRITICAL';
    } else if (pct >= WARN_YELLOW) {
      barColor = C.warn;
      warnSuffix = ' ! HIGH';
    } else {
      barColor = C.good;
    }

    const label = ' Context: ';
    const suffix = ` ${fmtTok(this.lastInputTokens)}/${fmtTok(this.contextWindow)} (${pctInt}%)${warnSuffix}`;
    const BAR_W = Math.max(8, width - label.length - suffix.length - 2);
    const filled = Math.round(pct * BAR_W);
    // Context fill is the headline metric — render it with the shared meter
    // primitive so the bar glyphs and width handling match every other panel.
    lines.push(buildMeterLine(width, filled, BAR_W,
      { filled: barColor, empty: C.barBg, label: C.label },
      { prefix: label, suffix },
    ));

    // Pressure pill — absorbed from ContextVisualizerPanel's headline indicator.
    const overLimit = this.contextWindow > 0 && this.lastInputTokens > this.contextWindow;
    const pressureState = overLimit || pct >= WARN_RED ? 'bad' : pct >= WARN_YELLOW ? 'warn' : 'good';
    const pressureLabel = overLimit ? 'over limit' : pct >= WARN_RED ? 'critical' : pct >= WARN_YELLOW ? 'elevated' : 'healthy';
    lines.push(buildStyledPanelLine(width, [
      { text: ' ', fg: C.dim },
      ...buildStatusPill(pressureState, pressureLabel),
    ]));

    return lines;
  }

  /** Session cumulative totals with color-coded labels, plus an inline cost estimate. */
  private renderTotals(width: number): Line[] {
    const lines: Line[] = [];
    lines.push(this.paintTextLine(' Session Totals:', width, C.label));

    const u = this.sessionUsage;
    const total = u.input + u.output + u.cacheRead + u.cacheWrite;

    const rows: Array<[string, number, string]> = [
      ['  Input:      ', u.input,      C.input],
      ['  Output:     ', u.output,     C.output],
      ['  Cache Read: ', u.cacheRead,  C.cacheRead],
      ['  Cache Write:', u.cacheWrite, C.cacheWrite],
      ['  Total:      ', total,         C.value],
    ];

    for (const [lbl, val, color] of rows) {
      if (lines.length >= 8) break; // guard — don't overflow the section
      lines.push(buildStyledPanelLine(width, [
        { text: lbl, fg: C.label },
        { text: fmtTok(val), fg: color, bold: lbl.includes('Total') },
      ]));
    }

    // Inline cost estimate — absorbed pricing wiring (cost-utils.ts), shown
    // whenever the active model id is known.
    if (this.getCurrentModelId) {
      const modelId = this.getCurrentModelId();
      const priced = isModelPriced(modelId);
      const cost = calcSessionCost(u.input, u.output, u.cacheRead, u.cacheWrite, modelId);
      // Dollars carry their source; an unknown price renders the explicit
      // marker (never $0.00) and names the one-key fix on the cost panel.
      const source = priced ? describePricingSource(modelId) : null;
      lines.push(buildStyledPanelLine(width, [
        { text: '  Cost:       ', fg: C.label },
        { text: priced ? `$${cost.toFixed(4)}` : 'price unknown', fg: C.value, bold: true },
        ...(priced && source
          ? [{ text: ` (${source})`, fg: C.dim }]
          : priced
            ? []
            : [{ text: ' — set it with p on the cost panel', fg: C.dim }]),
      ]));
    }

    return lines;
  }

  /** Last N turns table: turn#, in, out, CR, CW, total. */
  private renderTurnHistory(width: number, maxRows: number): Line[] {
    const available = Math.max(0, maxRows - 1); // minus col header
    const toShow = this.turnHistory.slice(-Math.max(0, available));

    // Width-aware aligned table via the shared primitive (replaces manual
    // per-cell column math, which miscounts on wide glyphs).
    return buildTable(
      width,
      [
        { label: '#', width: 4, align: 'right' },
        { label: 'Input', width: 9, align: 'right' },
        { label: 'Output', width: 9, align: 'right' },
        { label: 'CR', width: 7, align: 'right' },
        { label: 'CW', width: 7, align: 'right' },
        { label: 'Total', align: 'right' },
      ],
      toShow.map((t, i) => {
        const turnNum = this.turnHistory.length - toShow.length + i + 1;
        const total = t.input + t.output + t.cacheRead + t.cacheWrite;
        return {
          cells: [
            { text: String(turnNum), fg: C.dim },
            { text: fmtTok(t.input), fg: C.input },
            { text: fmtTok(t.output), fg: C.output },
            { text: fmtTok(t.cacheRead), fg: C.cacheRead },
            { text: fmtTok(t.cacheWrite), fg: C.cacheWrite },
            { text: fmtTok(total), fg: C.value },
          ],
        };
      }),
      { ...DEFAULT_PANEL_PALETTE, label: C.turnHeader },
    );
  }

  /** Paint a plain text string into a new Line. */
  private paintTextLine(
    text: string,
    width: number,
    fg: string,
    opts: { bold?: boolean; dim?: boolean } = {},
  ): Line {
    const line = createEmptyLine(width);
    let x = 0;
    for (const ch of text) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg, bold: opts.bold, dim: opts.dim });
    }
    return line;
  }
}
