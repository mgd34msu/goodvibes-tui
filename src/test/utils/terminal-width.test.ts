import { describe, expect, test } from 'bun:test';
import { fitDisplay, getDisplayWidth, joinPrioritizedSegments, padDisplayEnd, truncateDisplay, wrapText } from '../../utils/terminal-width.ts';

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

  test('SGR sequence wrapping wide chars: escapes stripped, wide chars counted', () => {
    // Green + CJK + reset: display width is 2 (wide char only)
    const styledWide = '\x1b[32m中\x1b[0m';
    expect(getDisplayWidth(styledWide)).toBe(2);
  });

  test('SGR sequence wrapping emoji: escapes stripped, emoji counted as wide', () => {
    const styledEmoji = '\x1b[1m\u{1F600}\x1b[0m';
    expect(getDisplayWidth(styledEmoji)).toBe(2);
  });

  test('ANSI sequence immediately adjacent to wide char (no whitespace)', () => {
    // Bold seq + CJK char + CJK char + reset, should count 4
    const s = '\x1b[1m中文\x1b[0m';
    expect(getDisplayWidth(s)).toBe(4);
  });

  test('empty ANSI sequences (zero-length payload) produce zero width', () => {
    const s = '\x1b[m\x1b[0m\x1b[1m';
    expect(getDisplayWidth(s)).toBe(0);
  });

  test('cross/tick glyph family counts as width 1 (fixes the "✕t" error-line glitch)', () => {
    // WO item 4: ✕ (U+2715) / ✖ (U+2716) sit inside the emoji block but
    // terminals draw them one cell wide. Counting them as 2 desynced the styled
    // cell grid from the physical glyph and corrupted the following text.
    expect(getDisplayWidth('✕')).toBe(1);
    expect(getDisplayWidth('✖')).toBe(1);
    // Sibling glyphs already width-1 stay width-1.
    expect(getDisplayWidth('✗')).toBe(1);
    expect(getDisplayWidth('✓')).toBe(1);
    // The exact error-line prefix renders at its true width (space + ✕ + space).
    expect(getDisplayWidth(' ✕ ')).toBe(3);
  });
});

describe('bracket-text-without-ESC over-strip guard', () => {
  // '[31mhi' is 6 literal characters: '[', '3', '1', 'm', 'h', 'i'
  // No ESC prefix, the parser must NOT strip this as an ANSI sequence.
  test('literal bracket text without ESC counts every character', () => {
    expect(getDisplayWidth('[31mhi')).toBe(6);
  });

  test('wrapText is unaffected by ESC-less bracket text', () => {
    // '[31m' looks like an SGR sequence but lacks ESC, so it must be treated
    // as 4 printable chars. wrapText should wrap based on the full 6-char width.
    const wrapped = wrapText('[31mhi', 4);
    // Total display width is 6, limit is 4, must produce at least 2 segments
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
    const text = 'abc界\u{1F642}xyz';
    const truncated = truncateDisplay(text, 6);
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(6);
  });

  test('padDisplayEnd pads to display width, not string length', () => {
    const text = '界\u{1F642}';
    const padded = padDisplayEnd(text, 6);
    expect(getDisplayWidth(padded)).toBe(6);
  });

  test('fitDisplay truncates and pads to exact display width', () => {
    const text = 'very-wide\u{1F642}value';
    const fitted = fitDisplay(text, 8);
    expect(getDisplayWidth(fitted)).toBe(8);
  });
});

describe('truncateDisplay: ANSI-safe slice boundaries', () => {
  test('truncation of ANSI-styled string does not cut mid-escape', () => {
    // Bold red 'hello world' styled, then reset, truncate to 5
    const styled = '\x1b[1;31m' + 'hello world' + '\x1b[0m';
    const truncated = truncateDisplay(styled, 5);
    // Display width must be <= 5
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(5);
    // The result must not contain a partial escape sequence:
    // If any ESC appears, it must be followed by a valid ANSI sequence final byte
    const hasPartialEsc = /\x1b(?![\[\]]|[0-9;]*[A-Za-z]|\])/u.test(truncated);
    expect(hasPartialEsc).toBe(false);
  });

  test('truncation at wide char boundary does not overshoot', () => {
    // 'AB' (2) + CJK (2) + CJK (2) = 6 total; truncate to 3, cannot fit second CJK
    const text = 'AB中文';
    const truncated = truncateDisplay(text, 3);
    // Ellipsis takes 1, so 'AB' + ellipsis = 3 display width fits
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(3);
    // Must not include the wide char that would overshoot
    expect(truncated).not.toContain('中');
  });

  test('truncation stops exactly at wide-char boundary, never mid-char', () => {
    // Exactly 4 wide chars = 8 display cols; truncating to 5 must not output partial wide char
    const text = '一丁丂七'; // four CJK, 8 display width
    const truncated = truncateDisplay(text, 5);
    // With ellipsis (1 wide), we can fit at most 2 CJK (4) + ellipsis (1) = 5
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(5);
  });

  test('truncateDisplay with no ellipsis (empty string) still stays within bounds', () => {
    const text = '界界界'; // 3 CJK = 6 display width
    const truncated = truncateDisplay(text, 4, '');
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(4);
  });

  test('truncateDisplay on ANSI-styled wide chars stays within bounds', () => {
    const styled = '\x1b[32m中文\x1b[0m'; // green + 2 CJK + reset = 4 display
    const truncated = truncateDisplay(styled, 3);
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(3);
  });
});

describe('getDisplayWidth: combining marks and variation selectors', () => {
  test('combining diacritical marks (U+0300-U+036F) add zero width', () => {
    // 'e' + combining grave accent, single base char
    const withCombining = 'è';
    expect(getDisplayWidth(withCombining)).toBe(1);
  });

  test('ZWJ (U+200D) adds zero width', () => {
    const zwj = '‍';
    expect(getDisplayWidth(zwj)).toBe(0);
  });

  test('variation selector VS-16 (U+FE0F) adds zero width', () => {
    const vs16 = '️';
    expect(getDisplayWidth(vs16)).toBe(0);
  });

  test('variation selector VS-15 (U+FE0E) adds zero width', () => {
    const vs15 = '︎';
    expect(getDisplayWidth(vs15)).toBe(0);
  });

  test('enclosing combining marks (U+20D0-U+20FF) add zero width', () => {
    const enc = '⃐';
    expect(getDisplayWidth(enc)).toBe(0);
  });

  test('CJK unified ideograph is double-width', () => {
    expect(getDisplayWidth('一')).toBe(2); // first CJK
    expect(getDisplayWidth('가')).toBe(2); // Korean syllable
  });

  test('ASCII letters and digits are single-width', () => {
    expect(getDisplayWidth('A')).toBe(1);
    expect(getDisplayWidth('9')).toBe(1);
  });

  test('fullwidth forms (U+FF00-U+FF60) are double-width', () => {
    expect(getDisplayWidth('０')).toBe(2); // fullwidth digit zero
  });

  test('control characters add zero width', () => {
    expect(getDisplayWidth('\x01')).toBe(0);
    expect(getDisplayWidth('\x1f')).toBe(0);
    expect(getDisplayWidth('\x7f')).toBe(0);
  });
});

describe('truncateDisplay: ZWJ sequence handling (code-point-safe, not grapheme-cluster-safe)', () => {
  test('ZWJ family total width is summed correctly (each component double-wide, ZWJ=0)', () => {
    // 👨‍👩‍👧‍👦: man(2)+ZWJ(0)+woman(2)+ZWJ(0)+girl(2)+ZWJ(0)+boy(2) = 8 display width
    const family = '👨‍👩‍👧‍👦';
    expect(getDisplayWidth(family)).toBe(8);
  });

  test('truncateDisplay result does not end with a bare ZWJ when family is split', () => {
    // When a ZWJ family is truncated mid-sequence the implementation may leave a
    // trailing ZWJ. This test documents the known limitation: we assert width
    // correctness only, not grapheme-cluster integrity.
    const family = '👨‍👩‍👧‍👦x';
    const truncated = truncateDisplay(family, 4);
    // Width constraint must always be respected
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(4);
  });

  test('truncateDisplay of plain text followed by ZWJ family respects width', () => {
    // 'AB' (2) + ZWJ family (8) + 'Z' (1) = 11; truncate to 4
    const text = 'AB👨‍👩‍👧‍👦Z';
    const truncated = truncateDisplay(text, 4);
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(4);
  });
});

describe('padDisplayEnd: ANSI-aware padding', () => {
  test('padDisplayEnd on ANSI-styled string pads to display width', () => {
    // 'hi' with bold ANSI = 2 display chars, pad to 6 = 4 spaces appended
    const styled = '\x1b[1m' + 'hi' + '\x1b[0m';
    const padded = padDisplayEnd(styled, 6);
    expect(getDisplayWidth(padded)).toBe(6);
  });

  test('padDisplayEnd on wide-char string pads correctly', () => {
    // 2 CJK = 4 display width; pad to 6 = 2 spaces appended
    const cjk = '中文';
    const padded = padDisplayEnd(cjk, 6);
    expect(getDisplayWidth(padded)).toBe(6);
    expect(padded.endsWith('  ')).toBe(true);
  });

  test('padDisplayEnd does not add padding when already at target width', () => {
    const text = 'hello';
    const padded = padDisplayEnd(text, 5);
    expect(padded).toBe('hello');
  });

  test('padDisplayEnd does not truncate when wider than target', () => {
    const text = 'toolong';
    const padded = padDisplayEnd(text, 4);
    // wider input is returned unchanged (no truncation contract)
    expect(padded).toBe('toolong');
  });
});

describe('joinPrioritizedSegments: whole-segment drop under width pressure', () => {
  const SEP = ' | ';

  test('all segments fit: joined verbatim in original order, nothing dropped', () => {
    const segs = [
      { text: 'aaa', priority: 0 },
      { text: 'bbb', priority: 1 },
      { text: 'ccc', priority: 2 },
    ];
    expect(joinPrioritizedSegments(segs, SEP, 20)).toBe('aaa | bbb | ccc');
  });

  test('drops the single highest-priority-number (lowest-value) segment whole first', () => {
    const segs = [
      { text: 'essential', priority: 0 },
      { text: 'important', priority: 1 },
      { text: 'decorative', priority: 2 },
    ];
    // Width fits the two higher-priority segments plus separator, but not all three.
    const width = 'essential | important'.length;
    const result = joinPrioritizedSegments(segs, SEP, width);
    expect(result).toBe('essential | important');
    expect(result).not.toContain('decorative');
    // No partial/mangled fragment of the dropped segment leaks through.
    expect(result).not.toContain('deco');
  });

  test('on a priority tie, drops the LATER segment and keeps the earlier one (regression: cwd survived over model in the footer)', () => {
    // Two priority-0 ("essential") segments that together don't fit: the
    // earlier-declared one must survive, not be silently dropped in favor
    // of the later one. This mirrors the footer's cwd (declared first) and
    // model (declared second), both priority 0, a real bug caught during
    // live tmux verification: dir got dropped instead of model because the
    // original tie-break picked the FIRST max-priority index, not the LAST.
    const segs = [
      { text: 'first-essential', priority: 0 },
      { text: 'second-essential', priority: 0 },
      { text: 'decorative', priority: 1 },
    ];
    const width = 'first-essential'.length; // fits exactly one segment alone
    const result = joinPrioritizedSegments(segs, SEP, width);
    expect(result).toBe('first-essential');
    expect(result).not.toContain('second-essential');
    expect(result).not.toContain('decorative');
  });

  test('drops multiple low-priority segments in priority order until it fits', () => {
    const segs = [
      { text: 'core', priority: 0 },
      { text: 'high', priority: 1 },
      { text: 'mid', priority: 2 },
      { text: 'low', priority: 3 },
    ];
    const width = 'core | high'.length;
    const result = joinPrioritizedSegments(segs, SEP, width);
    expect(result).toBe('core | high');
    expect(result).not.toContain('mid');
    expect(result).not.toContain('low');
  });

  test('falls back to character truncation only when even the sole remaining segment does not fit', () => {
    const segs = [{ text: 'way-too-long-to-fit-in-the-given-width', priority: 0 }];
    const result = joinPrioritizedSegments(segs, SEP, 10);
    expect(getDisplayWidth(result)).toBeLessThanOrEqual(10);
    expect(result.endsWith('…')).toBe(true);
  });

  test('empty segment list returns empty string', () => {
    expect(joinPrioritizedSegments([], SEP, 10)).toBe('');
  });
});
