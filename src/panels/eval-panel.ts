/**
 * Eval Panel — renders evaluation harness results in list and detail modes.
 *
 * Displays suite run summaries, per-scenario scorecards, and regression
 * indicators. Wired with an EvalRegistry that holds the latest run results.
 */

import { BasePanel } from './base-panel.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import type { Line } from '../types/grid.ts';
import type { KeyName } from './types.ts';
import { createEmptyLine } from '../types/grid.ts';
import {
  buildAlignedRow,
  buildEmptyState,
  buildKeyboardHints,
  buildMeterLine,
  buildPanelLine,
  buildPanelWorkspace,
  buildTable,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
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

// ── Colour palette (no inline hex in render bodies) ──────────────────────────

// Domain accents only; base chrome (header/headerBg/info/good/warn/bad/
// value/selectBg) comes from DEFAULT_PANEL_PALETTE.
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  selected: '#f1f5f9',   // emphasized row/text highlight, brighter than value
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 80) return C.good;
  if (score >= 60) return C.warn;
  return C.bad;
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

    if (suites.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Eval Harness',
        intro,
        sections: [{
          title: 'Status',
          lines: [
            this._statusLine(width),
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
      this._renderList(lines, suites, gates, width, height, intro);
    } else {
      const suite = suites[this._selectedSuiteIdx];
      if (suite) {
        this._renderDetail(lines, suite, width, height, intro);
      }
    }

    return lines;
  }

  // ── Shared summary line ───────────────────────────────────────────────────

  private _statusLine(width: number): Line {
    const running = this._registry.isRunning();
    const lastRun = this._registry.getLastRunAt();
    const suites = this._registry.getSuiteResults();
    const passed = suites.filter((s) => s.passed).length;
    const failed = suites.length - passed;
    return buildPanelLine(width, [
      ['  state ', C.label],
      [running ? 'running' : 'idle', running ? C.warn : C.dim],
      ['  passed ', C.label],
      [String(passed), passed > 0 ? C.good : C.dim],
      ['  failed ', C.label],
      [String(failed), failed > 0 ? C.bad : C.dim],
      ['  last ', C.label],
      [lastRun ? new Date(lastRun).toLocaleTimeString() : 'n/a', C.dim],
    ]);
  }

  // ── List view ────────────────────────────────────────────────────────────────

  private _renderList(
    lines: Line[],
    suites: EvalSuiteResult[],
    gates: EvalGateResult[],
    width: number,
    height: number,
    intro: string,
  ): void {
    const gateMap = new Map(gates.map((g) => [g.suite, g]));

    const tableRows = suites.map((suite, idx) => {
      const selected = idx === this._selectedSuiteIdx;
      const gate = gateMap.get(suite.suite);
      const gateStr = gate ? (gate.passed ? 'ok' : 'FAIL') : '-';
      const gateColor = gate ? (gate.passed ? C.good : C.bad) : C.dim;
      const durationMs = suite.finishedAt - suite.startedAt;
      return {
        selected,
        cells: [
          { text: suite.suite, fg: selected ? C.selected : C.value, bold: selected },
          { text: suite.meanScore.toFixed(1), fg: scoreColor(suite.meanScore) },
          { text: suite.passed ? 'PASS' : 'FAIL', fg: suite.passed ? C.good : C.bad },
          { text: gateStr, fg: gateColor },
          { text: fmtTime(durationMs), fg: C.dim },
        ],
      };
    });

    const tableLines = buildTable(width, [
      { label: 'Suite' },
      { label: 'Score', width: 7, align: 'right' },
      { label: 'Pass', width: 6 },
      { label: 'Gate', width: 6 },
      { label: 'Duration', width: 10, align: 'right' },
    ], tableRows, C, { selectedBg: C.selectBg });

    const selectedSuite = suites[this._selectedSuiteIdx];
    const detailLines: Line[] = [];
    if (selectedSuite) {
      const passCount = selectedSuite.results.filter((r) => r.scorecard.passed).length;
      detailLines.push(buildPanelLine(width, [
        [' selected ', C.label],
        [selectedSuite.suite, C.info],
        ['  scenarios ', C.label],
        [`${passCount}/${selectedSuite.results.length} passed`, passCount === selectedSuite.results.length ? C.good : C.warn],
      ]));
      const meterW = Math.max(10, Math.min(30, width - 24));
      detailLines.push(buildMeterLine(width, Math.round((selectedSuite.meanScore / 100) * meterW), meterW, {
        filled: scoreColor(selectedSuite.meanScore),
        empty: C.empty,
        label: C.label,
      }, { prefix: ' mean ', suffix: ` ${selectedSuite.meanScore.toFixed(1)}/100 ` }));
    }

    const footer = buildKeyboardHints(width, [
      { keys: `${this._selectedSuiteIdx + 1}/${suites.length}`, label: 'suite' },
      { keys: '↑/↓', label: 'navigate' },
      { keys: 'Enter', label: 'open detail' },
    ], C);

    lines.push(...buildPanelWorkspace(width, height, {
      title: 'Eval Harness',
      intro,
      sections: [
        { lines: [this._statusLine(width)] },
        { title: 'Suites', lines: tableLines },
        ...(detailLines.length > 0 ? [{ title: 'Selected Suite', lines: detailLines }] : []),
      ],
      footerLines: [footer],
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
  ): void {
    const passCount = suite.results.filter((r) => r.scorecard.passed).length;
    const headerLines: Line[] = [
      this._statusLine(width),
      buildPanelLine(width, [
        [' suite ', C.label],
        [suite.suite, C.info],
        ['  mean ', C.label],
        [suite.meanScore.toFixed(1), scoreColor(suite.meanScore)],
        ['  ', C.label],
        [suite.passed ? 'PASS' : 'FAIL', suite.passed ? C.good : C.bad],
        ['  scenarios ', C.label],
        [`${passCount}/${suite.results.length} passed`, passCount === suite.results.length ? C.good : C.warn],
      ]),
    ];

    const allDetailLines: Line[] = [];
    suite.results.forEach((result, idx) => {
      const selected = idx === this._selectedScenarioIdx;
      this._renderScenarioBlock(allDetailLines, result, selected, width);
    });

    const footer = buildKeyboardHints(width, [
      { keys: `${this._selectedScenarioIdx + 1}/${suite.results.length}`, label: 'scenario' },
      { keys: 'Esc', label: 'back' },
      { keys: '↑/↓', label: 'navigate' },
      { keys: 'PgUp/PgDn', label: 'scroll' },
    ], C);

    const detailSection = resolveScrollablePanelSection(width, height, {
      intro,
      footerLines: [footer],
      palette: C,
      beforeSections: [{ title: `Scenario Detail · ${suite.suite}`, lines: headerLines }],
      section: {
        scrollableLines: allDetailLines,
        scrollOffset: this._scrollOffset,
        minRows: 1,
        appendWindowSummary: { dimColor: C.dim },
      },
    });
    this._scrollOffset = detailSection.scrollOffset;

    lines.push(...buildPanelWorkspace(width, height, {
      title: 'Eval Harness',
      intro,
      sections: [{ title: `Scenario Detail · ${suite.suite}`, lines: [...headerLines, ...detailSection.section.lines] }],
      footerLines: [footer],
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
    const scoreC = scoreColor(sc.compositeScore);
    const passC = sc.passed ? C.good : C.bad;

    lines.push(buildAlignedRow(
      width,
      [
        { text: result.scenario.name, fg: selected ? C.selected : C.value, bold: selected },
        { text: sc.compositeScore.toFixed(1), fg: scoreC },
        { text: sc.passed ? 'PASS' : 'FAIL', fg: passC },
      ],
      [
        { width: Math.max(8, width - 16) },
        { width: 6, align: 'right' },
        { width: 5 },
      ],
      { gap: 1, selected, selectedBg: C.selectBg, marker: '▸' },
    ));

    if (selected) {
      for (const dim of DIMENSION_ORDER) {
        const d = sc.dimensions.find((x) => x.dimension === dim);
        if (!d) continue;
        const filled = Math.round(d.score / 10);
        lines.push(buildMeterLine(width, filled, 10, {
          filled: scoreColor(d.score),
          empty: C.empty,
          label: C.label,
        }, { prefix: `    ${dim.padEnd(9)} `, suffix: ` ${d.score.toFixed(0).padStart(3)}/100 ` }));
      }

      if (sc.notes && sc.notes.length > 0) {
        for (const note of sc.notes) {
          lines.push(buildPanelLine(width, [
            ['    ! ', C.warn],
            [truncateDisplay(note, Math.max(8, width - 6)), C.warn],
          ]));
        }
      }
    }
  }
}
