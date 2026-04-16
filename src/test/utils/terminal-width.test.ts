import { describe, expect, test } from 'bun:test';
import { fitDisplay, getDisplayWidth, padDisplayEnd, truncateDisplay } from '../../utils/terminal-width.ts';

describe('terminal width helpers', () => {
  test('truncateDisplay respects wide characters', () => {
    const text = 'abc界🙂xyz';
    const truncated = truncateDisplay(text, 6);
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(6);
  });

  test('padDisplayEnd pads to display width, not string length', () => {
    const text = '界🙂';
    const padded = padDisplayEnd(text, 6);
    expect(getDisplayWidth(padded)).toBe(6);
  });

  test('fitDisplay truncates and pads to exact display width', () => {
    const text = 'very-wide🙂value';
    const fitted = fitDisplay(text, 8);
    expect(getDisplayWidth(fitted)).toBe(8);
  });
});
