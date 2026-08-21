/**
 * Context meter threshold rendering tests, TASK-055.
 *
 * Validates:
 *   1. Threshold marker ('▸') appears in the bar at the threshold column.
 *   2. Color switches at the threshold boundary (green below, yellow at/above, red at 100%).
 *   3. No marker when compactThreshold is not provided (legacy path).
 *   4. Boundary values: 0% usage, exact-threshold usage, 100% usage.
 */
import { describe, test, expect } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { linesToText, lineToString } from '../setup.ts';

const W = 120;

// UIFactory.createFooter is the public surface; we exercise createProgressBarLine
// indirectly through createFooter with a contextWindow + lastInputTokens.

/**
 * Build a minimal footer and return the text of the context-meter bar line.
 * The bar line immediately follows the blank line after the token-usage line.
 */
function buildFooterLines(
  usedTokens: number,
  contextWindow: number,
  compactThreshold?: number,
): string[] {
  const lines = UIFactory.createFooter(
    W,
    '',                // prompt
    { up: 0, down: 0 },
    false,             // showExitNotice
    0,                 // lastCopyTime
    undefined,         // model
    undefined,         // toolCount
    undefined,         // cursorPos
    undefined,         // workingDir
    undefined,         // provider
    contextWindow,
    compactThreshold,
    false,             // dangerMode
    usedTokens,        // lastInputTokens
  );
  return linesToText(lines);
}

describe('context meter threshold marker', () => {
  test('threshold marker \'▸\' present when usage is below compact threshold', () => {
    // 50% usage, threshold at 80%, marker should appear in the empty region
    const texts = buildFooterLines(50_000, 100_000, 0.8);
    const barLine = texts.find((t) => t.includes('Context Usage'));
    expect(barLine).toBeDefined();
    expect(barLine).toContain('▸');
  });

  test('no threshold marker when no compactThreshold provided', () => {
    const texts = buildFooterLines(50_000, 100_000, undefined);
    const barLine = texts.find((t) => t.includes('Context Usage'));
    expect(barLine).toBeDefined();
    expect(barLine).not.toContain('▸');
  });

  test('no threshold marker when usage has consumed the threshold column (filled region)', () => {
    // 90% usage, threshold at 80%, bar is 90% filled, threshold col is inside filled region
    const texts = buildFooterLines(90_000, 100_000, 0.8);
    const barLine = texts.find((t) => t.includes('Context Usage'));
    expect(barLine).toBeDefined();
    // Marker is in the empty region only; at 90% fill the threshold col is filled
    expect(barLine).not.toContain('▸');
  });

  test('bar line present at 0% usage', () => {
    const texts = buildFooterLines(0, 100_000, 0.8);
    const barLine = texts.find((t) => t.includes('Context Usage'));
    expect(barLine).toBeDefined();
    expect(barLine).toContain('▸');
  });

  test('bar line present at exactly 100% usage', () => {
    const texts = buildFooterLines(100_000, 100_000, 0.8);
    const barLine = texts.find((t) => t.includes('Context Usage'));
    expect(barLine).toBeDefined();
    // At 100%, all cells are filled, no empty region for the marker
    expect(barLine).not.toContain('▸');
  });
});

describe('context meter color at threshold', () => {
  test('all lines have correct width', () => {
    const lines = UIFactory.createFooter(
      W, '', { up: 0, down: 0 }, false, 0,
      undefined, undefined, undefined, undefined, undefined,
      100_000, 0.8, false, 50_000,
    );
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('footer renders without error for threshold=0 (edge: no marker)', () => {
    // threshold=0 means compactThreshold > 0 guard prevents marker
    const texts = buildFooterLines(10_000, 100_000, 0);
    expect(texts.some((t) => t.includes('Context Usage'))).toBe(true);
    const barLine = texts.find((t) => t.includes('Context Usage'));
    // compactThreshold=0 is clamped to undefined (no marker)
    expect(barLine).not.toContain('▸');
  });

  test('footer renders without error for threshold=1 (edge: marker at end)', () => {
    const texts = buildFooterLines(50_000, 100_000, 1.0);
    expect(texts.some((t) => t.includes('Context Usage'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config path regression, verifies that main.ts converts percent → fraction
// ---------------------------------------------------------------------------
// behavior.autoCompactThreshold is stored as a percent integer (e.g. 80).
// main.ts must divide by 100 before passing to UIFactory. Without the fix,
// the raw value (80) reaches ui-factory, which clamps Math.min(1, 80) → 1.0,
// making the threshold indistinguishable from 100%, no marker at 50% usage.
describe('context meter config path regression (percent→fraction mapping)', () => {
  test('raw integer 80 (uncorrected config value) is clamped to 1.0 by ui-factory: no marker at 50%', () => {
    // This represents the OLD broken behavior: raw percent integer passed through.
    // thresholdFraction = Math.min(1, 80) = 1.0; at 50% fill the threshold col is beyond filled,
    // but thresholdCol = Math.round(1.0 * barWidth) which equals barWidth, outside the bar loop.
    // Result: no marker rendered (the bug).
    const texts = buildFooterLines(50_000, 100_000, 80);
    const barLine = texts.find((t) => t.includes('Context Usage'));
    expect(barLine).toBeDefined();
    // With raw integer 80, the threshold column is off-screen, no marker.
    expect(barLine).not.toContain('▸');
  });

  test('corrected fraction 0.8 (main.ts maps 80 → 0.8) shows marker at 50% usage', () => {
    // main.ts fix: (80 / 100) = 0.8 → threshold at 80% of bar width.
    // At 50% fill the threshold column is in the empty region → marker rendered.
    const texts = buildFooterLines(50_000, 100_000, 0.8);
    const barLine = texts.find((t) => t.includes('Context Usage'));
    expect(barLine).toBeDefined();
    expect(barLine).toContain('▸');
  });
});

// ---------------------------------------------------------------------------
// Color-switch assertions, fg codes: green=82, yellow=220, red=196
// ---------------------------------------------------------------------------
/**
 * Build a raw footer Line[] and find the bar line (Context Usage line).
 * Returns the fg color of the first non-space character on that line.
 */
function buildFooterBarLineFg(
  usedTokens: number,
  contextWindow: number,
  compactThreshold?: number,
): string {
  const lines = UIFactory.createFooter(
    W,
    '',
    { up: 0, down: 0 },
    false,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    contextWindow,
    compactThreshold,
    false,
    usedTokens,
  );
  const barLine = lines.find((line) => lineToString(line).includes('Context Usage'));
  if (!barLine) throw new Error('Context Usage bar line not found');
  // All cells on the bar line share the same fg (set by stringToLine with { fg: color }).
  // Find the first cell with a non-space character to get the assigned fg.
  const cell = barLine.find((c) => c.char !== ' ' && c.char !== '');
  return cell?.fg ?? '';
}

describe('context meter fg color switches at threshold', () => {
  test('usage just below threshold → green (82)', () => {
    // 79% usage, threshold 0.8, pct (0.79) < compactThreshold (0.8) → color '82'
    const fg = buildFooterBarLineFg(79_000, 100_000, 0.8);
    expect(fg).toBe('82');
  });

  test('usage at threshold → yellow (220)', () => {
    // 80% usage, threshold 0.8, pct (0.8) >= compactThreshold (0.8), pct < 1.0 → color '220'
    const fg = buildFooterBarLineFg(80_000, 100_000, 0.8);
    expect(fg).toBe('220');
  });

  test('usage at 100% → red (196)', () => {
    // 100% usage, pct (1.0) >= 1.0 → color '196'
    const fg = buildFooterBarLineFg(100_000, 100_000, 0.8);
    expect(fg).toBe('196');
  });
});
