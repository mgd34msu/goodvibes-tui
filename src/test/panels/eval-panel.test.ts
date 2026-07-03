/**
 * Regression tests for EvalPanel.
 *
 * Key handling is driven with the actual logical key names emitted by the
 * input tokenizer (see src/panels/types.ts KeyName) — 'up' / 'down' / 'enter'
 * / 'escape' / etc. — passed straight into handleInput, matching how every
 * other panel test in this suite exercises key handling. Panels never see
 * raw terminal escape sequences; the tokenizer layer already converts them
 * before handleInput is called, so there is no value in routing tests
 * through InputTokenizer just to get back to a logical name.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvalPanel, EvalRegistry } from '../../panels/eval-panel.ts';
import type { EvalSuiteResult, EvalGateResult } from '@/runtime/index.ts';
import { writeBaseline, captureBaseline } from '@/runtime/index.ts';
import type { PanelIntegrationContext } from '../../panels/types.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function linesText(panel: EvalPanel, w = 100, h = 30): string {
  return panel.render(w, h).flat().map((cell) => cell.char).join('');
}

function makeSuiteResult(suite: string, numScenarios = 2, meanScore = 82): EvalSuiteResult {
  const now = Date.now();
  return {
    suite,
    startedAt: now,
    finishedAt: now + 500,
    meanScore,
    passed: true,
    results: Array.from({ length: numScenarios }, (_, i) => ({
      scenario: {
        id: `${suite}-s${i}`,
        name: `Scenario ${i + 1}`,
        suite,
        description: '',
        tags: [],
        run: async () => ({ completed: true, durationMs: 0, safetyViolations: 0 }),
      },
      raw: { completed: true, durationMs: 100, safetyViolations: 0 },
      scorecard: {
        scenarioId: `${suite}-s${i}`,
        scenarioName: `Scenario ${i + 1}`,
        dimensions: [
          { dimension: 'safety' as const, score: 90, weight: 0.2, rationale: '' },
          { dimension: 'quality' as const, score: 80, weight: 0.2, rationale: '' },
        ],
        compositeScore: meanScore,
        passed: true,
      },
      startedAt: now,
      finishedAt: now + 100,
    })),
  };
}

function makeGateResult(suite: EvalSuiteResult, regressedScenarioIdx: number, delta = -12.5): EvalGateResult {
  const result = suite.results[regressedScenarioIdx]!;
  return {
    suite: suite.suite,
    passed: false,
    regressionThreshold: 5,
    fresh: suite,
    regressions: [{
      scenarioId: result.scenario.id,
      scenarioName: result.scenario.name,
      baselineScore: result.scorecard.compositeScore - delta,
      freshScore: result.scorecard.compositeScore,
      delta,
    }],
  };
}

function makeExecuteCommandCtx(): { ctx: PanelIntegrationContext; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  const ctx = {
    panelManager: {},
    executeCommand: async (name: string, args: string[]) => {
      calls.push([name, args]);
      return undefined;
    },
  } as unknown as PanelIntegrationContext;
  return { ctx, calls };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EvalPanel — logical key handling', () => {
  let registry: EvalRegistry;
  let panel: EvalPanel;

  beforeEach(() => {
    registry = new EvalRegistry();
    panel = new EvalPanel(registry);
    panel.onActivate();
  });

  test('up/down move selection in list mode', () => {
    registry.push(makeSuiteResult('suite-alpha'));
    registry.push(makeSuiteResult('suite-beta'));

    expect(panel.handleInput('down')).toBe(true);
    expect(panel['_selectedSuiteIdx']).toBe(1);

    expect(panel.handleInput('up')).toBe(true);
    expect(panel['_selectedSuiteIdx']).toBe(0);
  });

  test('j/k are accepted as vim-style aliases for down/up', () => {
    registry.push(makeSuiteResult('suite-alpha'));
    registry.push(makeSuiteResult('suite-beta'));

    expect(panel.handleInput('j')).toBe(true);
    expect(panel['_selectedSuiteIdx']).toBe(1);
    expect(panel.handleInput('k')).toBe(true);
    expect(panel['_selectedSuiteIdx']).toBe(0);
  });

  test('enter enters detail mode when suites are present', () => {
    registry.push(makeSuiteResult('suite-alpha'));

    expect(panel['_mode']).toBe('list');
    expect(panel.handleInput('enter')).toBe(true);
    expect(panel['_mode']).toBe('detail');
  });

  test('escape returns to list mode from detail mode', () => {
    registry.push(makeSuiteResult('suite-alpha'));

    panel.handleInput('enter');
    expect(panel['_mode']).toBe('detail');

    expect(panel.handleInput('escape')).toBe(true);
    expect(panel['_mode']).toBe('list');
  });

  test('up/down in detail mode navigate scenarios', () => {
    registry.push(makeSuiteResult('suite-alpha', 3));
    panel.handleInput('enter');

    expect(panel['_selectedScenarioIdx']).toBe(0);
    expect(panel.handleInput('down')).toBe(true);
    expect(panel['_selectedScenarioIdx']).toBe(1);
    expect(panel.handleInput('up')).toBe(true);
    expect(panel['_selectedScenarioIdx']).toBe(0);
  });

  test('enter key does nothing in list mode when no suites exist', () => {
    expect(panel.handleInput('enter')).toBe(false);
    expect(panel['_mode']).toBe('list');
  });

  test('pagedown scroll offset is clamped to the detail content length', () => {
    registry.push(makeSuiteResult('suite-alpha', 2));
    panel.handleInput('enter');

    // Selected scenario contributes: 1 row + 2 dimensions = 3 lines; the
    // unselected scenario contributes 1 row. Total detail line count = 4,
    // so scrollOffset must clamp at 3 (count - 1) no matter how many times
    // pagedown fires.
    for (let i = 0; i < 10; i++) {
      panel.handleInput('pagedown');
    }
    expect(panel['_scrollOffset']).toBeLessThanOrEqual(3);
    expect(panel['_scrollOffset']).toBeGreaterThanOrEqual(0);
  });

  test('pageup does not go below zero', () => {
    registry.push(makeSuiteResult('suite-alpha', 2));
    panel.handleInput('enter');
    panel.handleInput('pageup');
    expect(panel['_scrollOffset']).toBe(0);
  });
});

describe('EvalPanel — run dispatch (r / R)', () => {
  let registry: EvalRegistry;
  let panel: EvalPanel;

  beforeEach(() => {
    registry = new EvalRegistry();
    panel = new EvalPanel(registry);
    panel.onActivate();
  });

  test('r dispatches /eval run <selected suite> via ctx.executeCommand', () => {
    registry.push(makeSuiteResult('suite-alpha'));
    registry.push(makeSuiteResult('suite-beta'));
    panel.handleInput('down'); // select suite-beta

    const { ctx, calls } = makeExecuteCommandCtx();
    const consumed = panel.handlePanelIntegrationAction!('r', ctx);

    expect(consumed).toBe(true);
    expect(calls).toEqual([['eval', ['run', 'suite-beta']]]);
  });

  test('R dispatches /eval run all via ctx.executeCommand regardless of selection', () => {
    registry.push(makeSuiteResult('suite-alpha'));

    const { ctx, calls } = makeExecuteCommandCtx();
    const consumed = panel.handlePanelIntegrationAction!('R', ctx);

    expect(consumed).toBe(true);
    expect(calls).toEqual([['eval', ['run', 'all']]]);
  });

  test('other keys are not consumed by the integration hook', () => {
    const { ctx, calls } = makeExecuteCommandCtx();
    expect(panel.handlePanelIntegrationAction!('x', ctx)).toBe(false);
    expect(calls).toEqual([]);
  });

  test('r is a no-op when ctx has no executeCommand', () => {
    registry.push(makeSuiteResult('suite-alpha'));
    const ctx = { panelManager: {} } as unknown as PanelIntegrationContext;
    expect(panel.handlePanelIntegrationAction!('r', ctx)).toBe(false);
  });
});

describe('EvalPanel — regressions rendered in list and detail', () => {
  let registry: EvalRegistry;
  let panel: EvalPanel;

  beforeEach(() => {
    registry = new EvalRegistry();
    panel = new EvalPanel(registry);
    panel.onActivate();
  });

  test('list mode surfaces the regression count and worst-scenario delta for the selected suite', () => {
    const suite = makeSuiteResult('suite-alpha', 2);
    registry.push(suite);
    registry.pushGate(makeGateResult(suite, 0, -12.5));

    const text = linesText(panel);
    expect(text).toContain('regressions');
    expect(text).toContain('Scenario 1');
    expect(text).toContain('FAIL'); // gate column shows FAIL for a failed gate
  });

  test('detail mode marks the regressed scenario and shows baseline vs fresh scores when selected', () => {
    const suite = makeSuiteResult('suite-alpha', 2);
    registry.push(suite);
    registry.pushGate(makeGateResult(suite, 0, -12.5));

    panel.handleInput('enter'); // detail mode, scenario 0 selected by default
    const text = linesText(panel);
    expect(text).toContain('regression vs baseline');
    expect(text).toContain('▼');
  });
});

describe('EvalPanel — baseline seeding on activate', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-eval-panel-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('fresh session with no live runs shows baseline scores instead of a signpost', async () => {
    const suite = makeSuiteResult('core-performance', 2, 91);
    const baseline = captureBaseline('main', [suite]);
    await writeBaseline(join(root, '.goodvibes/eval/baseline.json'), baseline, root);

    const registry = new EvalRegistry();
    const panel = new EvalPanel(registry, root);
    panel.onActivate();

    // Baseline load is async (file I/O); wait for it to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const text = linesText(panel);
    expect(text).toContain('core-performance');
    expect(text).toContain('91.0');
    expect(text).toContain('Baseline');
    expect(text).not.toContain('No results yet');
  });

  test('no baseline file on disk falls back to a keyboard-hint empty state, not a slash-command signpost', async () => {
    const registry = new EvalRegistry();
    const panel = new EvalPanel(registry, root); // root has no .goodvibes/eval/baseline.json
    panel.onActivate();

    await new Promise((resolve) => setTimeout(resolve, 20));

    const text = linesText(panel);
    expect(text).toContain('No results yet');
    expect(text).not.toContain('/eval run');
    expect(text).toContain('run selected suite');
    expect(text).toContain('run all suites');
  });

  test('r on a baseline-only row dispatches /eval run <baseline suite name>', async () => {
    const suite = makeSuiteResult('cost-tokens', 2, 70);
    const baseline = captureBaseline('main', [suite]);
    await writeBaseline(join(root, '.goodvibes/eval/baseline.json'), baseline, root);

    const registry = new EvalRegistry();
    const panel = new EvalPanel(registry, root);
    panel.onActivate();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const { ctx, calls } = makeExecuteCommandCtx();
    const consumed = panel.handlePanelIntegrationAction!('r', ctx);
    expect(consumed).toBe(true);
    expect(calls).toEqual([['eval', ['run', 'cost-tokens']]]);
  });

  test('a live suite run supersedes the baseline view even if the baseline loaded first', async () => {
    const baselineSuite = makeSuiteResult('core-performance', 2, 91);
    const baseline = captureBaseline('main', [baselineSuite]);
    await writeBaseline(join(root, '.goodvibes/eval/baseline.json'), baseline, root);

    const registry = new EvalRegistry();
    const panel = new EvalPanel(registry, root);
    panel.onActivate();
    await new Promise((resolve) => setTimeout(resolve, 20));

    registry.push(makeSuiteResult('live-suite', 1, 55));
    const text = linesText(panel);
    expect(text).toContain('live-suite');
  });
});
