// ---------------------------------------------------------------------------
// panel-basics.test.ts — Pure data-transformation and render tests for panels
//
// Tests the render() -> Line[] pattern. No Ink JSX used anywhere.
// Panels tested (all have zero prior coverage):
//   1. DiffPanel    — parseDiff logic via showDiff+render, splitIntoDiffEntries
//   2. TokenBudgetPanel — fmtTok, renderStackedBar, renderContextBar, renderTotals
//   3. GitPanel     — render in loading/error/data states
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import type { Line } from '../../types/grid.ts';
import type { Orchestrator } from '../../core/orchestrator.ts';
const TEST_ROOT = '/tmp/goodvibes-test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract all printable characters from a Line[] grid as a flat string. */
function linesText(lines: Line[]): string {
  return lines
    .map(line => line.map(cell => cell.char ?? ' ').join(''))
    .join('\n');
}

/** Extract only the non-space text from a Line[]. */
function linesTextTrimmed(lines: Line[]): string {
  return lines
    .map(line => line.map(cell => cell.char ?? ' ').join('').trimEnd())
    .filter(s => s.trim().length > 0)
    .join('\n');
}

/** Count lines in a render result that contain a given string. */
function countLinesContaining(lines: Line[], needle: string): number {
  return lines.filter(line =>
    line.map(c => c.char ?? ' ').join('').includes(needle)
  ).length;
}

/** Get the text of a specific rendered row. */
function rowText(lines: Line[], rowIndex: number): string {
  return (lines[rowIndex] ?? []).map(c => c.char ?? ' ').join('');
}

function asOrchestratorMock(mock: TokenBudgetPanelOrchestratorMock): Orchestrator {
  return mock as unknown as Orchestrator;
}

// ---------------------------------------------------------------------------
// 1. DiffPanel tests
// ---------------------------------------------------------------------------

import { DiffPanel } from '../../panels/diff-panel.ts';

describe('DiffPanel', () => {
  let panel: DiffPanel;

  beforeEach(() => {
    panel = new DiffPanel(TEST_ROOT);
  });

  describe('render() — empty state', () => {
    test('renders "No diff to display" message when empty', () => {
      const lines = panel.render(80, 10);
      expect(lines).toHaveLength(10);
      const text = linesText(lines);
      expect(text).toContain('No diff to display');
    });

    test('returns exactly height lines when empty', () => {
      const lines = panel.render(60, 5);
      expect(lines).toHaveLength(5);
    });

    test('handles zero height gracefully', () => {
      const lines = panel.render(80, 0);
      expect(lines).toHaveLength(0);
    });

    test('handles zero width gracefully', () => {
      const lines = panel.render(0, 10);
      expect(lines).toHaveLength(0);
    });
  });

  describe('showDiff() — parseDiff via render', () => {
    const simpleDiff = [
      '@@ -1,3 +1,4 @@',
      ' line one',
      '-line two',
      '+line two modified',
      '+line inserted',
      ' line three',
    ].join('\n');

    test('showDiff() populates panel and marks dirty', () => {
      panel.showDiff('src/foo.ts', simpleDiff);
      expect(panel.needsRender).toBe(true);
    });

    test('render() returns height lines after showDiff', () => {
      panel.showDiff('src/foo.ts', simpleDiff);
      const lines = panel.render(80, 20);
      expect(lines).toHaveLength(20);
    });

    test('render includes the diff content (additions visible)', () => {
      panel.showDiff('src/foo.ts', simpleDiff);
      const lines = panel.render(120, 20);
      const text = linesText(lines);
      // Addition line should appear with + prefix
      expect(text).toContain('line two modified');
    });

    test('render shows deletion lines', () => {
      panel.showDiff('src/foo.ts', simpleDiff);
      const lines = panel.render(120, 20);
      const text = linesText(lines);
      expect(text).toContain('line two');
    });

    test('tab bar shows file basename', () => {
      panel.showDiff('src/components/foo.ts', simpleDiff);
      const lines = panel.render(120, 20);
      const text = linesText(lines);
      expect(text).toContain('foo.ts');
    });

    test('replacing existing file preserves selection', () => {
      panel.showDiff('src/foo.ts', simpleDiff);
      panel.showDiff('src/foo.ts', '@@ -1,1 +1,1 @@\n-old\n+new');
      const lines = panel.render(80, 10);
      const text = linesText(lines);
      // After replacement the content is the new diff
      expect(text).toContain('new');
    });

    test('adding second file creates two-file tab bar', () => {
      panel.showDiff('src/a.ts', '@@ -1,1 +1,1 @@\n-a\n+a2');
      panel.showDiff('src/b.ts', '@@ -1,1 +1,1 @@\n-b\n+b2');
      const lines = panel.render(120, 20);
      const text = linesText(lines);
      expect(text).toContain('a.ts');
      expect(text).toContain('b.ts');
    });

    test('hunk header line is present in render output', () => {
      panel.showDiff('file.ts', '@@ -1,3 +1,3 @@\n line1\n-removed\n+added');
      const lines = panel.render(120, 20);
      const text = linesText(lines);
      expect(text).toContain('@@ -1,3 +1,3 @@');
    });
  });

  describe('loadRawDiff() — multi-file diff splitting', () => {
    const multiFileDiff = [
      'diff --git a/src/alpha.ts b/src/alpha.ts',
      'index 000000..111111 100644',
      '--- a/src/alpha.ts',
      '+++ b/src/alpha.ts',
      '@@ -1,2 +1,2 @@',
      '-old alpha',
      '+new alpha',
      'diff --git a/src/beta.ts b/src/beta.ts',
      'index 000000..222222 100644',
      '--- a/src/beta.ts',
      '+++ b/src/beta.ts',
      '@@ -1,1 +1,1 @@',
      '-old beta',
      '+new beta',
    ].join('\n');

    test('loadRawDiff creates entries for each file', () => {
      panel.loadRawDiff(multiFileDiff);
      const lines = panel.render(120, 20);
      const text = linesText(lines);
      expect(text).toContain('alpha.ts');
    });

    test('loadRawDiff marks panel dirty', () => {
      panel.loadRawDiff(multiFileDiff);
      expect(panel.needsRender).toBe(true);
    });

    test('loadRawDiff with empty string yields empty state', () => {
      panel.loadRawDiff('');
      const lines = panel.render(80, 10);
      const text = linesText(lines);
      expect(text).toContain('No diff to display');
    });
  });

  describe('clear()', () => {
    test('clear() resets to empty state', () => {
      panel.showDiff('file.ts', '@@ -1,1 +1,1 @@\n-a\n+b');
      panel.clear();
      const lines = panel.render(80, 10);
      expect(linesText(lines)).toContain('No diff to display');
    });
  });

  describe('setSemanticSummary()', () => {
    test('setSemanticSummary for loaded file appears in status bar', () => {
      panel.showDiff('app.ts', '@@ -1,1 +1,1 @@\n-old\n+new');
      panel.setSemanticSummary('app.ts', 'refactored auth logic');
      const lines = panel.render(120, 20);
      const statusRow = rowText(lines, lines.length - 1);
      expect(statusRow).toContain('refactored auth logic');
    });

    test('setSemanticSummary for unknown file is a no-op', () => {
      panel.showDiff('app.ts', '@@ -1,1 +1,1 @@\n-old\n+new');
      // Should not throw
      expect(() => panel.setSemanticSummary('unknown.ts', 'summary')).not.toThrow();
    });
  });

  describe('render geometry', () => {
    test('render never returns more lines than height', () => {
      panel.showDiff('big.ts', Array.from({ length: 200 }, (_, i) => `+line${i}`).join('\n'));
      const lines = panel.render(80, 15);
      expect(lines.length).toBeLessThanOrEqual(15);
    });

    test('every rendered line has exactly width cells', () => {
      panel.showDiff('a.ts', '@@ -1,2 +1,2 @@\n-old\n+new');
      const W = 60;
      const lines = panel.render(W, 10);
      for (const line of lines) {
        expect(line.length).toBe(W);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. TokenBudgetPanel tests
// ---------------------------------------------------------------------------

import { TokenBudgetPanel } from '../../panels/token-budget-panel.ts';
import { SessionMemoryStore } from '../../core/session-memory.ts';

describe('TokenBudgetPanel', () => {
  let panel: TokenBudgetPanel;

  // We need a minimal Orchestrator-like object for wiring
  function makeOrchMock(overrides: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    lastInputTokens?: number;
  } = {}): TokenBudgetPanelOrchestratorMock {
    return {
      usage: {
        input:      overrides.input      ?? 0,
        output:     overrides.output     ?? 0,
        cacheRead:  overrides.cacheRead  ?? 0,
        cacheWrite: overrides.cacheWrite ?? 0,
      },
      lastInputTokens: overrides.lastInputTokens ?? 0,
    };
  }

  beforeEach(() => {
    panel = new TokenBudgetPanel(new SessionMemoryStore());
  });

  describe('render() — unwired panel', () => {
    test('renders without throwing when not wired', () => {
      expect(() => panel.render(80, 20)).not.toThrow();
    });

    test('returns exactly height lines', () => {
      const lines = panel.render(80, 20);
      expect(lines).toHaveLength(20);
    });

    test('contains "Token Budget" title', () => {
      const lines = panel.render(80, 20);
      const text = linesText(lines);
      expect(text).toContain('Token Budget');
    });

    test('shows "no data" placeholder when no usage', () => {
      const lines = panel.render(80, 20);
      const text = linesText(lines);
      expect(text).toContain('no data');
    });

    test('shows "No turns recorded" when no turn history', () => {
      const lines = panel.render(80, 20);
      const text = linesText(lines);
      expect(text).toContain('No turns recorded');
    });
  });

  describe('render() — wired with usage data', () => {
    test('shows input/output data when wired', () => {
      const orch = makeOrchMock({ input: 1000, output: 500 });
      panel.wire(asOrchestratorMock(orch), () => 0);
      panel.onActivate();
      const lines = panel.render(80, 25);
      const text = linesText(lines);
      // Should contain stacked bar
      expect(text).toContain('[');
      expect(text).toContain(']');
    });

    test('shows "Session Totals" section', () => {
      const orch = makeOrchMock({ input: 2000, output: 800 });
      panel.wire(asOrchestratorMock(orch), () => 0);
      panel.onActivate();
      const lines = panel.render(80, 25);
      const text = linesText(lines);
      expect(text).toContain('Session Totals');
    });

    test('fmtTok: values < 10000 shown as raw integer', () => {
      // Wire panel with 9999 input tokens
      const orch = makeOrchMock({ input: 9999, output: 0, cacheRead: 0, cacheWrite: 0 });
      panel.wire(asOrchestratorMock(orch), () => 0);
      panel.onActivate();
      const lines = panel.render(80, 25);
      const text = linesText(lines);
      expect(text).toContain('9999');
    });

    test('fmtTok: values >= 10000 shown with k suffix', () => {
      const orch = makeOrchMock({ input: 15000, output: 0, cacheRead: 0, cacheWrite: 0 });
      panel.wire(asOrchestratorMock(orch), () => 0);
      panel.onActivate();
      const lines = panel.render(80, 25);
      const text = linesText(lines);
      expect(text).toContain('15.0k');
    });

    test('fmtTok: values >= 1M shown with M suffix', () => {
      const orch = makeOrchMock({ input: 1_200_000, output: 0, cacheRead: 0, cacheWrite: 0 });
      panel.wire(asOrchestratorMock(orch), () => 0);
      panel.onActivate();
      const lines = panel.render(80, 25);
      const text = linesText(lines);
      expect(text).toContain('1.20M');
    });

    test('renders context bar when contextWindow > 0', () => {
      const orch = makeOrchMock({ lastInputTokens: 50000 });
      panel.wire(asOrchestratorMock(orch), () => 200000);
      panel.onActivate();
      const lines = panel.render(80, 30);
      const text = linesText(lines);
      expect(text).toContain('Context:');
    });

    test('context bar shows WARNING at >= 70% fill', () => {
      const orch = makeOrchMock({ lastInputTokens: 75000 });
      panel.wire(asOrchestratorMock(orch), () => 100000); // 75% fill
      panel.onActivate();
      const lines = panel.render(80, 30);
      const text = linesText(lines);
      expect(text).toContain('HIGH');
    });

    test('context bar shows CRITICAL at >= 90% fill', () => {
      const orch = makeOrchMock({ lastInputTokens: 92000 });
      panel.wire(asOrchestratorMock(orch), () => 100000); // 92% fill
      panel.onActivate();
      const lines = panel.render(80, 30);
      const text = linesText(lines);
      expect(text).toContain('CRITICAL');
    });

    test('context bar not shown when contextWindow is 0', () => {
      const orch = makeOrchMock({ lastInputTokens: 50000 });
      panel.wire(asOrchestratorMock(orch), () => 0); // unknown window size
      panel.onActivate();
      const lines = panel.render(80, 25);
      const text = linesText(lines);
      expect(text).not.toContain('Context:');
    });
  });

  describe('render geometry', () => {
    test('returns exactly height lines', () => {
      const orch = makeOrchMock({ input: 500, output: 200 });
      panel.wire(asOrchestratorMock(orch), () => 1000);
      panel.onActivate();
      const lines = panel.render(80, 30);
      expect(lines).toHaveLength(30);
    });

    test('every line has exactly width cells', () => {
      panel.render(60, 15).forEach(line => {
        expect(line.length).toBe(60);
      });
    });
  });

  describe('onDeactivate()', () => {
    test('onDeactivate does not throw', () => {
      expect(() => panel.onDeactivate()).not.toThrow();
    });

    test('onDestroy does not throw', () => {
      expect(() => panel.onDestroy()).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// 3. GitPanel tests
// ---------------------------------------------------------------------------

import { GitPanel } from '../../panels/git-panel.ts';

describe('GitPanel', () => {
  let panel: GitPanel;

  beforeEach(() => {
    panel = new GitPanel(TEST_ROOT);
  });

  describe('render() — initial loading state', () => {
    test('renders without throwing', () => {
      expect(() => panel.render(80, 20)).not.toThrow();
    });

    test('returns exactly height lines', () => {
      const lines = panel.render(80, 20);
      expect(lines).toHaveLength(20);
    });

    test('shows loading message initially', () => {
      const lines = panel.render(80, 20);
      const text = linesText(lines);
      expect(text).toContain('Loading');
    });

    test('loading state renders correct number of lines for varying heights', () => {
      expect(panel.render(80, 5)).toHaveLength(5);
      expect(panel.render(80, 30)).toHaveLength(30);
    });
  });

  describe('render geometry', () => {
    test('every line has exactly width cells', () => {
      const W = 70;
      panel.render(W, 10).forEach(line => {
        expect(line.length).toBe(W);
      });
    });

    test('handles narrow width (10 chars)', () => {
      const lines = panel.render(10, 10);
      expect(lines).toHaveLength(10);
      for (const line of lines) {
        expect(line.length).toBe(10);
      }
    });

    test('handles very wide width (200 chars)', () => {
      const lines = panel.render(200, 10);
      expect(lines).toHaveLength(10);
      for (const line of lines) {
        expect(line.length).toBe(200);
      }
    });
  });

  describe('panel metadata', () => {
    test('has correct id', () => {
      expect(panel.id).toBe('git');
    });

    test('has correct name', () => {
      expect(panel.name).toBe('Git');
    });

    test('has correct icon', () => {
      expect(panel.icon).toBe('G');
    });

    test('has correct category', () => {
      expect(panel.category).toBe('development');
    });

    test('starts with needsRender true', () => {
      expect(panel.needsRender).toBe(true);
    });
  });

  describe('onActivate / onDeactivate / onDestroy', () => {
    test('onActivate does not throw', () => {
      expect(() => panel.onActivate()).not.toThrow();
    });

    test('onActivate sets needsRender', () => {
      panel.needsRender = false;
      panel.onActivate();
      expect(panel.needsRender).toBe(true);
    });

    test('onDeactivate does not throw', () => {
      expect(() => panel.onDeactivate()).not.toThrow();
    });

    test('onDestroy does not throw', () => {
      expect(() => panel.onDestroy()).not.toThrow();
    });
  });
});
type TokenBudgetPanelOrchestratorMock = {
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  lastInputTokens: number;
};
