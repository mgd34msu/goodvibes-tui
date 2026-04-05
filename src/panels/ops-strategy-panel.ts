/**
 * Ops Strategy Timeline Panel.
 *
 * Renders the Adaptive Execution Planner state: current strategy, reason
 * code, mode, override status, and a scrollable history of past decisions.
 *
 * Registered as panel id 'ops' in builtin-panels.
 */

import { BasePanel } from './base-panel.ts';
import type { Line } from '../types/grid.ts';
import { createStyledCell } from '../types/grid.ts';
import type { RuntimeEventBus, PlannerEvent } from '../runtime/events/index.ts';
import { adaptivePlanner } from '../core/adaptive-planner-instance.ts';
import type { PlannerDecision, ExecutionStrategy } from '../core/adaptive-planner.ts';

// ---------------------------------------------------------------------------
// Cell rendering helpers — follows the WrfcPanel pattern
// ---------------------------------------------------------------------------

const STRATEGY_FG: Record<ExecutionStrategy, string> = {
  auto:       '#00cccc',
  single:     '#00cc66',
  cohort:     '#cccc00',
  background: '#cc66cc',
  remote:     '#cccccc',
};

const STRATEGY_ICON: Record<ExecutionStrategy, string> = {
  auto:       '\u27f3', // ⟳
  single:     '\u25b6', // ▶
  cohort:     '\u25c8', // ◈
  background: '\u231b', // ⌛
  remote:     '\u21dd', // ⇝
};

function makeLine(
  text: string,
  width: number,
  opts: { fg?: string; bg?: string; bold?: boolean; dim?: boolean } = {},
): Line {
  const line: Line = [];
  const chars = [...text]; // unicode-safe split
  for (let i = 0; i < width; i++) {
    const ch = i < chars.length ? (chars[i] ?? ' ') : ' ';
    line.push(createStyledCell(ch, {
      fg:   opts.fg   ?? '',
      bg:   opts.bg   ?? '',
      bold: opts.bold ?? false,
      dim:  opts.dim  ?? false,
    }));
  }
  return line;
}

interface Seg {
  text:  string;
  fg?:   string;
  bg?:   string;
  bold?: boolean;
  dim?:  boolean;
}

function makeSegLine(segs: Seg[], width: number): Line {
  const line: Line = [];
  for (const seg of segs) {
    for (const ch of [...seg.text]) {
      if (line.length >= width) break;
      line.push(createStyledCell(ch, {
        fg:   seg.fg   ?? '',
        bg:   seg.bg   ?? '',
        bold: seg.bold ?? false,
        dim:  seg.dim  ?? false,
      }));
    }
    if (line.length >= width) break;
  }
  while (line.length < width) {
    line.push(createStyledCell(' ', {}));
  }
  return line;
}

// ---------------------------------------------------------------------------
// OpsStrategyPanel
// ---------------------------------------------------------------------------

export class OpsStrategyPanel extends BasePanel {
  private unsubscribers: Array<() => void> = [];
  private scrollOffset = 0;
  private history: PlannerDecision[] = [];

  constructor(private readonly runtimeBus: RuntimeEventBus) {
    super('ops', 'Ops', 'O', 'agent');
  }

  override onActivate(): void {
    super.onActivate();
    this._syncHistory();
    this.unsubscribers.push(
      this.runtimeBus.on<Extract<PlannerEvent, { type: 'PLAN_STRATEGY_SELECTED' }>>('PLAN_STRATEGY_SELECTED', () => {
        this._syncHistory();
        this.markDirty();
      }),
      this.runtimeBus.on<Extract<PlannerEvent, { type: 'PLAN_STRATEGY_OVERRIDDEN' }>>('PLAN_STRATEGY_OVERRIDDEN', () => {
        this._syncHistory();
        this.markDirty();
      }),
    );
  }

  override onDestroy(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  handleInput(key: string): boolean {
    if (key === 'up' || key === 'k') {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.scrollOffset++;
      this.markDirty();
      return true;
    }
    if (key === 'g') {
      this.scrollOffset = 0;
      this.markDirty();
      return true;
    }
    if (key === 'G') {
      this.scrollOffset = Math.max(0, this.history.length - 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];

    // Header
    lines.push(makeLine(' Ops: Adaptive Execution Planner', width, { fg: '#00cccc', bold: true }));
    lines.push(makeLine('\u2500'.repeat(width), width, { dim: true }));

    // Status block
    const latest   = adaptivePlanner.getLatest();
    const mode     = adaptivePlanner.getMode();
    const override = adaptivePlanner.getOverride();

    lines.push(makeSegLine([
      { text: ' Mode:     ', dim: true },
      { text: mode.toUpperCase(), bold: true },
    ], width));

    if (override) {
      lines.push(makeSegLine([
        { text: ' Override: ', dim: true },
        { text: `${override.toUpperCase()} [ACTIVE]`, fg: '#cccc00', bold: true },
      ], width));
    } else {
      lines.push(makeLine(' Override: none', width, { dim: true }));
    }

    if (latest) {
      const fg   = STRATEGY_FG[latest.selected];
      const icon = STRATEGY_ICON[latest.selected];
      lines.push(makeSegLine([
        { text: ' Last:     ', dim: true },
        { text: `${icon} ${latest.selected.toUpperCase()}`, fg, bold: true },
      ], width));
      lines.push(makeLine(` Reason:   ${latest.reasonCode}`, width, { dim: true }));
    } else {
      lines.push(makeLine(' No decisions recorded yet.', width, { dim: true }));
    }

    lines.push(makeLine('\u2500'.repeat(width), width, { dim: true }));

    // History — scrollable section
    const headerRowCount = lines.length;
    const bodyHeight     = Math.max(1, height - headerRowCount);
    const historyLines   = this._renderHistory(width);
    const maxScroll      = Math.max(0, historyLines.length - bodyHeight);
    this.scrollOffset    = Math.min(this.scrollOffset, maxScroll);
    const slice          = historyLines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
    for (const l of slice) lines.push(l);

    // Pad to full height
    while (lines.length < height) {
      lines.push(makeLine('', width));
    }

    return lines.slice(0, height);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _syncHistory(): void {
    this.history = adaptivePlanner.getHistory(50);
  }

  private _renderHistory(width: number): Line[] {
    if (this.history.length === 0) {
      return [makeLine('  No history yet.', width, { dim: true })];
    }

    const lines: Line[] = [];
    lines.push(makeLine(' Decision History', width, { bold: true }));

    const reversed = [...this.history].reverse();
    for (let i = 0; i < reversed.length; i++) {
      const d    = reversed[i]!;
      const ts   = new Date(d.timestamp).toLocaleTimeString();
      const fg   = STRATEGY_FG[d.selected];
      const icon = STRATEGY_ICON[d.selected];
      const num  = String(i + 1).padStart(3);
      const overrideMark = d.overrideActive ? ' [O]' : '';

      // Row 1: index + icon + strategy + timestamp (right-aligned)
      const leftBase  = ` ${num}. ${icon} ${d.selected.toUpperCase()}${overrideMark}`;
      const rightText = `  ${ts}`;
      const pad       = Math.max(1, width - leftBase.length - rightText.length);
      lines.push(makeSegLine([
        { text: ` ${num}. `, dim: true },
        { text: `${icon} ${d.selected.toUpperCase()}`, fg, bold: true },
        { text: overrideMark, fg: '#cccc00' },
        { text: ' '.repeat(pad) },
        { text: rightText, dim: true },
      ], width));

      // Row 2: reason code
      lines.push(makeLine(`       ${d.reasonCode}`, width, { dim: true }));

      // Row 3+: top-2 scored candidates (auto mode only)
      if (!d.overrideActive && d.candidates.length > 1) {
        const top2 = d.candidates.slice(0, 2);
        for (const c of top2) {
          lines.push(makeSegLine([
            { text: '         ', dim: true },
            { text: c.strategy.padEnd(12), fg: STRATEGY_FG[c.strategy] },
            { text: ` score ${c.score}`, dim: true },
          ], width));
        }
      }
    }

    return lines;
  }
}
