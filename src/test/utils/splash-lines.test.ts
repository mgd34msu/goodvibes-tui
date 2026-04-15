import { describe, expect, test } from 'bun:test';
import { getSplashLines } from '../../utils/splash-lines.ts';
import { getDisplayWidth } from '@pellux/goodvibes-sdk/platform/utils/terminal-width';

describe('splash lines', () => {
  test('keeps the full-size splash instead of switching to a compact fallback', () => {
    const lines = getSplashLines(40);
    expect(lines.join('\n')).toContain('██████╗');
    expect(lines.join('\n')).toContain('いい雰囲気');
    expect(lines.join('\n')).not.toContain('GOODVIBES');
  });

  test('wide splash remains within the available width', () => {
    const lines = getSplashLines(120);
    expect(lines.every((line) => getDisplayWidth(line) <= 120)).toBe(true);
  });

  test('wide splash is padded to center horizontally when it fits', () => {
    const lines = getSplashLines(120);
    expect(lines[0]?.startsWith(' '.repeat(16))).toBe(true);
    expect(lines[1]?.startsWith(' '.repeat(17))).toBe(true);
  });
});
