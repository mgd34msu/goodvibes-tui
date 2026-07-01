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

  test('does not match ANSI-256 index strings or short hex', () => {
    expect(countHexLiterals("const C = { a: '244', b: '#fff' };")).toBe(0);
  });
});

describe('isHexLiteralBanTarget', () => {
  test('targets src/panels and src/renderer files', () => {
    expect(isHexLiteralBanTarget('src/panels/git-panel.ts')).toBe(true);
    expect(isHexLiteralBanTarget('src/renderer/ui-factory.ts')).toBe(true);
  });

  test('exempts the token-source files', () => {
    expect(isHexLiteralBanTarget('src/renderer/ui-primitives.ts')).toBe(false);
    expect(isHexLiteralBanTarget('src/renderer/theme.ts')).toBe(false);
    expect(isHexLiteralBanTarget('src/renderer/syntax-highlighter.ts')).toBe(false);
  });

  test('does not target files outside panels/renderer', () => {
    expect(isHexLiteralBanTarget('src/runtime/bootstrap.ts')).toBe(false);
    expect(isHexLiteralBanTarget('src/core/context-usage.ts')).toBe(false);
  });
});

describe('checkHexLiteralRatchet', () => {
  test('passes a file whose count matches its baseline', () => {
    const violations = checkHexLiteralRatchet(
      [{ relPath: 'src/panels/example-panel.ts', text: "fg: '#38bdf8'" }],
      { 'src/panels/example-panel.ts': 1 },
    );
    expect(violations).toEqual([]);
  });

  test('passes a file whose count shrank below its baseline', () => {
    const violations = checkHexLiteralRatchet(
      [{ relPath: 'src/panels/example-panel.ts', text: 'fg: UI_TONES.state.info' }],
      { 'src/panels/example-panel.ts': 3 },
    );
    expect(violations).toEqual([]);
  });

  test('fails a file whose count grew past its baseline', () => {
    const violations = checkHexLiteralRatchet(
      [{ relPath: 'src/panels/example-panel.ts', text: "fg: '#38bdf8', bg: '#0f172a'" }],
      { 'src/panels/example-panel.ts': 1 },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('src/panels/example-panel.ts');
    expect(violations[0]).toContain('2 > baseline 1');
    expect(violations[0]).toContain('no-raw-hex-literal-growth');
  });

  test('holds files absent from the baseline to zero', () => {
    const violations = checkHexLiteralRatchet(
      [{ relPath: 'src/panels/brand-new-panel.ts', text: "fg: '#38bdf8'" }],
      {},
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('1 > baseline 0');
  });

  test('ignores exempt token-source files even with many literals', () => {
    const violations = checkHexLiteralRatchet(
      [{ relPath: 'src/renderer/ui-primitives.ts', text: "'#38bdf8' '#ef4444' '#22c55e'" }],
      {},
    );
    expect(violations).toEqual([]);
  });

  test('ignores files outside src/panels and src/renderer', () => {
    const violations = checkHexLiteralRatchet(
      [{ relPath: 'src/runtime/bootstrap.ts', text: "fg: '#38bdf8'" }],
      {},
    );
    expect(violations).toEqual([]);
  });
});
