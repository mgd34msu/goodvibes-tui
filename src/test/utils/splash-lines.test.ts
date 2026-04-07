import { describe, expect, test } from 'bun:test';
import { getSplashLines } from '../../utils/splash-lines.ts';
import { getDisplayWidth } from '../../utils/terminal-width.ts';

describe('splash lines', () => {
  test('uses ASCII-safe compact splash in narrow panes', () => {
    const lines = getSplashLines(40);
    expect(lines.join('\n')).toContain('GOODVIBES');
    expect(lines.join('\n')).not.toContain('いい雰囲気');
    expect(lines.every((line) => getDisplayWidth(line) <= 40)).toBe(true);
  });

  test('wide splash remains within the available width', () => {
    const lines = getSplashLines(120);
    expect(lines.every((line) => getDisplayWidth(line) <= 120)).toBe(true);
  });
});
