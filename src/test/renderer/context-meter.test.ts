/**
 * The status line's context bar: "context" + 16 cells + percent + used / total.
 * Filled cells carry the brand gradient while healthy, the warning color from
 * 65%, the error color at or past the compaction threshold; the track is the
 * border color and an amber │ marks the threshold.
 */
import { describe, expect, test } from 'bun:test';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { renderStatusLine } from '../../renderer/status-line.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { lineToString } from '../setup.ts';
import { interpolateColor } from '../../utils/terminal-width.ts';

const WINDOW = 200_000;

function bar(usedFraction: number, compactFraction = 0.8, width = 120): Line {
  return renderStatusLine({
    width,
    branch: 'main',
    context: { usedTokens: Math.round(WINDOW * usedFraction), windowTokens: WINDOW, compactFraction },
  });
}

/** The 16 bar cells after the "context " label. */
function cells(line: Line): Line {
  const start = lineToString(line).indexOf('context ') + 'context '.length;
  return line.slice(start, start + 16);
}

describe('context bar geometry', () => {
  test('16 cells between the label and the percent', () => {
    const text = lineToString(bar(0.25));
    expect(text).toMatch(/context [█░│]{16} 25% 50\.0k \/ 200\.0k/);
  });

  test('the threshold tick sits at the compaction fraction of the bar, in the warning color', () => {
    const c = cells(bar(0.25, 0.8));
    const tick = c.findIndex((cell) => cell.char === '│');
    expect(tick).toBe(Math.round(16 * 0.8));
    expect(c[tick]!.fg).toBe(activeTokens().warning);
  });

  test('the tick stays visible once the fill has passed it', () => {
    expect(cells(bar(0.95, 0.8)).some((cell) => cell.char === '│')).toBe(true);
  });

  test('0% draws an empty track; 100% fills every cell but the tick', () => {
    expect(cells(bar(0)).filter((c) => c.char === '█')).toHaveLength(0);
    expect(cells(bar(1)).filter((c) => c.char === '░')).toHaveLength(0);
  });

  test('the track is the border color', () => {
    const track = cells(bar(0.1)).filter((c) => c.char === '░');
    expect(track.length).toBeGreaterThan(0);
    expect(track.every((c) => c.fg === activeTokens().border)).toBe(true);
  });

  test('the bar narrows (never below 6 cells) before it is dropped on a narrow screen', () => {
    const narrow = lineToString(bar(0.25, 0.8, 70));
    const m = narrow.match(/context ([█░│]+) /);
    expect(m).not.toBeNull();
    expect(m![1]!.length).toBeGreaterThanOrEqual(6);
    expect(m![1]!.length).toBeLessThan(16);
    expect(lineToString(bar(0.25, 0.8, 40))).not.toContain('context');
  });

  test('past 6 cells the used / total label goes first, then the word, then the bar', () => {
    const widths = [60, 52, 48, 44, 40, 36, 30];
    const forms = widths.map((w) => lineToString(bar(0.25, 0.8, w)));
    // Every rendering that still shows the bar keeps at least 6 cells and the percent.
    for (const text of forms) {
      const m = text.match(/([█░│]+) 25%/);
      if (m) expect(m[1]!.length).toBeGreaterThanOrEqual(6);
    }
    // Somewhere in that range the label has gone while the word remains, and
    // later the word has gone while the bare bar remains.
    expect(forms.some((t) => t.includes('context ') && t.includes('25%') && !t.includes('/ 200.0k'))).toBe(true);
    expect(forms.some((t) => !t.includes('context') && /[█░│]{6} 25%/.test(t))).toBe(true);
  });

  test('from the warning level a busy phrase truncates so the bare bar stays visible', () => {
    const busy = { spinner: '◐', frame: 0, phrase: 'Recalibrating the vibe matrix while the long phrase keeps going', elapsedMs: 12_000 };
    const render = (fraction: number): string => lineToString(renderStatusLine({
      width: 80,
      busy,
      context: { usedTokens: Math.round(WINDOW * fraction), windowTokens: WINDOW, compactFraction: 0.8 },
    }));
    expect(render(0.85)).toMatch(/[█░│]{6} 85%/);
    expect(render(0.7)).toMatch(/[█░│]{6} 70%/);
    // Healthy: the phrase keeps its room.
    expect(render(0.3)).not.toContain('30%');
  });
});

describe('context bar color', () => {
  const filled = (line: Line) => cells(line).filter((c) => c.char === '█');

  test('healthy: the brand gradient runs across the filled cells', () => {
    const f = filled(bar(0.5));
    expect(f[0]!.fg).toBe(interpolateColor(activeTokens().brand, activeTokens().brandEnd, 0));
    expect(new Set(f.map((c) => c.fg)).size).toBeGreaterThan(1);
  });

  test('from 65%: the warning color', () => {
    expect(filled(bar(0.7)).every((c) => c.fg === activeTokens().warning)).toBe(true);
  });

  test('at or past the compaction threshold: the error color, and the percent too', () => {
    const line = bar(0.8, 0.8);
    expect(filled(line).every((c) => c.fg === activeTokens().error)).toBe(true);
    const text = lineToString(line);
    expect(line[text.indexOf('80%')]!.fg).toBe(activeTokens().error);
  });
});

describe('context bar config path (percent -> fraction mapping)', () => {
  test('main.ts maps behavior.autoCompactThreshold 80 to 0.8: 85% is past the threshold', () => {
    expect(cells(bar(0.85, 80 / 100)).filter((c) => c.char === '█').every((c) => c.fg === activeTokens().error)).toBe(true);
  });

  test('an unmapped raw value is clamped to 1: no tick and no error color at 85%', () => {
    const line = bar(0.85, 80);
    expect(cells(line).some((c) => c.char === '│')).toBe(false);
    expect(cells(line).filter((c) => c.char === '█').every((c) => c.fg === activeTokens().warning)).toBe(true);
  });
});
