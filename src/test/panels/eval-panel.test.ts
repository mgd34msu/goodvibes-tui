/**
 * Regression tests for EvalPanel key handling.
 *
 * Feeds REAL tokenizer output through the panel's handleInput to verify that
 * up/down navigation, enter (detail mode), and escape (back to list) all work
 * with the actual logical key names emitted by the input pipeline.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { InputTokenizer } from '@pellux/goodvibes-sdk/platform/core';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import { EvalPanel, EvalRegistry } from '../../panels/eval-panel.ts';
import type { EvalSuiteResult } from '@/runtime/index.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeKeyToken(sequence: string): Extract<InputToken, { type: 'key' }> {
  const tokenizer = new InputTokenizer();
  const tokens = tokenizer.feed(sequence);
  if (tokens.length !== 1 || tokens[0].type !== 'key') {
    throw new Error(`Expected one key token from sequence ${JSON.stringify(sequence)}, got: ${JSON.stringify(tokens)}`);
  }
  return tokens[0] as Extract<InputToken, { type: 'key' }>;
}

/**
 * Feed a terminal escape sequence through the tokenizer and forward the
 * resulting logicalName into the panel — exactly as handler-feed-routes does.
 */
function feedKey(panel: EvalPanel, sequence: string): boolean {
  const token = makeKeyToken(sequence);
  return panel.handleInput(token.logicalName);
}

function makeSuiteResult(suite: string, numScenarios = 2): EvalSuiteResult {
  const now = Date.now();
  return {
    suite,
    startedAt: now,
    finishedAt: now + 500,
    meanScore: 82,
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
        dimensions: [],
        compositeScore: 82,
        passed: true,
      },
      startedAt: now,
      finishedAt: now + 100,
    })),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EvalPanel — tokenizer-driven key handling', () => {
  let registry: EvalRegistry;
  let panel: EvalPanel;

  beforeEach(() => {
    registry = new EvalRegistry();
    panel = new EvalPanel(registry);
    panel.onActivate();
  });

  test('up arrow (\\x1b[A) moves selection in list mode', () => {
    registry.push(makeSuiteResult('suite-alpha'));
    registry.push(makeSuiteResult('suite-beta'));

    // Move down first so we have something to move up from
    expect(feedKey(panel, '\x1b[B')).toBe(true); // down
    expect(panel['_selectedSuiteIdx']).toBe(1);

    expect(feedKey(panel, '\x1b[A')).toBe(true); // up
    expect(panel['_selectedSuiteIdx']).toBe(0);
  });

  test('down arrow (\\x1b[B) moves selection in list mode', () => {
    registry.push(makeSuiteResult('suite-alpha'));
    registry.push(makeSuiteResult('suite-beta'));

    expect(feedKey(panel, '\x1b[B')).toBe(true); // down
    expect(panel['_selectedSuiteIdx']).toBe(1);
  });

  test('enter (\\r) enters detail mode when suites are present', () => {
    registry.push(makeSuiteResult('suite-alpha'));

    expect(panel['_mode']).toBe('list');
    expect(feedKey(panel, '\r')).toBe(true); // enter
    expect(panel['_mode']).toBe('detail');
  });

  test('escape (\\x1b bare) returns to list mode from detail mode', () => {
    registry.push(makeSuiteResult('suite-alpha'));

    feedKey(panel, '\r'); // enter detail
    expect(panel['_mode']).toBe('detail');

    // Bare ESC emits logicalName=escape
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\x1b');
    expect(tokens).toHaveLength(1);
    const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
    expect(t.logicalName).toBe('escape');

    expect(panel.handleInput(t.logicalName)).toBe(true);
    expect(panel['_mode']).toBe('list');
  });

  test('up/down in detail mode navigate scenarios', () => {
    registry.push(makeSuiteResult('suite-alpha', 3));
    feedKey(panel, '\r'); // enter detail

    expect(panel['_selectedScenarioIdx']).toBe(0);
    expect(feedKey(panel, '\x1b[B')).toBe(true); // down
    expect(panel['_selectedScenarioIdx']).toBe(1);
    expect(feedKey(panel, '\x1b[A')).toBe(true); // up
    expect(panel['_selectedScenarioIdx']).toBe(0);
  });

  test('enter key does nothing in list mode when no suites exist', () => {
    // Empty registry — enter should return false (no suites to enter)
    expect(feedKey(panel, '\r')).toBe(false);
    expect(panel['_mode']).toBe('list');
  });
});
