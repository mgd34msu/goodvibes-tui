import { describe, expect, test } from 'bun:test';
import {
  checkHexLiteralRatchet,
  countHexLiterals,
  isHexLiteralBanTarget,
} from '../../../scripts/hex-literal-rule.ts';

describe('countHexLiterals', () => {
  test('counts raw 6-digit hex literals', () => {
    expect(countHexLiterals("const C = { a: '#38bdf8', b: '#ef4444' };")).toBe(2);
  });

  test('returns 0 when there are none', () => {
    expect(countHexLiterals('const C = { a: UI_TONES.state.info };')).toBe(0);
  });

  test('does not match ANSI-256 index strings', () => {
    expect(countHexLiterals("const C = { a: '244' };")).toBe(0);
  });

  test('counts 3-digit and 8-digit hex color literals too', () => {
    expect(
      countHexLiterals("const C = { a: '#fff', b: '#38bdf8', c: '#ef444480' };"),
    ).toBe(3);
  });
});

describe('isHexLiteralBanTarget', () => {
  test('targets src/views and src/renderer files', () => {
    expect(isHexLiteralBanTarget('src/views/git-view.ts')).toBe(true);
    expect(isHexLiteralBanTarget('src/renderer/ui-factory.ts')).toBe(true);
  });

  test('holds the former token-source files to the ban (theme data lives in the SDK)', () => {
    expect(isHexLiteralBanTarget('src/renderer/ui-primitives.ts')).toBe(true);
    expect(isHexLiteralBanTarget('src/renderer/theme.ts')).toBe(true);
    expect(isHexLiteralBanTarget('src/renderer/syntax-highlighter.ts')).toBe(true);
  });

  test('does not target files outside views/renderer', () => {
    expect(isHexLiteralBanTarget('src/runtime/bootstrap.ts')).toBe(false);
    expect(isHexLiteralBanTarget('src/core/context-usage.ts')).toBe(false);
  });
});

describe('checkHexLiteralRatchet', () => {
  test('passes a file whose count matches its baseline', () => {
    const violations = checkHexLiteralRatchet(
      [{ relPath: 'src/views/example-view.ts', text: "fg: '#38bdf8'" }],
      { 'src/views/example-view.ts': 1 },
    );
    expect(violations).toEqual([]);
  });

  test('passes a file whose count shrank below its baseline', () => {
    const violations = checkHexLiteralRatchet(
      [{ relPath: 'src/views/example-view.ts', text: 'fg: UI_TONES.state.info' }],
      { 'src/views/example-view.ts': 3 },
    );
    expect(violations).toEqual([]);
  });

  test('fails a file whose count grew past its baseline', () => {
    const violations = checkHexLiteralRatchet(
      [{ relPath: 'src/views/example-view.ts', text: "fg: '#38bdf8', bg: '#0f172a'" }],
      { 'src/views/example-view.ts': 1 },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('src/views/example-view.ts');
    expect(violations[0]).toContain('2 > baseline 1');
    expect(violations[0]).toContain('no-raw-hex-literal-growth');
  });

  test('holds files absent from the baseline to zero', () => {
    const violations = checkHexLiteralRatchet(
      [{ relPath: 'src/views/brand-new-view.ts', text: "fg: '#38bdf8'" }],
      {},
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('1 > baseline 0');
  });

  test('flags literals in the former token-source files', () => {
    const violations = checkHexLiteralRatchet(
      [{ relPath: 'src/renderer/theme.ts', text: "'#38bdf8' '#ef4444' '#22c55e'" }],
      {},
    );
    expect(violations).toHaveLength(1);
  });

  test('ignores files outside src/views and src/renderer', () => {
    const violations = checkHexLiteralRatchet(
      [{ relPath: 'src/runtime/bootstrap.ts', text: "fg: '#38bdf8'" }],
      {},
    );
    expect(violations).toEqual([]);
  });
});
