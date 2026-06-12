import { describe, expect, test } from 'bun:test';
import { fitDisplay, getDisplayWidth, padDisplayEnd, truncateDisplay, wrapText } from '../../utils/terminal-width.ts';

describe('ANSI escape stripping in getDisplayWidth', () => {
  test('SGR reset sequence \\x1b[0m is not counted as width', () => {
    const withSgr = '\x1b[0m' + 'abc';
    expect(getDisplayWidth(withSgr)).toBe(3);
  });

  test('SGR bold+color sequence is not counted as width', () => {
    const styled = '\x1b[1;38;2;255;0;0m' + 'hello' + '\x1b[0m';
    expect(getDisplayWidth(styled)).toBe(5);
  });

  test('256-colour SGR sequence is not counted as width', () => {
    const styled = '\x1b[38;5;196m' + 'XY' + '\x1b[0m';
    expect(getDisplayWidth(styled)).toBe(2);
  });

  test('OSC-8 hyperlink sequences are not counted as width', () => {
    // OSC 8 ; params ; uri ST text OSC 8 ;; ST
    const osc8 = '\x1b]8;;https://example.com\x07link text\x1b]8;;\x07';
    expect(getDisplayWidth(osc8)).toBe(9); // 'link text' = 9 chars
  });

  test('OSC-8 with ESC\\ terminator is stripped', () => {
    const osc8St = '\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\';
    expect(getDisplayWidth(osc8St)).toBe(4); // 'link' = 4 chars
  });

  test('mixed SGR and plain text measures only visible chars', () => {
    // 'a' + SGR cyan + 'bc' + SGR reset = 3 visible chars
    const mixed = 'a' + '\x1b[36m' + 'bc' + '\x1b[0m';
    expect(getDisplayWidth(mixed)).toBe(3);
  });

  test('string without escapes is unchanged in width', () => {
    expect(getDisplayWidth('hello')).toBe(5);
    expect(getDisplayWidth('界')).toBe(2); // CJK wide char
  });
});

describe('bracket-text-without-ESC over-strip guard', () => {
  // '[31mhi' is 6 literal characters: '[', '3', '1', 'm', 'h', 'i'
  // No ESC prefix — the parser must NOT strip this as an ANSI sequence.
  test('literal bracket text without ESC counts every character', () => {
    expect(getDisplayWidth('[31mhi')).toBe(6);
  });

  test('wrapText is unaffected by ESC-less bracket text', () => {
    // '[31m' looks like an SGR sequence but lacks ESC, so it must be treated
    // as 4 printable chars. wrapText should wrap based on the full 6-char width.
    const wrapped = wrapText('[31mhi', 4);
    // Total display width is 6, limit is 4 — must produce at least 2 segments
    expect(wrapped.length).toBeGreaterThanOrEqual(2);
  });

  test('truncateDisplay is unaffected by ESC-less bracket text', () => {
    const truncated = truncateDisplay('[31mhi', 4);
    // Must truncate to at most 4 display chars; all chars are printable
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(4);
    // The truncated result must be shorter than the original 6-char string
    expect(getDisplayWidth(truncated)).toBeLessThan(6);
  });
});

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
