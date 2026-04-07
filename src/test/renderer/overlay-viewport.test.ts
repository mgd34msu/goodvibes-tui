import { describe, expect, test } from 'bun:test';
import { getOverlayContentBudget, getOverlayMaxWidth, getOverlaySurfaceMetrics, getStableOverlayContentRows } from '../../renderer/overlay-viewport.ts';

describe('overlay viewport policy', () => {
  test('keeps content budgets within a stable half-screen band', () => {
    expect(getOverlayContentBudget(18, { chromeRows: 4, minContentRows: 6, maxContentRows: 10 })).toBeGreaterThanOrEqual(4);
    expect(getOverlayContentBudget(24, { chromeRows: 4, minContentRows: 6, maxContentRows: 10 })).toBe(8);
    expect(getOverlayContentBudget(40, { chromeRows: 4, minContentRows: 6, maxContentRows: 10 })).toBe(10);
  });

  test('keeps overlay widths away from terminal edges', () => {
    expect(getOverlayMaxWidth(80, 4, 72)).toBe(72);
    expect(getOverlayMaxWidth(120, 4, 88)).toBe(88);
    expect(getOverlayMaxWidth(60, 2, 88)).toBe(56);
  });

  test('returns a stable shared overlay footprint', () => {
    const compact = getOverlaySurfaceMetrics(80, 24, { chromeRows: 6 });
    expect(compact.margin).toBe(6);
    expect(compact.boxWidth).toBe(68);
    expect(compact.contentWidth).toBe(64);
    expect(compact.contentRows).toBeGreaterThanOrEqual(6);

    const roomy = getOverlaySurfaceMetrics(120, 40, {
      chromeRows: 6,
      maxWidth: 88,
      minContentRows: 8,
      maxContentRows: 12,
    });
    expect(roomy.boxWidth).toBe(88);
    expect(roomy.contentWidth).toBe(84);
    expect(roomy.contentRows).toBeLessThanOrEqual(12);
  });

  test('stable overlay target rows clamp to a shared minimum band', () => {
    expect(getStableOverlayContentRows(5, 8)).toBe(8);
    expect(getStableOverlayContentRows(9, 8)).toBe(9);
  });
});
