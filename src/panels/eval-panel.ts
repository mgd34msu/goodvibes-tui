/**
 * Eval Panel — renders evaluation harness results in list and detail modes.
 *
 * Displays suite run summaries, per-scenario scorecards, and regression
 * indicators. Wired with an EvalRegistry that holds the latest run results.
 */

import { BasePanel } from './base-panel.ts';
import type { Line, Cell } from '../types/grid.ts';
import { createStyledCell } from '../types/grid.ts';

// ── EvalRegistry ─────────────────────────────────────────────────────────────

import type {
  EvalSuiteResult,
  EvalResult,
  EvalGateResult,
  EvalDimension,
} from '../runtime/eval/types.ts';

/**
 * Holds the latest eval run state for display in EvalPanel.
 * Created externally, injected into the panel.
 */
export class EvalRegistry {
  private _suiteResults: EvalSuiteResult[] = [];
  private _gateResults: EvalGateResult[] = [];
  private _running = false;
  private _lastRunAt: number | null = null;
  private readonly _subscribers = new Set<() => void>();

  push(result: EvalSuiteResult): void {
    const idx = this._suiteResults.findIndex((r) => r.suite === result.suite);
    if (idx >= 0) {
      this._suiteResults[idx] = result;
    } else {
      this._suiteResults.push(result);
    }
    this._lastRunAt = Date.now();
    this._notify();
  }

  pushGate(gate: EvalGateResult): void {
    const idx = this._gateResults.findIndex((g) => g.suite === gate.suite);
    if (idx >= 0) {
      this._gateResults[idx] = gate;
    } else {
      this._gateResults.push(gate);
    }
    this._notify();
  }

  setRunning(running: boolean): void {
    this._running = running;
    this._notify();
  }

  isRunning(): boolean { return this._running; }
  getLastRunAt(): number | null { return this._lastRunAt; }
  getSuiteResults(): EvalSuiteResult[] { return this._suiteResults; }
  getGateResults(): EvalGateResult[] { return this._gateResults; }

  subscribe(cb: () => void): () => void {
    this._subscribers.add(cb);
    return () => this._subscribers.delete(cb);
  }

  private _notify(): void {
    for (const cb of this._subscribers) cb();
  }
}

// ── Colour palette (hex fg colours for createStyledCell) ─────────────────────

const C = {
  header:   '#94a3b8',
  headerBg: '#1e293b',
  cyan:     '#38bdf8',
  green:    '#22c55e',
  yellow:   '#eab308',
  red:      '#ef4444',
  dim:      '#4b5563',
  label:    '#64748b',
  value:    '#e2e8f0',
  selected: '#f1f5f9',
  sep:      '#1e293b',
  white:    '#cbd5e1',
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a Line (Cell[]) from [text, fg, bg?] segments, padding to width. */
function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells: Cell[] = [];
  let used = 0;
  for (const [text, fg, bg] of segments) {
    if (text.length === 0) continue;
    cells.push(createStyledCell(text, { fg, bg: bg ?? '' }));
    used += text.length;
  }
  if (used < width) {
    cells.push(createStyledCell(' '.repeat(width - used), { fg: '' }));
  }
  return cells;
}

function sep(width: number): Line {
  return buildLine(width, [['─'.repeat(width), C.sep]]);
}

function scoreColor(score: number): string {
  if (score >= 80) return C.green;
  if (score >= 60) return C.yellow;
  return C.red;
}

function fmtTime(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const DIMENSION_ORDER: EvalDimension[] = ['safety', 'quality', 'latency', 'cost', 'recovery'];

// ── EvalPanel ─────────────────────────────────────────────────────────────────

export class EvalPanel extends BasePanel {
  private readonly _registry: EvalRegistry;
  private _mode: 'list' | 'detail' = 'list';
  private _selectedSuiteIdx = 0;
  private _selectedScenarioIdx = 0;
  private _scrollOffset = 0;
  private _unsub: (() => void) | null = null;

  public constructor(registry: EvalRegistry) {
    super('eval', 'Eval', 'V', 'monitoring');
    this._registry = registry;
  }

  public override onActivate(): void {
    this._unsub = this._registry.subscribe(() => this.markDirty());
    this.markDirty();
  }

  public override onDestroy(): void {
    this._unsub?.();
    this._unsub = null;
  }

  public handleInput(key: string): boolean {
    const suites = this._registry.getSuiteResults();

    if (this._mode === 'list') {
      if (key === 'ArrowUp' || key === 'k') {
        this._selectedSuiteIdx = Math.max(0, this._selectedSuiteIdx - 1);
        this.markDirty();
        return true;
      }
      if (key === 'ArrowDown' || key === 'j') {
        this._selectedSuiteIdx = Math.min(suites.length - 1, this._selectedSuiteIdx + 1);
        this.markDirty();
        return true;
      }
      if ((key === 'Enter' || key === 'Return' || key === 'l') && suites.length > 0) {
        this._mode = 'detail';
        this._selectedScenarioIdx = 0;
        this._scrollOffset = 0;
        this.markDirty();
        return true;
      }
      return false;
    }

    // detail mode
    if (key === 'Escape' || key === 'q' || key === 'h') {
      this._mode = 'list';
      this.markDirty();
      return true;
    }
    if (key === 'ArrowUp' || key === 'k') {
      const suite = suites[this._selectedSuiteIdx];
      if (suite) {
        this._selectedScenarioIdx = Math.max(0, this._selectedScenarioIdx - 1);
        this._scrollOffset = 0;
        this.markDirty();
      }
      return true;
    }
    if (key === 'ArrowDown' || key === 'j') {
      const suite = suites[this._selectedSuiteIdx];
      if (suite) {
        this._selectedScenarioIdx = Math.min(
          suite.results.length - 1,
          this._selectedScenarioIdx + 1,
        );
        this._scrollOffset = 0;
        this.markDirty();
      }
      return true;
    }
    if (key === 'PageUp') {
      this._scrollOffset = Math.max(0, this._scrollOffset - 5);
      this.markDirty();
      return true;
    }
    if (key === 'PageDown') {
      this._scrollOffset += 5;
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    const suites = this._registry.getSuiteResults();
    const gates = this._registry.getGateResults();

    // Header
    const running = this._registry.isRunning();
    const lastRun = this._registry.getLastRunAt();
    const headerSegs: Array<[string, string, string?]> = [
      ['Eval Harness', C.cyan, C.headerBg],
    ];
    if (running) headerSegs.push(['  [running...]', C.yellow]);
    if (lastRun) headerSegs.push([`  last: ${new Date(lastRun).toLocaleTimeString()}`, C.dim]);
    lines.push(buildLine(width, headerSegs));
    lines.push(sep(width));

    if (suites.length === 0) {
      lines.push(buildLine(width, [['No results — run /eval run <suite> to start.', C.dim]]));
      lines.push(buildLine(width, [['Suites: core-performance, safety-baseline, cost-tokens', C.label]]));
      return lines;
    }

    if (this._mode === 'list') {
      this._renderList(lines, suites, gates, width, height);
    } else {
      const suite = suites[this._selectedSuiteIdx];
      if (suite) {
        this._renderDetail(lines, suite, width, height);
      }
    }

    return lines;
  }

  // ── List view ────────────────────────────────────────────────────────────────

  private _renderList(
    lines: Line[],
    suites: EvalSuiteResult[],
    gates: EvalGateResult[],
    width: number,
    _height: number,
  ): void {
    const gateMap = new Map(gates.map((g) => [g.suite, g]));

    lines.push(buildLine(width, [
      ['Suite'.padEnd(28), C.header],
      ['Score'.padEnd(8), C.header],
      ['Pass'.padEnd(6), C.header],
      ['Gate'.padEnd(6), C.header],
      ['Duration', C.header],
    ]));
    lines.push(sep(width));

    suites.forEach((suite, idx) => {
      const selected = idx === this._selectedSuiteIdx;
      const gate = gateMap.get(suite.suite);
      const gateStr = gate ? (gate.passed ? 'ok' : 'FAIL') : '-';
      const gateColor = gate ? (gate.passed ? C.green : C.red) : C.dim;
      const durationMs = suite.finishedAt - suite.startedAt;
      const scoreC = scoreColor(suite.meanScore);
      const passC = suite.passed ? C.green : C.red;
      const nameColor = selected ? C.selected : C.white;
      const prefix = selected ? '> ' : '  ';
      const name = suite.suite.slice(0, 24).padEnd(26);

      lines.push(buildLine(width, [
        [prefix + name, nameColor],
        [suite.meanScore.toFixed(1).padEnd(8), scoreC],
        [(suite.passed ? 'PASS' : 'FAIL').padEnd(6), passC],
        [gateStr.padEnd(6), gateColor],
        [fmtTime(durationMs), C.dim],
      ]));
    });

    lines.push(sep(width));
    lines.push(buildLine(width, [['Enter/l: detail  j/k: navigate', C.dim]]));
  }

  // ── Detail view ──────────────────────────────────────────────────────────────

  private _renderDetail(
    lines: Line[],
    suite: EvalSuiteResult,
    width: number,
    height: number,
  ): void {
    lines.push(buildLine(width, [
      [`Suite: ${suite.suite}`, C.cyan],
      ['  mean=', C.label],
      [suite.meanScore.toFixed(1), scoreColor(suite.meanScore)],
      ['  ', C.label],
      [suite.passed ? 'PASS' : 'FAIL', suite.passed ? C.green : C.red],
    ]));
    lines.push(sep(width));

    const allDetailLines: Line[] = [];
    suite.results.forEach((result, idx) => {
      const selected = idx === this._selectedScenarioIdx;
      this._renderScenarioBlock(allDetailLines, result, selected, width);
    });

    // Scroll window
    const maxVisible = Math.max(1, height - lines.length - 2);
    const visible = allDetailLines.slice(this._scrollOffset, this._scrollOffset + maxVisible);
    for (const l of visible) lines.push(l);

    lines.push(sep(width));
    lines.push(buildLine(width, [['Esc/q: back  j/k: scenario  PgUp/PgDn: scroll', C.dim]]));
  }

  private _renderScenarioBlock(
    lines: Line[],
    result: EvalResult,
    selected: boolean,
    width: number,
  ): void {
    const sc = result.scorecard;
    const prefix = selected ? '> ' : '  ';
    const nameColor = selected ? C.selected : C.white;
    const scoreC = scoreColor(sc.compositeScore);
    const passC = sc.passed ? C.green : C.red;
    const nameLen = Math.max(1, width - 22);

    lines.push(buildLine(width, [
      [prefix + result.scenario.name.slice(0, nameLen).padEnd(nameLen + 2), nameColor],
      [sc.compositeScore.toFixed(1).padStart(5), scoreC],
      ['  ', C.label],
      [sc.passed ? 'PASS' : 'FAIL', passC],
    ]));

    if (selected) {
      for (const dim of DIMENSION_ORDER) {
        const d = sc.dimensions.find((x) => x.dimension === dim);
        if (!d) continue;
        const filled = Math.round(d.score / 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        lines.push(buildLine(width, [
          ['    ' + dim.padEnd(10) + ' ', C.label],
          [bar, scoreColor(d.score)],
          [` ${d.score.toFixed(0).padStart(3)}/100`, C.value],
        ]));
      }

      if (sc.notes && sc.notes.length > 0) {
        for (const note of sc.notes) {
          lines.push(buildLine(width, [
            ['    ! ', C.yellow],
            [note.slice(0, width - 6), C.yellow],
          ]));
        }
      }
    }
  }
}
