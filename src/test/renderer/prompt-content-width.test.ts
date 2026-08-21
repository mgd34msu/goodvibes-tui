import { describe, expect, test } from 'bun:test';
import { computePromptContentWidth } from '../../renderer/prompt-content-width.ts';

describe('computePromptContentWidth', () => {
  test('matches the historical formula at ordinary terminal widths', () => {
    // 100 cols: boxWidth = 100 - 4 = 96; content = 96 - 4 - 3 = 89
    expect(computePromptContentWidth(100)).toBe(89);
  });

  test('falls back to 80 columns when terminalColumns is falsy', () => {
    expect(computePromptContentWidth(0)).toBe(computePromptContentWidth(80));
  });

  test('floors at 1 instead of going zero or negative on a hostile-narrow terminal', () => {
    // 10 cols: boxWidth = 10 - 4 = 6; raw content = 6 - 4 - 3 = -1, must floor at 1.
    expect(computePromptContentWidth(10)).toBe(1);
    // Even narrower still floors at 1, never goes negative.
    expect(computePromptContentWidth(1)).toBe(1);
  });
});
