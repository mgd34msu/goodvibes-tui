/**
 * Eval Panel — renders evaluation harness results in list and detail modes.
 *
 * Displays suite run summaries, per-scenario scorecards, and regression
 * indicators. Wired with an EvalRegistry that holds the latest run results.
 */

import { BasePanel } from './base-panel.ts';
import type { Line } from '../types/grid.ts';
import type { KeyName } from './types.ts';
import { createEmptyLine } from '../types/grid.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';

// ── EvalRegistry ─────────────────────────────────────────────────────────────

import type {
  EvalSuiteResult,
  EvalResult,
  EvalGateResult,
  EvalDimension,
} from '@/runtime/index.ts';
import { formatShortDuration } from '../utils/format-duration.ts';

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
  ...DEFAULT_PANEL_PALETTE,
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
  selectBg: '#0f172a',
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 80) return C.green;
  if (score >= 60) return C.yellow;
  return C.red;
}

function fmtTime(ms: number): string {
  return formatShortDuration(ms);
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

  public handleInput(key: KeyName): boolean {
    const suites = this._registry.getSuiteResults();

    if (this._mode === 'list') {
      if (key === 'up' || key === 'k') {
        this._selectedSuiteIdx = Math.max(0, this._selectedSuiteIdx - 1);
        this.markDirty();
        return true;
      }
      if (key === 'down' || key === 'j') {
        this._selectedSuiteIdx = Math.min(suites.length - 1, this._selectedSuiteIdx + 1);
        this.markDirty();
        return true;
      }
      if ((key === 'enter' || key === 'return' || key === 'l') && suites.length > 0) {
        this._mode = 'detail';
        this._selectedScenarioIdx = 0;
        this._scrollOffset = 0;
        this.markDirty();
        return true;
      }
      return false;
    }

    // detail mode
    if (key === 'escape' || key === 'q' || key === 'h') {
      this._mode = 'list';
      this.markDirty();
      return true;
    }
    if (key === 'up' || key === 'k') {
      const suite = suites[this._selectedSuiteIdx];
      if (suite) {
        this._selectedScenarioIdx = Math.max(0, this._selectedScenarioIdx - 1);
        this._scrollOffset = 0;
        this.markDirty();
      }
      return true;
    }
    if (key === 'down' || key === 'j') {
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
    if (key === 'pageup') {
      this._scrollOffset = Math.max(0, this._scrollOffset - 5);
      this.markDirty();
      return true;
    }
    if (key === 'pagedown') {
      this._scrollOffset += 5;
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const suites = this._registry.getSuiteResults();
    const gates = this._registry.getGateResults();
    const intro = 'Evaluation harness runs, gates, scenario scorecards, and regression indicators for model and product validation.';

    const running = this._registry.isRunning();
    const lastRun = this._registry.getLastRunAt();
    const summaryLine = buildPanelLine(width, [
      ['  state: ', C.label],
      [running ? 'running' : 'idle', running ? C.yellow : C.dim],
      ['  last: ', C.label],
      [lastRun ? new Date(lastRun).toLocaleTimeString() : 'n/a', C.dim],
    ]);

    if (suites.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Eval Harness',
        intro,
        sections: [{
          title: 'Status',
          lines: [
            summaryLine,
            ...buildEmptyState(
              width,
              ' No results yet.',
              'Run an eval suite to populate this workspace with suite scores, gate results, and per-scenario detail.',
              [{ command: '/eval run <suite>', summary: 'start a suite such as core-performance, safety-baseline, or cost-tokens' }],
              C,
            ),
          ],
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const lines: Line[] = [];
    if (this._mode === 'list') {
      this._renderList(lines, suites, gates, width, height, intro, summaryLine);
    } else {
      const suite = suites[this._selectedSuiteIdx];
      if (suite) {
        this._renderDetail(lines, suite, width, height, intro, summaryLine);
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
    intro: string,
    summaryLine: Line,
  ): void {
    const gateMap = new Map(gates.map((g) => [g.suite, g]));
    const sectionLines: Line[] = [
      summaryLine,
      buildPanelLine(width, [
      ['Suite'.padEnd(28), C.header],
      ['Score'.padEnd(8), C.header],
      ['Pass'.padEnd(6), C.header],
      ['Gate'.padEnd(6), C.header],
      ['Duration', C.header],
      ]),
    ];

    suites.forEach((suite, idx) => {
      const selected = idx === this._selectedSuiteIdx;
      const gate = gateMap.get(suite.suite);
      const gateStr = gate ? (gate.passed ? 'ok' : 'FAIL') : '-';
      const gateColor = gate ? (gate.passed ? C.green : C.red) : C.dim;
      const durationMs = suite.finishedAt - suite.startedAt;
      const scoreC = scoreColor(suite.meanScore);
      const passC = suite.passed ? C.green : C.red;
      const nameColor = selected ? C.selected : C.white;
      const bg = selected ? C.selectBg : undefined;
      const prefix = selected ? '▸ ' : '  ';
      const name = suite.suite.slice(0, 24).padEnd(26);

      sectionLines.push(buildPanelLine(width, [
        [prefix + name, nameColor, bg],
        [suite.meanScore.toFixed(1).padEnd(8), scoreC, bg],
        [(suite.passed ? 'PASS' : 'FAIL').padEnd(6), passC, bg],
        [gateStr.padEnd(6), gateColor, bg],
        [fmtTime(durationMs), C.dim, bg],
      ]));
    });

    sectionLines.push(buildPanelLine(width, [[' Enter/l: detail  j/k: navigate', C.dim]]));
    lines.push(...buildPanelWorkspace(width, _height, {
      title: 'Eval Harness',
      intro,
      sections: [{ title: 'Suites', lines: sectionLines }],
      palette: C,
    }));
  }

  // ── Detail view ──────────────────────────────────────────────────────────────

  private _renderDetail(
    lines: Line[],
    suite: EvalSuiteResult,
    width: number,
    height: number,
    intro: string,
    summaryLine: Line,
  ): void {
    const sectionLines: Line[] = [
      summaryLine,
      buildPanelLine(width, [
      [`Suite: ${suite.suite}`, C.cyan],
      ['  mean=', C.label],
      [suite.meanScore.toFixed(1), scoreColor(suite.meanScore)],
      ['  ', C.label],
      [suite.passed ? 'PASS' : 'FAIL', suite.passed ? C.green : C.red],
      ]),
    ];

    const allDetailLines: Line[] = [];
    suite.results.forEach((result, idx) => {
      const selected = idx === this._selectedScenarioIdx;
      this._renderScenarioBlock(allDetailLines, result, selected, width);
    });

    const detailSection = resolveScrollablePanelSection(width, height, {
      intro,
      palette: C,
      beforeSections: [{ title: 'Scenario Detail', lines: sectionLines }],
      section: {
        scrollableLines: allDetailLines,
        scrollOffset: this._scrollOffset,
        minRows: 1,
      },
    });
    this._scrollOffset = detailSection.scrollOffset;
    sectionLines.push(...detailSection.section.lines);
    sectionLines.push(buildPanelLine(width, [[' Esc/q: back  j/k: scenario  PgUp/PgDn: scroll', C.dim]]));
    lines.push(...buildPanelWorkspace(width, height, {
      title: 'Eval Harness',
      intro,
      sections: [{ title: 'Scenario Detail', lines: sectionLines }],
      palette: C,
    }));
  }

  private _renderScenarioBlock(
    lines: Line[],
    result: EvalResult,
    selected: boolean,
    width: number,
  ): void {
    const sc = result.scorecard;
    const prefix = selected ? '▸ ' : '  ';
    const nameColor = selected ? C.selected : C.white;
    const scoreC = scoreColor(sc.compositeScore);
    const passC = sc.passed ? C.green : C.red;
    const nameLen = Math.max(1, width - 22);

    lines.push(buildPanelLine(width, [
      [prefix + result.scenario.name.slice(0, nameLen).padEnd(nameLen + 2), nameColor, selected ? C.selectBg : undefined],
      [sc.compositeScore.toFixed(1).padStart(5), scoreC, selected ? C.selectBg : undefined],
      ['  ', C.label, selected ? C.selectBg : undefined],
      [sc.passed ? 'PASS' : 'FAIL', passC, selected ? C.selectBg : undefined],
    ]));

    if (selected) {
      for (const dim of DIMENSION_ORDER) {
        const d = sc.dimensions.find((x) => x.dimension === dim);
        if (!d) continue;
        const filled = Math.round(d.score / 10);
        const bar = '#'.repeat(filled) + '.'.repeat(10 - filled);
        lines.push(buildPanelLine(width, [
          ['    ' + dim.padEnd(10) + ' ', C.label],
          [bar, scoreColor(d.score)],
          [` ${d.score.toFixed(0).padStart(3)}/100`, C.value],
        ]));
      }

      if (sc.notes && sc.notes.length > 0) {
        for (const note of sc.notes) {
          lines.push(buildPanelLine(width, [
            ['    ! ', C.yellow],
            [note.slice(0, width - 6), C.yellow],
          ]));
        }
      }
    }
  }
}
