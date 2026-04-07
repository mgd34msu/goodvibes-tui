import { describe, expect, test } from 'bun:test';
import { getSurfaceContentRows, getTrackedVisibleWindow, getVisibleWindow, sliceVisibleWindow } from '../../renderer/surface-layout.ts';

describe('surface layout', () => {
  test('keeps framed content within a stable viewport budget', () => {
    expect(getSurfaceContentRows({ viewportHeight: 24, chromeRows: 5, minContentRows: 5, maxContentRows: 8 })).toBeGreaterThanOrEqual(5);
    expect(getSurfaceContentRows({ viewportHeight: 40, chromeRows: 5, minContentRows: 5, maxContentRows: 8 })).toBeLessThanOrEqual(8);
  });

  test('centers visible window around selection where possible', () => {
    const window = getVisibleWindow(20, 10, 5);
    expect(window.start).toBe(8);
    expect(window.end).toBe(13);
  });

  test('slices items using the shared visible window helper', () => {
    const values = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const result = sliceVisibleWindow(values, 4, 3);
    expect(result.items).toEqual(['d', 'e', 'f']);
    expect(result.window.start).toBe(3);
  });

  test('tracked visible window preserves scroll until selection reaches the viewport edge', () => {
    expect(getTrackedVisibleWindow(20, 3, 5, 0, 1).start).toBe(0);
    expect(getTrackedVisibleWindow(20, 4, 5, 0, 1).start).toBe(1);
    expect(getTrackedVisibleWindow(20, 10, 5, 8, 1).start).toBe(8);
    expect(getTrackedVisibleWindow(20, 8, 5, 8, 1).start).toBe(7);
  });
});
