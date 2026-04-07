import { describe, test, expect } from 'bun:test';
import { renderProcessIndicator } from '../../renderer/process-indicator.ts';
import { lineToString } from '../setup.ts';

const W = 100;

describe('renderProcessIndicator', () => {
  test('returns a single Line when idle (0 agents, 0 tools)', () => {
    const lines = renderProcessIndicator(W, 0, 0);
    expect(lines.length).toBe(1);
  });

  test('idle line has correct terminal width', () => {
    const lines = renderProcessIndicator(W, 0, 0);
    expect(lines[0].length).toBe(W);
  });

  test('idle state contains idle label text', () => {
    const lines = renderProcessIndicator(W, 0, 0);
    const text = lineToString(lines[0]);
    expect(text).toContain('bg: none');
  });

  test('idle state cells are dimmed', () => {
    const lines = renderProcessIndicator(W, 0, 0);
    const dimCells = lines[0].filter((c) => c.char !== ' ' && c.dim);
    expect(dimCells.length).toBeGreaterThan(0);
  });

  test('returns a single Line when active', () => {
    const lines = renderProcessIndicator(W, 2, 1);
    expect(lines.length).toBe(1);
  });

  test('active line has correct terminal width', () => {
    const lines = renderProcessIndicator(W, 2, 1);
    expect(lines[0].length).toBe(W);
  });

  test('active state shows agent count', () => {
    const lines = renderProcessIndicator(W, 2, 0);
    const text = lineToString(lines[0]);
    expect(text).toContain('2 agents');
  });

  test('active state shows tool count', () => {
    const lines = renderProcessIndicator(W, 0, 3);
    const text = lineToString(lines[0]);
    expect(text).toContain('3 tools running');
  });

  test('active state shows both agents and tools', () => {
    const lines = renderProcessIndicator(W, 1, 2);
    const text = lineToString(lines[0]);
    expect(text).toContain('1 agent');
    expect(text).toContain('2 tools running');
  });

  test('pluralization: 1 agent singular', () => {
    const lines = renderProcessIndicator(W, 1, 0);
    const text = lineToString(lines[0]);
    expect(text).toContain('1 agent');
    expect(text).not.toContain('1 agents');
  });

  test('pluralization: 2 agents plural', () => {
    const lines = renderProcessIndicator(W, 2, 0);
    const text = lineToString(lines[0]);
    expect(text).toContain('2 agents');
  });

  test('pluralization: 1 tool singular', () => {
    const lines = renderProcessIndicator(W, 0, 1);
    const text = lineToString(lines[0]);
    expect(text).toContain('1 tool running');
    expect(text).not.toContain('1 tools running');
  });

  test('open hint present when active', () => {
    const lines = renderProcessIndicator(W, 1, 0);
    const text = lineToString(lines[0]);
    expect(text).toContain('Enter to view');
  });

  test('open hint not present when idle', () => {
    const lines = renderProcessIndicator(W, 0, 0);
    const text = lineToString(lines[0]);
    expect(text).not.toContain('Enter to view');
  });

  test('width handling: narrow terminal (40 cols)', () => {
    const narrow = 40;
    const lines = renderProcessIndicator(narrow, 2, 1);
    expect(lines.length).toBe(1);
    expect(lines[0].length).toBe(narrow);
  });

  test('active label cells are cyan + bold', () => {
    const lines = renderProcessIndicator(W, 1, 0);
    // Find a cell with cyan foreground from the label
    const cyanBold = lines[0].filter((c) => c.fg === '#00ffff' && c.bold);
    expect(cyanBold.length).toBeGreaterThan(0);
  });

  test('focused with zero processes shows focus prefix', () => {
    const lines = renderProcessIndicator(80, 0, 0, true);
    expect(lines.length).toBe(1);
    const text = lines[0].map(c => c.char).join('');
    expect(text).toContain('>');
    expect(text).toContain('No background processes');
  });

  test('focused with active processes shows Enter hint', () => {
    const lines = renderProcessIndicator(80, 2, 0, true);
    expect(lines.length).toBe(1);
    const text = lines[0].map(c => c.char).join('');
    expect(text).toContain('Enter to open');
    expect(text).toContain('back to input');
  });

  test('focused line uses cyan bold styling', () => {
    const lines = renderProcessIndicator(80, 1, 0, true);
    const firstNonSpace = lines[0].find(c => c.char.trim() !== '');
    expect(firstNonSpace?.fg).toBe('#00ffff');
    expect(firstNonSpace?.bold).toBe(true);
  });

  test('focused line respects terminal width', () => {
    const lines = renderProcessIndicator(120, 1, 0, true);
    expect(lines[0].length).toBe(120);
  });

  test('unfocused with explicit false matches default behavior', () => {
    const defaultLines = renderProcessIndicator(80, 1, 0);
    const explicitLines = renderProcessIndicator(80, 1, 0, false);
    const defaultText = defaultLines[0].map(c => c.char).join('');
    const explicitText = explicitLines[0].map(c => c.char).join('');
    expect(defaultText).toBe(explicitText);
  });

  test('agentProgress appears in rendered output when passed', () => {
    const progress = 'Turn 3 | precision_write';
    const lines = renderProcessIndicator(W, 1, 0, false, progress);
    const text = lineToString(lines[0]);
    expect(text).toContain(progress);
  });

  test('agentProgress is truncated when it exceeds available width', () => {
    // With a narrow terminal, progress is either truncated or omitted entirely
    const progress = 'A'.repeat(100);
    const lines = renderProcessIndicator(60, 1, 0, false, progress);
    const text = lineToString(lines[0]);
    // Should not overflow the line width
    expect(lines[0].length).toBe(60);
    // The full 100-char string must not appear verbatim
    expect(text).not.toContain('A'.repeat(100));
  });

  test('no agentProgress shows no progress suffix', () => {
    const lines = renderProcessIndicator(W, 1, 0, false, undefined);
    const text = lineToString(lines[0]);
    // Should contain agent count but no progress suffix beyond it
    expect(text).toContain('1 agent');
    expect(text).not.toContain(' | Turn');
  });
});
