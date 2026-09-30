/**
 * Diff row tints in the Changes modal stay clearly visible in every bundled
 * theme and mode, on the element inset the diff sits on and on the modal's
 * surface fill (backgroundPanel).
 *
 * Metric: Euclidean distance in sRGB (0..441). MIN_DIFF_TINT_DISTANCE (24) is
 * about three times the step at which two flat fills can be told apart side by
 * side, so a tinted row reads as tinted at a glance instead of on inspection.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { listBundledThemes } from '@pellux/goodvibes-sdk/platform/presentation';
import { diffRowTints } from '../../renderer/diff-tint.ts';
import { activeTokens, getActiveThemeName, activeThemeMode, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import { drawDiffRow, type DiffRow } from '../../renderer/changes-modal.ts';
import { beginModal } from '../../renderer/surface-kit.ts';
import { inset } from '../../renderer/surface-kit-parts.ts';

/** Mirrors the floor in src/renderer/diff-tint.ts (see the justification there and above). */
const MIN_DIFF_TINT_DISTANCE = 24;

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const colorDistance = (a: string, b: string): number => {
  const x = rgb(a);
  const y = rgb(b);
  return Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!);
};

const savedName = getActiveThemeName();
const savedMode = activeThemeMode();
afterAll(() => {
  setActiveThemeName(savedName);
  setActiveThemeMode(savedMode);
});

describe('the visibility floor', () => {
  test('keeps a theme tint that is already far enough from the fill', () => {
    setActiveThemeName('dracula');
    setActiveThemeMode('dark');
    const t = activeTokens();
    // dracula dark's added row sits well clear of its surface fill.
    expect(colorDistance(t.diffAddedBg, t.backgroundPanel)).toBeGreaterThan(MIN_DIFF_TINT_DISTANCE);
    expect(diffRowTints(t.backgroundPanel).addedRow).toBe(t.diffAddedBg);
  });

  test('pushes a close tint further along its own direction from the fill', () => {
    setActiveThemeName('gruvbox');
    setActiveThemeMode('light');
    const t = activeTokens();
    const out = diffRowTints(t.backgroundElement).addedRow;
    expect(colorDistance(t.diffAddedBg, t.backgroundElement)).toBeLessThan(MIN_DIFF_TINT_DISTANCE);
    expect(colorDistance(out, t.backgroundElement)).toBeGreaterThanOrEqual(MIN_DIFF_TINT_DISTANCE);
    // Same direction: moving from the fill toward the theme's tint, never past it the other way.
    const along = (c: string): number => rgb(c).reduce((sum, v, i) => sum + (v - rgb(t.backgroundElement)[i]!) * (rgb(t.diffAddedBg)[i]! - rgb(t.backgroundElement)[i]!), 0);
    expect(along(out)).toBeGreaterThan(along(t.diffAddedBg));
  });

  test('a tint equal to the fill falls back to mixing the fill toward the sign color', () => {
    setActiveThemeName('goodvibes');
    setActiveThemeMode('dark');
    const t = activeTokens();
    const out = diffRowTints(t.diffAddedBg).addedRow;
    expect(colorDistance(out, t.diffAddedBg)).toBeGreaterThanOrEqual(MIN_DIFF_TINT_DISTANCE);
  });
});

describe('every bundled theme: added and removed rows are clearly tinted', () => {
  for (const theme of listBundledThemes()) {
    for (const mode of ['dark', 'light'] as const) {
      if (!theme.variants.includes(mode)) continue;
      test(`${theme.name} ${mode}`, () => {
        setActiveThemeName(theme.name);
        setActiveThemeMode(mode);
        const t = activeTokens();
        for (const fill of [t.backgroundElement, t.backgroundPanel]) {
          const tints = diffRowTints(fill);
          for (const [name, color] of Object.entries(tints)) {
            const d = colorDistance(color, fill);
            if (d < MIN_DIFF_TINT_DISTANCE) throw new Error(`${theme.name} ${mode}: ${name} ${color} is ${d.toFixed(1)} from fill ${fill}`);
          }
          // Added and removed rows stay distinguishable from each other too.
          expect(colorDistance(tints.addedRow, tints.removedRow)).toBeGreaterThan(8);
        }
      });
    }
  }
});

test('drawDiffRow paints the visible tints across the row and the gutter', () => {
  setActiveThemeName('gruvbox');
  setActiveThemeMode('light');
  const f = beginModal(120, 30, { title: 'Changes' });
  const p = inset(f.canvas, 10, 4, 60, 8);
  const row: DiffRow = { kind: 'line', hunk: 0, first: true, text: 'const a = 1;', line: { kind: 'add', text: 'const a = 1;', oldNo: null, newNo: 3 }, tokens: [{ text: 'const a = 1;', fg: activeTokens().text }] };
  drawDiffRow(f.canvas, p, p.top, row, 0);
  const tints = diffRowTints(p.bg);
  expect(f.canvas.lines[p.top]![p.x + p.w - 1]!.bg).toBe(tints.addedRow);
  expect(f.canvas.lines[p.top]![p.x]!.bg).toBe(tints.addedGutter);
  expect(colorDistance(tints.addedRow, p.bg)).toBeGreaterThanOrEqual(MIN_DIFF_TINT_DISTANCE);
});
