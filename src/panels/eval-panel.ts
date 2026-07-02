/**
 * Eval Panel — renders evaluation harness results in list and detail modes.
 *
 * Displays suite run summaries, per-scenario scorecards, and regression
 * indicators. Wired with an EvalRegistry that holds the latest run results.
 */

import { join } from 'node:path';
import { BasePanel } from './base-panel.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import type { Line } from '../types/grid.ts';
import type { KeyName, PanelIntegrationContext } from './types.ts';
import { createEmptyLine } from '../types/grid.ts';
import {
  buildAlignedRow,
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
  EvalBaseline,
  RegressionEntry,
} from '@/runtime/index.ts';
import { loadBaseline } from '@/runtime/index.ts';
import { formatShortDuration } from '../utils/format-duration.ts';

const BASELINE_PATH = '.goodvibes/eval/baseline.json';

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
  private readonly _projectRoot: string;
  private _mode: 'list' | 'detail' = 'list';
  private _selectedSuiteIdx = 0;
  private _selectedScenarioIdx = 0;
  private _scrollOffset = 0;
  private _unsub: (() => void) | null = null;
  private _baseline: EvalBaseline | null = null;
  private _baselineLoading = false;

  public constructor(registry: EvalRegistry, projectRoot = '.') {
    super('eval', 'Eval', 'V', 'monitoring');
    this._registry = registry;
    this._projectRoot = projectRoot;
  }

  public override onActivate(): void {
    this._unsub = this._registry.subscribe(() => this.markDirty());
    this._loadBaselineIfNeeded();
    this.markDirty();
  }

  public override onDestroy(): void {
    this._unsub?.();
    this._unsub = null;
  }

  /**
   * Seed the panel with last-known scores from the on-disk baseline so a
   * fresh session shows real data instead of a "run a suite" signpost.
   * Only loaded once per activation; a live suite run supersedes it.
   *
   * Resolved as an absolute path under _projectRoot before handing it to
   * loadBaseline() — the SDK helper resolves a relative path against the
   * process cwd (not the projectRoot argument), so joining here is what
   * actually makes the constructor's projectRoot meaningful.
   */
  private _loadBaselineIfNeeded(): void {
    if (this._baseline || this._baselineLoading) return;
    this._baselineLoading = true;
    void loadBaseline(join(this._projectRoot, BASELINE_PATH), this._projectRoot)
      .then((baseline) => {
        this._baseline = baseline ?? null;
      })
      .catch(() => {
        this._baseline = null;
      })
      .finally(() => {
        this._baselineLoading = false;
        this.markDirty();
      });
  }

  /** Number of selectable rows in list mode: live suite results, or baseline suites when none have run yet. */
  private _listLength(suites: EvalSuiteResult[]): number {
    if (suites.length > 0) return suites.length;
    return this._baseline ? Object.keys(this._baseline.suites).length : 0;
  }

  /** Name of the suite currently selected in list mode, from live results or the baseline. */
  private _selectedSuiteName(suites: EvalSuiteResult[]): string | undefined {
    if (suites.length > 0) return suites[this._selectedSuiteIdx]?.suite;
    if (!this._baseline) return undefined;
    return Object.keys(this._baseline.suites)[this._selectedSuiteIdx];
  }

  /** Total scenario/detail line count for the given suite, used to clamp pagedown scrolling. */
  private _detailLineCount(suite: EvalSuiteResult): number {
    const gates = this._registry.getGateResults();
    const gate = gates.find((g) => g.suite === suite.suite);
    const regressedIds = new Set((gate?.regressions ?? []).map((r) => r.scenarioId));

    let count = 0;
    suite.results.forEach((result, idx) => {
      count += 1;
      if (idx === this._selectedScenarioIdx) {
        count += DIMENSION_ORDER.filter((dim) =>
          result.scorecard.dimensions.some((d) => d.dimension === dim),
        ).length;
        if (regressedIds.has(result.scenario.id)) count += 1;
        count += result.scorecard.notes?.length ?? 0;
      }
    });
    return count;
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
        const len = this._listLength(suites);
        this._selectedSuiteIdx = Math.min(Math.max(0, len - 1), this._selectedSuiteIdx + 1);
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
      const suite = suites[this._selectedSuiteIdx];
      const maxOffset = suite ? Math.max(0, this._detailLineCount(suite) - 1) : 0;
      this._scrollOffset = Math.min(maxOffset, this._scrollOffset + 5);
      this.markDirty();
      return true;
    }
    return false;
  }

  /**
   * Cross-panel integration hook: r runs the selected suite, R runs all
   * suites, both dispatched through the real /eval command executor rather
   * than a printed signpost. registry.setRunning()/push() (already wired in
   * src/input/commands/eval.ts) animate the in-panel state as the run proceeds.
   */
  public handlePanelIntegrationAction(key: string, ctx: PanelIntegrationContext): boolean {
    if (key !== 'r' && key !== 'R') return false;
    if (!ctx.executeCommand) return false;

    if (key === 'R') {
      void ctx.executeCommand('eval', ['run', 'all']).catch(() => {});
      return true;
    }

    const suites = this._registry.getSuiteResults();
    const suiteName = this._selectedSuiteName(suites);
    if (!suiteName) return false;
    void ctx.executeCommand('eval', ['run', suiteName]).catch(() => {});
    return true;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const suites = this._registry.getSuiteResults();
    const gates = this._registry.getGateResults();
    const intro = 'Evaluation harness runs, gates, scenario scorecards, and regression indicators for model and product validation.';

    if (suites.length === 0) {
      if (this._baseline && Object.keys(this._baseline.suites).length > 0) {
        const workspace = this._renderBaselineList(this._baseline, width, height, intro);
        while (workspace.length < height) workspace.push(createEmptyLine(width));
        return workspace;
      }

      const workspace = buildPanelWorkspace(width, height, {
        title: 'Eval Harness',
        intro,
        sections: [{
          title: 'Status',
          lines: [
            this._statusLine(width),
            buildPanelLine(width, [[' No results yet — no baseline on disk.', C.dim]]),
          ],
        }],
        footerLines: [buildKeyboardHints(width, [
          { keys: 'r', label: 'run selected suite' },
          { keys: 'R', label: 'run all suites' },
        ], C)],
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
        this._renderDetail(lines, suite, gates, width, height, intro);
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

      const gate = gateMap.get(selectedSuite.suite);
      if (gate && gate.regressions.length > 0) {
        const worst = [...gate.regressions].sort((a, b) => a.delta - b.delta)[0];
        const segments: Array<[string, string]> = [
          [' regressions ', C.label],
          [`${gate.regressions.length}`, C.bad],
        ];
        if (worst) {
          segments.push(['  worst ', C.label], [`${worst.scenarioName} ${worst.delta.toFixed(1)}`, C.bad]);
        }
        detailLines.push(buildPanelLine(width, segments));
      }
    }

    const footer = buildKeyboardHints(width, [
      { keys: `${this._selectedSuiteIdx + 1}/${suites.length}`, label: 'suite' },
      { keys: '↑/↓', label: 'navigate' },
      { keys: 'Enter', label: 'open detail' },
      { keys: 'r', label: 'run selected' },
      { keys: 'R', label: 'run all' },
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
    gates: EvalGateResult[],
    width: number,
    height: number,
    intro: string,
  ): void {
    const passCount = suite.results.filter((r) => r.scorecard.passed).length;
    const gate = gates.find((g) => g.suite === suite.suite);
    const regressionMap = new Map((gate?.regressions ?? []).map((r) => [r.scenarioId, r]));

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
    if (gate && gate.regressions.length > 0) {
      headerLines.push(buildPanelLine(width, [
        [' regressions ', C.label],
        [`${gate.regressions.length} scenario(s) below baseline`, C.bad],
      ]));
    }

    const allDetailLines: Line[] = [];
    suite.results.forEach((result, idx) => {
      const selected = idx === this._selectedScenarioIdx;
      this._renderScenarioBlock(allDetailLines, result, selected, width, regressionMap.get(result.scenario.id));
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
    regression: RegressionEntry | undefined,
  ): void {
    const sc = result.scorecard;
    const scoreC = scoreColor(sc.compositeScore);
    const passC = sc.passed ? C.good : C.bad;
    const nameText = regression ? `▼ ${result.scenario.name}` : result.scenario.name;
    const nameColor = selected ? C.selected : (regression ? C.bad : C.value);

    lines.push(buildAlignedRow(
      width,
      [
        { text: nameText, fg: nameColor, bold: selected },
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

      if (regression) {
        lines.push(buildPanelLine(width, [
          ['    ▼ regression vs baseline ', C.bad],
          [`${regression.baselineScore.toFixed(1)} -> ${regression.freshScore.toFixed(1)} (${regression.delta >= 0 ? '+' : ''}${regression.delta.toFixed(1)})`, C.bad],
        ]));
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

  // ── Baseline-seeded list (no live suite results yet) ─────────────────────────

  private _renderBaselineList(
    baseline: EvalBaseline,
    width: number,
    height: number,
    intro: string,
  ): Line[] {
    const entries = Object.entries(baseline.suites);

    const tableRows = entries.map(([name, summary], idx) => {
      const selected = idx === this._selectedSuiteIdx;
      const scenarioCount = Object.keys(summary.scenarioScores).length;
      return {
        selected,
        cells: [
          { text: name, fg: selected ? C.selected : C.value, bold: selected },
          { text: summary.meanScore.toFixed(1), fg: scoreColor(summary.meanScore) },
          { text: `${scenarioCount}`, fg: C.dim },
        ],
      };
    });

    const tableLines = buildTable(width, [
      { label: 'Suite' },
      { label: 'Score', width: 7, align: 'right' },
      { label: 'Scenarios', width: 10, align: 'right' },
    ], tableRows, C, { selectedBg: C.selectBg });

    const footer = buildKeyboardHints(width, [
      { keys: `${entries.length > 0 ? this._selectedSuiteIdx + 1 : 0}/${entries.length}`, label: 'suite' },
      { keys: '↑/↓', label: 'navigate' },
      { keys: 'r', label: 'run selected' },
      { keys: 'R', label: 'run all' },
    ], C);

    return buildPanelWorkspace(width, height, {
      title: 'Eval Harness',
      intro,
      sections: [
        { lines: [this._statusLine(width)] },
        {
          title: `Baseline · ${baseline.label} (captured ${new Date(baseline.capturedAt).toLocaleString()})`,
          lines: tableLines,
        },
      ],
      footerLines: [footer],
      palette: C,
    });
  }
}
