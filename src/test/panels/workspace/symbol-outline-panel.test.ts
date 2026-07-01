import { describe, expect, test } from 'bun:test';
import { SymbolOutlinePanel } from '../../../panels/symbol-outline-panel.ts';
import { linesText } from './_shared.ts';

describe('workspace panel migrations', () => {
  test('SymbolOutlinePanel renders shared workspace empty state cleanly', async () => {
    const panel = new SymbolOutlinePanel();
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Symbols');
    expect(linesText(lines)).toContain('No file loaded');
  });
});
