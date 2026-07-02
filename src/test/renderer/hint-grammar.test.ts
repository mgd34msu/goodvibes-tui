import { describe, test, expect } from 'bun:test';
import { formatHint, formatHints, joinHints, HINT_SEPARATOR } from '../../renderer/hint-grammar.ts';

describe('hint-grammar', () => {
  test('formatHint renders [Key] Verb', () => {
    expect(formatHint({ key: 'Enter', verb: 'Select' })).toBe('[Enter] Select');
  });

  test('formatHint renders a bare [Key] when verb is omitted', () => {
    expect(formatHint({ key: 'Esc' })).toBe('[Esc]');
  });

  test('formatHints joins with the middle-dot separator', () => {
    const out = formatHints([{ key: 'Up/Down', verb: 'Move' }, { key: 'Enter', verb: 'Select' }]);
    expect(out).toBe(`[Up/Down] Move${HINT_SEPARATOR}[Enter] Select`);
  });

  test('formatHints always sorts an Esc hint last', () => {
    const out = formatHints([
      { key: 'Esc', verb: 'Close' },
      { key: 'Up/Down', verb: 'Move' },
      { key: 'Enter', verb: 'Select' },
    ]);
    expect(out).toBe('[Up/Down] Move · [Enter] Select · [Esc] Close');
  });

  test('formatHints keeps non-esc order stable', () => {
    const out = formatHints([
      { key: 'A', verb: 'one' },
      { key: 'B', verb: 'two' },
      { key: 'C', verb: 'three' },
    ]);
    expect(out).toBe('[A] one · [B] two · [C] three');
  });

  test('joinHints appends state segments after a hint bar, dropping empties', () => {
    const bar = formatHints([{ key: 'Enter', verb: 'Select' }]);
    expect(joinHints(bar, '', 'Filter: All', undefined, 'Group: provider'))
      .toBe('[Enter] Select · Filter: All · Group: provider');
  });
});
